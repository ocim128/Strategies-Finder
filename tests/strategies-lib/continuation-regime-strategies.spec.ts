import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { autocorr_regime_switch } from "../../lib/strategies/lib/autocorr_regime_switch";
import { body_thrust_continuation } from "../../lib/strategies/lib/body_thrust_continuation";
import { close_location_streak_continuation } from "../../lib/strategies/lib/close_location_streak_continuation";
import { compression_release_range_expansion } from "../../lib/strategies/lib/compression_release_range_expansion";
import { decay_weighted_momentum_zero_cross } from "../../lib/strategies/lib/decay_weighted_momentum_zero_cross";
import { efficiency_thrust_continuation } from "../../lib/strategies/lib/efficiency_thrust_continuation";
import { gap_zscore_fade } from "../../lib/strategies/lib/gap_zscore_fade";
import { initiative_pressure_surge } from "../../lib/strategies/lib/initiative_pressure_surge";
import { relative_volume_breakout_drive } from "../../lib/strategies/lib/relative_volume_breakout_drive";
import { rolling_channel_position_fade } from "../../lib/strategies/lib/rolling_channel_position_fade";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

const NEW_KEYS = [
    "compression_release_range_expansion",
    "close_location_streak_continuation",
    "efficiency_thrust_continuation",
    "relative_volume_breakout_drive",
    "autocorr_regime_switch",
    "decay_weighted_momentum_zero_cross",
    "rolling_channel_position_fade",
    "gap_zscore_fade",
    "body_thrust_continuation",
    "initiative_pressure_surge",
];

