import { expect } from "chai";
import { describe, it } from "node:test";
import type {
    OHLCVData,
    Polymarket1sQuoteContextRow,
    StrategyExecutionContext,
    Time,
} from "../../lib/types/strategies";
import { polymarket_fair_value_mispricing } from "../../lib/strategies/lib/polymarket_fair_value_mispricing";

const EVENT_START = 1_700_002_000;
const EVENT_END = EVENT_START + 300;

function bars(length: number): OHLCVData[] {
    return Array.from({ length }, (_unused, index) => ({
        time: (EVENT_START + index) as Time,
        open: 100,
        high: 100,
        low: 100,
        close: 100,
        volume: 1,
    }));
}

function quote(offsetSeconds: number, overrides: Partial<Polymarket1sQuoteContextRow>): Polymarket1sQuoteContextRow {
    return {
        series_id: "btc-5m",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: EVENT_START,
        event_end_ts: EVENT_END,
        sample_ts: EVENT_START + offsetSeconds,
        yes_ask: 0.99,
        yes_mid: 0.5,
        no_ask: 0.99,
        no_mid: 0.5,
        ...overrides,
    };
}

function contextFor(
    data: readonly OHLCVData[],
    quoteOverrides: Partial<Polymarket1sQuoteContextRow>
): StrategyExecutionContext {
    return {
        polymarket1s: {
            symbol: "BTCUSDT",
            outcomeSymbol: "BTCUSDT",
            seriesId: "btc-5m",
            outcomeInterval: "5m",
            quotes: data.map((_bar, index) => quote(index, quoteOverrides)),
        },
    };
}

describe("polymarket_fair_value_mispricing", () => {
    it("buys YES when the YES ask is below fair value by the minimum edge", () => {
        const data = bars(123);
        const signals = polymarket_fair_value_mispricing.execute(
            data,
            { minEdgeCents: 3 },
            contextFor(data, { yes_ask: 0.46 })
        );

        expect(signals.length).to.be.greaterThan(0);
        expect(signals.every((signal) => signal.type === "buy")).to.equal(true);
    });

    it("buys NO when the NO ask is below fair value by the minimum edge", () => {
        const data = bars(123);
        const signals = polymarket_fair_value_mispricing.execute(
            data,
            { minEdgeCents: 3 },
            contextFor(data, { no_ask: 0.46 })
        );

        expect(signals.length).to.be.greaterThan(0);
        expect(signals.every((signal) => signal.type === "sell")).to.equal(true);
    });

    it("keeps the event-end cutoff hardcoded at 180 seconds", () => {
        const data = bars(123);
        const signals = polymarket_fair_value_mispricing.execute(
            data,
            { minEdgeCents: 3 },
            contextFor(data, { yes_ask: 0.46 })
        );

        expect(signals.length).to.be.greaterThan(0);
        expect(Math.max(...signals.map((signal) => signal.barIndex ?? -1))).to.equal(120);
    });

    it("exposes only the minimum edge as a tunable parameter", () => {
        expect(polymarket_fair_value_mispricing.defaultParams).to.deep.equal({
            minEdgeCents: 3,
        });
        expect(polymarket_fair_value_mispricing.paramLabels).to.deep.equal({
            minEdgeCents: "Minimum Edge (cents)",
        });
        expect(polymarket_fair_value_mispricing.metadata?.walkForwardParams).to.deep.equal([
            "minEdgeCents",
        ]);
    });
});
