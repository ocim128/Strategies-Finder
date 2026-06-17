import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingStdDev,
    buildPercentileRank,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 35))),
        volThreshold: Math.max(0.5, Math.min(0.999, Number(params.volThreshold ?? 0.90))),
        zThreshold: Math.max(0.01, Number(params.zThreshold ?? 1.8)),
    };
}

export const volatility_percentile_reversion_fade: Strategy = {
    name: "Volatility Percentile Reversion Fade",
    description: "Fades ratio price extensions from the rolling median when the percentile rank of return volatility is exceptionally high.",
    defaultParams: {
        lookback: 35,
        volThreshold: 0.90,
        zThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volThreshold: "Vol Percentile Threshold",
        zThreshold: "Price Z-Score Threshold",
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
        const closeZ = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [volPct, closeZ], (i) => {
            const vp = volPct[i];
            const cz = closeZ[i];
            if (vp === null || cz === null) return null;

            // Buy: close z-score is extremely negative and return volatility percentile is high
            if (cz < -p.zThreshold && vp > p.volThreshold) {
                return createBuySignal(cleanData, i, `Volatility percentile reversion buy: Close Z ${cz.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
            }
            // Sell: close z-score is extremely positive and return volatility percentile is high
            if (cz > p.zThreshold && vp > p.volThreshold) {
                return createSellSignal(cleanData, i, `Volatility percentile reversion sell: Close Z ${cz.toFixed(2)}, Vol Pct ${vp.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volThreshold", "zThreshold"],
    },
};
