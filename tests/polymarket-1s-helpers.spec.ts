import { expect } from "chai";
import { describe, it } from "node:test";
import type {
    OHLCVData,
    Polymarket1sGammaContextRow,
    Polymarket1sQuoteContextRow,
    Polymarket1sRuntimeContext,
    Time,
} from "../lib/types/strategies";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableAgreementMask,
    buildPolymarket1sExecutableEdge,
    buildPolymarket1sGammaAgreement,
    buildPolymarket1sGammaConsensusMask,
    buildPolymarket1sNoAdverseActionableMask,
    buildPolymarket1sPressureAgreementMask,
    buildPolymarket1sPressureGap,
    buildPolymarket1sReactionAgreementMask,
    buildPolymarket1sReactionGap,
} from "../lib/strategies/lib/polymarket-1s-helpers";

const EVENT_START = 1_700_000_000;
const EVENT_END = EVENT_START + 300;

function candle(offsetSec: number, close: number): OHLCVData {
    return {
        time: (EVENT_START + offsetSec) as Time,
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
        yes_ask: 0.61,
        yes_mid: 0.595,
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
        yes_ask: 0.51,
        yes_mid: 0.5,
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

    it("builds binary pressure agreement masks from pressure gap sign", () => {
        const positive = buildPolymarket1sPressureAgreementMask(candles(), runtime(quoteEverySecond()), { volLookback: 5 });

        expect(positive.available).to.equal(true);
        expect(positive.longAllowed[7]).to.equal(true);
        expect(positive.shortAllowed[7]).to.equal(false);

        const flatData = Array.from({ length: 10 }, (_unused, index) => candle(index, 100));
        const negative = buildPolymarket1sPressureAgreementMask(flatData, runtime(
            Array.from({ length: 10 }, (_unused, index) => quote(index, {
                yes_mid: 0.99,
                no_mid: 0.01,
            }))
        ), { volLookback: 5 });

        expect(negative.available).to.equal(true);
        expect(negative.longAllowed[7]).to.equal(false);
        expect(negative.shortAllowed[7]).to.equal(true);
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

    it("builds binary executable and no-adverse actionable masks", () => {
        const data = [100, 100, 100, 100, 100, 100.5, 101, 101.5, 102, 102.5]
            .map((close, index) => candle(index, close));
        const quotes = Array.from({ length: 10 }, (_unused, index) => quote(index, {
            yes_ask: 0.40,
            yes_mid: 0.39,
            no_ask: 0.99,
            no_mid: 0.61,
        }));

        const executable = buildPolymarket1sExecutableAgreementMask(data, runtime(quotes), { volLookback: 5 });
        const noAdverse = buildPolymarket1sNoAdverseActionableMask(data, runtime(quotes), { volLookback: 5 });

        expect(executable.available).to.equal(true);
        expect(executable.yesAllowed[8]).to.equal(true);
        expect(executable.noAllowed[8]).to.equal(false);
        expect(noAdverse.available).to.equal(true);
        expect(noAdverse.yesAllowed[8]).to.equal(true);
        expect(noAdverse.noAllowed[8]).to.equal(false);
    });

    it("fails the missing executable side closed without dropping the other side", () => {
        const frame = buildPolymarket1sExecutableEdge(candles(), runtime([
            quote(6, { yes_ask: null }),
        ]), { volLookback: 5, maxQuoteAgeSec: 2 });

        expect(frame.buyYesEdge[6]).to.equal(null);
        expect(frame.buyNoEdge[6]).to.be.a("number");
    });

    it("marks only sides with executable asks as actionable", () => {
        const actionability = buildPolymarket1sActionabilityMask(candles(), runtime([
            quote(6, {
                yes_ask: null,
                no_ask: 0.48,
            }),
        ]), { volLookback: 5, maxQuoteAgeSec: 2 });

        expect(actionability.actionable[6]).to.equal(true);
        expect(actionability.yesActionable[6]).to.equal(false);
        expect(actionability.noActionable[6]).to.equal(true);
        expect(actionability.reason[6]).to.equal(null);
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

    it("builds binary reaction agreement masks from reaction gap sign", () => {
        const data = [100, 100, 100, 100, 100, 100, 101, 102, 103, 104]
            .map((close, index) => candle(index, close));
        const mask = buildPolymarket1sReactionAgreementMask(data, runtime(quoteEverySecond()), {
            volLookback: 5,
            lagSec: 3,
        });

        expect(mask.available).to.equal(true);
        expect(mask.longAllowed[8]).to.equal(true);
        expect(mask.shortAllowed[8]).to.equal(false);
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

    it("builds binary Gamma consensus masks from same-side agreement", () => {
        const mask = buildPolymarket1sGammaConsensusMask(candles(), runtime(quoteEverySecond(), [
            gamma(5, 0.7, 0.3),
            gamma(8, 0.2, 0.8),
        ]), { volLookback: 5, maxGammaAgeSec: 20 });

        expect(mask.available).to.equal(true);
        expect(mask.longAllowed[7]).to.equal(true);
        expect(mask.shortAllowed[7]).to.equal(false);
    });

});
