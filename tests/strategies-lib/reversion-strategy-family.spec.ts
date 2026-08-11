import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { cumulative_gap_reversion } from "../../lib/strategies/lib/cumulative_gap_reversion";
import { decay_anchor_reversion } from "../../lib/strategies/lib/decay_anchor_reversion";
import { defended_low_reversion } from "../../lib/strategies/lib/defended_low_reversion";
import { high_entropy_noise_fade } from "../../lib/strategies/lib/high_entropy_noise_fade";
import { lagged_value_anchor_reversion } from "../../lib/strategies/lib/lagged_value_anchor_reversion";
import { median_time_stretch_reversion } from "../../lib/strategies/lib/median_time_stretch_reversion";
import { multiscale_overextension_fade } from "../../lib/strategies/lib/multiscale_overextension_fade";
import { negative_autocorr_reversion } from "../../lib/strategies/lib/negative_autocorr_reversion";
import { quiet_streak_exhaustion } from "../../lib/strategies/lib/quiet_streak_exhaustion";
import { range_bound_channel_fade } from "../../lib/strategies/lib/range_bound_channel_fade";

function bar(time: number, open: number, high: number, low: number, close: number): OHLCVData {
    return { time: time as Time, open, high, low, close, volume: 1000 };
}

function flatBars(count: number, close: number): OHLCVData[] {
    const bars: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        bars.push(bar(i, close - 0.5, close + 1, close - 1, close));
    }
    return bars;
}

const NEW_REVERSION_KEYS = [
    "multiscale_overextension_fade",
    "median_time_stretch_reversion",
    "range_bound_channel_fade",
    "high_entropy_noise_fade",
    "negative_autocorr_reversion",
    "decay_anchor_reversion",
    "defended_low_reversion",
    "lagged_value_anchor_reversion",
    "cumulative_gap_reversion",
    "quiet_streak_exhaustion",
];

describe("reversion strategy family", () => {
    it("registers all new reversion strategies in the built-in manifest", () => {
        for (const key of NEW_REVERSION_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        // multiscale_overextension_fade: lookback clamped >= 5
        expect(multiscale_overextension_fade.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(multiscale_overextension_fade.normalizeParams?.({ lookback: 20 })).to.deep.equal({ lookback: 20 });

        // median_time_stretch_reversion: streakLength rounded, clamped >= 3
        expect(median_time_stretch_reversion.normalizeParams?.({ streakLength: 2 })).to.deep.equal({ streakLength: 3 });
        expect(median_time_stretch_reversion.normalizeParams?.({ streakLength: 8.6 })).to.deep.equal({ streakLength: 9 });

        // range_bound_channel_fade: lookback clamped >= 10
        expect(range_bound_channel_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(range_bound_channel_fade.normalizeParams?.({ lookback: 40 })).to.deep.equal({ lookback: 40 });

        // high_entropy_noise_fade / negative_autocorr_reversion: lookback clamped >= 20
        expect(high_entropy_noise_fade.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });
        expect(negative_autocorr_reversion.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });

        // decay_anchor_reversion: decay clamped into (0.5, 0.999)
        expect(decay_anchor_reversion.normalizeParams?.({ decay: 0.2 })).to.deep.equal({ decay: 0.5 });
        expect(decay_anchor_reversion.normalizeParams?.({ decay: 0.95 })).to.deep.equal({ decay: 0.95 });
        expect(decay_anchor_reversion.normalizeParams?.({ decay: 1 })).to.deep.equal({ decay: 0.999 });

        // defended_low_reversion / lagged_value_anchor_reversion: lookback clamped >= 10
        expect(defended_low_reversion.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(lagged_value_anchor_reversion.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });

        // cumulative_gap_reversion: lookback clamped >= 10
        expect(cumulative_gap_reversion.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(cumulative_gap_reversion.normalizeParams?.({ lookback: 20 })).to.deep.equal({ lookback: 20 });

        // quiet_streak_exhaustion: streakLength rounded, clamped >= 2
        expect(quiet_streak_exhaustion.normalizeParams?.({ streakLength: 1 })).to.deep.equal({ streakLength: 2 });
        expect(quiet_streak_exhaustion.normalizeParams?.({ streakLength: 4 })).to.deep.equal({ streakLength: 4 });
    });

    it("median_time_stretch_reversion buys exactly when the below-median streak first reaches the threshold", () => {
        // 60 flat bars establish the median, then 8 consecutive closes below it.
        const data = [
            ...flatBars(60, 100),
            bar(60, 98.5, 100, 98, 99),
            bar(61, 97.5, 99, 97, 98),
            bar(62, 96.5, 98, 96, 97),
            bar(63, 95.5, 97, 95, 96),
            bar(64, 94.5, 96, 94, 95),
            bar(65, 93.5, 95, 93, 94),
            bar(66, 92.5, 94, 92, 93),
            bar(67, 91.5, 93, 91, 92),
            bar(68, 90.5, 92, 90, 91),
            bar(69, 89.5, 91, 89, 90),
        ];
        const signals = median_time_stretch_reversion.execute(data, { streakLength: 8 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(67);
    });

    it("range_bound_channel_fade buys the proven range floor and sells the proven range ceiling", () => {
        // 40 flat bars: prior-only channel 99..101, width 2 vs ATR ~2 -> narrow gate open.
        const data = [
            ...flatBars(40, 100),
            bar(40, 98, 99, 97.5, 98),      // close at/below the prior-only low -> buy
            bar(41, 102, 103, 101.5, 102),  // close at/above the prior-only high -> sell
        ];
        const signals = range_bound_channel_fade.execute(data, { lookback: 40 });
        expect(signals.map((s) => [s.type, s.barIndex])).to.deep.equal([["buy", 40], ["sell", 41]]);
    });

    it("quiet_streak_exhaustion buys exactly when a down streak first hits the threshold on a quiet bar", () => {
        // 60 uniform-range flat bars give a bottom-third range rank; then a 4-bar decline.
        const data = [
            ...flatBars(60, 100),
            bar(60, 98.5, 100, 98, 99),
            bar(61, 97.5, 99, 97, 98),
            bar(62, 96.5, 98, 96, 97),
            bar(63, 95.5, 97, 95, 96),
            bar(64, 94.5, 96, 94, 95),
        ];
        const signals = quiet_streak_exhaustion.execute(data, { streakLength: 4 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(63);
    });

    it("cumulative_gap_reversion stays silent until the rolling sum z-score is fully warmed up", () => {
        const data = flatBars(60, 100);
        const signals = cumulative_gap_reversion.execute(data, { lookback: 20 });
        expect(signals).to.have.length(0);
    });
});
