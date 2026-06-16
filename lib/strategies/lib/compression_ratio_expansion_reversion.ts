import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        compressThreshold: Math.max(0.01, Math.min(0.99, Number(params.compressThreshold ?? 0.30))),
        rangePercentileMin: Math.max(0.01, Math.min(0.99, Number(params.rangePercentileMin ?? 0.80))),
    };
}

export const compression_ratio_expansion_reversion: Strategy = {
    name: "Compression Ratio Expansion Reversion",
    description: "Fades failed breakouts following volatility compression.",
    defaultParams: {
        lookback: 30,
        compressThreshold: 0.30,
        rangePercentileMin: 0.80,
    },
    paramLabels: {
        lookback: "Lookback Window",
        compressThreshold: "Compression Threshold",
        rangePercentileMin: "Min Range Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = cleanData.map((bar) => bar.close);
        const roc1 = buildRateOfChange(closes, 1);
        const returns = roc1.map((v) => v ?? 0);

        const vol = buildRollingStdDev(returns, lookback);
        const volClean = vol.map((v) => v ?? 0);

        const volPct = buildPercentileRank(volClean, lookback);

        const ranges = buildRangeSeries(cleanData);
        const rangePct = buildPercentileRank(ranges, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [volPct, rangePct], (i) => {
            const vp = volPct[i];
            const rp = rangePct[i];
            if (vp === null || rp === null) return null;

            // Ensure we have lookback window for compression check
            if (i < 2) return null;
            const vp1 = volPct[i - 1];
            const vp2 = volPct[i - 2];
            if (vp1 === null || vp2 === null) return null;

            // Volatility was compressed within the last 3 bars
            const wasCompressed = vp < p.compressThreshold || vp1 < p.compressThreshold || vp2 < p.compressThreshold;
            if (!wasCompressed) return null;

            const cl = closeLoc[i];
            const isCloseCentered = cl >= 0.45 && cl <= 0.55;
            if (!isCloseCentered) return null;

            const bar = cleanData[i];
            const midpoint = (bar.high + bar.low) / 2;
            const open = bar.open;

            // Buy: failed breakout to the downside (open in upper half, meaning we attempted down but closed center)
            if (rp > p.rangePercentileMin && open > midpoint) {
                return createBuySignal(cleanData, i, `Compression failed downside breakout: Range Pct ${rp.toFixed(2)}`);
            }
            // Sell: failed breakout to the upside (open in lower half, meaning we attempted up but closed center)
            if (rp > p.rangePercentileMin && open < midpoint) {
                return createSellSignal(cleanData, i, `Compression failed upside breakout: Range Pct ${rp.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "compressThreshold", "rangePercentileMin"],
    },
};
