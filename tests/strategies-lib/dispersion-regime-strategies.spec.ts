import { expect } from "chai";
import { describe, it } from "node:test";
import type { OHLCVData, Time } from "../../lib/types/strategies";
import { builtInStrategyKeys } from "../../lib/strategies/manifest-keys";
import { decay_dispersion_fade } from "../../lib/strategies/lib/decay_dispersion_fade";
import { initiative_pressure_extreme_follow } from "../../lib/strategies/lib/initiative_pressure_extreme_follow";
import { placement_forecast_slope } from "../../lib/strategies/lib/placement_forecast_slope";
import { median_crossing_chop_fade } from "../../lib/strategies/lib/median_crossing_chop_fade";
import { trailing_envelope_breakout } from "../../lib/strategies/lib/trailing_envelope_breakout";
import { band_walkaway_fade } from "../../lib/strategies/lib/band_walkaway_fade";
import { vol_expansion_ratio_follow } from "../../lib/strategies/lib/vol_expansion_ratio_follow";
import { return_kurtosis_regime_switch } from "../../lib/strategies/lib/return_kurtosis_regime_switch";
import { cmf_extreme_fade } from "../../lib/strategies/lib/cmf_extreme_fade";
import { trend_slope_strength_follow } from "../../lib/strategies/lib/trend_slope_strength_follow";

const NEW_KEYS = [
    "decay_dispersion_fade",
    "initiative_pressure_extreme_follow",
    "placement_forecast_slope",
    "median_crossing_chop_fade",
    "trailing_envelope_breakout",
    "band_walkaway_fade",
    "vol_expansion_ratio_follow",
    "return_kurtosis_regime_switch",
    "cmf_extreme_fade",
    "trend_slope_strength_follow",
];

function bar(time: number, open: number, high: number, low: number, close: number, volume = 1000): OHLCVData {
    return { time: time as Time, open, high, low, close, volume };
}

function closeLocation(b: OHLCVData): number {
    return (b.close - b.low) / Math.max(1e-12, b.high - b.low);
}

