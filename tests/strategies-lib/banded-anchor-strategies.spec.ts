import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { banded_robust_single_bar_fade } from "../../lib/strategies/lib/banded_robust_single_bar_fade";
import { conviction_volatility_coherence_follow } from "../../lib/strategies/lib/conviction_volatility_coherence_follow";
import { cumulative_return_percentile_follow } from "../../lib/strategies/lib/cumulative_return_percentile_follow";
import { deviation_close_location_agreement_fade } from "../../lib/strategies/lib/deviation_close_location_agreement_fade";
import { direction_alternation_fade } from "../../lib/strategies/lib/direction_alternation_fade";
import { moderate_gap_reversion } from "../../lib/strategies/lib/moderate_gap_reversion";
import { prior_bar_body_mid_reversion } from "../../lib/strategies/lib/prior_bar_body_mid_reversion";
import { return_median_zero_cross } from "../../lib/strategies/lib/return_median_zero_cross";
import { symmetric_regime_deviation_fade } from "../../lib/strategies/lib/symmetric_regime_deviation_fade";
import { weighted_close_envelope_fade } from "../../lib/strategies/lib/weighted_close_envelope_fade";

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

// Baseline of alternating ±0.1% returns around a level.
function alternatingBaseline(count: number): OHLCVData[] {
    const data: OHLCVData[] = [];
    let close = 100;
    for (let i = 0; i < count; i++) {
        const open = close;
        close = close * (1 + (i % 2 === 0 ? 0.001 : -0.001));
        data.push(bar(i, open, Math.max(open, close) * 1.001, Math.min(open, close) * 0.999, close));
    }
    return data;
}

const NEW_KEYS = [
    "banded_robust_single_bar_fade",
    "prior_bar_body_mid_reversion",
    "return_median_zero_cross",
    "deviation_close_location_agreement_fade",
    "moderate_gap_reversion",
    "cumulative_return_percentile_follow",
    "conviction_volatility_coherence_follow",
    "symmetric_regime_deviation_fade",
    "direction_alternation_fade",
    "weighted_close_envelope_fade",
];

