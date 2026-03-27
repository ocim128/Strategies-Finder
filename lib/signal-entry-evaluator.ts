import type {
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
    Trade,
} from "./types/strategies";
import { strategies } from "./strategies/library";
import { prepareSignalsForScanner } from "./strategies/backtest/signal-preparation";
import {
    allowsSignalAsEntry,
    applySignalPolarity,
    getExecutionShift,
    normalizeBacktestSettings,
    normalizeTradeDirection,
} from "./strategies/backtest/backtest-utils";
import { runBacktest } from "./strategies/backtest/backtest-engine";
import { getResampleBucketStart, resampleOHLCV, type ResampleOptions } from "./strategies/resample-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { mergeStrategySignals } from "./signal-merge";
import { toBooleanLike, toFiniteNumber } from "./settings-parse-utils";
import { isTradeSizingMode, type CapitalSettings, type TradeSizingMode } from "./types/backtest";

export interface EntrySignalEvaluationRequest {
    strategyKey: string;
    candles: OHLCVData[];
    strategyParams?: Record<string, number>;
    backtestSettings?: BacktestSettings;
    capitalSettings?: EntrySignalCapitalSettings;
    freshnessBars?: number;
}

export interface EntrySignalCapitalSettings extends Partial<CapitalSettings> {
    fixedTradeToggle?: boolean;
}

export interface EvaluatedEntrySignal {
    strategyKey: string;
    strategyName: string;
    signal: Signal;
    direction: "long" | "short";
    signalTimeSec: number;
    entryTimeSec: number | null;
    entryPrice: number | null;
    signalAgeBars: number;
    isFresh: boolean;
    fingerprint: string;
}

export interface EvaluatedLatestTradeContext {
    entryTimeSec: number;
    entryPrice: number;
    exitReason: string | null;
    isOpen: boolean;
    takeProfitPrice: number | null;
    stopLossPrice: number | null;
    takeProfitPercent: number | null;
    stopLossPercent: number | null;
}

export interface EntrySignalEvaluationResult {
    ok: boolean;
    reason?:
    | "strategy_not_found"
    | "invalid_input"
    | "insufficient_data"
    | "no_signals"
    | "signal_time_not_found";
    rawSignalCount: number;
    preparedSignalCount: number;
    latestEntry: EvaluatedEntrySignal | null;
    latestTrade: EvaluatedLatestTradeContext | null;
    pendingEntry?: EvaluatedEntrySignal | null;
}

const EVALUATION_CAPITAL_DEFAULTS = Object.freeze({
    initialCapital: 10000,
    positionSize: 100,
    commission: 0,
    sizingMode: "percent" as const,
    fixedTradeAmount: 0,
});

function toTargetPercent(entryPrice: number, targetPrice: number | null | undefined): number | null {
    if (
        !Number.isFinite(entryPrice)
        || entryPrice <= 0
        || targetPrice === null
        || targetPrice === undefined
        || !Number.isFinite(targetPrice)
    ) {
        return null;
    }
    return Math.abs(((targetPrice - entryPrice) / entryPrice) * 100);
}

function toUnixSeconds(value: Time): number | null {
    return parseTimeToUnixSeconds(value);
}

function toSizingMode(value: unknown): TradeSizingMode | null {
    if (value === "smart_fixed") return "smart_fixed_velocity_memory";
    if (
        value === "smart_fixed_early_heat_filter"
        || value === "smart_fixed_adverse_memory"
        || value === "smart_fixed_mfe_ancestor"
        || value === "smart_fixed_tp_distance_fit"
    ) {
        return "smart_fixed_quality_x_velocity";
    }
    return isTradeSizingMode(value) ? value : null;
}