describe("dispersion and regime strategy batch", () => {
    it("registers all new strategies in the built-in manifest", () => {
        for (const key of NEW_KEYS) {
            expect(builtInStrategyKeys, `manifest missing ${key}`).to.include(key);
        }
    });

    it("normalizes params to canonical bounds", () => {
        expect(decay_dispersion_fade.normalizeParams?.({ decay: 0.1 })).to.deep.equal({ decay: 0.5 });
        expect(decay_dispersion_fade.normalizeParams?.({ decay: 0.9995 })).to.deep.equal({ decay: 0.999 });
        expect(band_walkaway_fade.normalizeParams?.({ bandWidth: 9 })).to.deep.equal({ bandWidth: 4 });
        expect(band_walkaway_fade.normalizeParams?.({ bandWidth: 0.1 })).to.deep.equal({ bandWidth: 0.5 });
        expect(vol_expansion_ratio_follow.normalizeParams?.({ lookback: 3 })).to.deep.equal({ lookback: 6 });
        expect(return_kurtosis_regime_switch.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 4 });
        expect(median_crossing_chop_fade.normalizeParams?.({ lookback: 2 })).to.deep.equal({ lookback: 3 });
    });

    it("decay_dispersion_fade buys a bar stretched far below its decay-weighted center", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            data.push(bar(i, 100, 100, 100, 100));
        }
        data.push(bar(40, 100, 100, 100, 98));
        const signals = decay_dispersion_fade.execute(data, { decay: 0.95 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(40);
    });

    it("initiative_pressure_extreme_follow buys only the extreme-pressure spike bar", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            // Alternating signed acceptance gives dispersion so quiet bars do not pin a tail.
            data.push(bar(i, 100, 101, 99, i % 2 === 0 ? 100.8 : 99.2));
        }
        data.push(bar(40, 99.5, 102, 99, 101.5, 3000));
        const signals = initiative_pressure_extreme_follow.execute(data, { lookback: 30 });
        const buys = signals.filter((s) => s.type === "buy");
        expect(buys).to.have.length(1);
        expect(buys[0].barIndex).to.equal(40);
        expect(signals.some((s) => s.type === "sell")).to.equal(true);
    });

    it("placement_forecast_slope follows the current bar when placement predicts the next return", () => {
        const data: OHLCVData[] = [];
        let prevClose = 100;
        for (let i = 0; i < 42; i++) {
            // Even bars close low in range with a negative return; odd bars close high
            // with a positive return. Pairs (L[j-1], R[j]) are then strongly positive.
            const close = i % 2 === 0 ? prevClose - 0.5 : prevClose + 0.5;
            const high = i % 2 === 0 ? close + 0.5 : close + 2;
            const low = i % 2 === 0 ? close - 2 : close - 0.5;
            data.push(bar(i, prevClose, high, low, close));
            prevClose = close;
        }
        const signals = placement_forecast_slope.execute(data, { lookback: 40 });
        expect(signals.some((s) => s.type === "buy")).to.equal(true);
        expect(signals.some((s) => s.type === "sell")).to.equal(true);
        for (const signal of signals) {
            const location = closeLocation(data[signal.barIndex!]);
            if (signal.type === "buy") {
                expect(location, "buy must fire on high placement").to.be.greaterThanOrEqual(0.6);
            } else {
                expect(location, "sell must fire on low placement").to.be.lessThanOrEqual(0.4);
            }
        }
    });

    it("median_crossing_chop_fade fades toward the median when close flips it constantly", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 50; i++) {
            data.push(bar(i, 100, 101, 98, i % 2 === 0 ? 100.2 : 99));
        }
        const signals = median_crossing_chop_fade.execute(data, { lookback: 24 });
        expect(signals.some((s) => s.type === "buy")).to.equal(true);
        expect(signals.some((s) => s.type === "sell")).to.equal(true);
        for (const signal of signals) {
            const b = data[signal.barIndex!];
            if (signal.type === "buy") {
                expect(b.close, "chop-fade buy must be below the median").to.be.lessThan(b.open);
            } else {
                expect(b.close, "chop-fade sell must be above the median").to.be.greaterThan(b.open);
            }
        }
    });

    it("trailing_envelope_breakout buys an earned breakout of the prior-only envelope", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 35; i++) {
            data.push(bar(i, 100, 101, 99, 100));
        }
        data.push(bar(35, 100.5, 103, 100.4, 102.5));
        const signals = trailing_envelope_breakout.execute(data, { lookback: 20 });
        expect(signals).to.have.length(1);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(35);
    });

    it("band_walkaway_fade buys after consecutive closes below the lower band", () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 25; i++) {
            data.push(bar(i, 100, 100.1, 99.9, 100));
        }
        for (let i = 25; i < 31; i++) {
            data.push(bar(i, 99.6, 99.6, 98.7, 98.8));
        }
        const signals = band_walkaway_fade.execute(data, { bandWidth: 2 });
        expect(signals.length).to.be.greaterThan(0);
        for (const signal of signals) {
            expect(signal.type).to.equal("buy");
        }
        expect(signals[0].barIndex).to.equal(28);
    });

    it("vol_expansion_ratio_follow follows the expansion bar's direction", () => {
        const data: OHLCVData[] = [];
        let prevClose = 100;
        for (let i = 0; i < 40; i++) {
            const close = prevClose + (i % 2 === 1 ? 0.1 : 0);
            data.push(bar(i, prevClose, Math.max(prevClose, close) + 0.01, Math.min(prevClose, close) - 0.01, close));
            prevClose = close;
        }
        for (let i = 40; i < 62; i++) {
            const close = prevClose * (1 + (i % 2 === 0 ? 0.02 : -0.02));
            data.push(bar(i, prevClose, Math.max(prevClose, close) * 1.01, Math.min(prevClose, close) * 0.99, close));
            prevClose = close;
        }
        const signals = vol_expansion_ratio_follow.execute(data, { lookback: 60 });
        expect(signals).to.have.length(2);
        expect(signals[0].type).to.equal("buy");
        expect(signals[0].barIndex).to.equal(60);
        expect(signals[1].type).to.equal("sell");
        expect(signals[1].barIndex).to.equal(61);
    });

    it("return_kurtosis_regime_switch follows moves in a thin-tailed return regime", () => {
        const data: OHLCVData[] = [];
        let prevClose = 100;
        for (let i = 0; i < 50; i++) {
            const close = prevClose * (1 + (i % 2 === 0 ? 0.005 : -0.005));
            data.push(bar(i, prevClose, Math.max(prevClose, close) * 1.001, Math.min(prevClose, close) * 0.999, close));
            prevClose = close;
        }
        const signals = return_kurtosis_regime_switch.execute(data, { lookback: 40 });
        expect(signals.some((s) => s.type === "buy")).to.equal(true);
        expect(signals.some((s) => s.type === "sell")).to.equal(true);
        for (const signal of signals) {
            const b = data[signal.barIndex!];
            if (signal.type === "buy") {
                expect(b.close, "follow buy must be on an up bar").to.be.greaterThan(b.open);
            } else {
                expect(b.close, "follow sell must be on a down bar").to.be.lessThan(b.open);
            }
        }
    });

    it("cmf_extreme_fade sells persistent accumulation and buys persistent distribution", () => {
        const accumulation: OHLCVData[] = [];
        const distribution: OHLCVData[] = [];
        for (let i = 0; i < 40; i++) {
            accumulation.push(bar(i, 100, 101.5, 99.5, 101)); // close near high -> +0.5 multiplier
            distribution.push(bar(i, 100, 100.5, 98.5, 99)); // close near low -> -0.5 multiplier
        }
        const sellSignals = cmf_extreme_fade.execute(accumulation, { lookback: 30 });
        expect(sellSignals.length).to.be.greaterThan(0);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
        const buySignals = cmf_extreme_fade.execute(distribution, { lookback: 30 });
        expect(buySignals.length).to.be.greaterThan(0);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
    });

    it("trend_slope_strength_follow buys clean uptrends and sells clean downtrends", () => {
        const rising: OHLCVData[] = [];
        const falling: OHLCVData[] = [];
        for (let i = 0; i < 45; i++) {
            const upClose = 100 + i * 0.5;
            const downClose = 100 - i * 0.5;
            rising.push(bar(i, upClose - 0.1, upClose + 0.2, upClose - 0.2, upClose));
            falling.push(bar(i, downClose - 0.1, downClose + 0.2, downClose - 0.2, downClose));
        }
        const buySignals = trend_slope_strength_follow.execute(rising, { lookback: 30 });
        expect(buySignals.length).to.be.greaterThan(0);
        for (const signal of buySignals) {
            expect(signal.type).to.equal("buy");
        }
        const sellSignals = trend_slope_strength_follow.execute(falling, { lookback: 30 });
        expect(sellSignals.length).to.be.greaterThan(0);
        for (const signal of sellSignals) {
            expect(signal.type).to.equal("sell");
        }
    });
});
