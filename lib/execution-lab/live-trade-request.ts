import type {
    ExecutionLabBaseRecord,
    ExecutionLabLiveUiConfig,
    ExecutionLabOpenPaperPosition,
    ExecutionLabResolvedLiveConfig,
    LiveCancelAllRequestRecord,
    LiveCancelAllResultRecord,
    LiveCancelAllSubmitRequest,
    LiveCancelAllSubmitResponse,
    LiveCancelAllSubmitStatus,
    LiveCancelScope,
    LiveEntrySubmitRequest,
    LiveLimitOrderType,
    LiveExitRequestRecord,
    LiveExitResultRecord,
    LiveExitSubmitRequest,
    LiveTakeProfitSubmitRequest,
    ExecutionLabSessionSnapshot,
    LiveOrderMode,
    LiveTakerOrderType,
    LiveTradeSizingMode,
    LiveTradeRequestRecord,
    LiveTradeResultRecord,
    LiveTradeSubmitRequestBase,
    LiveTradeSubmitRequest,
    LiveTradeSubmitResponse,
    LiveTradeSubmitStatus,
} from "./execution-lab-model";

export const LIVE_TRADE_DEFAULT_ORDER_MODE: LiveOrderMode = "taker";
export const LIVE_TRADE_DEFAULT_ORDER_TYPE: LiveTakerOrderType = "FAK";
export const LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE: LiveLimitOrderType = "GTC";
export const LIVE_TRADE_DEFAULT_SIZING_MODE: LiveTradeSizingMode = "fixed";
export const LIVE_TRADE_DEFAULT_MAX_STAKE_USD = 100;
export const LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS = 1;
export const LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS = 5;
export const LIVE_TRADE_DEFAULT_LIMIT_OFFSET_ENABLED = false;
export const LIVE_TRADE_DEFAULT_LIMIT_OFFSET_CENTS = 0;
export const LIVE_TRADE_DEFAULT_LIMIT_CANCEL_ALL_ON_EXIT_ENABLED = false;
export const LIVE_TRADE_REQUEST_TTL_SEC = 10;
export const LIVE_TRADE_MAX_EXPIRY_WINDOW_SEC = 30;
const LIVE_TRADE_SHARE_EPSILON = 0.000001;
const LIVE_TRADE_DEFAULT_LIMIT_TICK_SIZE = 0.01;

const LIVE_TRADE_STATUSES = new Set<LiveTradeSubmitStatus>([
    "dry_run",
    "rejected",
    "posted_live",
    "matched",
    "delayed",
    "partial",
    "duplicate",
    "failed",
]);

const LIVE_CANCEL_ALL_STATUSES = new Set<LiveCancelAllSubmitStatus>([
    "dry_run",
    "submitted",
    "partial",
    "duplicate",
    "rejected",
    "failed",
]);

const LIVE_TRADE_GEOBLOCK_REASONS = new Set(["geoblocked", "geoblock_check_failed"]);

export function isLiveTradeGeoblockReason(reason: string | undefined): boolean {
    return reason !== undefined && LIVE_TRADE_GEOBLOCK_REASONS.has(reason);
}

export function shouldAttemptLiveExitAfterLimitCancel(
    response: Pick<LiveCancelAllSubmitResponse, "status" | "reason" | "canceledCount">
): boolean {
    return response.status === "rejected"
        && response.reason === "not_canceled"
        && (response.canceledCount ?? 0) === 0;
}

export const EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG: ExecutionLabLiveUiConfig = {
    orderMode: LIVE_TRADE_DEFAULT_ORDER_MODE,
    takerOrderType: LIVE_TRADE_DEFAULT_ORDER_TYPE,
    sizingMode: LIVE_TRADE_DEFAULT_SIZING_MODE,
    maxStakeUsd: LIVE_TRADE_DEFAULT_MAX_STAKE_USD,
    entryMaxSlippageCents: LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS,
    exitMaxSlippageCents: LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS,
    limitOffsetEnabled: LIVE_TRADE_DEFAULT_LIMIT_OFFSET_ENABLED,
    limitOffsetCents: LIVE_TRADE_DEFAULT_LIMIT_OFFSET_CENTS,
    limitCancelAllOnExitEnabled: LIVE_TRADE_DEFAULT_LIMIT_CANCEL_ALL_ON_EXIT_ENABLED,
};

