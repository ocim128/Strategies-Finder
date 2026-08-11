import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { acceptance_median_pullback_follow } from "../../lib/strategies/lib/acceptance_median_pullback_follow";
import { close_location_entropy_compression } from "../../lib/strategies/lib/close_location_entropy_compression";
import { compression_streak_expansion_entry } from "../../lib/strategies/lib/compression_streak_expansion_entry";
import { gap_momentum_continuation } from "../../lib/strategies/lib/gap_momentum_continuation";
import { money_flow_exhaustion_fade } from "../../lib/strategies/lib/money_flow_exhaustion_fade";
import { robust_volume_conviction_follow } from "../../lib/strategies/lib/robust_volume_conviction_follow";
import { trailing_channel_poke_rejection_fade } from "../../lib/strategies/lib/trailing_channel_poke_rejection_fade";
import { wick_dominance_flip_persistence } from "../../lib/strategies/lib/wick_dominance_flip_persistence";
import { wick_imbalance_decay_memory_follow } from "../../lib/strategies/lib/wick_imbalance_decay_memory_follow";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

const NEW_KEYS = [
    "wick_imbalance_decay_memory_follow",
    "close_location_entropy_compression",
    "gap_momentum_continuation",
    "robust_volume_conviction_follow",
    "trailing_channel_poke_rejection_fade",
    "money_flow_exhaustion_fade",
    "acceptance_median_pullback_follow",
    "wick_dominance_flip_persistence",
    "compression_streak_expansion_entry",
];

describe("persistence and compression strategy family", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(wick_imbalance_decay_memory_follow.normalizeParams?.({ decay: 0.01 })).to.deep.equal({ decay: 0.05 });
        expect(wick_imbalance_decay_memory_follow.normalizeParams?.({ decay: 0.995 })).to.deep.equal({ decay: 0.99 });
        expect(close_location_entropy_compression.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(gap_momentum_continuation.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(robust_volume_conviction_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(trailing_channel_poke_rejection_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(money_flow_exhaustion_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(acceptance_median_pullback_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(wick_dominance_flip_persistence.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(compression_streak_expansion_entry.normalizeParams?.({ minCompressionBars: 1 })).to.deep.equal({ minCompressionBars: 2 });
        expect(compression_streak_expansion_entry.normalizeParams?.({ minCompressionBars: 4 })).to.deep.equal({ minCompressionBars: 4 });
    });

    it("wick_imbalance_decay_memory_follow buys when decayed lower-wick absorption crosses its level", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 10; i++) data.push(bar(i, 100, 100.5, 99.5, 100)); // neutral wicks
        for (let i = 10; i < 13; i++) data.push(bar(i, 100, 100.3, 99, 100.2)); // lower-wick defense
        const signals = wick_imbalance_decay_memory_follow.execute(data, { decay: 0.9 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(12);
    });

    it("close_location_entropy_compression buys concentrated settlement at the range high", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 25; i++) data.push(bar(i, 99.9, 101, 99, 101)); // every close at the high
        const signals = close_location_entropy_compression.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(24);
    });

    it("gap_momentum_continuation buys a large percentile gap that closes in the gap direction", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 40; i++) {
            const open = close;
            close = open;
            data.push(bar(i, open, open * 1.001, open * 0.999, close));
        }
        const open = close * 1.02;
        const c = close * 1.015;
        data.push(bar(40, open, c * 1.001, open * 0.999, c));
        const signals = gap_momentum_continuation.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("robust_volume_conviction_follow buys a robust volume outlier with a full up body", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 30; i++) data.push(bar(i, 100, 100.5, 99.5, 100, i % 2 === 0 ? 1000 : 1100));
        data.push(bar(30, 100, 102, 100, 102, 5000));
        const signals = robust_volume_conviction_follow.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("trailing_channel_poke_rejection_fade buys a poke below the channel low that closes back inside", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 21; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(21, 100, 100.5, 98.5, 99.5));
        const signals = trailing_channel_poke_rejection_fade.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(21);
    });

    it("money_flow_exhaustion_fade buys when persistent down flow meets a high close", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 19; i++) data.push(bar(i, 100, 100.5, 99, 99)); // closes at low
        data.push(bar(19, 99.5, 100, 99.5, 100));
        data.push(bar(20, 99.5, 100, 99.5, 100)); // closes at high
        const signals = money_flow_exhaustion_fade.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(20);
    });

    it("acceptance_median_pullback_follow buys a violent bearish bar inside an upside acceptance regime", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 24; i++) data.push(bar(i, 99, 101, 99, 101)); // acceptance +1
        data.push(bar(24, 101, 101, 99, 99)); // acceptance -1 counter-bar
        const signals = acceptance_median_pullback_follow.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(24);
    });

    it("wick_dominance_flip_persistence buys persistent lower-wick dominance with no flips", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 31; i++) data.push(bar(i, 100, 100.3, 99, 100.2)); // dominant lower wicks
        const signals = wick_dominance_flip_persistence.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(30);
    });

    it("compression_streak_expansion_entry buys the range release after a compression streak", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 16; i++) data.push(bar(i, 100, 102.5, 97.5, 100)); // wide ranges
        for (let i = 16; i < 24; i++) data.push(bar(i, 100, 100.5, 99.5, 100)); // compressed
        data.push(bar(24, 100, 105, 95, 105)); // release bar closing at its high
        const signals = compression_streak_expansion_entry.execute(data, { minCompressionBars: 4 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(24);
    });
});
