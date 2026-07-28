import assert from "node:assert/strict";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../lib/strategies/strategy-helpers";
import { calculateVWAP } from "../lib/strategies/indicators";
import { buildCloseLocationSeries, buildRangeSeries } from "../lib/strategies/lib/price-action-frequency-core";
import {
    buildPercentileRank,
    buildRateOfChange,
    buildRollingStdDev,
    buildStreakCount,
} from "../lib/strategies/lib/price-action-statistics-core";
import { vwap_regime_gradient_streak } from "../lib/strategies/lib/vwap_regime_gradient_streak";
import { compression_close_location_expansion } from "../lib/strategies/lib/compression_close_location_expansion";
import type { OHLCVData, Signal, StrategyParams, Time } from "../lib/types/strategies";

const data: OHLCVData[] = Array.from({ length: 700 }, (_, index) => {
    const close = 100 + Math.sin(index / 9) * 4 + Math.sin(index / 37) * 2 + index * 0.02;
    return {
        time: (1_700_000_000 + index * 14_400) as Time,
        open: close - Math.sin(index / 5) * 0.3,
        high: close + 1 + (index % 7) * 0.05,
        low: close - 1 - (index % 5) * 0.04,
        close,
        volume: 1_000 + (index % 23) * 37,
    };
});

function referenceVwap(dataInput: OHLCVData[], params: StrategyParams): Signal[] {
    const cleanData = ensureCleanData(dataInput);
    const lookback = Math.max(3, Math.round(Number(params.lookback ?? 30)));
    const minStreak = Math.max(1, Math.round(Number(params.minStreak ?? 3)));
    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const volumes = cleanData.map((bar) => bar.volume);
    const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
    const closeLoc = buildCloseLocationSeries(cleanData);
    const gradFlags = new Array<number>(cleanData.length).fill(0);
    for (let i = 1; i < cleanData.length; i++) {
        const grad = closeLoc[i] - closeLoc[i - 1];
        if (grad > 0) gradFlags[i] = 1;
        else if (grad < 0) gradFlags[i] = -1;
    }
    const streaks = buildStreakCount(gradFlags);
    return createSignalLoop(cleanData, [vwap], (i) => {
        if (i < lookback || vwap[i] === null) return null;
        if (closes[i] > vwap[i]! && streaks[i] >= minStreak) {
            return createBuySignal(cleanData, i, `VWAP Grad Streak Buy: Streak ${streaks[i]}`);
        }
        if (closes[i] < vwap[i]! && streaks[i] <= -minStreak) {
            return createSellSignal(cleanData, i, `VWAP Grad Streak Sell: Streak ${streaks[i]}`);
        }
        return null;
    });
}

function referenceCompression(dataInput: OHLCVData[], params: StrategyParams): Signal[] {
    const cleanData = ensureCleanData(dataInput);
    const lookback = Math.max(4, Math.round(Number(params.lookback ?? 30)));
    const volPercentileMax = Math.max(0.1, Math.min(0.9, Number(params.volPercentileMax ?? 0.30)));
    const rangePercentileMin = Math.max(0.5, Math.min(0.99, Number(params.rangePercentileMin ?? 0.75)));
    const closes = getCloses(cleanData);
    const closeLocation = buildCloseLocationSeries(cleanData);
    const returns = buildRateOfChange(closes, 1);
    const returnsClean = returns.map(value => value ?? 0);
    const volStdDev = buildRollingStdDev(returnsClean, lookback);
    const volPctl = buildPercentileRank(volStdDev.map(value => value ?? 0), lookback);
    const rangePctl = buildPercentileRank(buildRangeSeries(cleanData), lookback);
    return createSignalLoop(cleanData, [volPctl, rangePctl], (i) => {
        const vp = volPctl[i];
        const rp = rangePctl[i];
        if (vp === null || rp === null || vp >= volPercentileMax || rp < rangePercentileMin) return null;
        const cl = closeLocation[i];
        if (cl > 0.60) {
            return createBuySignal(cleanData, i, `Compression break vol pctl ${vp.toFixed(2)} range pctl ${rp.toFixed(2)} bullish CL ${cl.toFixed(2)}`);
        }
        if (cl < 0.40) {
            return createSellSignal(cleanData, i, `Compression break vol pctl ${vp.toFixed(2)} range pctl ${rp.toFixed(2)} bearish CL ${cl.toFixed(2)}`);
        }
        return null;
    });
}

assert.deepEqual(
    vwap_regime_gradient_streak.execute(data, { lookback: 30, minStreak: 3 }),
    referenceVwap(data, { lookback: 30, minStreak: 3 }),
    "VWAP optimization must preserve every signal and reason",
);
assert.deepEqual(
    compression_close_location_expansion.execute(data, {
        lookback: 196,
        volPercentileMax: 0.9,
        rangePercentileMin: 0.5,
    }),
    referenceCompression(data, {
        lookback: 196,
        volPercentileMax: 0.9,
        rangePercentileMin: 0.5,
    }),
    "compression optimization must preserve every signal and reason",
);

console.log("PASS: exit-strategy-optimization.spec.ts");
