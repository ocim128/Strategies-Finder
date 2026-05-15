import { describe, it } from "node:test";
import { expect } from "chai";
import {
    buildPolymarket1sGammaAgreement,
    buildPolymarket1sPressureGap,
    buildPolymarket1sReactionGap,
} from "../lib/strategies/lib/polymarket-1s-helpers";
import type { OHLCVData, Polymarket1sRuntimeContext } from "../lib/types/strategies";

function candles(): OHLCVData[] {
    return [
        { time: 1_700_000_000 as OHLCVData["time"], open: 100.00, high: 100.01, low: 99.99, close: 100.00, volume: 1 },
        { time: 1_700_000_001 as OHLCVData["time"], open: 100.00, high: 100.01, low: 99.99, close: 100.00, volume: 1 },
        { time: 1_700_000_002 as OHLCVData["time"], open: 100.00, high: 100.02, low: 99.99, close: 100.01, volume: 1 },
        { time: 1_700_000_003 as OHLCVData["time"], open: 100.01, high: 100.03, low: 100.00, close: 100.02, volume: 1 },
        { time: 1_700_000_004 as OHLCVData["time"], open: 100.02, high: 100.04, low: 100.01, close: 100.03, volume: 1 },
        { time: 1_700_000_005 as OHLCVData["time"], open: 100.03, high: 100.06, low: 100.02, close: 100.05, volume: 1 },
        { time: 1_700_000_006 as OHLCVData["time"], open: 100.05, high: 100.09, low: 100.04, close: 100.08, volume: 1 },
        { time: 1_700_000_007 as OHLCVData["time"], open: 100.08, high: 100.13, low: 100.07, close: 100.12, volume: 1 },
    ];
}

function context(): Polymarket1sRuntimeContext {
    const eventStart = 1_700_000_000;
    const eventEnd = 1_700_000_300;
    return {
        symbol: "BTCUSDT",
        outcomeSymbol: "BTCUSDT",
        seriesId: "10684",
        outcomeInterval: "5m",
        quotes: Array.from({ length: 8 }, (_, index) => ({
            series_id: "10684",
            symbol: "BTCUSDT",
            outcome_interval: "5m",
            event_start_ts: eventStart,
            event_end_ts: eventEnd,
            sample_ts: eventStart + index,
            yes_mid: 0.5,
            no_mid: 0.5,
        })),
        gammaSnapshots: [{
            series_id: "10684",
            symbol: "BTCUSDT",
            outcome_interval: "5m",
            event_start_ts: eventStart,
            event_end_ts: eventEnd,
            snapshot_ts: eventStart,
            gamma_yes_price: 0.75,
            gamma_no_price: 0.25,
        }],
    };
}

describe("Polymarket 1s helper series", () => {
    it("scores positive pressure when Binance-implied probability exceeds market probability", () => {
        const frame = buildPolymarket1sPressureGap(candles(), context(), { volLookback: 5 });

        expect(frame.available).to.equal(true);
        expect(frame.pressureGap[7]).to.be.greaterThan(0);
        expect(frame.longEdge[7]).to.equal(frame.pressureGap[7]);
        expect(frame.shortEdge[7]).to.equal(0);
        expect(frame.eventProgress[7]).to.be.greaterThan(0);
    });

    it("detects positive underreaction when spot probability rises faster than Polymarket probability", () => {
        const frame = buildPolymarket1sReactionGap(candles(), context(), { volLookback: 5, lagSec: 2 });

        expect(frame.available).to.equal(true);
        expect(frame.reactionGap[7]).to.be.greaterThan(0);
        expect(frame.longLagEdge[7]).to.equal(frame.reactionGap[7]);
        expect(frame.shortLagEdge[7]).to.equal(0);
    });

    it("uses Gamma only when it agrees with the spot pressure direction", () => {
        const frame = buildPolymarket1sGammaAgreement(candles(), context(), { volLookback: 5 });

        expect(frame.available).to.equal(true);
        expect(frame.gammaGap[7]).to.be.greaterThan(0);
        expect(frame.consensusLongEdge[7]).to.be.greaterThan(0);
        expect(frame.consensusShortEdge[7]).to.equal(0);
    });

    it("uses the charted event open when the first available quote is mid-event", () => {
        const baseContext = context();
        const liveStartedMidEvent = {
            ...baseContext,
            quotes: baseContext.quotes.slice(-1),
        };
        const frame = buildPolymarket1sPressureGap(candles(), liveStartedMidEvent, { volLookback: 5 });

        expect(frame.available).to.equal(true);
        expect(frame.pressureGap[7]).to.be.a("number");
    });

    it("fails closed when the chart window starts after the active event open", () => {
        const midEventData = candles().map((bar, index) => ({
            ...bar,
            time: (1_700_000_030 + index) as OHLCVData["time"],
        }));
        const frame = buildPolymarket1sPressureGap(midEventData, context(), { volLookback: 5 });

        expect(frame.available).to.equal(false);
        expect(frame.pressureGap.every(value => value === null)).to.equal(true);
    });
});
