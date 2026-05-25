import { expect } from "chai";
import { describe, it } from "node:test";
import type { ExecutionLabOpenPaperPosition, ExecutionLabSessionSnapshot } from "../lib/execution-lab/execution-lab-model";
import {
    buildLiveExitSubmitRequest,
    buildLiveTakeProfitSubmitRequest,
    buildLiveTradeSubmitRequest,
    isLiveTradeGeoblockReason,
    normalizeLiveTradeSubmitResponse,
    resolveLiveLimitEntryPrice,
    resolveLiveTakeProfitLimitPrice,
    resolveLiveExitFloorPreflight,
    resolveLiveExitShareUpdate,
    resolveLiveTradeFilledShares,
    shouldAttemptLiveExitAfterLimitCancel,
    validateLiveCancelAllSubmitRequest,
    validateLiveTradeSubmitRequest,
} from "../lib/execution-lab/live-trade-request";
import { resolvePolymarketEntryCutoff } from "../lib/polymarket-entry-cutoff";
import type { Trade } from "../lib/types/strategies";

const EVENT_START = 1_700_000_000;
const EVENT_END = EVENT_START + 300;

function snapshot(): ExecutionLabSessionSnapshot {
    return {
        sessionId: "session-1",
        symbol: "BTCUSDT",
        outcomeSymbol: "BTCUSDT",
        interval: "1s",
        strategyKey: "test_strategy",
        strategyName: "Test Strategy",
        params: {},
        backtestSettings: {},
        capitalSettings: {
            initialCapital: 10000,
            positionSize: 100,
            commission: 0,
            sizingMode: "percent",
            fixedTradeAmount: 100,
        },
        polymarketSettings: {},
        outcomeInterval: "5m",
        seriesId: "10684",
        exitMode: "resolve_hold",
        allowMultipleTradesPerEvent: false,
        stakeUsd: 5,
        startedAtIso: "2026-01-01T00:00:00.000Z",
    };
}

function sourceTrade(type: Trade["type"]): Trade {
    return {
        id: 1,
        type,
        entryTime: EVENT_START + 10,
        entryPrice: 100,
        exitTime: EVENT_END,
        exitPrice: 101,
        pnl: 1,
        pnlPercent: 1,
        size: 1,
        exitReason: "end_of_data",
    };
}

function position(side: "yes" | "no"): ExecutionLabOpenPaperPosition {
    return {
        tradeId: `paper-${side}`,
        sourceTrade: sourceTrade(side === "yes" ? "long" : "short"),
        seriesId: "10684",
        eventStartTs: EVENT_START,
        eventEndTs: EVENT_END,
        marketSlug: "btc-event",
        conditionId: "condition",
        yesTokenId: "yes-token",
        noTokenId: "no-token",
        side,
        chartDirection: side === "yes" ? "long" : "short",
        signalTimeSec: EVENT_START + 9,
        entryTimeSec: EVENT_START + 10,
        entryQuoteTs: EVENT_START + 10,
        entryPrice: 0.57,
        stakeUsd: 5,
        shares: 5 / 0.57,
    };
}