type LiveRecordContext = {
    dryRun?: boolean;
    sizingMode?: LiveTradeSizingMode;
    latencyMs?: number;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function finiteNumber(value: unknown): number | null {
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric : null;
}

function finiteNonNegativeNumber(value: unknown): number | null {
    const numeric = finiteNumber(value);
    return numeric !== null && numeric >= 0 ? numeric : null;
}

function finitePositiveNumber(value: unknown): number | null {
    const numeric = finiteNumber(value);
    return numeric !== null && numeric > 0 ? numeric : null;
}

function finiteBoolean(value: unknown, fallback: boolean): boolean {
    return typeof value === "boolean" ? value : fallback;
}

function normalizeCents(value: unknown, fallback: number): number {
    const numeric = finiteNumber(value);
    return numeric !== null && numeric >= 0 ? Math.round(numeric * 100) / 100 : fallback;
}

function normalizeUsd(value: unknown, fallback: number): number {
    const numeric = finiteNumber(value);
    return numeric !== null && numeric > 0 ? Math.round(numeric * 100) / 100 : fallback;
}

export function isLiveOrderMode(value: unknown): value is LiveOrderMode {
    return value === "taker" || value === "limit";
}

export function isLiveTakerOrderType(value: unknown): value is LiveTakerOrderType {
    return value === "FOK" || value === "FAK";
}

export function isLiveSizingMode(value: unknown): value is LiveTradeSizingMode {
    return value === "fixed" || value === "exchange_min";
}

export function isLiveCancelScope(value: unknown): value is LiveCancelScope {
    return value === "account"
        || value === "market"
        || value === "token"
        || value === "session"
        || value === "unknown";
}

export function normalizeExecutionLabLiveUiConfig(
    value: unknown,
    fallback: ExecutionLabLiveUiConfig = EXECUTION_LAB_DEFAULT_LIVE_UI_CONFIG
): ExecutionLabLiveUiConfig {
    const record = isPlainObject(value) ? value : {};
    return {
        orderMode: isLiveOrderMode(record.orderMode) ? record.orderMode : fallback.orderMode,
        takerOrderType: isLiveTakerOrderType(record.takerOrderType) ? record.takerOrderType : fallback.takerOrderType,
        sizingMode: isLiveSizingMode(record.sizingMode) ? record.sizingMode : fallback.sizingMode,
        maxStakeUsd: normalizeUsd(record.maxStakeUsd, fallback.maxStakeUsd),
        entryMaxSlippageCents: normalizeCents(record.entryMaxSlippageCents, fallback.entryMaxSlippageCents),
        exitMaxSlippageCents: normalizeCents(record.exitMaxSlippageCents, fallback.exitMaxSlippageCents),
        limitOffsetEnabled: finiteBoolean(record.limitOffsetEnabled, fallback.limitOffsetEnabled),
        limitOffsetCents: normalizeCents(record.limitOffsetCents, fallback.limitOffsetCents),
        limitCancelAllOnExitEnabled: finiteBoolean(
            record.limitCancelAllOnExitEnabled,
            fallback.limitCancelAllOnExitEnabled
        ),
    };
}

function hasExplicitFilledShares(response: { filledShares?: number }): boolean {
    return response.filledShares !== undefined && Number.isFinite(response.filledShares);
}

export function resolveLiveTradeFilledShares(response: {
    status: string;
    filledShares?: number;
    submittedShares?: number;
}): number | null {
    if (hasExplicitFilledShares(response)) {
        return finiteNonNegativeNumber(response.filledShares);
    }
    const submittedShares = finitePositiveNumber(response.submittedShares);
    if (response.status === "matched" && submittedShares !== null) {
        return submittedShares;
    }
    return null;
}

export function resolveLiveExitShareUpdate(args: {
    remainingShares: number;
    response: {
        status: string;
        submittedShares?: number;
        filledShares?: number;
    };
    minRemainingShares?: number;
}): {
    filledShares: number | null;
    remainingShares: number;
    closePosition: boolean;
} {
    const currentRemainingShares = Math.max(0, args.remainingShares);
    const minRemainingShares = Math.max(0, args.minRemainingShares ?? LIVE_TRADE_SHARE_EPSILON);
    const explicitFilledShares = hasExplicitFilledShares(args.response);
    const filledShares = resolveLiveTradeFilledShares(args.response);

    if (filledShares === null) {
        return {
            filledShares: null,
            remainingShares: currentRemainingShares,
            closePosition: args.response.status === "matched" && !explicitFilledShares,
        };
    }

    const submittedShares = finitePositiveNumber(args.response.submittedShares);
    const filledSubmittedShares = explicitFilledShares
        && submittedShares !== null
        && filledShares >= submittedShares - LIVE_TRADE_SHARE_EPSILON;
    const remainingShares = filledSubmittedShares
        ? 0
        : Math.max(0, currentRemainingShares - filledShares);

    return {
        filledShares,
        remainingShares,
        closePosition: remainingShares <= minRemainingShares
            || filledSubmittedShares
            || (args.response.status === "matched" && !explicitFilledShares),
    };
}

export function resolveLiveExitFloorPreflight(args: {
    currentBid?: number | null;
    minPrice: number;
}): { shouldSubmit: true } | { shouldSubmit: false; reason: "price_moved_below_floor" } {
    if (args.currentBid === null || args.currentBid === undefined) {
        return { shouldSubmit: true };
    }
    const currentBid = finiteNumber(args.currentBid);
    if (currentBid === null) {
        return { shouldSubmit: true };
    }
    return currentBid >= args.minPrice - LIVE_TRADE_SHARE_EPSILON
        ? { shouldSubmit: true }
        : { shouldSubmit: false, reason: "price_moved_below_floor" };
}

function isIsoTimestamp(value: string): boolean {
    return Number.isFinite(Date.parse(value));
}

function hashParts(parts: readonly string[]): string {
    let hash = 0x811c9dc5;
    const text = parts.join("|");
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

function baseRecord(snapshot: ExecutionLabSessionSnapshot, recordedAtIso: string): ExecutionLabBaseRecord {
    return {
        recordType: "",
        sessionId: snapshot.sessionId,
        recordedAtIso,
        symbol: snapshot.symbol,
        interval: "1s",
        strategyKey: snapshot.strategyKey,
    };
}

export function buildLiveTradeRequestId(args: {
    sessionId: string;
    paperTradeId: string;
    tokenId: string;
    entryTimeSec: number;
}): string {
    return `live:${args.sessionId}:${hashParts([
        args.paperTradeId,
        args.tokenId,
        String(Math.floor(args.entryTimeSec)),
    ])}`;
}

export function resolveLiveEntryMaxPrice(args: {
    entryPrice: number;
    maxEntrySlippageCents?: number;
}): number {
    const entryPrice = finitePositiveNumber(args.entryPrice) ?? 0.01;
    const maxEntrySlippageCents = Number.isFinite(args.maxEntrySlippageCents)
        ? Math.max(0, args.maxEntrySlippageCents ?? LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS)
        : LIVE_TRADE_DEFAULT_ENTRY_MAX_SLIPPAGE_CENTS;
    return Math.max(0.01, Math.min(1, Number((entryPrice + (maxEntrySlippageCents / 100)).toFixed(4))));
}

export function resolveLiveLimitEntryPrice(args: {
    referencePrice: number;
    offsetEnabled?: boolean;
    offsetCents?: number;
    tickSize?: number;
}): number {
    const referencePrice = finitePositiveNumber(args.referencePrice) ?? 0.01;
    const offsetCents = args.offsetEnabled
        ? Math.max(0, finiteNumber(args.offsetCents) ?? LIVE_TRADE_DEFAULT_LIMIT_OFFSET_CENTS)
        : 0;
    const tickSize = finitePositiveNumber(args.tickSize) ?? LIVE_TRADE_DEFAULT_LIMIT_TICK_SIZE;
    const rawPrice = Math.max(0.01, Math.min(1, referencePrice - (offsetCents / 100)));
    const rounded = Math.floor((rawPrice + Number.EPSILON) / tickSize) * tickSize;
    return Math.max(0.01, Math.min(1, Number(rounded.toFixed(4))));
}

export function resolveLiveTakeProfitLimitPrice(args: {
    entryPrice: number;
    takeProfitCents: number;
    tickSize?: number;
}): number | null {
    const entryPrice = finitePositiveNumber(args.entryPrice);
    const takeProfitCents = finitePositiveNumber(args.takeProfitCents);
    if (entryPrice === null || takeProfitCents === null) return null;
    const tickSize = finitePositiveNumber(args.tickSize) ?? LIVE_TRADE_DEFAULT_LIMIT_TICK_SIZE;
    const rawPrice = entryPrice + (takeProfitCents / 100);
    if (rawPrice > 1) return null;
    const rounded = Math.ceil((rawPrice - Number.EPSILON) / tickSize) * tickSize;
    return Math.max(0.01, Math.min(1, Number(rounded.toFixed(4))));
}

export function buildLiveTradeSubmitRequest(args: {
    snapshot: ExecutionLabSessionSnapshot;
    position: ExecutionLabOpenPaperPosition;
    createdAtIso: string;
    nowSec: number;
    liveConfig?: ExecutionLabLiveUiConfig;
    orderType?: LiveTakerOrderType;
    limitOrderType?: LiveLimitOrderType;
    limitTickSize?: number;
    maxEntrySlippageCents?: number;
}): LiveEntrySubmitRequest {
    const liveConfig = normalizeExecutionLabLiveUiConfig(args.liveConfig);
    const tokenId = args.position.side === "yes"
        ? args.position.yesTokenId
        : args.position.noTokenId;
    const common = {
        action: "entry",
        requestId: buildLiveTradeRequestId({
            sessionId: args.snapshot.sessionId,
            paperTradeId: args.position.tradeId,
            tokenId,
            entryTimeSec: args.position.entryTimeSec,
        }),
        sessionId: args.snapshot.sessionId,
        paperTradeId: args.position.tradeId,
        createdAtIso: args.createdAtIso,
        expiresAtSec: Math.floor(args.nowSec) + LIVE_TRADE_REQUEST_TTL_SEC,
        symbol: args.snapshot.outcomeSymbol,
        strategyKey: args.snapshot.strategyKey,
        eventStartTs: args.position.eventStartTs,
        eventEndTs: args.position.eventEndTs,
        marketSlug: args.position.marketSlug,
        conditionId: args.position.conditionId,
        tokenId,
        side: args.position.side,
        stakeUsd: args.position.stakeUsd,
        signalTimeSec: args.position.signalTimeSec,
        entryTimeSec: args.position.entryTimeSec,
    } satisfies LiveTradeSubmitRequestBase & { action: "entry" };

    if (liveConfig.orderMode === "limit") {
        const limitPrice = resolveLiveLimitEntryPrice({
            referencePrice: args.position.entryPrice,
            offsetEnabled: liveConfig.limitOffsetEnabled,
            offsetCents: liveConfig.limitOffsetCents,
            tickSize: args.limitTickSize,
        });
        return {
            ...common,
            orderMode: "limit",
            orderType: args.limitOrderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE,
            limitReferencePrice: args.position.entryPrice,
            maxPrice: limitPrice,
            limitPrice,
            limitOffsetEnabled: liveConfig.limitOffsetEnabled,
            limitOffsetCents: liveConfig.limitOffsetCents,
        };
    }

    return {
        ...common,
        orderMode: "taker",
        maxPrice: resolveLiveEntryMaxPrice({
            entryPrice: args.position.entryPrice,
            maxEntrySlippageCents: args.maxEntrySlippageCents ?? liveConfig.entryMaxSlippageCents,
        }),
        orderType: args.orderType ?? liveConfig.takerOrderType,
    };
}

export function buildLiveTakeProfitRequestId(args: {
    sessionId: string;
    entryRequestId: string;
    paperTradeId: string;
    limitPrice: number;
}): string {
    return `live-tp:${args.sessionId}:${hashParts([
        args.entryRequestId,
        args.paperTradeId,
        String(Number(args.limitPrice).toFixed(4)),
    ])}`;
}

export function buildLiveTakeProfitSubmitRequest(args: {
    snapshot: ExecutionLabSessionSnapshot;
    entryRequestId: string;
    paperTradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: "yes" | "no";
    shares: number;
    signalTimeSec: number;
    entryTimeSec: number;
    entryPrice: number;
    takeProfitCents: number;
    createdAtIso: string;
    nowSec: number;
    orderType?: LiveLimitOrderType;
    limitTickSize?: number;
}): LiveTakeProfitSubmitRequest | null {
    const limitPrice = resolveLiveTakeProfitLimitPrice({
        entryPrice: args.entryPrice,
        takeProfitCents: args.takeProfitCents,
        tickSize: args.limitTickSize,
    });
    const shares = finitePositiveNumber(args.shares);
    if (limitPrice === null || shares === null) return null;
    const exitTimeSec = Math.floor(args.nowSec);
    return {
        action: "take_profit",
        requestId: buildLiveTakeProfitRequestId({
            sessionId: args.snapshot.sessionId,
            entryRequestId: args.entryRequestId,
            paperTradeId: args.paperTradeId,
            limitPrice,
        }),
        sessionId: args.snapshot.sessionId,
        paperTradeId: args.paperTradeId,
        entryRequestId: args.entryRequestId,
        createdAtIso: args.createdAtIso,
        expiresAtSec: exitTimeSec + LIVE_TRADE_REQUEST_TTL_SEC,
        symbol: args.snapshot.outcomeSymbol,
        strategyKey: args.snapshot.strategyKey,
        eventStartTs: args.eventStartTs,
        eventEndTs: args.eventEndTs,
        marketSlug: args.marketSlug,
        conditionId: args.conditionId,
        tokenId: args.tokenId,
        side: args.side,
        stakeUsd: Math.max(0.01, shares * limitPrice),
        signalTimeSec: args.signalTimeSec,
        entryTimeSec: args.entryTimeSec,
        orderMode: "limit",
        orderType: args.orderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE,
        maxPrice: limitPrice,
        limitPrice,
        limitReferencePrice: args.entryPrice,
        shares,
        exitTimeSec,
        minPrice: limitPrice,
    };
}

export function buildLiveExitRequestId(args: {
    sessionId: string;
    entryRequestId: string;
    paperTradeId: string;
    exitTimeSec: number;
    attempt?: number;
}): string {
    return `live-exit:${args.sessionId}:${hashParts([
        args.entryRequestId,
        args.paperTradeId,
        String(Math.floor(args.exitTimeSec)),
        String(Math.max(1, Math.floor(args.attempt ?? 1))),
    ])}`;
}

export function buildLiveExitSubmitRequest(args: {
    snapshot: ExecutionLabSessionSnapshot;
    entryRequestId: string;
    paperTradeId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    tokenId: string;
    side: "yes" | "no";
    shares: number;
    signalTimeSec: number;
    entryTimeSec: number;
    exitTimeSec: number;
    paperExitPrice: number;
    liveEntryPrice?: number;
    attempt?: number;
    maxExitSlippageCents?: number;
    createdAtIso: string;
    nowSec: number;
    orderType?: LiveTakerOrderType;
}): LiveExitSubmitRequest {
    const maxExitSlippageCents = Number.isFinite(args.maxExitSlippageCents)
        ? Math.max(0, args.maxExitSlippageCents ?? LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS)
        : LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS;
    const liveEntryPrice = finitePositiveNumber(args.liveEntryPrice);
    const floorReferencePrice = liveEntryPrice === null
        ? args.paperExitPrice
        : Math.min(args.paperExitPrice, liveEntryPrice);
    const minPrice = Math.max(0.01, Math.min(1, floorReferencePrice - (maxExitSlippageCents / 100)));
    const shares = Math.max(0, args.shares);
    return {
        action: "exit",
        requestId: buildLiveExitRequestId({
            sessionId: args.snapshot.sessionId,
            entryRequestId: args.entryRequestId,
            paperTradeId: args.paperTradeId,
            exitTimeSec: args.exitTimeSec,
            attempt: args.attempt,
        }),
        sessionId: args.snapshot.sessionId,
        paperTradeId: args.paperTradeId,
        entryRequestId: args.entryRequestId,
        createdAtIso: args.createdAtIso,
        expiresAtSec: Math.floor(args.nowSec) + LIVE_TRADE_REQUEST_TTL_SEC,
        symbol: args.snapshot.outcomeSymbol,
        strategyKey: args.snapshot.strategyKey,
        eventStartTs: args.eventStartTs,
        eventEndTs: args.eventEndTs,
        marketSlug: args.marketSlug,
        conditionId: args.conditionId,
        tokenId: args.tokenId,
        side: args.side,
        stakeUsd: Math.max(0.01, shares * minPrice),
        signalTimeSec: args.signalTimeSec,
        entryTimeSec: args.entryTimeSec,
        orderMode: "taker",
        maxPrice: minPrice,
        orderType: args.orderType ?? LIVE_TRADE_DEFAULT_ORDER_TYPE,
        shares,
        exitTimeSec: Math.floor(args.exitTimeSec),
        minPrice,
        attempt: Math.max(1, Math.floor(args.attempt ?? 1)),
    };
}

export function buildLiveTradeRequestRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: LiveEntrySubmitRequest | LiveTakeProfitSubmitRequest,
    recordedAtIso: string,
    context: LiveRecordContext = {}
): LiveTradeRequestRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_trade_request",
        action: request.action,
        requestId: request.requestId,
        paperTradeId: request.paperTradeId,
        entryRequestId: request.action === "take_profit" ? request.entryRequestId : undefined,
        expiresAtSec: request.expiresAtSec,
        eventStartTs: request.eventStartTs,
        eventEndTs: request.eventEndTs,
        marketSlug: request.marketSlug,
        conditionId: request.conditionId,
        tokenId: request.tokenId,
        side: request.side,
        stakeUsd: request.stakeUsd,
        signalTimeSec: request.signalTimeSec,
        entryTimeSec: request.entryTimeSec,
        shares: request.action === "take_profit" ? request.shares : undefined,
        exitTimeSec: request.action === "take_profit" ? request.exitTimeSec : undefined,
        orderMode: request.orderMode,
        orderType: request.orderType,
        maxPrice: request.maxPrice,
        minPrice: request.action === "take_profit" ? request.minPrice : undefined,
        limitPrice: request.orderMode === "limit" ? request.limitPrice : undefined,
        limitReferencePrice: request.orderMode === "limit" ? request.limitReferencePrice : undefined,
        limitOffsetEnabled: request.action === "entry" && request.orderMode === "limit" ? request.limitOffsetEnabled : undefined,
        limitOffsetCents: request.action === "entry" && request.orderMode === "limit" ? request.limitOffsetCents : undefined,
        dryRun: context.dryRun,
        sizingMode: context.sizingMode,
    };
}

