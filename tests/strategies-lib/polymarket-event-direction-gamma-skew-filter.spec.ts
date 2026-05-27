import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, StrategyExecutionContext, Time } from "../../lib/types/strategies";
import { polymarket_event_direction_gamma_skew_filter } from "../../lib/strategies/lib/polymarket_event_direction_gamma_skew_filter";

const EVENT_START = 1_700_001_000;
const EVENT_END = EVENT_START + 300;

function bar(offsetSeconds: number, open: number, close: number): OHLCVData {
    return {
        time: (EVENT_START + offsetSeconds) as Time,
        open,
        high: Math.max(open, close),
        low: Math.min(open, close),
        close,
        volume: 1000,
    };
}

function contextForBars(
    bars: readonly OHLCVData[],
    marketYesProbability: number,
    gammaYesProbability: number
): StrategyExecutionContext {
    return {
        polymarket1s: {
            symbol: "BTCUSDT",
            outcomeSymbol: "BTCUSDT",
            seriesId: "test-series",
            outcomeInterval: "5m",
            quotes: bars.map((item) => ({
                series_id: "test-series",
                symbol: "BTCUSDT",
                outcome_interval: "5m",
                event_start_ts: EVENT_START,
                event_end_ts: EVENT_END,
                sample_ts: Number(item.time),
                yes_ask: marketYesProbability + 0.01,
                yes_mid: marketYesProbability,
                no_ask: 1 - marketYesProbability + 0.01,
                no_mid: 1 - marketYesProbability,
            })),
            gammaSnapshots: bars.map((item) => ({
                series_id: "test-series",
                symbol: "BTCUSDT",
                outcome_interval: "5m",
                event_start_ts: EVENT_START,
                event_end_ts: EVENT_END,
                snapshot_ts: Number(item.time),
                gamma_yes_price: gammaYesProbability,
                gamma_no_price: 1 - gammaYesProbability,
            })),
        },
    };
}

describe("polymarket_event_direction_gamma_skew_filter", () => {
    it("fails closed without 1s Polymarket context", () => {
        const bars = [
            bar(0, 100, 100),
            bar(1, 100, 100.01),
            bar(2, 100.01, 100.02),
            bar(3, 100.02, 100.03),
            bar(4, 100.03, 100.04),
            bar(5, 100.04, 100.05),
            bar(6, 100.05, 101.5),
            bar(7, 101.5, 102),
        ];

        expect(polymarket_event_direction_gamma_skew_filter.execute(bars, {
            volLookback: 5,
            skewThreshold: 0,
            minEdge: 0,
        })).to.deep.equal([]);
    });

    it("requires event-open direction to agree with the Gamma-skew filter", () => {
        const bars = [
            bar(0, 100, 100),
            bar(1, 100, 100.01),
            bar(2, 100.01, 100.02),
            bar(3, 100.02, 100.03),
            bar(4, 100.03, 100.04),
            bar(5, 100.04, 100.05),
            bar(6, 100.05, 101.5),
            bar(7, 101.5, 102),
        ];

        const signals = polymarket_event_direction_gamma_skew_filter.execute(bars, {
            volLookback: 5,
            skewThreshold: 0,
            minEdge: 0,
        }, contextForBars(bars, 0.3, 0.7));

        expect(signals.map((signal) => [signal.barIndex, signal.type])).to.deep.equal([
            [7, "buy"],
        ]);
    });

    it("does not buy a Gamma-skew long setup while price remains below event open", () => {
        const bars = [
            bar(0, 100, 100),
            bar(1, 100, 99),
            bar(2, 99, 99.1),
            bar(3, 99.1, 99.2),
            bar(4, 99.2, 99.3),
            bar(5, 99.3, 99.4),
            bar(6, 99.4, 99.8),
        ];

        const signals = polymarket_event_direction_gamma_skew_filter.execute(bars, {
            volLookback: 5,
            skewThreshold: 0,
            minEdge: 0,
        }, contextForBars(bars, 0.2, 0.8));

        expect(signals).to.deep.equal([]);
    });

    it("treats minEdge zero as any positive Gamma consensus, not optional consensus", () => {
        const bars = [
            bar(0, 100, 100),
            bar(1, 100, 100.01),
            bar(2, 100.01, 100.02),
            bar(3, 100.02, 100.03),
            bar(4, 100.03, 100.04),
            bar(5, 100.04, 100.05),
            bar(6, 100.05, 101.5),
            bar(7, 101.5, 102),
        ];

        const signals = polymarket_event_direction_gamma_skew_filter.execute(bars, {
            volLookback: 5,
            skewThreshold: 0,
            minEdge: 0,
        }, contextForBars(bars, 0.3, 0.3));

        expect(signals).to.deep.equal([]);
    });

    it("keeps the event-end cutoff hardcoded and exposes only filter parameters", () => {
        expect(polymarket_event_direction_gamma_skew_filter.defaultParams).to.deep.equal({
            volLookback: 164,
            skewThreshold: 1.6,
            minEdge: 0,
        });
        expect(polymarket_event_direction_gamma_skew_filter.paramLabels).to.deep.equal({
            volLookback: "Volatility Lookback",
            skewThreshold: "Skew Threshold",
            minEdge: "Minimum Consensus Edge",
        });
        expect(polymarket_event_direction_gamma_skew_filter.metadata?.walkForwardParams).to.deep.equal([
            "volLookback",
            "skewThreshold",
            "minEdge",
        ]);
    });
});
