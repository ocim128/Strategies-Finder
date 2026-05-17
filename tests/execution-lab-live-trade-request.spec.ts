import { expect } from "chai";
import { describe, it } from "node:test";
import type { ExecutionLabOpenPaperPosition, ExecutionLabSessionSnapshot } from "../lib/execution-lab/execution-lab-model";
import {
    buildLiveExitSubmitRequest,
    buildLiveTradeSubmitRequest,
    normalizeLiveTradeSubmitResponse,
    resolveLiveExitFloorPreflight,
    resolveLiveExitShareUpdate,
    resolveLiveTradeFilledShares,
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
        });

        expect(yes.action).to.equal("entry");
        expect(yes.tokenId).to.equal("yes-token");
        expect(no.tokenId).to.equal("no-token");
        expect(yes.maxPrice).to.equal(0.57);
        expect(yes.orderType).to.equal("FAK");
        expect(yes.requestId).to.equal(yesRepeat.requestId);
        expect(no.requestId).to.not.equal(yes.requestId);
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
        expect(request.minPrice).to.be.closeTo(0.49, 1e-12);
        expect(request.maxPrice).to.be.closeTo(0.49, 1e-12);
        expect(buildLiveExitSubmitRequest({ ...exitArgs, attempt: 2 }).requestId).to.not.equal(request.requestId);
        expect(validateLiveTradeSubmitRequest(request, {
            nowSec: EVENT_START + 51,
            maxStakeUsd: 1,
        }).ok).to.equal(true);
        expect(validateLiveTradeSubmitRequest({ ...request, shares: 0 }, {
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
            createdAtIso: "2026-01-01T00:00:50.000Z",
            nowSec: EVENT_START + 51,
        });

        expect(request.minPrice).to.be.closeTo(0.57, 1e-12);
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
        expect(validateLiveTradeSubmitRequest({ ...request, entryTimeSec: EVENT_END }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
        }).ok).to.equal(false);
        expect(validateLiveTradeSubmitRequest({ ...request, expiresAtSec: EVENT_START + 42 }, {
            nowSec: EVENT_START + 11,
            maxStakeUsd: 10,
        }).ok).to.equal(false);
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