export function buildLiveTradeResultRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: Pick<LiveTradeSubmitRequest, "requestId" | "paperTradeId" | "action">,
    response: LiveTradeSubmitResponse,
    recordedAtIso: string,
    context: LiveRecordContext = {}
): LiveTradeResultRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_trade_result",
        action: request.action === "take_profit" ? "take_profit" : "entry",
        requestId: request.requestId,
        paperTradeId: request.paperTradeId,
        status: response.status,
        reason: response.reason,
        orderId: response.orderId,
        orderStatus: response.orderStatus,
        orderSuccess: response.orderSuccess,
        submittedPrice: response.submittedPrice,
        submittedShares: response.submittedShares,
        submittedNotionalUsd: response.submittedNotionalUsd,
        filledShares: response.filledShares,
        currentAsk: response.currentAsk,
        maxPrice: response.maxPrice,
        limitPrice: response.limitPrice,
        limitReferencePrice: response.limitReferencePrice,
        limitOffsetEnabled: response.limitOffsetEnabled,
        limitOffsetCents: response.limitOffsetCents,
        minPrice: response.minPrice,
        currentBid: response.currentBid,
        latencyMs: context.latencyMs,
    };
}

export function buildLiveExitRequestRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: LiveExitSubmitRequest,
    recordedAtIso: string,
    context: LiveRecordContext = {}
): LiveExitRequestRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_exit_request",
        requestId: request.requestId,
        entryRequestId: request.entryRequestId,
        paperTradeId: request.paperTradeId,
        expiresAtSec: request.expiresAtSec,
        eventStartTs: request.eventStartTs,
        eventEndTs: request.eventEndTs,
        marketSlug: request.marketSlug,
        conditionId: request.conditionId,
        tokenId: request.tokenId,
        side: request.side,
        shares: request.shares,
        exitTimeSec: request.exitTimeSec,
        minPrice: request.minPrice,
        orderMode: request.orderMode,
        orderType: request.orderType,
        attempt: request.attempt,
        dryRun: context.dryRun,
        sizingMode: context.sizingMode,
    };
}

