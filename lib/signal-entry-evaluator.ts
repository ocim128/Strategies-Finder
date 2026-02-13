import type { BacktestSettings, OHLCVData, Signal } from "./types/strategies";
import { strategies } from "./strategies/library";
import { prepareSignalsForScanner } from "./strategies/backtest/signal-preparation";
import { allowsSignalAsEntry, normalizeTradeDirection } from "./strategies/backtest/backtest-utils";

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
}

function toUnixSeconds(value: OHLCVData["time"]): number | null {
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null;
        // Normalize ms timestamps to seconds.
        return value > 9_999_999_999 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === "string") {
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
    }
    if (value && typeof value === "object" && "year" in value) {
        const day = value as { year: number; month: number; day: number };
        return Math.floor(Date.UTC(day.year, day.month - 1, day.day) / 1000);
    }
    return null;
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
        };
    }

    if (request.candles.length < 2) {
        return {
            ok: false,
            reason: "insufficient_data",
            rawSignalCount: 0,
            preparedSignalCount: 0,
            latestEntry: null,
        };
    }

    const mergedParams = { ...strategy.defaultParams, ...(request.strategyParams ?? {}) };
    const rawSignals = strategy.execute(request.candles, mergedParams);
    const preparedSignals = prepareSignalsForScanner(
        request.candles,
        rawSignals,
        request.backtestSettings ?? {}
    );
    const tradeDirection = normalizeTradeDirection(request.backtestSettings);
    const entrySignals = preparedSignals.filter((signal) =>
        allowsSignalAsEntry(signal.type, tradeDirection)
    );

    if (entrySignals.length === 0) {
        return {
            ok: true,
            reason: "no_signals",
            rawSignalCount: rawSignals.length,
            preparedSignalCount: preparedSignals.length,
            latestEntry: null,
        };
    }

    const latestSignal = entrySignals[entrySignals.length - 1];
    const signalTimeSec = toUnixSeconds(latestSignal.time);
    if (signalTimeSec === null) {
        return {
            ok: false,
            reason: "signal_time_not_found",
            rawSignalCount: rawSignals.length,
            preparedSignalCount: preparedSignals.length,
            latestEntry: null,
        };
    }

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
        };
    }

    const signalAgeBars = request.candles.length - 1 - signalIndex;
    const maxAge = Math.max(0, Math.floor(request.freshnessBars ?? 1));
    const direction = latestSignal.type === "buy" ? "long" : "short";

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
    };
}