function resolveEvaluationCapitalSettings(request: EntrySignalEvaluationRequest): CapitalSettings {
    const rawBacktestSettings = request.backtestSettings as Record<string, unknown> | undefined;
    const rawCapitalSettings = request.capitalSettings as Record<string, unknown> | undefined;

    const initialCapital = Math.max(
        0,
        toFiniteNumber(rawCapitalSettings?.initialCapital)
        ?? toFiniteNumber(rawBacktestSettings?.initialCapital)
        ?? EVALUATION_CAPITAL_DEFAULTS.initialCapital
    );
    const positionSize = Math.max(
        0,
        toFiniteNumber(rawCapitalSettings?.positionSize)
        ?? toFiniteNumber(rawBacktestSettings?.positionSize)
        ?? EVALUATION_CAPITAL_DEFAULTS.positionSize
    );
    const commission = Math.max(
        0,
        toFiniteNumber(rawCapitalSettings?.commission)
        ?? toFiniteNumber(rawBacktestSettings?.commission)
        ?? EVALUATION_CAPITAL_DEFAULTS.commission
    );
    const fixedTradeAmount = Math.max(
        0,
        toFiniteNumber(rawCapitalSettings?.fixedTradeAmount)
        ?? toFiniteNumber(rawBacktestSettings?.fixedTradeAmount)
        ?? EVALUATION_CAPITAL_DEFAULTS.fixedTradeAmount
    );

    const explicitSizingMode = toSizingMode(rawCapitalSettings?.sizingMode)
        ?? toSizingMode(rawBacktestSettings?.sizingMode);
    const fixedTradeToggle = toBooleanLike(rawCapitalSettings?.fixedTradeToggle)
        ?? toBooleanLike(rawBacktestSettings?.fixedTradeToggle);
    const sizingMode = explicitSizingMode ?? (fixedTradeToggle === true ? "fixed" : EVALUATION_CAPITAL_DEFAULTS.sizingMode);

    return { initialCapital, positionSize, commission, sizingMode, fixedTradeAmount };
}

function toNumericTimeData(data: OHLCVData[]): OHLCVData[] | null {
    const mapped: OHLCVData[] = new Array(data.length);
    for (let i = 0; i < data.length; i++) {
        const sec = toUnixSeconds(data[i].time);
        if (sec === null) return null;
        mapped[i] = { ...data[i], time: sec as Time };
    }
    return mapped;
}

function readStrategyTimeframeConfig(settings: BacktestSettings): {
    enabled: boolean;
    interval: string;
    resampleOptions?: ResampleOptions;
} {
    const enabled = settings.strategyTimeframeEnabled === true;
    const parsedMinutes = Number(settings.strategyTimeframeMinutes);
    const minutes = Number.isFinite(parsedMinutes) && parsedMinutes > 0
        ? Math.max(1, Math.floor(parsedMinutes))
        : 120;
    const parity = settings.twoHourCloseParity === "even" ? "even" : "odd";
    const interval = `${minutes}m`;
    const resampleOptions: ResampleOptions | undefined = minutes === 120
        ? { twoHourCloseParity: parity }
        : undefined;
    return { enabled, interval, resampleOptions };
}

function mapSignalsFromHigherTimeframe(
    baseData: OHLCVData[],
    numericBaseData: OHLCVData[],
    higherData: OHLCVData[],
    higherSignals: Signal[],
    interval: string,
    options?: ResampleOptions
): Signal[] {
    if (higherSignals.length === 0) return [];

    const lastBaseIndexByBucket = new Map<number, number>();
    for (let i = 0; i < numericBaseData.length; i++) {
        const t = Number(numericBaseData[i].time);
        if (!Number.isFinite(t)) continue;
        const bucketStart = getResampleBucketStart(t, interval, options);
        lastBaseIndexByBucket.set(bucketStart, i);
    }

    const mapped: Signal[] = [];
    for (const signal of higherSignals) {
        let bucketStart: number | null = null;

        if (Number.isFinite(signal.barIndex)) {
            const idx = Math.trunc(signal.barIndex as number);
            if (idx >= 0 && idx < higherData.length) {
                const timeValue = higherData[idx].time;
                const sec = typeof timeValue === "number" ? timeValue : toUnixSeconds(timeValue);
                if (sec !== null) {
                    bucketStart = sec;
                }
            }
        }

        if (bucketStart === null) {
            const signalTimeSec = toUnixSeconds(signal.time);
            if (signalTimeSec !== null) {
                bucketStart = getResampleBucketStart(signalTimeSec, interval, options);
            }
        }

        if (bucketStart === null) continue;
        const baseIndex = lastBaseIndexByBucket.get(bucketStart);
        if (baseIndex === undefined) continue;

        mapped.push({
            ...signal,
            time: baseData[baseIndex].time,
            price: baseData[baseIndex].close,
            barIndex: baseIndex,
        });
    }

    return mapped;
}