export function buildLiveExitResultRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: Pick<LiveExitSubmitRequest, "requestId" | "entryRequestId" | "paperTradeId">,
    response: LiveTradeSubmitResponse,
    recordedAtIso: string,
    context: LiveRecordContext = {}
): LiveExitResultRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_exit_result",
        requestId: request.requestId,
        entryRequestId: request.entryRequestId,
        paperTradeId: request.paperTradeId,
        status: response.status,
        reason: response.reason,
        orderId: response.orderId,
        orderStatus: response.orderStatus,
        orderSuccess: response.orderSuccess,
        submittedPrice: response.submittedPrice,
        submittedShares: response.submittedShares,
        submittedNotionalUsd: response.submittedNotionalUsd,
        filledShares: response.filledShares,
        currentBid: response.currentBid,
        minPrice: response.minPrice,
        latencyMs: context.latencyMs,
    };
}

export function buildLiveCancelAllRequestId(args: {
    sessionId: string;
    exitTriggerKey: string;
}): string {
    return `live-cancel:${args.sessionId}:${hashParts([args.exitTriggerKey])}`;
}

export function buildLiveCancelAllRequestRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: LiveCancelAllSubmitRequest,
    recordedAtIso: string,
    context: LiveRecordContext = {}
): LiveCancelAllRequestRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_cancel_all_request",
        requestId: request.requestId,
        paperTradeId: request.paperTradeId,
        exitTriggerKey: request.exitTriggerKey,
        marketSlug: request.marketSlug,
        conditionId: request.conditionId,
        tokenId: request.tokenId,
        orderIds: request.orderIds,
        scope: request.scope,
        reason: request.reason,
        orderMode: request.orderMode,
        dryRun: context.dryRun,
    };
}

export function buildLiveCancelAllResultRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: Pick<LiveCancelAllSubmitRequest, "requestId" | "paperTradeId">,
    response: LiveCancelAllSubmitResponse,
    recordedAtIso: string,
    context: LiveRecordContext = {}
): LiveCancelAllResultRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_cancel_all_result",
        requestId: request.requestId,
        paperTradeId: request.paperTradeId,
        status: response.status,
        reason: response.reason,
        scope: response.scope,
        canceledOrderIds: response.canceledOrderIds,
        canceledCount: response.canceledCount,
        latencyMs: context.latencyMs,
    };
}

export function buildLiveTradeFailureResponse(args: {
    requestId: string;
    status?: LiveTradeSubmitStatus;
    reason: string;
    maxPrice?: number;
    currentAsk?: number;
    limitPrice?: number;
    limitReferencePrice?: number;
    limitOffsetEnabled?: boolean;
    limitOffsetCents?: number;
    minPrice?: number;
    currentBid?: number;
}): LiveTradeSubmitResponse {
    return {
        ok: true,
        requestId: args.requestId,
        status: args.status ?? "failed",
        reason: args.reason,
        maxPrice: args.maxPrice,
        currentAsk: args.currentAsk,
        limitPrice: args.limitPrice,
        limitReferencePrice: args.limitReferencePrice,
        limitOffsetEnabled: args.limitOffsetEnabled,
        limitOffsetCents: args.limitOffsetCents,
        minPrice: args.minPrice,
        currentBid: args.currentBid,
    };
}

export function buildLiveCancelAllFailureResponse(args: {
    requestId: string;
    scope: LiveCancelScope;
    status?: LiveCancelAllSubmitStatus;
    reason: string;
}): LiveCancelAllSubmitResponse {
    return {
        ok: true,
        requestId: args.requestId,
        status: args.status ?? "failed",
        reason: args.reason,
        scope: args.scope,
    };
}

export function normalizeLiveTradeSubmitResponse(
    value: unknown,
    expectedRequestId?: string
): { ok: true; response: LiveTradeSubmitResponse } | { ok: false; error: string } {
    if (!isPlainObject(value)) return { ok: false, error: "executor stdout must be a JSON object" };
    if (value.ok !== true) return { ok: false, error: "executor response ok must be true" };
    const requestId = nonEmptyString(value.requestId);
    if (!requestId) return { ok: false, error: "executor response requestId is required" };
    if (expectedRequestId && requestId !== expectedRequestId) {
        return { ok: false, error: "executor response requestId mismatch" };
    }
    if (typeof value.status !== "string" || !LIVE_TRADE_STATUSES.has(value.status as LiveTradeSubmitStatus)) {
        return { ok: false, error: "executor response status is invalid" };
    }

    const reason = value.reason !== undefined ? String(value.reason) : undefined;
    const status = value.status as LiveTradeSubmitStatus;
    const response: LiveTradeSubmitResponse = {
        ok: true,
        requestId,
        status: status === "failed" && isLiveTradeGeoblockReason(reason) ? "rejected" : status,
    };
    if (reason !== undefined) response.reason = reason;
    if (value.orderId !== undefined) response.orderId = String(value.orderId);
    if (value.orderStatus !== undefined) response.orderStatus = String(value.orderStatus);
    if (value.orderSuccess !== undefined) response.orderSuccess = value.orderSuccess === true;

    for (const key of [
        "submittedPrice",
        "submittedShares",
        "submittedNotionalUsd",
        "filledShares",
        "maxPrice",
        "currentAsk",
        "limitPrice",
        "limitReferencePrice",
        "limitOffsetCents",
        "minPrice",
        "currentBid",
        "minOrderSize",
        "minTickSize",
    ] as const) {
        const numeric = finiteNumber(value[key]);
        if (numeric !== null) response[key] = numeric;
    }
    if (value.limitOffsetEnabled !== undefined) response.limitOffsetEnabled = value.limitOffsetEnabled === true;
    if (
        response.status === "matched"
        && hasExplicitFilledShares(response)
        && finitePositiveNumber(response.submittedShares) !== null
        && (response.filledShares ?? 0) < (response.submittedShares ?? 0) - LIVE_TRADE_SHARE_EPSILON
    ) {
        response.status = "partial";
    }

    return { ok: true, response };
}

