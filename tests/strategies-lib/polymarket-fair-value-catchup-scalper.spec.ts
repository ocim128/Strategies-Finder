import { expect } from "chai";
import { describe, it } from "node:test";
import type {
    OHLCVData,
    Polymarket1sQuoteContextRow,
    StrategyExecutionContext,
    Time,
} from "../../lib/types/strategies";
import { polymarket_fair_value_catchup_scalper } from "../../lib/strategies/lib/polymarket_fair_value_catchup_scalper";

const EVENT_START = 1_700_003_000;

function makeBars(length: number, closeForIndex: (index: number) => number): OHLCVData[] {
    return Array.from({ length }, (_unused, index) => {
        const close = closeForIndex(index);
        return {
            time: (EVENT_START + index) as Time,
            open: close,
            high: close,
            low: close,
            close,
            volume: 1,
        };
    });
}

function quote(index: number, overrides: Partial<Polymarket1sQuoteContextRow>): Polymarket1sQuoteContextRow {
    const eventStart = EVENT_START + Math.floor(index / 300) * 300;
    return {
        series_id: "btc-5m",
        symbol: "BTCUSDT",
        outcome_interval: "5m",
        event_start_ts: eventStart,
        event_end_ts: eventStart + 300,
        sample_ts: EVENT_START + index,
        yes_ask: 0.99,
        yes_mid: 0.5,
        no_ask: 0.99,
        no_mid: 0.5,
        ...overrides,
    };
}

function contextFor(
    data: readonly OHLCVData[],
    quoteForIndex: (index: number) => Partial<Polymarket1sQuoteContextRow>
): StrategyExecutionContext {
    return {
        polymarket1s: {
            symbol: "BTCUSDT",
            outcomeSymbol: "BTCUSDT",
            seriesId: "btc-5m",
            outcomeInterval: "5m",
            quotes: data.map((_bar, index) => quote(index, quoteForIndex(index))),
        },
    };
}

describe("polymarket_fair_value_catchup_scalper", () => {
    it("buys YES when fair-value edge and reaction lag point up", () => {
        const data = makeBars(130, (index) => index < 55 ? 100 : 100 + (index - 54) * 0.04);
        const signals = polymarket_fair_value_catchup_scalper.execute(
            data,
            { entryEdgeCents: 3, exitEdgeCents: 0, reactionLagSec: 5 },
            contextFor(data, () => ({ yes_ask: 0.45 }))
        );

        expect(signals.length).to.be.greaterThan(0);
        expect(signals[0]?.type).to.equal("buy");
    });

    it("flips to NO when opposite catch-up edge appears", () => {
        const data = makeBars(150, (index) => {
            if (index < 55) return 100;
            if (index < 90) return 100 + (index - 54) * 0.04;
            return 101.4 - (index - 89) * 0.08;
        });
        const signals = polymarket_fair_value_catchup_scalper.execute(
            data,
            { entryEdgeCents: 3, exitEdgeCents: 0, reactionLagSec: 5 },
            contextFor(data, (index) => index < 90
                ? { yes_ask: 0.45 }
                : { no_ask: 0.45 }
            )
        );

        expect(signals.map((signal) => signal.type)).to.include("buy");
        expect(signals.map((signal) => signal.type)).to.include("sell");
        expect(signals.findIndex((signal) => signal.type === "sell"))
            .to.be.greaterThan(signals.findIndex((signal) => signal.type === "buy"));
    });

    it("does not open new entries after the hardcoded 180-second remaining cutoff", () => {
        const data = makeBars(140, (index) => index < 125 ? 100 : 100 + (index - 124) * 0.08);
        const signals = polymarket_fair_value_catchup_scalper.execute(
            data,
            { entryEdgeCents: 3, exitEdgeCents: 0, reactionLagSec: 5 },
            contextFor(data, () => ({ yes_ask: 0.45 }))
        );

        expect(signals).to.deep.equal([]);
    });

    it("resets active side at the next Polymarket event boundary", () => {
        const data = makeBars(340, (index) => index < 55 ? 100 : 100 + (index - 54) * 0.04);
        const signals = polymarket_fair_value_catchup_scalper.execute(
            data,
            { entryEdgeCents: 3, exitEdgeCents: 0, reactionLagSec: 5 },
            contextFor(data, () => ({ yes_ask: 0.45 }))
        );

        expect(signals.some((signal) => signal.type === "buy" && (signal.barIndex ?? -1) < 300)).to.equal(true);
        expect(signals.some((signal) => signal.type === "buy" && (signal.barIndex ?? -1) >= 300)).to.equal(true);
    });

    it("keeps only catch-up scalper parameters exposed", () => {
        expect(polymarket_fair_value_catchup_scalper.defaultParams).to.deep.equal({
            entryEdgeCents: 3,
            exitEdgeCents: 0,
            reactionLagSec: 5,
        });
        expect(polymarket_fair_value_catchup_scalper.metadata?.walkForwardParams).to.deep.equal([
            "entryEdgeCents",
            "exitEdgeCents",
            "reactionLagSec",
        ]);
    });
});