describe("Execution Lab live trade request", () => {
    it("builds deterministic YES and NO token requests from accepted paper entries", () => {
        const yes = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: position("yes"),
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
        });
        const yesRepeat = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: position("yes"),
            createdAtIso: "2026-01-01T00:00:02.000Z",
            nowSec: EVENT_START + 12,
        });
        const no = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: position("no"),
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
            orderType: "FOK",
        });

        expect(yes.action).to.equal("entry");
        expect(yes.tokenId).to.equal("yes-token");
        expect(no.tokenId).to.equal("no-token");
        expect(yes.orderMode).to.equal("taker");
        expect(yes.maxPrice).to.equal(0.58);
        expect(yes.orderType).to.equal("FAK");
        expect(no.orderType).to.equal("FOK");
        expect(yes.requestId).to.equal(yesRepeat.requestId);
        expect(no.requestId).to.not.equal(yes.requestId);
    });

    it("applies configured live entry slippage to the paper entry cap", () => {
        const zeroSlippage = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: position("yes"),
            maxEntrySlippageCents: 0,
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
        });
        const clamped = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: { ...position("yes"), entryPrice: 0.99 },
            maxEntrySlippageCents: 5,
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
        });

        expect(zeroSlippage.maxPrice).to.equal(0.57);
        expect(clamped.maxPrice).to.equal(1);
    });

    it("builds limit entries with explicit price offset and executor-compatible max price", () => {
        const request = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: { ...position("yes"), entryPrice: 0.25 },
            liveConfig: {
                orderMode: "limit",
                takerOrderType: "FAK",
                sizingMode: "fixed",
                maxStakeUsd: 100,
                entryMaxSlippageCents: 1,
                exitMaxSlippageCents: 5,
                limitOffsetEnabled: true,
                limitOffsetCents: 6,
                limitFixedPriceEnabled: false,
                limitFixedPriceCents: 20,
                limitCancelAllOnExitEnabled: true,
            },
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
        });

        expect(request.orderMode).to.equal("limit");
        if (request.orderMode === "limit") {
            expect(request.orderType).to.equal("GTC");
            expect(request.limitReferencePrice).to.equal(0.25);
            expect(request.limitPrice).to.equal(0.19);
            expect(request.maxPrice).to.equal(request.limitPrice);
        }
        expect(resolveLiveLimitEntryPrice({
            referencePrice: 0.03,
            offsetEnabled: true,
            offsetCents: 6,
        })).to.equal(0.01);
        expect(resolveLiveLimitEntryPrice({
            referencePrice: 0.256,
        })).to.equal(0.25);
    });

    it("caps live limit entries at the configured fixed limit price without raising lower signals", () => {
        const highSignal = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: { ...position("no"), entryPrice: 0.53 },
            liveConfig: {
                orderMode: "limit",
                takerOrderType: "FAK",
                sizingMode: "exchange_min",
                maxStakeUsd: 100,
                entryMaxSlippageCents: 1,
                exitMaxSlippageCents: 5,
                limitOffsetEnabled: false,
                limitOffsetCents: 0,
                limitFixedPriceEnabled: true,
                limitFixedPriceCents: 20,
                limitCancelAllOnExitEnabled: false,
            },
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
        });
        const lowerSignal = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: { ...position("no"), entryPrice: 0.17 },
            liveConfig: {
                orderMode: "limit",
                takerOrderType: "FAK",
                sizingMode: "exchange_min",
                maxStakeUsd: 100,
                entryMaxSlippageCents: 1,
                exitMaxSlippageCents: 5,
                limitOffsetEnabled: false,
                limitOffsetCents: 0,
                limitFixedPriceEnabled: true,
                limitFixedPriceCents: 20,
                limitCancelAllOnExitEnabled: false,
            },
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
        });

        expect(highSignal.orderMode).to.equal("limit");
        expect(lowerSignal.orderMode).to.equal("limit");
        if (highSignal.orderMode === "limit") {
            expect(highSignal.limitPrice).to.equal(0.20);
            expect(highSignal.maxPrice).to.equal(0.20);
        }
        if (lowerSignal.orderMode === "limit") {
            expect(lowerSignal.limitPrice).to.equal(0.17);
            expect(lowerSignal.maxPrice).to.equal(0.17);
        }
    });

    it("builds and validates resting take-profit sell limits from confirmed entry fills", () => {
        const request = buildLiveTakeProfitSubmitRequest({
            snapshot: snapshot(),
            entryRequestId: "live-entry-1",
            paperTradeId: "paper-yes",
            eventStartTs: EVENT_START,
            eventEndTs: EVENT_END,
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            side: "yes",
            shares: 8.5,
            signalTimeSec: EVENT_START + 9,
            entryTimeSec: EVENT_START + 10,
            entryPrice: 0.57,
            takeProfitCents: 5,
            createdAtIso: "2026-01-01T00:00:12.000Z",
            nowSec: EVENT_START + 12,
        });

        expect(request).to.not.equal(null);
        if (!request) return;
        expect(request.action).to.equal("take_profit");
        expect(request.orderMode).to.equal("limit");
        expect(request.orderType).to.equal("GTC");
        expect(request.limitPrice).to.equal(0.62);
        expect(request.minPrice).to.equal(request.limitPrice);
        expect(request.maxPrice).to.equal(request.limitPrice);
        expect(request.shares).to.equal(8.5);
        expect(resolveLiveTakeProfitLimitPrice({
            entryPrice: 0.575,
            takeProfitCents: 5,
        })).to.equal(0.63);
        expect(buildLiveTakeProfitSubmitRequest({
            ...request,
            snapshot: snapshot(),
            entryRequestId: "live-entry-1",
            paperTradeId: "paper-yes",
            entryPrice: 0.98,
            takeProfitCents: 5,
            createdAtIso: "2026-01-01T00:00:12.000Z",
            nowSec: EVENT_START + 12,
        })).to.equal(null);
        expect(validateLiveTradeSubmitRequest(request, {
            nowSec: EVENT_START + 12,
            maxStakeUsd: 1,
            orderMode: "taker",
            supportedLimitOrderType: "GTC",
        }).ok).to.equal(true);
        expect(validateLiveTradeSubmitRequest({ ...request, orderMode: "taker" }, {
            nowSec: EVENT_START + 12,
            maxStakeUsd: 100,
            supportedLimitOrderType: "GTC",
        }).ok).to.equal(false);
    });

    it("builds and validates live exit requests with a floor below paper exit price", () => {
        const exitArgs = {
            snapshot: snapshot(),
            entryRequestId: "live-entry-1",
            paperTradeId: "paper-yes",
            eventStartTs: EVENT_START,
            eventEndTs: EVENT_END,
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            side: "yes",
            shares: 8.5,
            signalTimeSec: EVENT_START + 9,
            entryTimeSec: EVENT_START + 10,
            exitTimeSec: EVENT_START + 50,
            paperExitPrice: 0.54,
            maxExitSlippageCents: 5,
            createdAtIso: "2026-01-01T00:00:50.000Z",
            nowSec: EVENT_START + 51,
        };
        const request = buildLiveExitSubmitRequest(exitArgs);

        expect(request.action).to.equal("exit");
        expect(request.orderMode).to.equal("taker");
        expect(request.attempt).to.equal(1);
        expect(request.minPrice).to.be.closeTo(0.49, 1e-12);
        expect(request.maxPrice).to.be.closeTo(0.49, 1e-12);
        expect(buildLiveExitSubmitRequest({ ...exitArgs, attempt: 2 }).requestId).to.not.equal(request.requestId);
        expect(buildLiveExitSubmitRequest({ ...exitArgs, attempt: 2 }).attempt).to.equal(2);
        expect(validateLiveTradeSubmitRequest(request, {
            nowSec: EVENT_START + 51,
            maxStakeUsd: 1,
        }).ok).to.equal(true);
        expect(validateLiveTradeSubmitRequest({ ...request, shares: 0 }, {
            nowSec: EVENT_START + 51,
            maxStakeUsd: 10,
        }).ok).to.equal(false);
        expect(validateLiveTradeSubmitRequest({ ...request, attempt: 0 }, {
            nowSec: EVENT_START + 51,
            maxStakeUsd: 10,
        }).ok).to.equal(false);
    });

    it("caps live exit floor by actual live entry price when live fill improves versus paper", () => {
        const request = buildLiveExitSubmitRequest({
            snapshot: snapshot(),
            entryRequestId: "live-entry-1",
            paperTradeId: "paper-yes",
            eventStartTs: EVENT_START,
            eventEndTs: EVENT_END,
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            side: "yes",
            shares: 5.1,
            signalTimeSec: EVENT_START + 9,
            entryTimeSec: EVENT_START + 10,
            exitTimeSec: EVENT_START + 50,
            paperExitPrice: 0.78,
            liveEntryPrice: 0.62,
            maxExitSlippageCents: 5,
            orderType: "FOK",
            createdAtIso: "2026-01-01T00:00:50.000Z",
            nowSec: EVENT_START + 51,
        });

        expect(request.minPrice).to.be.closeTo(0.57, 1e-12);
        expect(request.orderType).to.equal("FOK");
    });

    it("rejects live entries too close to the event close by entry time or current clock", () => {
        expect(resolvePolymarketEntryCutoff({
            entryTimeSec: EVENT_END - 5,
            eventEndTs: EVENT_END,
            currentTimeSec: EVENT_END - 5,
        }).allowed).to.equal(true);

        expect(resolvePolymarketEntryCutoff({
            entryTimeSec: EVENT_END - 20,
            eventEndTs: EVENT_END,
            currentTimeSec: EVENT_END - 20,
            enabled: true,
        }).allowed).to.equal(true);

        expect(resolvePolymarketEntryCutoff({
            entryTimeSec: EVENT_END - 15,
            eventEndTs: EVENT_END,
            currentTimeSec: EVENT_END - 20,
            enabled: true,
        })).to.deep.equal({
            allowed: false,
            secondsToEventEnd: 15,
        });

        expect(resolvePolymarketEntryCutoff({
            entryTimeSec: EVENT_END - 30,
            eventEndTs: EVENT_END,
            currentTimeSec: EVENT_END - 5,
            enabled: true,
        })).to.deep.equal({
            allowed: false,
            secondsToEventEnd: 5,
        });
    });

    it("validates live request freshness, stake cap, event window, and order type", () => {
        const request = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: position("yes"),
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
        });

        expect(validateLiveTradeSubmitRequest(request, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
        }).ok).to.equal(true);
        expect(validateLiveTradeSubmitRequest({ ...request, stakeUsd: 11 }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
        }).ok).to.equal(false);
        expect(validateLiveTradeSubmitRequest({ ...request, stakeUsd: 11 }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
            sizingMode: "exchange_min",
        }).ok).to.equal(true);
        expect(validateLiveTradeSubmitRequest({ ...request, orderType: "GTC" }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
        }).ok).to.equal(false);
        expect(validateLiveTradeSubmitRequest({
            ...request,
            orderMode: "limit",
            orderType: "GTC",
            maxPrice: 0.51,
            limitPrice: 0.51,
            limitReferencePrice: 0.57,
            limitOffsetEnabled: true,
            limitOffsetCents: 6,
            limitFixedPriceEnabled: false,
            limitFixedPriceCents: 20,
        }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
            orderMode: "limit",
            supportedLimitOrderType: "GTC",
        }).ok).to.equal(true);
        expect(validateLiveTradeSubmitRequest({
            ...request,
            orderMode: "limit",
            orderType: "GTC",
            maxPrice: undefined,
            limitPrice: 0.51,
            limitReferencePrice: 0.57,
            limitOffsetEnabled: true,
            limitOffsetCents: 6,
            limitFixedPriceEnabled: false,
            limitFixedPriceCents: 20,
        }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
            orderMode: "limit",
            supportedLimitOrderType: "GTC",
        }).ok).to.equal(false);
        expect(validateLiveTradeSubmitRequest({
            ...request,
            orderMode: "limit",
            orderType: "GTC",
            maxPrice: 0.51,
            limitPrice: 0.51,
            limitReferencePrice: 0.57,
            limitOffsetEnabled: false,
            limitOffsetCents: 0,
            limitFixedPriceEnabled: true,
            limitFixedPriceCents: 20,
        }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
            orderMode: "limit",
            supportedLimitOrderType: "GTC",
        }).ok).to.equal(false);
        expect(validateLiveTradeSubmitRequest({ ...request, entryTimeSec: EVENT_END }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
        }).ok).to.equal(false);
        expect(validateLiveTradeSubmitRequest({ ...request, expiresAtSec: EVENT_START + 42 }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
        }).ok).to.equal(false);
    });

    it("validates targeted session cancel requests with explicit order ids", () => {
        const request = {
            action: "cancel_all",
            requestId: "cancel-1",
            sessionId: "session-1",
            paperTradeId: "paper-1",
            exitTriggerKey: "session-1|event|yes|paper-1|exit",
            createdAtIso: "2026-01-01T00:00:01.000Z",
            symbol: "BTCUSDT",
            strategyKey: "test_strategy",
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            orderIds: [" 0xabc "],
            scope: "session",
            reason: "limit_exit_signal",
            orderMode: "limit",
        };

        const valid = validateLiveCancelAllSubmitRequest(request, {
            resolvedConfig: {
                orderMode: "limit",
                cancelScope: "session",
                limitCancelAllOnExitEnabled: true,
            },
        });

        expect(valid.ok).to.equal(true);
        if (valid.ok) expect(valid.request.orderIds).to.deep.equal(["0xabc"]);
        expect(validateLiveCancelAllSubmitRequest({ ...request, orderIds: [] }, {
            resolvedConfig: {
                orderMode: "limit",
                cancelScope: "session",
                limitCancelAllOnExitEnabled: true,
            },
        }).ok).to.equal(false);
    });

    it("allows targeted pending-order cancels even when broad cancel-on-exit is off", () => {
        const request = {
            action: "cancel_all",
            requestId: "cancel-targeted-1",
            sessionId: "session-1",
            paperTradeId: "paper-1",
            exitTriggerKey: "session-1|event|yes|paper-1|exit",
            createdAtIso: "2026-01-01T00:00:01.000Z",
            symbol: "BTCUSDT",
            strategyKey: "test_strategy",
            marketSlug: "btc-event",
            conditionId: "condition",
            tokenId: "yes-token",
            orderIds: ["0xabc"],
            scope: "session",
            reason: "limit_exit_signal",
            orderMode: "limit",
        };

        const valid = validateLiveCancelAllSubmitRequest(request, {
            resolvedConfig: {
                orderMode: "limit",
                cancelScope: "account",
                limitCancelAllOnExitEnabled: false,
            },
        });

        expect(valid.ok).to.equal(true);
        if (valid.ok) expect(valid.request.orderIds).to.deep.equal(["0xabc"]);
    });

    it("requires executor responses to be structured and tied to the request id", () => {
        const request = buildLiveTradeSubmitRequest({
            snapshot: snapshot(),
            position: position("yes"),
            createdAtIso: "2026-01-01T00:00:01.000Z",
            nowSec: EVENT_START + 11,
        });

        expect(normalizeLiveTradeSubmitResponse({
            ok: true,
            requestId: request.requestId,
            status: "dry_run",
            currentAsk: "0.52",
            currentBid: "0.51",
            minPrice: "0.50",
        }, request.requestId).ok).to.equal(true);
        expect(normalizeLiveTradeSubmitResponse({
            ok: true,
            requestId: "other",
            status: "dry_run",
        }, request.requestId).ok).to.equal(false);
        expect(normalizeLiveTradeSubmitResponse({
            ok: true,
            requestId: request.requestId,
            status: "accepted",
        }, request.requestId).ok).to.equal(false);
    });

    it("normalizes matched executor responses with explicit partial fills", () => {
        const requestId = "live-exit-1";
        const normalized = normalizeLiveTradeSubmitResponse({
            ok: true,
            requestId,
            status: "matched",
            submittedShares: 29.35,
            filledShares: 8.94,
        }, requestId);

        expect(normalized.ok).to.equal(true);
        if (normalized.ok) {
            expect(normalized.response.status).to.equal("partial");
            expect(normalized.response.submittedShares).to.equal(29.35);
            expect(normalized.response.filledShares).to.equal(8.94);
        }
    });

    it("treats geoblock preflight failures as live safety rejections", () => {
        const requestId = "live-entry-geoblock";
        const normalized = normalizeLiveTradeSubmitResponse({
            ok: true,
            requestId,
            status: "failed",
            reason: "geoblock_check_failed",
            maxPrice: 0.57,
        }, requestId);

        expect(normalized.ok).to.equal(true);
        if (normalized.ok) {
            expect(normalized.response.status).to.equal("rejected");
            expect(normalized.response.reason).to.equal("geoblock_check_failed");
            expect(normalized.response.maxPrice).to.equal(0.57);
        }
        expect(isLiveTradeGeoblockReason("geoblock_check_failed")).to.equal(true);
        expect(isLiveTradeGeoblockReason("geoblocked")).to.equal(true);
        expect(isLiveTradeGeoblockReason("executor_unavailable")).to.equal(false);
    });

    it("only attempts a protective exit when a posted limit entry cannot be canceled", () => {
        expect(shouldAttemptLiveExitAfterLimitCancel({
            ok: true,
            requestId: "cancel-1",
            status: "rejected",
            reason: "not_canceled",
            scope: "session",
            canceledCount: 0,
        })).to.equal(true);

        expect(shouldAttemptLiveExitAfterLimitCancel({
            ok: true,
            requestId: "cancel-2",
            status: "submitted",
            scope: "session",
            canceledCount: 1,
        })).to.equal(false);

        expect(shouldAttemptLiveExitAfterLimitCancel({
            ok: true,
            requestId: "cancel-3",
            status: "failed",
            reason: "executor_unavailable",
            scope: "session",
            canceledCount: 0,
        })).to.equal(false);
    });

    it("keeps live exit positions open after explicit partial fills", () => {
        expect(resolveLiveTradeFilledShares({
            status: "matched",
            submittedShares: 29.35,
            filledShares: 0,
        })).to.equal(0);

        const partial = resolveLiveExitShareUpdate({
            remainingShares: 29.35294,
            response: {
                status: "matched",
                submittedShares: 29.35,
                filledShares: 8.94,
            },
        });
        expect(partial.closePosition).to.equal(false);
        expect(partial.remainingShares).to.be.closeTo(20.41294, 1e-9);

        const full = resolveLiveExitShareUpdate({
            remainingShares: 29.35294,
            response: {
                status: "matched",
                submittedShares: 29.35,
                filledShares: 29.35,
            },
        });
        expect(full.closePosition).to.equal(true);
        expect(full.remainingShares).to.equal(0);

        const legacyMatched = resolveLiveExitShareUpdate({
            remainingShares: 29.35294,
            response: {
                status: "matched",
                submittedShares: 29.35,
            },
        });
        expect(legacyMatched.closePosition).to.equal(true);
    });

    it("preflights live exits against the configured floor", () => {
        expect(resolveLiveExitFloorPreflight({
            currentBid: 0.36,
            minPrice: 0.35,
        }).shouldSubmit).to.equal(true);
        expect(resolveLiveExitFloorPreflight({
            currentBid: 0.11,
            minPrice: 0.35,
        })).to.deep.equal({
            shouldSubmit: false,
            reason: "price_moved_below_floor",
        });
        expect(resolveLiveExitFloorPreflight({
            currentBid: null,
            minPrice: 0.35,
        }).shouldSubmit).to.equal(true);
    });
});
