import { expect } from "chai";
import { describe, it } from "node:test";
import type {
    OHLCVData,
    Polymarket1sGammaContextRow,
    Polymarket1sQuoteContextRow,
    Polymarket1sRuntimeContext,
} from "../lib/types/strategies";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sEdgePersistence,
    buildPolymarket1sExecutableEdge,
    buildPolymarket1sGammaAgreement,
    buildPolymarket1sPressureGap,
    buildPolymarket1sReactionGap,
    type Polymarket1sExecutableEdgeFrame,
} from "../lib/strategies/lib/polymarket-1s-helpers";
import { polymarket_executable_edge_persistence } from "../lib/strategies/lib/polymarket_executable_edge_persistence";

const EVENT_START = 1_700_000_000;
const EVENT_END = EVENT_START + 300;

function candle(offsetSec: number, close: number): OHLCVData {
    return {
        time: EVENT_START + offsetSec,
        open: close,
        high: close,
        low: close,
        close,
        volume: 1,
    };
}

function candles(): OHLCVData[] {
    return [100, 100.05, 100.01, 100.08, 100.02, 100.12, 100.25, 100.4, 100.65, 100.85]
        .map((close, index) => candle(index, close));
}

function quote(offsetSec: number, overrides: Partial<Polymarket1sQuoteContextRow> = {}): Polymarket1sQuoteContextRow {
    return {
        series_id: "btc-5m",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: EVENT_START,
        event_end_ts: EVENT_END,
        sample_ts: EVENT_START + offsetSec,
        yes_bid: 0.58,
        yes_ask: 0.61,
        yes_mid: 0.595,
        no_bid: 0.38,
        no_ask: 0.41,
        no_mid: 0.395,
        ...overrides,
    };
}

function gamma(offsetSec: number, yes: number, no: number): Polymarket1sGammaContextRow {
    return {
        series_id: "btc-5m",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: EVENT_START,
        event_end_ts: EVENT_END,
        snapshot_ts: EVENT_START + offsetSec,
        gamma_yes_price: yes,
        gamma_no_price: no,
    };
}

function runtime(
    quotes: readonly Polymarket1sQuoteContextRow[],
    gammaSnapshots: readonly Polymarket1sGammaContextRow[] = []
): Polymarket1sRuntimeContext {
    return {
        symbol: "BTCUSDT",
        outcomeSymbol: "BTCUSDT",
        seriesId: "btc-5m",
        outcomeInterval: "5m",
        quotes,
        gammaSnapshots,
    };
}

function quoteEverySecond(): Polymarket1sQuoteContextRow[] {
    return Array.from({ length: 10 }, (_, index) => quote(index, {
        yes_bid: 0.49,
        yes_ask: 0.51,
        yes_mid: 0.5,
        no_bid: 0.49,
        no_ask: 0.51,
        no_mid: 0.5,
    }));
}