export function normalizeLiveCancelAllSubmitResponse(
    value: unknown,
    expectedRequestId?: string
): { ok: true; response: LiveCancelAllSubmitResponse } | { ok: false; error: string } {
    if (!isPlainObject(value)) return { ok: false, error: "executor stdout must be a JSON object" };
    if (value.ok !== true) return { ok: false, error: "executor response ok must be true" };
    const requestId = nonEmptyString(value.requestId);
    if (!requestId) return { ok: false, error: "executor response requestId is required" };
    if (expectedRequestId && requestId !== expectedRequestId) {
        return { ok: false, error: "executor response requestId mismatch" };
    }
    if (typeof value.status !== "string" || !LIVE_CANCEL_ALL_STATUSES.has(value.status as LiveCancelAllSubmitStatus)) {
        return { ok: false, error: "executor response status is invalid" };
    }
    const scope = isLiveCancelScope(value.scope) ? value.scope : "unknown";
    const response: LiveCancelAllSubmitResponse = {
        ok: true,
        requestId,
        status: value.status as LiveCancelAllSubmitStatus,
        scope,
    };
    if (value.reason !== undefined) response.reason = String(value.reason);
    if (Array.isArray(value.canceledOrderIds)) {
        response.canceledOrderIds = value.canceledOrderIds.map((item) => String(item)).filter((item) => item.length > 0);
    }
    const canceledCount = finiteNonNegativeNumber(value.canceledCount);
    if (canceledCount !== null) response.canceledCount = Math.floor(canceledCount);
    return { ok: true, response };
}

