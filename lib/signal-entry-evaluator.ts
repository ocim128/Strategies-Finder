import type {
    BacktestSettings,
    OHLCVData,
    Signal,
    Strategy,
    StrategyParams,
    Time,
    Trade,
    TradeDirection,
    TradeFilterMode,
} from "./types/strategies";
import { strategies } from "./strategies/library";
import { prepareSignalsForScanner } from "./strategies/backtest/signal-preparation";
import { allowsSignalAsEntry, normalizeTradeDirection } from "./strategies/backtest/backtest-utils";
import { runBacktest } from "./strategies/backtest/backtest-engine";
import { getResampleBucketStart, resampleOHLCV, type ResampleOptions } from "./strategies/resample-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";
import { toTimeKey } from "./time-key";

export interface EntrySignalEvaluationRequest {
    strategyKey: string;
    candles: OHLCVData[];
    strategyParams?: Record<string, number>;
    backtestSettings?: BacktestSettings;
    freshnessBars?: number;
}

export interface EvaluatedEntrySignal {
    strategyKey: string;
    strategyName: string;
    signal: Signal;
    direction: "long" | "short";
    signalTimeSec: number;
    signalAgeBars: number;
    isFresh: boolean;
    fingerprint: string;
}

export interface EvaluatedLatestTradeContext {
    entryTimeSec: number;
    exitReason: string | null;
    isOpen: boolean;
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
}

type StrategyRole = NonNullable<NonNullable<Strategy["metadata"]>["role"]>;

const TRADE_FILTER_MODES: ReadonlySet<TradeFilterMode> = new Set([
    "none",
    "close",
    "volume",
    "rsi",
    "trend",
    "adx",
]);

function toUnixSeconds(value: Time): number | null {
    return parseTimeToUnixSeconds(value);
}

function resolveTradeFilterMode(settings: BacktestSettings | undefined): TradeFilterMode {
    const raw = settings?.tradeFilterMode ?? settings?.entryConfirmation ?? "none";
    return TRADE_FILTER_MODES.has(raw as TradeFilterMode) ? (raw as TradeFilterMode) : "none";
}

function getTimeIndex(data: OHLCVData[]): Map<string, number> {
    const out = new Map<string, number>();
    data.forEach((bar, idx) => {
        out.set(toTimeKey(bar.time), idx);
    });
    return out;
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
        return strategy.execute(data, params);
    }

    const numericData = toNumericTimeData(data);
    if (!numericData) {
        return strategy.execute(data, params);
    }

    const higherData = resampleOHLCV(numericData, tfConfig.interval, tfConfig.resampleOptions);
    if (higherData.length === 0) return [];

    const higherSignals = strategy.execute(higherData, params);
    return mapSignalsFromHigherTimeframe(
        data,
        numericData,
        higherData,
        higherSignals,
        tfConfig.interval,
        tfConfig.resampleOptions
    );
}

function buildConfirmationStates(
    data: OHLCVData[],
    strategyKeys: string[],
    settings: BacktestSettings,
    paramsByKey?: Record<string, StrategyParams>
): Int8Array[] {
    if (data.length === 0 || strategyKeys.length === 0) return [];

    const timeIndex = getTimeIndex(data);
    const states: Int8Array[] = [];

    strategyKeys.forEach((key) => {
        const strategy = strategies[key];
        if (!strategy) return;

        const params = paramsByKey?.[key] ?? strategy.defaultParams;
        const signals = executeStrategyWithSettings(data, strategy, params, settings);
        if (signals.length === 0) {
            states.push(new Int8Array(data.length));
            return;
        }

        const entries: Array<{ index: number; direction: number; order: number }> = [];
        signals.forEach((signal, order) => {
            const index = timeIndex.get(toTimeKey(signal.time));
            if (index === undefined) return;
            const direction = signal.type === "buy" ? 1 : -1;
            entries.push({ index, direction, order });
        });

        if (entries.length === 0) {
            states.push(new Int8Array(data.length));
            return;
        }

        entries.sort((a, b) => a.index - b.index || a.order - b.order);

        const state = new Int8Array(data.length);
        let current = 0;
        let cursor = 0;
        for (let i = 0; i < data.length; i++) {
            while (cursor < entries.length && entries[cursor].index === i) {
                current = entries[cursor].direction;
                cursor += 1;
            }
            state[i] = current;
        }
        states.push(state);
    });

    return states;
}

function filterSignalsWithConfirmationsBoth(
    data: OHLCVData[],
    signals: Signal[],
    confirmationStates: Int8Array[],
    tradeFilterMode: TradeFilterMode
): Signal[] {
    if (confirmationStates.length === 0 || signals.length === 0) return signals;

    const timeIndex = getTimeIndex(data);
    const useCloseConfirm = tradeFilterMode === "close";
    const filtered: Signal[] = [];

    for (const signal of signals) {
        const signalIndex = timeIndex.get(toTimeKey(signal.time));
        if (signalIndex === undefined) {
            filtered.push(signal);
            continue;
        }

        const entryIndex = useCloseConfirm ? signalIndex + 1 : signalIndex;
        if (entryIndex >= data.length) continue;

        const requiredState = signal.type === "buy" ? 1 : -1;
        let confirmed = true;
        for (const state of confirmationStates) {
            if (state[entryIndex] !== requiredState) {
                confirmed = false;
                break;
            }
        }

        if (confirmed) {
            filtered.push(signal);
        }
    }

    return filtered;
}