function executeStrategyWithSettings(
    data: OHLCVData[],
    strategy: Strategy,
    params: StrategyParams,
    settings: BacktestSettings
): Signal[] {
    const tfConfig = readStrategyTimeframeConfig(settings);
    if (!tfConfig.enabled || data.length === 0) {
        return applySignalPolarity(strategy.execute(data, params), settings);
    }

    const numericData = toNumericTimeData(data);
    if (!numericData) {
        return applySignalPolarity(strategy.execute(data, params), settings);
    }

    const higherData = resampleOHLCV(numericData, tfConfig.interval, tfConfig.resampleOptions);
    if (higherData.length === 0) return [];

    const higherSignals = strategy.execute(higherData, params);
    const mappedSignals = mapSignalsFromHigherTimeframe(
        data,
        numericData,
        higherData,
        higherSignals,
        tfConfig.interval,
        tfConfig.resampleOptions
    );
    return applySignalPolarity(mappedSignals, settings);
}

function applyConfirmationStrategies(
    candles: OHLCVData[],
    baseSignals: Signal[],
    settings: BacktestSettings,
): Signal[] {
    const keys = Array.isArray(settings.confirmationStrategies)
        ? settings.confirmationStrategies.filter((key): key is string => typeof key === "string" && key.trim().length > 0)
        : [];
    if (keys.length === 0 || baseSignals.length === 0) return baseSignals;

    const confirmationParamsByStrategy = settings.confirmationStrategyParams ?? {};
    let mergedSignals: Signal[] = baseSignals;
    for (const key of keys) {
        const confirmationStrategy = strategies[key];
        if (!confirmationStrategy) continue;

        const confirmationParams = {
            ...confirmationStrategy.defaultParams,
            ...(confirmationParamsByStrategy[key] ?? {}),
        };
        const confirmationSignals = executeStrategyWithSettings(candles, confirmationStrategy, confirmationParams, settings);
        mergedSignals = mergeStrategySignals(mergedSignals, confirmationSignals, "and") as Signal[];
        if (mergedSignals.length === 0) break;
    }

    return mergedSignals;
}

function buildSignalFingerprint(
    strategyKey: string,
    direction: "long" | "short",
    signalTimeSec: number,
    signalPrice: number
): string {
    const normalizedPrice = Number(signalPrice.toFixed(8));
    return `${strategyKey}:${direction}:${signalTimeSec}:${normalizedPrice}`;
}

function toSignalType(direction: "long" | "short"): Signal["type"] {
    return direction === "long" ? "buy" : "sell";
}

function buildEvaluatedEntrySignal(args: {
    strategyKey: string;
    strategyName: string;
    sourceSignal: Signal;
    direction: "long" | "short";
    signalTimeSec: number;
    signalAgeBars: number;
    maxAge: number;
    entryTimeSec: number | null;
    entryPrice: number | null;
}): EvaluatedEntrySignal {
    return {
        strategyKey: args.strategyKey,
        strategyName: args.strategyName,
        signal: args.sourceSignal,
        direction: args.direction,
        signalTimeSec: args.signalTimeSec,
        entryTimeSec: args.entryTimeSec,
        entryPrice: args.entryPrice,
        signalAgeBars: args.signalAgeBars,
        isFresh: args.signalAgeBars <= args.maxAge,
        fingerprint: buildSignalFingerprint(
            args.strategyKey,
            args.direction,
            args.signalTimeSec,
            args.sourceSignal.price
        ),
    };
}

