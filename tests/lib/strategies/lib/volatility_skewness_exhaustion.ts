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
    buildRollingSkewness,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        skewThreshold: Number(params.skewThreshold ?? 1.5),
    };
}

export const volatility_skewness_exhaustion: Strategy = {
    name: "Volatility Skewness Exhaustion",
    description: "Fades price z-score extensions when rolling skewness of return volatility is positive and extreme, signaling volatility decay.",
    defaultParams: {
        lookback: 40,
        skewThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        skewThreshold: "Skewness Threshold",
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

        const volSkew = buildRollingSkewness(volClean, lookback);
        const closeZ = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [volSkew, closeZ], (i) => {
            const vs = volSkew[i];
            const cz = closeZ[i];
            if (vs === null || cz === null) return null;

            // Buy: close z-score is extremely negative and return volatility skew is high
            if (cz < -1.8 && vs > p.skewThreshold) {
                return createBuySignal(cleanData, i, `Volatility skewness exhaustion buy: Close Z ${cz.toFixed(2)}, Skew ${vs.toFixed(2)}`);
            }
            // Sell: close z-score is extremely positive and return volatility skew is high
            if (cz > 1.8 && vs > p.skewThreshold) {
                return createSellSignal(cleanData, i, `Volatility skewness exhaustion sell: Close Z ${cz.toFixed(2)}, Skew ${vs.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold"],
    },
};