export function validateLiveTradeSubmitRequest(
    value: unknown,
    options: {
        nowSec?: number;
        maxStakeUsd: number;
        sizingMode?: LiveTradeSizingMode;
        orderMode?: LiveOrderMode;
        takerOrderType?: LiveTakerOrderType;
        supportedTakerOrderTypes?: readonly LiveTakerOrderType[];
        supportedLimitOrderType?: LiveLimitOrderType | null;
        maxExpiryWindowSec?: number;
    }
): { ok: true; request: LiveTradeSubmitRequest } | { ok: false; error: string } {
    if (!isPlainObject(value)) return { ok: false, error: "request must be an object" };
    const action = value.action === undefined ? "entry" : value.action;
    if (action !== "entry" && action !== "exit" && action !== "take_profit") {
        return { ok: false, error: "action must be entry, take_profit, or exit" };
    }
    const requestId = nonEmptyString(value.requestId);
    const sessionId = nonEmptyString(value.sessionId);
    const paperTradeId = nonEmptyString(value.paperTradeId);
    const symbol = nonEmptyString(value.symbol);
    const strategyKey = nonEmptyString(value.strategyKey);
    const marketSlug = nonEmptyString(value.marketSlug);
    const conditionId = nonEmptyString(value.conditionId);
    const tokenId = nonEmptyString(value.tokenId);
    if (!requestId || !sessionId || !paperTradeId || !symbol || !strategyKey || !marketSlug || !conditionId || !tokenId) {
        return { ok: false, error: "request identity fields are required" };
    }

    const createdAtIso = nonEmptyString(value.createdAtIso);
    if (!createdAtIso || !isIsoTimestamp(createdAtIso)) {
        return { ok: false, error: "createdAtIso is invalid" };
    }
    if (value.side !== "yes" && value.side !== "no") return { ok: false, error: "side must be yes or no" };
    const orderMode = isLiveOrderMode(value.orderMode) ? value.orderMode : "taker";

    const nowSec = Math.floor(options.nowSec ?? Date.now() / 1000);
    const maxWindow = options.maxExpiryWindowSec ?? LIVE_TRADE_MAX_EXPIRY_WINDOW_SEC;
    const stakeUsd = finiteNumber(value.stakeUsd);
    const expiresAtSec = finiteNumber(value.expiresAtSec);
    const eventStartTs = finiteNumber(value.eventStartTs);
    const eventEndTs = finiteNumber(value.eventEndTs);
    const signalTimeSec = finiteNumber(value.signalTimeSec);
    const entryTimeSec = finiteNumber(value.entryTimeSec);

    if (
        stakeUsd === null
        || stakeUsd <= 0
        || (action === "entry" && options.sizingMode !== "exchange_min" && stakeUsd > options.maxStakeUsd)
    ) {
        return { ok: false, error: "stakeUsd is outside the configured live cap" };
    }
    if (expiresAtSec === null || expiresAtSec <= nowSec || expiresAtSec > nowSec + maxWindow) {
        return { ok: false, error: "expiresAtSec must be in the near future" };
    }
    if (
        eventStartTs === null
        || eventEndTs === null
        || signalTimeSec === null
        || entryTimeSec === null
        || eventEndTs <= eventStartTs
    ) {
        return { ok: false, error: "event and signal times must be finite unix seconds" };
    }
    if (entryTimeSec < eventStartTs || entryTimeSec >= eventEndTs) {
        return { ok: false, error: "entryTimeSec must be inside the event window" };
    }

    if (action === "take_profit") {
        if (orderMode !== "limit") return { ok: false, error: "take-profit must use limit order mode" };
        if (value.orderType !== (options.supportedLimitOrderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE)) {
            return { ok: false, error: "orderType does not match resolved limit order type" };
        }
        const entryRequestId = nonEmptyString(value.entryRequestId);
        const shares = finiteNumber(value.shares);
        const exitTimeSec = finiteNumber(value.exitTimeSec);
        const maxPrice = finiteNumber(value.maxPrice);
        const minPrice = finiteNumber(value.minPrice);
        const limitPrice = finiteNumber(value.limitPrice);
        const limitReferencePrice = finiteNumber(value.limitReferencePrice);
        if (!entryRequestId) return { ok: false, error: "entryRequestId is required for take-profit" };
        if (shares === null || shares <= 0) return { ok: false, error: "shares must be positive for take-profit" };
        if (maxPrice === null || maxPrice <= 0 || maxPrice > 1) return { ok: false, error: "maxPrice must be in (0, 1]" };
        if (minPrice === null || minPrice <= 0 || minPrice > 1) return { ok: false, error: "minPrice must be in (0, 1]" };
        if (limitPrice === null || limitPrice <= 0 || limitPrice > 1) {
            return { ok: false, error: "limitPrice must be in (0, 1]" };
        }
        if (Math.abs(maxPrice - limitPrice) > 0.000000001) {
            return { ok: false, error: "maxPrice must match limitPrice for take-profit" };
        }
        if (Math.abs(minPrice - limitPrice) > 0.000000001) {
            return { ok: false, error: "minPrice must match limitPrice for take-profit" };
        }
        if (limitReferencePrice === null || limitReferencePrice <= 0 || limitReferencePrice > 1) {
            return { ok: false, error: "limitReferencePrice must be in (0, 1]" };
        }
        if (exitTimeSec === null || exitTimeSec < eventStartTs || exitTimeSec >= eventEndTs) {
            return { ok: false, error: "exitTimeSec must be inside the event window" };
        }
        return {
            ok: true,
            request: {
                action: "take_profit",
                requestId,
                sessionId,
                paperTradeId,
                entryRequestId,
                createdAtIso,
                expiresAtSec: Math.floor(expiresAtSec),
                symbol,
                strategyKey,
                eventStartTs: Math.floor(eventStartTs),
                eventEndTs: Math.floor(eventEndTs),
                marketSlug,
                conditionId,
                tokenId,
                side: value.side,
                stakeUsd,
                signalTimeSec: Math.floor(signalTimeSec),
                entryTimeSec: Math.floor(entryTimeSec),
                orderMode: "limit",
                orderType: options.supportedLimitOrderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE,
                maxPrice,
                limitPrice,
                limitReferencePrice,
                shares,
                exitTimeSec: Math.floor(exitTimeSec),
                minPrice,
            },
        };
    }

    if (action === "exit") {
        if (orderMode !== "taker") return { ok: false, error: "live exits must use taker order mode" };
        if (!isLiveTakerOrderType(value.orderType)) {
            return { ok: false, error: "orderType must be FOK or FAK for taker exits" };
        }
        if (options.takerOrderType && value.orderType !== options.takerOrderType) {
            return { ok: false, error: "orderType does not match resolved taker order type" };
        }
        const entryRequestId = nonEmptyString(value.entryRequestId);
        const shares = finiteNumber(value.shares);
        const exitTimeSec = finiteNumber(value.exitTimeSec);
        const maxPrice = finiteNumber(value.maxPrice);
        const minPrice = finiteNumber(value.minPrice);
        const attempt = value.attempt === undefined ? undefined : finitePositiveNumber(value.attempt);
        if (!entryRequestId) return { ok: false, error: "entryRequestId is required for exits" };
        if (shares === null || shares <= 0) return { ok: false, error: "shares must be positive for exits" };
        if (maxPrice === null || maxPrice <= 0 || maxPrice > 1) return { ok: false, error: "maxPrice must be in (0, 1]" };
        if (minPrice === null || minPrice <= 0 || minPrice > 1) return { ok: false, error: "minPrice must be in (0, 1]" };
        if (value.attempt !== undefined && attempt === null) return { ok: false, error: "attempt must be positive for exits" };
        if (exitTimeSec === null || exitTimeSec < eventStartTs || exitTimeSec >= eventEndTs) {
            return { ok: false, error: "exitTimeSec must be inside the event window" };
        }
        const normalizedAttempt = attempt === undefined || attempt === null ? undefined : Math.floor(attempt);
        return {
            ok: true,
            request: {
                action: "exit",
                requestId,
                sessionId,
                paperTradeId,
                entryRequestId,
                createdAtIso,
                expiresAtSec: Math.floor(expiresAtSec),
                symbol,
                strategyKey,
                eventStartTs: Math.floor(eventStartTs),
                eventEndTs: Math.floor(eventEndTs),
                marketSlug,
                conditionId,
                tokenId,
                side: value.side,
                stakeUsd,
                signalTimeSec: Math.floor(signalTimeSec),
                entryTimeSec: Math.floor(entryTimeSec),
                orderMode: "taker",
                maxPrice,
                orderType: value.orderType,
                shares,
                exitTimeSec: Math.floor(exitTimeSec),
                minPrice,
                attempt: normalizedAttempt,
            },
        };
    }

    if (options.orderMode && orderMode !== options.orderMode) {
        return { ok: false, error: "orderMode does not match resolved live config" };
    }

    if (orderMode === "limit") {
        if (value.orderType !== (options.supportedLimitOrderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE)) {
            return { ok: false, error: "orderType does not match resolved limit order type" };
        }
        const maxPrice = finiteNumber(value.maxPrice);
        const limitPrice = finiteNumber(value.limitPrice);
        const limitReferencePrice = finiteNumber(value.limitReferencePrice);
        const limitOffsetEnabled = typeof value.limitOffsetEnabled === "boolean"
            ? value.limitOffsetEnabled
            : false;
        const limitOffsetCents = finiteNonNegativeNumber(value.limitOffsetCents);
        if (maxPrice === null || maxPrice <= 0 || maxPrice > 1) {
            return { ok: false, error: "maxPrice must be in (0, 1] for limit entries" };
        }
        if (limitPrice === null || limitPrice <= 0 || limitPrice > 1) {
            return { ok: false, error: "limitPrice must be in (0, 1]" };
        }
        if (Math.abs(maxPrice - limitPrice) > 0.000000001) {
            return { ok: false, error: "maxPrice must match limitPrice for limit entries" };
        }
        if (limitReferencePrice === null || limitReferencePrice <= 0 || limitReferencePrice > 1) {
            return { ok: false, error: "limitReferencePrice must be in (0, 1]" };
        }
        if (limitOffsetCents === null) return { ok: false, error: "limitOffsetCents must be non-negative" };
        return {
            ok: true,
            request: {
                action: "entry",
                requestId,
                sessionId,
                paperTradeId,
                createdAtIso,
                expiresAtSec: Math.floor(expiresAtSec),
                symbol,
                strategyKey,
                eventStartTs: Math.floor(eventStartTs),
                eventEndTs: Math.floor(eventEndTs),
                marketSlug,
                conditionId,
                tokenId,
                side: value.side,
                stakeUsd,
                signalTimeSec: Math.floor(signalTimeSec),
                entryTimeSec: Math.floor(entryTimeSec),
                orderMode: "limit",
                orderType: options.supportedLimitOrderType ?? LIVE_TRADE_DEFAULT_LIMIT_ORDER_TYPE,
                maxPrice,
                limitPrice,
                limitReferencePrice,
                limitOffsetEnabled,
                limitOffsetCents,
            },
        };
    }

    if (!isLiveTakerOrderType(value.orderType)) {
        return { ok: false, error: "orderType must be FOK or FAK for taker entries" };
    }
    const supportedTakerOrderTypes = options.supportedTakerOrderTypes ?? ["FOK", "FAK"];
    if (!supportedTakerOrderTypes.includes(value.orderType)) {
        return { ok: false, error: "orderType is not supported" };
    }
    if (options.takerOrderType && value.orderType !== options.takerOrderType) {
        return { ok: false, error: "orderType does not match resolved taker order type" };
    }
    const maxPrice = finiteNumber(value.maxPrice);
    if (maxPrice === null || maxPrice <= 0 || maxPrice > 1) return { ok: false, error: "maxPrice must be in (0, 1]" };
    return {
        ok: true,
        request: {
            action: "entry",
            requestId,
            sessionId,
            paperTradeId,
            createdAtIso,
            expiresAtSec: Math.floor(expiresAtSec),
            symbol,
            strategyKey,
            eventStartTs: Math.floor(eventStartTs),
            eventEndTs: Math.floor(eventEndTs),
            marketSlug,
            conditionId,
            tokenId,
            side: value.side,
            stakeUsd,
            signalTimeSec: Math.floor(signalTimeSec),
            entryTimeSec: Math.floor(entryTimeSec),
            orderMode: "taker",
            maxPrice,
            orderType: value.orderType,
        },
    };
}