function normalizePriceForMatch(price: number): number {
    return Number(price.toFixed(8));
}

function pickLatestExecutedEntryTrade(trades: Trade[]): { trade: Trade; entryTimeSec: number } | null {
    let latest: { trade: Trade; entryTimeSec: number } | null = null;

    for (const trade of trades) {
        const entryTimeSec = toUnixSeconds(trade.entryTime);
        if (entryTimeSec === null) continue;

        if (
            latest === null ||
            entryTimeSec > latest.entryTimeSec ||
            (entryTimeSec === latest.entryTimeSec && trade.id > latest.trade.id)
        ) {
            latest = { trade, entryTimeSec };
        }
    }

    return latest;
}

function findPreparedSignalForTradeEntry(
    preparedEntrySignals: Signal[],
    direction: "long" | "short",
    entryTimeSec: number,
    entryPrice: number
): Signal | null {
    const expectedType = toSignalType(direction);
    const normalizedEntryPrice = normalizePriceForMatch(entryPrice);

    let fallbackByTimeAndType: Signal | null = null;

    for (const signal of preparedEntrySignals) {
        if (signal.type !== expectedType) continue;
        const signalTimeSec = toUnixSeconds(signal.time);
        if (signalTimeSec !== entryTimeSec) continue;

        if (fallbackByTimeAndType === null) {
            fallbackByTimeAndType = signal;
        }

        if (normalizePriceForMatch(signal.price) === normalizedEntryPrice) {
            return signal;
        }
    }

    return fallbackByTimeAndType;
}

function findSourceSignalForTradeEntry(
    candles: OHLCVData[],
    rawEntrySignals: Signal[],
    preparedSignal: Signal | null,
    direction: "long" | "short",
    settings: BacktestSettings
): Signal | null {
    if (!preparedSignal) return null;

    const normalizedSettings = normalizeBacktestSettings(settings);
    const totalLeadBars =
        getExecutionShift(normalizedSettings)
        + (normalizedSettings.tradeFilterMode === "close" ? 1 : 0);
    const preparedIndex = Number.isFinite(preparedSignal.barIndex)
        ? Math.trunc(preparedSignal.barIndex as number)
        : candles.findIndex((bar) => toUnixSeconds(bar.time) === toUnixSeconds(preparedSignal.time));

    if (preparedIndex < totalLeadBars || preparedIndex >= candles.length) {
        return null;
    }

    const sourceIndex = preparedIndex - totalLeadBars;
    const sourceTime = candles[sourceIndex]?.time;
    const sourceTimeSec = sourceTime !== undefined ? toUnixSeconds(sourceTime) : null;
    if (sourceTime === undefined || sourceTimeSec === null) {
        return null;
    }

    const expectedType = toSignalType(direction);
    const normalizedTriggerPrice = normalizePriceForMatch(
        typeof preparedSignal.triggerPrice === "number" && Number.isFinite(preparedSignal.triggerPrice)
            ? preparedSignal.triggerPrice
            : preparedSignal.price
    );

    let fallbackByTimeAndType: Signal | null = null;

    for (const signal of rawEntrySignals) {
        if (signal.type !== expectedType) continue;
        const rawSignalTimeSec = toUnixSeconds(signal.time);
        if (rawSignalTimeSec !== sourceTimeSec) continue;

        const candidate: Signal = {
            ...signal,
            barIndex: Number.isFinite(signal.barIndex) ? Math.trunc(signal.barIndex as number) : sourceIndex,
        };
        if (fallbackByTimeAndType === null) {
            fallbackByTimeAndType = candidate;
        }

        if (normalizePriceForMatch(signal.price) === normalizedTriggerPrice) {
            return candidate;
        }
    }

    return fallbackByTimeAndType ?? {
        time: sourceTime,
        type: expectedType,
        price: typeof preparedSignal.triggerPrice === "number" && Number.isFinite(preparedSignal.triggerPrice)
            ? preparedSignal.triggerPrice
            : preparedSignal.price,
        reason: preparedSignal.reason,
        barIndex: sourceIndex,
    };
}

