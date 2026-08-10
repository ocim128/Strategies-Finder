import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { long_memory_return_streak } from "../../lib/strategies/lib/long_memory_return_streak";
import { fair_value_reversion_slow } from "../../lib/strategies/lib/fair_value_reversion_slow";
import { volatility_regime_compression_collapse } from "../../lib/strategies/lib/volatility_regime_compression_collapse";
import { tail_event_continuation_follow } from "../../lib/strategies/lib/tail_event_continuation_follow";
import { autocorrelation_persistence_signal } from "../../lib/strategies/lib/autocorrelation_persistence_signal";
import { cumulative_decay_momentum_extreme } from "../../lib/strategies/lib/cumulative_decay_momentum_extreme";
import { close_location_long_persistence } from "../../lib/strategies/lib/close_location_long_persistence";
import { return_acceleration_momentum } from "../../lib/strategies/lib/return_acceleration_momentum";
import { percentile_extreme_momentum_continuation } from "../../lib/strategies/lib/percentile_extreme_momentum_continuation";

const NEW_STRATEGY_KEYS = [
    "long_memory_return_streak",
    "fair_value_reversion_slow",
    "volatility_regime_compression_collapse",
    "tail_event_continuation_follow",
    "autocorrelation_persistence_signal",
    "cumulative_decay_momentum_extreme",
    "close_location_long_persistence",
    "return_acceleration_momentum",
    "percentile_extreme_momentum_continuation",
];

const NEW_STRATEGIES = [
    long_memory_return_streak,
    fair_value_reversion_slow,
    volatility_regime_compression_collapse,
    tail_event_continuation_follow,
    autocorrelation_persistence_signal,
    cumulative_decay_momentum_extreme,
    close_location_long_persistence,
    return_acceleration_momentum,
    percentile_extreme_momentum_continuation,
];

function bar(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as Time, open, high, low, close, volume: 1000 };
}

function closesToBars(closes: number[]): OHLCVData[] {
    return closes.map((close, i) => bar(i, close - 0.5, close + 1, close - 1, close));
}

describe("long memory / maturation strategy family", () => {
    it("registers all new long-memory strategies in the built-in manifest", () => {
        for (const key of NEW_STRATEGY_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("executes every new strategy with default params without throwing", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 260; i++) {
            close = close + Math.sin(i / 4) * 0.6 + (i < 130 ? 0.15 : -0.1);
            const open = close - Math.sin(i / 5) * 0.4;
            data.push(bar(i, open, Math.max(open, close) + 0.8, Math.min(open, close) - 0.8, close));
        }

        for (let index = 0; index < NEW_STRATEGIES.length; index++) {
            const signals = NEW_STRATEGIES[index].execute(data, NEW_STRATEGIES[index].defaultParams);
            expect(signals, `${NEW_STRATEGY_KEYS[index]} signals`).to.be.an("array");
            for (const signal of signals) {
                expect(signal.type === "buy" || signal.type === "sell", `${NEW_STRATEGY_KEYS[index]} signal type`).to.equal(true);
                expect(signal.barIndex, `${NEW_STRATEGY_KEYS[index]} signal barIndex`).to.be.a("number");
            }
        }
    });

    it("long_memory_return_streak follows 10+ bar same-sign streaks", () => {
        const rising = closesToBars(Array.from({ length: 12 }, (_, i) => 100 + i));
        const buySignals = long_memory_return_streak.execute(rising, {});
        expect(buySignals.map((s) => s.barIndex)).to.deep.equal([10, 11]);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }

        const falling = closesToBars(Array.from({ length: 12 }, (_, i) => 100 - i));
        const sellSignals = long_memory_return_streak.execute(falling, {});
        expect(sellSignals.map((s) => s.barIndex)).to.deep.equal([10, 11]);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
    });

    it("close_location_long_persistence buys when over 70% of the window closes above 0.65", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 11; i++) {
            data.push(bar(i, 100, 101, 99, 100)); // close location 0.50
        }
        for (let i = 11; i < 41; i++) {
            data.push(bar(i, 100, 101, 99, 100.9)); // close location 0.95
        }

        const signals = close_location_long_persistence.execute(data, {});
        expect(signals.map((s) => s.barIndex)).to.deep.equal([40]);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("tail_event_continuation_follow buys after an extreme positive tail confirms", () => {
        const closes: number[] = [];
        for (let i = 0; i < 35; i++) closes.push(100); // flat
        closes.push(120); // +20% tail
        closes.push(121); // confirming positive return
        const data = closesToBars(closes);

        const signals = tail_event_continuation_follow.execute(data, {});
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(36);
    });

    it("return_acceleration_momentum follows accelerating upward momentum", () => {
        const closes: number[] = [];
        for (let i = 0; i < 20; i++) closes.push(100); // flat base
        for (let i = 0; i < 20; i++) closes.push(100 + i * 0.5); // slow rise
        for (let i = 0; i < 20; i++) closes.push(110 + i * 2); // fast rise
        const data = closesToBars(closes);

        const signals = return_acceleration_momentum.execute(data, {});
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
            expect(signal.barIndex).to.be.greaterThanOrEqual(50);
        }
    });
});