function filterSignalsWithConfirmationsDirectional(
    data: OHLCVData[],
    signals: Signal[],
    confirmationStates: Int8Array[],
    tradeFilterMode: TradeFilterMode,
    tradeDirection: TradeDirection
): Signal[] {
    if (tradeDirection === "both" || tradeDirection === "combined") {
        return filterSignalsWithConfirmationsBoth(data, signals, confirmationStates, tradeFilterMode);
    }
    if (confirmationStates.length === 0 || signals.length === 0) return signals;

    const timeIndex = getTimeIndex(data);
    const entryType: Signal["type"] = tradeDirection === "short" ? "sell" : "buy";
    const requiredState = tradeDirection === "short" ? -1 : 1;
    const useCloseConfirm = tradeFilterMode === "close";
    const filtered: Signal[] = [];

    for (const signal of signals) {
        if (signal.type !== entryType) {
            filtered.push(signal);
            continue;
        }

        const signalIndex = timeIndex.get(toTimeKey(signal.time));
        if (signalIndex === undefined) {
            filtered.push(signal);
            continue;
        }

        const entryIndex = useCloseConfirm ? signalIndex + 1 : signalIndex;
        if (entryIndex >= data.length) continue;

        let confirmed = true;
        for (const state of confirmationStates) {
            if (state[entryIndex] !== requiredState) {
                confirmed = false;
                break;
            }
        }

        if (confirmed) {
            filtered.push(signal);
        }
    }

    return filtered;
}

function applyConfirmationFilters(
    data: OHLCVData[],
    signals: Signal[],
    settings: BacktestSettings,
    strategyRole: StrategyRole | undefined
): Signal[] {
    const confirmationStrategies = Array.isArray(settings.confirmationStrategies)
        ? settings.confirmationStrategies
            .filter((value): value is string => typeof value === "string" && value.trim() !== "")
            .slice(0, 5)
        : [];

    if (confirmationStrategies.length === 0 || signals.length === 0) {
        return signals;
    }

    const confirmationStates = buildConfirmationStates(
        data,
        confirmationStrategies,
        settings,
        settings.confirmationStrategyParams
    );
    if (confirmationStates.length === 0) {
        return signals;
    }

    const tradeDirection = normalizeTradeDirection(settings);
    const tradeFilterMode = resolveTradeFilterMode(settings);
    const useBothFilter = strategyRole === "entry"
        || tradeDirection === "both"
        || tradeDirection === "combined";

    if (useBothFilter) {
        return filterSignalsWithConfirmationsBoth(data, signals, confirmationStates, tradeFilterMode);
    }

    return filterSignalsWithConfirmationsDirectional(
        data,
        signals,
        confirmationStates,
        tradeFilterMode,
        tradeDirection
    );
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
    const filteredSignals = applyConfirmationFilters(
        request.candles,
        rawSignals,
        settings,
        strategy.metadata?.role
    );
    const preparedSignals = prepareSignalsForScanner(
        request.candles,
        filteredSignals,
        settings
    );
    const tradeDirection = normalizeTradeDirection(settings);
    const entrySignals = preparedSignals.filter((signal) =>
        allowsSignalAsEntry(signal.type, tradeDirection)
    );

    const backtestResult = runBacktest(
        request.candles,
        filteredSignals,
        10000,
        100,
        0,
        settings
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

    const { trade: latestTrade, entryTimeSec: signalTimeSec } = latestExecutedEntry;
    const direction: "long" | "short" = latestTrade.type;
    const matchedPreparedSignal = findPreparedSignalForTradeEntry(
        entrySignals,
        direction,
        signalTimeSec,
        latestTrade.entryPrice
    );
    const latestSignal: Signal = matchedPreparedSignal ?? {
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

    const latestEntry: EvaluatedEntrySignal = {
        strategyKey: request.strategyKey,
        strategyName: strategy.name,
        signal: latestSignal,
        direction,
        signalTimeSec,
        signalAgeBars,
        isFresh: signalAgeBars <= maxAge,
        fingerprint: buildSignalFingerprint(
            request.strategyKey,
            direction,
            signalTimeSec,
            latestSignal.price
        ),
    };

    return {
        ok: true,
        rawSignalCount: rawSignals.length,
        preparedSignalCount: preparedSignals.length,
        latestEntry,
        latestTrade: {
            entryTimeSec: signalTimeSec,
            exitReason: latestTrade.exitReason ?? null,
            isOpen: latestTrade.exitReason === "end_of_data",
        },
    };
}
