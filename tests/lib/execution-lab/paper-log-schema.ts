import type { ExecutionLabRecord } from "./execution-lab-model";

const VALID_RECORD_TYPES = new Set([
    "session_start",
    "signal_seen",
    "paper_entry",
    "live_trade_request",
    "live_trade_result",
    "live_exit_request",
    "live_exit_result",
    "live_cancel_all_request",
    "live_cancel_all_result",
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

function isValidIsoDate(value: string): boolean {
    return Number.isFinite(Date.parse(value));
}

function isPriceInRange(value: unknown, min: number): value is number {
    return isFiniteNumber(value) && value >= min && value <= 1;
}

function isLiveTradeStatus(value: unknown): boolean {
    return value === "dry_run"
        || value === "rejected"
        || value === "posted_live"
        || value === "matched"
        || value === "delayed"
        || value === "partial"
        || value === "duplicate"
        || value === "failed";
}

function isLiveSizingMode(value: unknown): boolean {
    return value === "fixed" || value === "exchange_min";
}

function isLiveOrderMode(value: unknown): boolean {
    return value === "taker" || value === "limit";
}

function isLiveTakerOrderType(value: unknown): boolean {
    return value === "FOK" || value === "FAK";
}

function isLiveLimitOrderType(value: unknown): boolean {
    return value === "GTC";
}

function isLiveCancelScope(value: unknown): boolean {
    return value === "account"
        || value === "market"
        || value === "token"
        || value === "session"
        || value === "unknown";
}

function isLiveCancelStatus(value: unknown): boolean {
    return value === "dry_run"
        || value === "submitted"
        || value === "partial"
        || value === "duplicate"
        || value === "rejected"
        || value === "failed";
}

function validateOptionalLiveMeta(value: Record<string, unknown>): { ok: true } | { ok: false; error: string } {
    if (value.expiresAtSec !== undefined && !isFiniteNumber(value.expiresAtSec)) {
        return { ok: false, error: "expiresAtSec is invalid" };
    }
    if (value.attempt !== undefined && (!isFiniteNumber(value.attempt) || value.attempt <= 0)) {
        return { ok: false, error: "attempt is invalid" };
    }
    if (value.sizingMode !== undefined && !isLiveSizingMode(value.sizingMode)) {
        return { ok: false, error: "sizingMode is invalid" };
    }
    if (value.dryRun !== undefined && typeof value.dryRun !== "boolean") {
        return { ok: false, error: "dryRun is invalid" };
    }
    if (value.latencyMs !== undefined && (!isFiniteNumber(value.latencyMs) || value.latencyMs < 0)) {
        return { ok: false, error: "latencyMs is invalid" };
    }
    return { ok: true };
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
    if (!isNonEmptyString(value.recordedAtIso) || !isValidIsoDate(value.recordedAtIso)) {
        return { ok: false, error: "recordedAtIso is invalid" };
    }
    if (!isNonEmptyString(value.symbol)) return { ok: false, error: "symbol is required" };
    if (value.interval !== "1s") return { ok: false, error: "interval must be 1s" };
    if (!isNonEmptyString(value.strategyKey)) return { ok: false, error: "strategyKey is required" };

    switch (value.recordType) {
        case "session_start":
            if (!isFiniteNumber(value.stakeUsd) || value.stakeUsd <= 0) return { ok: false, error: "stakeUsd is required" };
            break;
        case "signal_seen":
            if (!isFiniteNumber(value.signalTimeSec)) return { ok: false, error: "signalTimeSec is required" };
            if (value.signalType !== "buy" && value.signalType !== "sell") return { ok: false, error: "invalid signalType" };
            break;
        case "paper_entry":
            if (!isNonEmptyString(value.tradeId)) return { ok: false, error: "tradeId is required" };
            if (value.side !== "yes" && value.side !== "no") return { ok: false, error: "invalid side" };
            if (!isPriceInRange(value.entryPrice, 0.000000001)) return { ok: false, error: "entryPrice is required" };
            break;
        case "live_trade_request":
            {
                const liveMeta = validateOptionalLiveMeta(value);
                if (!liveMeta.ok) return liveMeta;
            }
            if (value.action !== undefined && value.action !== "entry" && value.action !== "take_profit") {
                return { ok: false, error: "invalid live trade action" };
            }
            if (!isNonEmptyString(value.requestId)) return { ok: false, error: "requestId is required" };
            if (!isNonEmptyString(value.paperTradeId)) return { ok: false, error: "paperTradeId is required" };
            if (!isNonEmptyString(value.marketSlug)) return { ok: false, error: "marketSlug is required" };
            if (!isNonEmptyString(value.conditionId)) return { ok: false, error: "conditionId is required" };
            if (!isNonEmptyString(value.tokenId)) return { ok: false, error: "tokenId is required" };
            if (value.side !== "yes" && value.side !== "no") return { ok: false, error: "invalid side" };
            if (!isLiveOrderMode(value.orderMode)) return { ok: false, error: "invalid orderMode" };
            if (value.orderMode === "taker" && !isLiveTakerOrderType(value.orderType)) return { ok: false, error: "invalid orderType" };
            if (value.orderMode === "limit" && !isLiveLimitOrderType(value.orderType)) return { ok: false, error: "invalid orderType" };
            if (!isFiniteNumber(value.stakeUsd) || value.stakeUsd <= 0) return { ok: false, error: "stakeUsd is required" };
            if (value.orderMode === "taker" && !isPriceInRange(value.maxPrice, 0.000000001)) {
                return { ok: false, error: "maxPrice is required" };
            }
            if (value.orderMode === "limit" && !isPriceInRange(value.limitPrice, 0.000000001)) {
                return { ok: false, error: "limitPrice is required" };
            }
            if (value.orderMode === "limit" && !isPriceInRange(value.limitReferencePrice, 0.000000001)) {
                return { ok: false, error: "limitReferencePrice is required" };
            }
            if (value.limitOffsetEnabled !== undefined && typeof value.limitOffsetEnabled !== "boolean") {
                return { ok: false, error: "limitOffsetEnabled is invalid" };
            }
            if (value.limitOffsetCents !== undefined && (!isFiniteNumber(value.limitOffsetCents) || value.limitOffsetCents < 0)) {
                return { ok: false, error: "limitOffsetCents is invalid" };
            }
            if (value.limitFixedPriceEnabled !== undefined && typeof value.limitFixedPriceEnabled !== "boolean") {
                return { ok: false, error: "limitFixedPriceEnabled is invalid" };
            }
            if (value.limitFixedPriceCents !== undefined && (!isFiniteNumber(value.limitFixedPriceCents) || value.limitFixedPriceCents <= 0 || value.limitFixedPriceCents > 100)) {
                return { ok: false, error: "limitFixedPriceCents is invalid" };
            }
            if (value.action === "take_profit") {
                if (!isNonEmptyString(value.entryRequestId)) return { ok: false, error: "entryRequestId is required" };
                if (!isFiniteNumber(value.shares) || value.shares <= 0) return { ok: false, error: "shares is required" };
                if (!isPriceInRange(value.minPrice, 0.000000001)) return { ok: false, error: "minPrice is required" };
            }
            break;
        case "live_trade_result":
            {
                const liveMeta = validateOptionalLiveMeta(value);
                if (!liveMeta.ok) return liveMeta;
            }
            if (value.action !== undefined && value.action !== "entry" && value.action !== "take_profit") {
                return { ok: false, error: "invalid live trade action" };
            }
            if (!isNonEmptyString(value.requestId)) return { ok: false, error: "requestId is required" };
            if (!isNonEmptyString(value.paperTradeId)) return { ok: false, error: "paperTradeId is required" };
            if (!isLiveTradeStatus(value.status)) return { ok: false, error: "invalid live trade status" };
            if (value.reason !== undefined && typeof value.reason !== "string") return { ok: false, error: "invalid live trade reason" };
            if (value.maxPrice !== undefined && !isPriceInRange(value.maxPrice, 0.000000001)) {
                return { ok: false, error: "maxPrice is invalid" };
            }
            if (value.currentAsk !== undefined && !isPriceInRange(value.currentAsk, 0.000000001)) {
                return { ok: false, error: "currentAsk is invalid" };
            }
            if (value.limitPrice !== undefined && !isPriceInRange(value.limitPrice, 0.000000001)) {
                return { ok: false, error: "limitPrice is invalid" };
            }
            if (value.limitReferencePrice !== undefined && !isPriceInRange(value.limitReferencePrice, 0.000000001)) {
                return { ok: false, error: "limitReferencePrice is invalid" };
            }
            if (value.limitOffsetEnabled !== undefined && typeof value.limitOffsetEnabled !== "boolean") {
                return { ok: false, error: "limitOffsetEnabled is invalid" };
            }
            if (value.limitOffsetCents !== undefined && (!isFiniteNumber(value.limitOffsetCents) || value.limitOffsetCents < 0)) {
                return { ok: false, error: "limitOffsetCents is invalid" };
            }
            if (value.limitFixedPriceEnabled !== undefined && typeof value.limitFixedPriceEnabled !== "boolean") {
                return { ok: false, error: "limitFixedPriceEnabled is invalid" };
            }
            if (value.limitFixedPriceCents !== undefined && (!isFiniteNumber(value.limitFixedPriceCents) || value.limitFixedPriceCents <= 0 || value.limitFixedPriceCents > 100)) {
                return { ok: false, error: "limitFixedPriceCents is invalid" };
            }
            if (value.minPrice !== undefined && !isPriceInRange(value.minPrice, 0.000000001)) {
                return { ok: false, error: "minPrice is invalid" };
            }
            if (value.currentBid !== undefined && !isPriceInRange(value.currentBid, 0.000000001)) {
                return { ok: false, error: "currentBid is invalid" };
            }
            break;
        case "live_exit_request":
            {
                const liveMeta = validateOptionalLiveMeta(value);
                if (!liveMeta.ok) return liveMeta;
            }
            if (!isNonEmptyString(value.requestId)) return { ok: false, error: "requestId is required" };
            if (!isNonEmptyString(value.entryRequestId)) return { ok: false, error: "entryRequestId is required" };
            if (!isNonEmptyString(value.paperTradeId)) return { ok: false, error: "paperTradeId is required" };
            if (!isNonEmptyString(value.marketSlug)) return { ok: false, error: "marketSlug is required" };
            if (!isNonEmptyString(value.conditionId)) return { ok: false, error: "conditionId is required" };
            if (!isNonEmptyString(value.tokenId)) return { ok: false, error: "tokenId is required" };
            if (value.side !== "yes" && value.side !== "no") return { ok: false, error: "invalid side" };
            if (value.orderMode !== "taker") return { ok: false, error: "invalid orderMode" };
            if (!isLiveTakerOrderType(value.orderType)) return { ok: false, error: "invalid orderType" };
            if (!isFiniteNumber(value.shares) || value.shares <= 0) return { ok: false, error: "shares is required" };
            if (!isPriceInRange(value.minPrice, 0.000000001)) return { ok: false, error: "minPrice is required" };
            break;
        case "live_exit_result":
            {
                const liveMeta = validateOptionalLiveMeta(value);
                if (!liveMeta.ok) return liveMeta;
            }
            if (!isNonEmptyString(value.requestId)) return { ok: false, error: "requestId is required" };
            if (!isNonEmptyString(value.entryRequestId)) return { ok: false, error: "entryRequestId is required" };
            if (!isNonEmptyString(value.paperTradeId)) return { ok: false, error: "paperTradeId is required" };
            if (!isLiveTradeStatus(value.status)) return { ok: false, error: "invalid live trade status" };
            if (value.reason !== undefined && typeof value.reason !== "string") return { ok: false, error: "invalid live trade reason" };
            if (value.minPrice !== undefined && !isPriceInRange(value.minPrice, 0.000000001)) {
                return { ok: false, error: "minPrice is invalid" };
            }
            if (value.currentBid !== undefined && !isPriceInRange(value.currentBid, 0.000000001)) {
                return { ok: false, error: "currentBid is invalid" };
            }
            break;
        case "live_cancel_all_request":
            {
                const liveMeta = validateOptionalLiveMeta(value);
                if (!liveMeta.ok) return liveMeta;
            }
            if (!isNonEmptyString(value.requestId)) return { ok: false, error: "requestId is required" };
            if (!isNonEmptyString(value.exitTriggerKey)) return { ok: false, error: "exitTriggerKey is required" };
            if (value.paperTradeId !== undefined && typeof value.paperTradeId !== "string") return { ok: false, error: "paperTradeId is invalid" };
            if (value.marketSlug !== undefined && typeof value.marketSlug !== "string") return { ok: false, error: "marketSlug is invalid" };
            if (value.conditionId !== undefined && typeof value.conditionId !== "string") return { ok: false, error: "conditionId is invalid" };
            if (value.tokenId !== undefined && typeof value.tokenId !== "string") return { ok: false, error: "tokenId is invalid" };
            if (
                value.orderIds !== undefined
                && (
                    !Array.isArray(value.orderIds)
                    || value.orderIds.some((item) => typeof item !== "string" || item.length === 0)
                )
            ) {
                return { ok: false, error: "orderIds is invalid" };
            }
            if (!isLiveCancelScope(value.scope)) return { ok: false, error: "scope is invalid" };
            if (value.reason !== "limit_exit_signal") return { ok: false, error: "reason is invalid" };
            if (value.orderMode !== "limit") return { ok: false, error: "orderMode is invalid" };
            break;
        case "live_cancel_all_result":
            {
                const liveMeta = validateOptionalLiveMeta(value);
                if (!liveMeta.ok) return liveMeta;
            }
            if (!isNonEmptyString(value.requestId)) return { ok: false, error: "requestId is required" };
            if (value.paperTradeId !== undefined && typeof value.paperTradeId !== "string") return { ok: false, error: "paperTradeId is invalid" };
            if (!isLiveCancelStatus(value.status)) return { ok: false, error: "invalid cancel status" };
            if (value.reason !== undefined && typeof value.reason !== "string") return { ok: false, error: "invalid cancel reason" };
            if (!isLiveCancelScope(value.scope)) return { ok: false, error: "scope is invalid" };
            if (value.canceledOrderIds !== undefined && !Array.isArray(value.canceledOrderIds)) {
                return { ok: false, error: "canceledOrderIds is invalid" };
            }
            if (value.canceledCount !== undefined && (!isFiniteNumber(value.canceledCount) || value.canceledCount < 0)) {
                return { ok: false, error: "canceledCount is invalid" };
            }
            break;
        case "paper_unfilled":
            if (!isNonEmptyString(value.reason)) return { ok: false, error: "reason is required" };
            if (value.entryPrice !== undefined && !isPriceInRange(value.entryPrice, 0)) {
                return { ok: false, error: "entryPrice is invalid" };
            }
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
                && value.exitReason !== "polymarket_take_profit"
                && value.exitReason !== "polymarket_stop_loss"
                && value.exitReason !== "resolution"
            ) {
                return { ok: false, error: "invalid exitReason" };
            }
            if (!isPriceInRange(value.exitPrice, 0)) return { ok: false, error: "exitPrice is required" };
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
                && value.mismatchType !== "late_paper_execution"
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
