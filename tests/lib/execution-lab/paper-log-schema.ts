import type { ExecutionLabRecord } from "./execution-lab-model";

const VALID_RECORD_TYPES = new Set([
    "session_start",
    "signal_seen",
    "paper_entry",
    "paper_unfilled",
    "paper_exit",
    "paper_resolution_pending",
    "execution_parity_mismatch",
    "session_stop",
]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
    return typeof value === "string" && value.trim().length > 0;
}

function isFiniteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

export function sanitizeExecutionLabPathPart(value: string): string {
    const normalized = value.trim().toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return normalized || "unknown";
}

export function validateExecutionLabRecord(value: unknown): { ok: true; record: ExecutionLabRecord } | { ok: false; error: string } {
    if (!isPlainObject(value)) return { ok: false, error: "record must be an object" };
    if (!isNonEmptyString(value.recordType) || !VALID_RECORD_TYPES.has(value.recordType)) {
        return { ok: false, error: "invalid recordType" };
    }
    if (!isNonEmptyString(value.sessionId)) return { ok: false, error: "sessionId is required" };
    if (!isNonEmptyString(value.recordedAtIso)) return { ok: false, error: "recordedAtIso is required" };
    if (!isNonEmptyString(value.symbol)) return { ok: false, error: "symbol is required" };
    if (value.interval !== "1s") return { ok: false, error: "interval must be 1s" };
    if (!isNonEmptyString(value.strategyKey)) return { ok: false, error: "strategyKey is required" };

    switch (value.recordType) {
        case "session_start":
            if (!isFiniteNumber(value.stakeUsd)) return { ok: false, error: "stakeUsd is required" };
            break;
        case "signal_seen":
            if (!isFiniteNumber(value.signalTimeSec)) return { ok: false, error: "signalTimeSec is required" };
            if (value.signalType !== "buy" && value.signalType !== "sell") return { ok: false, error: "invalid signalType" };
            break;
        case "paper_entry":
            if (!isNonEmptyString(value.tradeId)) return { ok: false, error: "tradeId is required" };
            if (value.side !== "yes" && value.side !== "no") return { ok: false, error: "invalid side" };
            if (!isFiniteNumber(value.entryPrice) || value.entryPrice <= 0) return { ok: false, error: "entryPrice is required" };
            break;
        case "paper_unfilled":
            if (!isNonEmptyString(value.reason)) return { ok: false, error: "reason is required" };
            break;
        case "paper_exit":
            if (!isNonEmptyString(value.tradeId)) return { ok: false, error: "tradeId is required" };
            if (
                value.exitReason !== "signal"
                && value.exitReason !== "stop_loss"
                && value.exitReason !== "take_profit"
                && value.exitReason !== "trailing_stop"
                && value.exitReason !== "time_stop"
                && value.exitReason !== "probation_fail"
                && value.exitReason !== "resolution"
            ) {
                return { ok: false, error: "invalid exitReason" };
            }
            if (!isFiniteNumber(value.exitPrice)) return { ok: false, error: "exitPrice is required" };
            break;
        case "paper_resolution_pending":
            if (!isNonEmptyString(value.tradeId)) return { ok: false, error: "tradeId is required" };
            break;
        case "execution_parity_mismatch":
            if (!isFiniteNumber(value.latestCandleTimeSec)) return { ok: false, error: "latestCandleTimeSec is required" };
            if (!isNonEmptyString(value.detail)) return { ok: false, error: "detail is required" };
            if (
                value.mismatchType !== "paper_open_after_backtest_exit"
                && value.mismatchType !== "paper_open_after_event_end"
                && value.mismatchType !== "missing_exit_quote"
                && value.mismatchType !== "entry_price_filter_violation"
            ) {
                return { ok: false, error: "invalid mismatchType" };
            }
            break;
        case "session_stop":
            if (value.reason !== "user_stop" && value.reason !== "error") return { ok: false, error: "invalid stop reason" };
            if (value.message !== undefined && typeof value.message !== "string") return { ok: false, error: "invalid stop message" };
            break;
    }

    return { ok: true, record: value as ExecutionLabRecord };
}