describe("banded and anchor strategy family", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(banded_robust_single_bar_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(prior_bar_body_mid_reversion.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 5 });
        expect(return_median_zero_cross.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(deviation_close_location_agreement_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(moderate_gap_reversion.normalizeParams?.({ lookback: 10 })).to.deep.equal({ lookback: 15 });
        expect(cumulative_return_percentile_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(conviction_volatility_coherence_follow.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(symmetric_regime_deviation_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
        expect(direction_alternation_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 8 });
        expect(weighted_close_envelope_fade.normalizeParams?.({ lookback: 5 })).to.deep.equal({ lookback: 10 });
    });

    it("banded_robust_single_bar_fade fades only the moderate band, both sides", () => {
        // +0.3% over the previous close: robust z lands in the upper band.
        const sellBase = alternatingBaseline(20);
        const sellOpen = sellBase[19].close;
        const sellClose = sellOpen * 1.003;
        sellBase.push(bar(20, sellOpen, sellClose * 1.001, sellOpen * 0.999, sellClose));
        const sellSignals = banded_robust_single_bar_fade.execute(sellBase, { lookback: 20 });
        expect(sellSignals).to.have.length(1);
        expect(sellSignals[0].type).to.equal("sell");
        expect(sellSignals[0].barIndex).to.equal(20);

        // -0.4% over the previous close: robust z lands in the lower band.
        const buyBase = alternatingBaseline(20);
        const buyOpen = buyBase[19].close;
        const buyClose = buyOpen * 0.996;
        buyBase.push(bar(20, buyOpen, buyOpen * 1.001, buyClose * 0.999, buyClose));
        const buySignals = banded_robust_single_bar_fade.execute(buyBase, { lookback: 20 });
        expect(buySignals).to.have.length(1);
        expect(buySignals[0].type).to.equal("buy");
        expect(buySignals[0].barIndex).to.equal(20);
    });

    it("prior_bar_body_mid_reversion buys a close two ATRs below the prior bar's body midpoint", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 14; i++) data.push(bar(i, 100, 101, 99, 100));
        data.push(bar(14, 99, 100, 94, 94));
        const signals = prior_bar_body_mid_reversion.execute(data, { lookback: 14 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(14);
    });

    it("return_median_zero_cross buys when the return-distribution median flips positive", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 30; i++) {
            const open = close;
            close = close * 0.999;
            data.push(bar(i, open, open * 1.001, close * 0.999, close));
        }
        for (let i = 30; i < 50; i++) {
            const open = close;
            close = close * 1.002;
            data.push(bar(i, open, close * 1.001, open * 0.999, close));
        }
        const signals = return_median_zero_cross.execute(data, { lookback: 30 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(44);
    });

    it("deviation_close_location_agreement_fade buys a stretched bar closing at its low", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 24; i++) {
            const close = i % 2 === 0 ? 99.9 : 100.1;
            data.push(bar(i, 100, close + 0.1, close - 0.1, close));
        }
        data.push(bar(24, 99.5, 99.5, 98, 98));
        const signals = deviation_close_location_agreement_fade.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(24);
    });

    it("moderate_gap_reversion buys a moderate down gap that fills back through the prior close", () => {
        const data: OHLCVData[] = [];
        let close = 100;
        for (let i = 0; i < 40; i++) {
            const gap = 0.0001 + 0.0001 * (i % 40);
            const open = close * (1 + gap);
            close = open;
            data.push(bar(i, open, open * 1.001, open * 0.999, close));
        }
        const open = close * (1 - 0.0031);
        const c = close * 1.002;
        data.push(bar(40, open, c * 1.001, open * 0.999, c));
        const signals = moderate_gap_reversion.execute(data, { lookback: 40 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("cumulative_return_percentile_follow buys momentum ignition at the top percentile crossing", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            const close = i % 2 === 0 ? 100 : 100.1;
            data.push(bar(i, 100, close + 0.1, close - 0.1, close));
        }
        data.push(bar(40, 100.1, 112.1, 112, 112));
        const signals = cumulative_return_percentile_follow.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("conviction_volatility_coherence_follow buys the first clean bar after coherence is established", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 24; i++) {
            if (i % 2 === 0) data.push(bar(i, 100, 103, 97, 100)); // big range, tiny body
            else data.push(bar(i, 99.5, 100.5, 99.5, 100.5)); // small range, full body
        }
        let close = 100.5;
        for (let i = 24; i < 44; i++) {
            if (i % 2 === 0) {
                const open = close;
                close = open + 6; // big range with full up body
                data.push(bar(i, open, close, open, close));
            } else {
                const open = close;
                close = open + 0.1; // small range with tiny body
                data.push(bar(i, open, open + 0.5, open, close));
            }
        }
        const signals = conviction_volatility_coherence_follow.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(42);
    });

    it("symmetric_regime_deviation_fade buys only inside a symmetric return distribution", () => {
        const base = alternatingBaseline(24);
        const open = base[23].close;
        const drop = [...base, bar(24, open, open * 1.001, open * 0.9975 * 0.999, open * 0.9975)];
        const signals = symmetric_regime_deviation_fade.execute(drop, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(24);

        // A much larger drop makes the window asymmetric; the gate must stay silent.
        const bigDrop = [...base, bar(24, open, open * 1.001, open * 0.99 * 0.999, open * 0.99)];
        const gated = symmetric_regime_deviation_fade.execute(bigDrop, { lookback: 24 });
        expect(gated).to.have.length(0);
    });

    it("direction_alternation_fade sells an up bar inside a certified alternating regime", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 22; i++) {
            const down = i % 2 === 0;
            data.push(bar(i, 100, down ? 100 : 101, down ? 99 : 100, down ? 99 : 101));
        }
        const signals = direction_alternation_fade.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("sell");
        expect(signals[0].barIndex).to.equal(21);
    });

    it("weighted_close_envelope_fade buys the weighted close crossing below the envelope floor", () => {
        const data: OHLCVData[] = [];
        data.push(bar(0, 99.9, 100.4, 99.4, 99.9));
        data.push(bar(1, 100.6, 101.1, 100.1, 100.6));
        for (let i = 2; i < 24; i++) {
            const close = i % 2 === 0 ? 100.2 : 100.4;
            data.push(bar(i, close, close + 0.5, close - 0.5, close));
        }
        data.push(bar(24, 99.5, 100, 99, 99.5));
        const signals = weighted_close_envelope_fade.execute(data, { lookback: 24 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(24);
    });
});