export function evaluateLatestEntrySignal(
    request: EntrySignalEvaluationRequest
): EntrySignalEvaluationResult {
    if (!request || !request.strategyKey || !Array.isArray(request.candles)) {
        return {
            ok: false,
            reason: "invalid_input",
            rawSignalCount: 0,
            preparedSignalCount: 0,
            latestEntry: null,
            latestTrade: null,
        };
    }

    const strategy = strategies[request.strategyKey];
    if (!strategy) {
        return {
            ok: false,
            reason: "strategy_not_found",
            rawSignalCount: 0,
            preparedSignalCount: 0,
            latestEntry: null,
            latestTrade: null,
        };
    }

    if (request.candles.length < 2) {
        return {
            ok: false,
            reason: "insufficient_data",
            rawSignalCount: 0,
            preparedSignalCount: 0,
            latestEntry: null,
            latestTrade: null,
        };
    }

    const settings = request.backtestSettings ?? {};
    const mergedParams = { ...strategy.defaultParams, ...(request.strategyParams ?? {}) };
    const rawSignals = executeStrategyWithSettings(request.candles, strategy, mergedParams, settings);
    const entrySignalsRaw = applyConfirmationStrategies(request.candles, rawSignals, settings);
    const preparedSignals = prepareSignalsForScanner(
        request.candles,
        entrySignalsRaw,
        settings
    );
    const tradeDirection = normalizeTradeDirection(settings);
    const entrySignals = preparedSignals.filter((signal) =>
        allowsSignalAsEntry(signal.type, tradeDirection)
    );
    const capitalSettings = resolveEvaluationCapitalSettings(request);

    const backtestResult = runBacktest(
        request.candles,
        entrySignalsRaw,
        capitalSettings.initialCapital,
        capitalSettings.positionSize,
        capitalSettings.commission,
        settings,
        {
            mode: capitalSettings.sizingMode,
            fixedTradeAmount: capitalSettings.fixedTradeAmount,
        }
    );

    if (backtestResult.trades.length === 0) {
        return {
            ok: true,
            reason: "no_signals",
            rawSignalCount: rawSignals.length,
            preparedSignalCount: preparedSignals.length,
            latestEntry: null,
            latestTrade: null,
        };
    }

    const latestExecutedEntry = pickLatestExecutedEntryTrade(backtestResult.trades);
    if (!latestExecutedEntry) {
        return {
            ok: false,
            reason: "signal_time_not_found",
            rawSignalCount: rawSignals.length,
            preparedSignalCount: preparedSignals.length,
            latestEntry: null,
            latestTrade: null,
        };
    }

    const { trade: latestTrade, entryTimeSec } = latestExecutedEntry;
    const direction: "long" | "short" = latestTrade.type;
    const matchedPreparedSignal = findPreparedSignalForTradeEntry(
        entrySignals,
        direction,
        entryTimeSec,
        latestTrade.entryPrice
    );
    const latestSignal: Signal = findSourceSignalForTradeEntry(
        request.candles,
        entrySignalsRaw,
        matchedPreparedSignal,
        direction,
        settings
    ) ?? matchedPreparedSignal ?? {
        time: latestTrade.entryTime,
        type: toSignalType(direction),
        price: latestTrade.entryPrice,
    };

    const candleTimeToLastIndex = new Map<number, number>();
    request.candles.forEach((bar, idx) => {
        const sec = toUnixSeconds(bar.time);
        if (sec !== null) {
            candleTimeToLastIndex.set(sec, idx);
        }
    });

    const signalTimeSec = toUnixSeconds(latestSignal.time) ?? entryTimeSec;
    const signalIndex = Number.isFinite(latestSignal.barIndex)
        ? Math.trunc(latestSignal.barIndex as number)
        : candleTimeToLastIndex.get(signalTimeSec);

    if (signalIndex === undefined || signalIndex < 0 || signalIndex >= request.candles.length) {
        return {
            ok: false,
            reason: "signal_time_not_found",
            rawSignalCount: rawSignals.length,
            preparedSignalCount: preparedSignals.length,
            latestEntry: null,
            latestTrade: null,
        };
    }

    const signalAgeBars = request.candles.length - 1 - signalIndex;
    const maxAge = Math.max(0, Math.floor(request.freshnessBars ?? 1));

    const latestEntry: EvaluatedEntrySignal = buildEvaluatedEntrySignal({
        strategyKey: request.strategyKey,
        strategyName: strategy.name,
        sourceSignal: latestSignal,
        direction,
        signalTimeSec,
        signalAgeBars,
        maxAge,
        entryTimeSec,
        entryPrice: latestTrade.entryPrice,
    });

    // Detect pending (skipped) entry signal when the latest trade is still open.
    // A "pending" signal fired while the backtest position was occupied — in live
    // trading this means there is a potential entry once the current position closes.
    let pendingEntry: EvaluatedEntrySignal | null = null;
    if (latestTrade.exitReason === 'end_of_data') {
        for (const signal of entrySignals) {
            const sigTimeSec = toUnixSeconds(signal.time);
            if (sigTimeSec === null || sigTimeSec <= signalTimeSec) continue;

            const pendingDirection: "long" | "short" = signal.type === "buy" ? "long" : "short";
            const pendingSignalIndex = candleTimeToLastIndex.get(sigTimeSec);
            if (pendingSignalIndex === undefined) continue;

            const pendingSourceSignal = findSourceSignalForTradeEntry(
                request.candles,
                entrySignalsRaw,
                signal,
                pendingDirection,
                settings
            ) ?? signal;
            const pendingSourceTimeSec = toUnixSeconds(pendingSourceSignal.time) ?? sigTimeSec;
            const pendingAgeBars = request.candles.length - 1 - pendingSignalIndex;

            // Keep the NEWEST pending signal
            if (!pendingEntry || sigTimeSec > (pendingEntry.entryTimeSec ?? pendingEntry.signalTimeSec)) {
                pendingEntry = buildEvaluatedEntrySignal({
                    strategyKey: request.strategyKey,
                    strategyName: strategy.name,
                    sourceSignal: pendingSourceSignal,
                    direction: pendingDirection,
                    signalTimeSec: pendingSourceTimeSec,
                    signalAgeBars: pendingAgeBars,
                    maxAge,
                    entryTimeSec: sigTimeSec,
                    entryPrice: signal.price,
                });
            }
        }
    }

    return {
        ok: true,
        rawSignalCount: rawSignals.length,
        preparedSignalCount: preparedSignals.length,
        latestEntry,
        latestTrade: {
            entryTimeSec,
            entryPrice: latestTrade.entryPrice,
            exitReason: latestTrade.exitReason ?? null,
            isOpen: latestTrade.exitReason === "end_of_data",
            takeProfitPrice: latestTrade.takeProfitPrice ?? null,
            stopLossPrice: latestTrade.stopLossPrice ?? null,
            takeProfitPercent: toTargetPercent(latestTrade.entryPrice, latestTrade.takeProfitPrice),
            stopLossPercent: toTargetPercent(latestTrade.entryPrice, latestTrade.stopLossPrice),
        },
        pendingEntry,
    };
}