export function validateLiveCancelAllSubmitRequest(
    value: unknown,
    options: {
        resolvedConfig?: Pick<ExecutionLabResolvedLiveConfig, "orderMode" | "cancelScope" | "limitCancelAllOnExitEnabled">;
    } = {}
): { ok: true; request: LiveCancelAllSubmitRequest } | { ok: false; error: string } {
    if (!isPlainObject(value)) return { ok: false, error: "request must be an object" };
    if (value.action !== "cancel_all") return { ok: false, error: "action must be cancel_all" };
    const requestId = nonEmptyString(value.requestId);
    const sessionId = nonEmptyString(value.sessionId);
    const exitTriggerKey = nonEmptyString(value.exitTriggerKey);
    const createdAtIso = nonEmptyString(value.createdAtIso);
    const symbol = nonEmptyString(value.symbol);
    const strategyKey = nonEmptyString(value.strategyKey);
    if (!requestId || !sessionId || !exitTriggerKey || !createdAtIso || !symbol || !strategyKey) {
        return { ok: false, error: "cancel request identity fields are required" };
    }
    if (!isIsoTimestamp(createdAtIso)) return { ok: false, error: "createdAtIso is invalid" };
    if (value.orderMode !== "limit") return { ok: false, error: "cancel-all is limit-mode only" };
    if (options.resolvedConfig?.orderMode && options.resolvedConfig.orderMode !== "limit") {
        return { ok: false, error: "resolved live config is not limit mode" };
    }
    const scope = isLiveCancelScope(value.scope) ? value.scope : "unknown";
    const orderIds = Array.isArray(value.orderIds)
        ? value.orderIds.map((item) => String(item).trim()).filter((item) => item.length > 0)
        : undefined;
    const isTargetedSessionCancel = scope === "session" && orderIds !== undefined && orderIds.length > 0;
    if (options.resolvedConfig && !options.resolvedConfig.limitCancelAllOnExitEnabled && !isTargetedSessionCancel) {
        return { ok: false, error: "limit cancel-all-on-exit is disabled" };
    }
    if (options.resolvedConfig?.cancelScope === "unknown" && !isTargetedSessionCancel) {
        return { ok: false, error: "cancel scope must be configured" };
    }
    if (scope === "unknown") return { ok: false, error: "cancel scope must be configured" };
    if (options.resolvedConfig?.cancelScope && !isTargetedSessionCancel && scope !== options.resolvedConfig.cancelScope) {
        return { ok: false, error: "cancel scope does not match resolved live config" };
    }
    if (value.reason !== "limit_exit_signal") return { ok: false, error: "cancel reason is invalid" };
    const paperTradeId = nonEmptyString(value.paperTradeId);
    const marketSlug = nonEmptyString(value.marketSlug);
    const conditionId = nonEmptyString(value.conditionId);
    const tokenId = nonEmptyString(value.tokenId);
    if (scope === "session" && (!orderIds || orderIds.length === 0)) {
        return { ok: false, error: "session cancel requires orderIds" };
    }
    return {
        ok: true,
        request: {
            action: "cancel_all",
            requestId,
            sessionId,
            paperTradeId: paperTradeId ?? undefined,
            exitTriggerKey,
            createdAtIso,
            symbol,
            strategyKey,
            marketSlug: marketSlug ?? undefined,
            conditionId: conditionId ?? undefined,
            tokenId: tokenId ?? undefined,
            orderIds,
            scope,
            reason: "limit_exit_signal",
            orderMode: "limit",
        },
    };
}