describe("continuation and regime strategy family", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(compression_release_range_expansion.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(close_location_streak_continuation.normalizeParams?.({ streakLength: 1 })).to.deep.equal({ streakLength: 2 });
        expect(close_location_streak_continuation.normalizeParams?.({ streakLength: 3 })).to.deep.equal({ streakLength: 3 });
        expect(efficiency_thrust_continuation.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(relative_volume_breakout_drive.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(autocorr_regime_switch.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(decay_weighted_momentum_zero_cross.normalizeParams?.({ decay: 1.5 })).to.deep.equal({ decay: 0.999 });
        expect(decay_weighted_momentum_zero_cross.normalizeParams?.({ decay: 0.001 })).to.deep.equal({ decay: 0.01 });
        expect(rolling_channel_position_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(gap_zscore_fade.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });
        expect(body_thrust_continuation.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 20 });
        expect(initiative_pressure_surge.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
    });

    it("compression_release_range_expansion buys the expansion bar after a compressed regime", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 56; i++) data.push(bar(i, 100, 101, 99, 100));
        for (let i = 56; i < 60; i++) data.push(bar(i, 100, 100.05, 99.95, 100)); // depressed ranges
        data.push(bar(60, 100, 105, 95, 105)); // expansion bar closing at its high
        const signals = compression_release_range_expansion.execute(data, { lookback: 60 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(60);
    });

    it("close_location_streak_continuation buys when the extreme-close streak first reaches the threshold", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 4; i++) data.push(bar(i, 99, 101, 99, 101)); // close at high each bar
        const signals = close_location_streak_continuation.execute(data, { streakLength: 3 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(2);

        const downData: OHLCVData[] = [];
        for (let i = 0; i < 4; i++) downData.push(bar(i, 101, 101, 99, 99)); // close at low each bar
        const downSignals = close_location_streak_continuation.execute(downData, { streakLength: 3 });
        expect(downSignals).to.have.length(1);
        expect(downSignals[0].type).to.equal("sell");
        expect(downSignals[0].barIndex).to.equal(2);
    });

    it("efficiency_thrust_continuation buys when efficiency crosses into the efficient up regime", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 100.5, 99.5, 100)); // flat
        let close = 100;
        for (let i = 20; i < 40; i++) {
            const open = close;
            close = close + (i % 2 === 0 ? 1 : -1); // choppy, low efficiency
            data.push(bar(i, open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close));
        }
        for (let i = 40; i < 52; i++) {
            const open = close;
            close = close + 2; // clean monotonic run, high efficiency
            data.push(bar(i, open, Math.max(open, close) + 0.1, Math.min(open, close) - 0.1, close));
        }
        const signals = efficiency_thrust_continuation.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(49);
    });

    it("relative_volume_breakout_drive buys a prior-only trailing breakout on a volume surge", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 41; i++) data.push(bar(i, 100, 101, 99, 100, i % 2 === 0 ? 1000 : 1100));
        data.push(bar(41, 100, 102.5, 101, 102, 3000));
        const signals = relative_volume_breakout_drive.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(41);
    });

    it("autocorr_regime_switch buys with the last return when autocorrelation certifies trending", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 42; i++) {
            // Balanced block pattern: long same-sign runs give strong positive
            // lag-1 autocorrelation; the trailing zero bar prevents a spurious
            // fire one bar early, and the final positive return triggers buy.
            let ret = 0;
            if ((i >= 1 && i <= 10) || (i >= 21 && i <= 30) || i === 41) ret = 0.01;
            if ((i >= 11 && i <= 20) || (i >= 31 && i <= 39)) ret = -0.01;
            const open = close;
            close = close * (1 + ret);
            data.push(bar(i, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close));
        }
        const signals = autocorr_regime_switch.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(41);
    });

    it("decay_weighted_momentum_zero_cross buys when the decayed pressure balance flips positive", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 12; i++) {
            const open = close;
            close = close * 0.99;
            data.push(bar(i, open, open * 1.001, close * 0.999, close));
        }
        for (let i = 12; i < 24; i++) {
            const open = close;
            close = close * 1.02;
            data.push(bar(i, open, close * 1.001, open * 0.999, close));
        }
        const signals = decay_weighted_momentum_zero_cross.execute(data, { decay: 0.9 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(14);
    });

    it("rolling_channel_position_fade buys a close in the bottom 5% of the channel", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 3; i++) data.push(bar(i, 100, 100.5, 99.5, 100));
        for (let i = 3; i < 6; i++) data.push(bar(i, 101, 101.5, 100.5, 101));
        for (let i = 6; i < 50; i++) data.push(bar(i, 100.5, 101, 100, 100.5)); // interior closes, no edge touches
        data.push(bar(50, 100.5, 91, 89.5, 90)); // new channel low
        const signals = rolling_channel_position_fade.execute(data, { lookback: 50 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(50);
    });

    it("gap_zscore_fade buys an abnormally large down gap at the open", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 90; i++) {
            const gap = i % 2 === 0 ? 0.0005 : -0.0005;
            const open = close * (1 + gap);
            close = open;
            data.push(bar(i, open, open * 1.001, open * 0.999, close));
        }
        const open = close * 0.95;
        const c = open * 1.01;
        data.push(bar(90, open, Math.max(open, c) * 1.001, Math.min(open, c) * 0.999, c));
        const signals = gap_zscore_fade.execute(data, { lookback: 90 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(90);
    });

    it("body_thrust_continuation buys a statistically extreme dominant up body", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 60; i++) {
            const sign = i % 2 === 0 ? 1 : -1;
            data.push(bar(i, 100, 101, 99, 100 + 0.2 * sign)); // small signed bodies
        }
        data.push(bar(60, 99, 101, 99, 101)); // full-range up body
        const signals = body_thrust_continuation.execute(data, { lookback: 60 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(60);
    });

    it("initiative_pressure_surge buys a fresh surge of volume-weighted acceptance", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 20; i++) data.push(bar(i, 100, 101, 99, 100, 1000)); // mid closes, flat volume
        data.push(bar(20, 99, 101, 99, 101, 2000)); // full-bodied up close at 2x volume
        const signals = initiative_pressure_surge.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(20);
    });
});
