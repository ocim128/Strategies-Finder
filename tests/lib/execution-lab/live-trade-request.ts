import type {
    ExecutionLabBaseRecord,
    ExecutionLabOpenPaperPosition,
    LiveEntrySubmitRequest,
    LiveExitRequestRecord,
    LiveExitResultRecord,
    LiveExitSubmitRequest,
    ExecutionLabSessionSnapshot,
    LiveTradeOrderType,
    LiveTradeSizingMode,
    LiveTradeRequestRecord,
    LiveTradeResultRecord,
    LiveTradeSubmitRequest,
    LiveTradeSubmitResponse,
    LiveTradeSubmitStatus,
} from "./execution-lab-model";

export const LIVE_TRADE_DEFAULT_ORDER_TYPE: LiveTradeOrderType = "FAK";
export const LIVE_TRADE_DEFAULT_EXIT_MAX_SLIPPAGE_CENTS = 5;
export const LIVE_TRADE_REQUEST_TTL_SEC = 10;
export const LIVE_TRADE_MAX_EXPIRY_WINDOW_SEC = 30;
const LIVE_TRADE_SHARE_EPSILON = 0.000001;

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

export function buildLiveTradeSubmitRequest(args: {
    snapshot: ExecutionLabSessionSnapshot;
    position: ExecutionLabOpenPaperPosition;
    createdAtIso: string;
    nowSec: number;
    orderType?: LiveTradeOrderType;
}): LiveEntrySubmitRequest {
    const tokenId = args.position.side === "yes"
        ? args.position.yesTokenId
        : args.position.noTokenId;
    return {
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
        maxPrice: args.position.entryPrice,
        orderType: args.orderType ?? LIVE_TRADE_DEFAULT_ORDER_TYPE,
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
    orderType?: LiveTradeOrderType;
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
        maxPrice: minPrice,
        orderType: args.orderType ?? LIVE_TRADE_DEFAULT_ORDER_TYPE,
        shares,
        exitTimeSec: Math.floor(args.exitTimeSec),
        minPrice,
    };
}

export function buildLiveTradeRequestRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: LiveEntrySubmitRequest,
    recordedAtIso: string
): LiveTradeRequestRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_trade_request",
        requestId: request.requestId,
        paperTradeId: request.paperTradeId,
        eventStartTs: request.eventStartTs,
        eventEndTs: request.eventEndTs,
        marketSlug: request.marketSlug,
        conditionId: request.conditionId,
        tokenId: request.tokenId,
        side: request.side,
        stakeUsd: request.stakeUsd,
        signalTimeSec: request.signalTimeSec,
        entryTimeSec: request.entryTimeSec,
        maxPrice: request.maxPrice,
        orderType: request.orderType,
    };
}

export function buildLiveTradeResultRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: Pick<LiveTradeSubmitRequest, "requestId" | "paperTradeId">,
    response: LiveTradeSubmitResponse,
    recordedAtIso: string
): LiveTradeResultRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_trade_result",
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
    };
}

export function buildLiveExitRequestRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: LiveExitSubmitRequest,
    recordedAtIso: string
): LiveExitRequestRecord {
    return {
        ...baseRecord(snapshot, recordedAtIso),
        recordType: "live_exit_request",
        requestId: request.requestId,
        entryRequestId: request.entryRequestId,
        paperTradeId: request.paperTradeId,
        eventStartTs: request.eventStartTs,
        eventEndTs: request.eventEndTs,
        marketSlug: request.marketSlug,
        conditionId: request.conditionId,
        tokenId: request.tokenId,
        side: request.side,
        shares: request.shares,
        exitTimeSec: request.exitTimeSec,
        minPrice: request.minPrice,
        orderType: request.orderType,
    };
}

export function buildLiveExitResultRecord(
    snapshot: ExecutionLabSessionSnapshot,
    request: Pick<LiveExitSubmitRequest, "requestId" | "entryRequestId" | "paperTradeId">,
    response: LiveTradeSubmitResponse,
    recordedAtIso: string
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
    };
}

export function buildLiveTradeFailureResponse(args: {
    requestId: string;
    status?: LiveTradeSubmitStatus;
    reason: string;
    maxPrice?: number;
    currentAsk?: number;
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
        minPrice: args.minPrice,
        currentBid: args.currentBid,
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

    const response: LiveTradeSubmitResponse = {
        ok: true,
        requestId,
        status: value.status as LiveTradeSubmitStatus,
    };
    if (value.reason !== undefined) response.reason = String(value.reason);
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
        "minPrice",
        "currentBid",
        "minOrderSize",
        "minTickSize",
    ] as const) {
        const numeric = finiteNumber(value[key]);
        if (numeric !== null) response[key] = numeric;
    }
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

export function validateLiveTradeSubmitRequest(
    value: unknown,
    options: {
        nowSec?: number;
        maxStakeUsd: number;
        sizingMode?: LiveTradeSizingMode;
        maxExpiryWindowSec?: number;
    }
): { ok: true; request: LiveTradeSubmitRequest } | { ok: false; error: string } {
    if (!isPlainObject(value)) return { ok: false, error: "request must be an object" };
    const action = value.action === undefined ? "entry" : value.action;
    if (action !== "entry" && action !== "exit") return { ok: false, error: "action must be entry or exit" };
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
    if (value.orderType !== "FOK" && value.orderType !== "FAK") {
        return { ok: false, error: "orderType must be FOK or FAK" };
    }

    const nowSec = Math.floor(options.nowSec ?? Date.now() / 1000);
    const maxWindow = options.maxExpiryWindowSec ?? LIVE_TRADE_MAX_EXPIRY_WINDOW_SEC;
    const stakeUsd = finiteNumber(value.stakeUsd);
    const maxPrice = finiteNumber(value.maxPrice);
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
    if (maxPrice === null || maxPrice <= 0 || maxPrice > 1) return { ok: false, error: "maxPrice must be in (0, 1]" };
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

    if (action === "exit") {
        const entryRequestId = nonEmptyString(value.entryRequestId);
        const shares = finiteNumber(value.shares);
        const exitTimeSec = finiteNumber(value.exitTimeSec);
        const minPrice = finiteNumber(value.minPrice);
        if (!entryRequestId) return { ok: false, error: "entryRequestId is required for exits" };
        if (shares === null || shares <= 0) return { ok: false, error: "shares must be positive for exits" };
        if (minPrice === null || minPrice <= 0 || minPrice > 1) return { ok: false, error: "minPrice must be in (0, 1]" };
        if (exitTimeSec === null || exitTimeSec < eventStartTs || exitTimeSec >= eventEndTs) {
            return { ok: false, error: "exitTimeSec must be inside the event window" };
        }
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
                maxPrice,
                orderType: value.orderType,
                shares,
                exitTimeSec: Math.floor(exitTimeSec),
                minPrice,
            },
        };
    }

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
            maxPrice,
            orderType: value.orderType,
        },
    };
}
