import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRangeSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingStdDev, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        rangePctThreshold: Math.max(0.5, Math.min(0.999, Number(params.rangePctThreshold ?? 0.85))),
        maxVolPercentile: Math.max(0.01, Math.min(0.99, Number(params.maxVolPercentile ?? 0.40))),
    };
}

export const range_volatility_divergence_fade: Strategy = {
    name: "Range Volatility Divergence Fade",
    description: "Fades ratio price extensions when range percentile is extremely high (intrabar divergence) but return volatility is low.",
    defaultParams: {
        lookback: 30,
        rangePctThreshold: 0.85,
        maxVolPercentile: 0.40,
    },
    paramLabels: {
        lookback: "Lookback Window",
        rangePctThreshold: "Range Percentile Threshold",
        maxVolPercentile: "Max Vol Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
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

            const cl = closeLoc[i];

            // Buy: range is extremely high, return volatility is low, close location is low (hammer-like fade)
            if (rp > p.rangePctThreshold && vp < p.maxVolPercentile && cl < 0.3) {
                return createBuySignal(cleanData, i, `Range volatility divergence buy: Range Pct ${rp.toFixed(2)}, Vol Pct ${vp.toFixed(2)}, CL ${cl.toFixed(2)}`);
            }
            // Sell: range is extremely high, return volatility is low, close location is high (shooting-star-like fade)
            if (rp > p.rangePctThreshold && vp < p.maxVolPercentile && cl > 0.7) {
                return createSellSignal(cleanData, i, `Range volatility divergence sell: Range Pct ${rp.toFixed(2)}, Vol Pct ${vp.toFixed(2)}, CL ${cl.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePctThreshold", "maxVolPercentile"],
    },
};