describe("Polymarket 1s helpers", () => {
    it("scores positive pressure when Binance-implied probability exceeds market probability", () => {
        const frame = buildPolymarket1sPressureGap(candles(), runtime(quoteEverySecond()), { volLookback: 5 });

        expect(frame.available).to.equal(true);
        expect(frame.pressureGap[7]).to.be.greaterThan(0);
        expect(frame.longEdge[7]).to.equal(frame.pressureGap[7]);
        expect(frame.shortEdge[7]).to.equal(0);
        expect(frame.eventProgress[7]).to.be.greaterThan(0);
    });

    it("uses the charted event open when the first available quote is mid-event", () => {
        const frame = buildPolymarket1sPressureGap(candles(), runtime([
            quote(7),
        ]), { volLookback: 5 });

        expect(frame.available).to.equal(true);
        expect(frame.pressureGap[7]).to.be.a("number");
    });

    it("fails closed when the chart window starts after the active event open", () => {
        const midEventData = candles().map((bar, index) => ({
            ...bar,
            time: (EVENT_START + 30 + index) as OHLCVData["time"],
        }));
        const frame = buildPolymarket1sPressureGap(midEventData, runtime([
            quote(37),
        ]), { volLookback: 5 });

        expect(frame.available).to.equal(false);
        expect(frame.pressureGap.every((value) => value === null)).to.equal(true);
    });

    it("uses the latest causal quote for executable edge and ignores future quotes", () => {
        const frame = buildPolymarket1sExecutableEdge(candles(), runtime([
            quote(5, { yes_ask: 0.61 }),
            quote(7, { yes_ask: 0.99 }),
        ]), { volLookback: 5, maxQuoteAgeSec: 2 });

        expect(frame.available).to.equal(true);
        expect(frame.yesAskProbability[6]).to.equal(0.61);
        expect(frame.yesAskProbability[7]).to.equal(0.99);
        expect(frame.buyYesEdge[6]).to.be.a("number");
    });

    it("fails the missing executable side closed without dropping the other side", () => {
        const frame = buildPolymarket1sExecutableEdge(candles(), runtime([
            quote(6, { yes_ask: null }),
        ]), { volLookback: 5, maxQuoteAgeSec: 2 });

        expect(frame.buyYesEdge[6]).to.equal(null);
        expect(frame.buyNoEdge[6]).to.be.a("number");
    });

    it("marks wide or crossed executable quotes as not actionable", () => {
        const actionability = buildPolymarket1sActionabilityMask(candles(), runtime([
            quote(6, {
                yes_bid: 0.50,
                yes_ask: 0.57,
                no_bid: 0.40,
                no_ask: 0.48,
            }),
        ]), { volLookback: 5, maxQuoteAgeSec: 2, maxSpread: 0.02 });

        expect(actionability.actionable[6]).to.equal(false);
        expect(actionability.yesActionable[6]).to.equal(false);
        expect(actionability.noActionable[6]).to.equal(false);
        expect(actionability.reason[6]).to.equal("spread_too_wide");
    });

    it("tracks positive edge persistence and resets when edge disappears", () => {
        const edgeFrame: Polymarket1sExecutableEdgeFrame = {
            available: true,
            fairYesProbability: new Array(5).fill(null),
            fairNoProbability: new Array(5).fill(null),
            marketYesProbability: new Array(5).fill(null),
            yesAskProbability: new Array(5).fill(null),
            noAskProbability: new Array(5).fill(null),
            buyYesEdge: [null, 0.03, 0.04, 0.01, 0.05],
            buyNoEdge: [null, null, null, null, null],
            yesSpread: new Array(5).fill(null),
            noSpread: new Array(5).fill(null),
            quoteAgeSec: new Array(5).fill(0),
            eventProgress: [null, 0.1, 0.2, 0.3, 0.4],
            secondsRemaining: new Array(5).fill(100),
        };

        const persistence = buildPolymarket1sEdgePersistence(edgeFrame, { minEdge: 0.03 });

        expect(persistence.yesEdgeSeconds).to.deep.equal([0, 1, 2, 0, 1]);
        expect(persistence.yesEdgeEwma[2]).to.be.a("number");
    });

    it("computes positive reaction lag when Binance fair probability moves faster than market probability", () => {
        const data = [100, 100, 100, 100, 100, 100, 101, 102, 103, 104]
            .map((close, index) => candle(index, close));
        const reaction = buildPolymarket1sReactionGap(data, runtime(quoteEverySecond()), {
            volLookback: 5,
            lagSec: 3,
        });

        expect(reaction.available).to.equal(true);
        expect(reaction.spotImpulse[8]).to.be.greaterThan(0);
        expect(reaction.longLagEdge[8]).to.be.greaterThan(0);
    });

    it("does not compute reaction lag across Polymarket event boundaries", () => {
        const data = Array.from({ length: 306 }, (_, index) => {
            const secondEventOffset = Math.max(0, index - 300);
            return candle(index, index < 300 ? 100 : 100 + secondEventOffset);
        });
        const firstEventQuotes = Array.from({ length: 300 }, (_, index) => quote(index, {
            yes_mid: 0.5,
            no_mid: 0.5,
        }));
        const secondEventQuotes = Array.from({ length: 6 }, (_, index) => quote(300 + index, {
            event_start_ts: EVENT_END,
            event_end_ts: EVENT_END + 300,
            yes_mid: 0.5,
            no_mid: 0.5,
        }));

        const reaction = buildPolymarket1sReactionGap(data, runtime([
            ...firstEventQuotes,
            ...secondEventQuotes,
        ]), { volLookback: 5, lagSec: 3 });

        expect(reaction.spotImpulse[302]).to.equal(null);
        expect(reaction.spotImpulse[305]).to.be.a("number");
    });

    it("uses Gamma snapshots causally and only as same-side agreement", () => {
        const agreement = buildPolymarket1sGammaAgreement(candles(), runtime(quoteEverySecond(), [
            gamma(5, 0.7, 0.3),
            gamma(8, 0.2, 0.8),
        ]), { volLookback: 5, maxGammaAgeSec: 20 });

        expect(agreement.available).to.equal(true);
        expect(agreement.gammaYesProbability[7]).to.equal(0.7);
        expect(agreement.consensusLongEdge[7]).to.be.greaterThan(0);
    });

    it("drives the executable-edge strategy from Binance fair probability and ask-side edge", () => {
        const data = [100, 100, 100, 100, 100, 100.5, 101, 101.5, 102, 102.5]
            .map((close, index) => candle(index, close));
        const quotes = Array.from({ length: 10 }, (_, index) => quote(index, {
            yes_bid: 0.38,
            yes_ask: 0.40,
            yes_mid: 0.39,
            no_bid: 0.58,
            no_ask: 0.60,
            no_mid: 0.59,
        }));

        const signals = polymarket_executable_edge_persistence.execute(data, {
            volLookback: 5,
            minEdge: 0.05,
            persistenceSec: 2,
            maxSpread: 0.05,
        }, { polymarket1s: runtime(quotes) });

        expect(signals.some((signal) => signal.type === "buy")).to.equal(true);
        expect(polymarket_executable_edge_persistence.execute(data, {
            volLookback: 5,
            minEdge: 0.05,
            persistenceSec: 2,
            maxSpread: 0.05,
        })).to.deep.equal([]);
    });

    it("normalizes invalid executable-edge strategy params back to safe defaults", () => {
        const normalized = polymarket_executable_edge_persistence.normalizeParams?.({
            volLookback: Number.NaN,
            minEdge: Number.NaN,
            persistenceSec: Number.NaN,
            maxSpread: Number.NaN,
        });

        expect(normalized).to.deep.include({
            volLookback: 45,
            minEdge: 0.04,
            persistenceSec: 2,
            maxSpread: 0.04,
        });
    });
});
