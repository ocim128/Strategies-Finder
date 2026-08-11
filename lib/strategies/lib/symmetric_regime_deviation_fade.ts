import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingSkewness, buildRollingZScore } from "./price-action-statistics-core";

const SYMMETRY_BAND = 0.5;
const DEVIATION_BAND = 2.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 24))),
    };
}

export const symmetric_regime_deviation_fade: Strategy = {
    name: "Symmetric Regime Deviation Fade",
    description: "Fades close deviations only when the one-bar return distribution is near-symmetric (skew inside a fixed band).",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Distribution Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const skewness = buildRollingSkewness(extractBarMetricSeries(cleanData, "closeReturn"), lookback);
        const z = buildRollingZScore(getCloses(cleanData), lookback);

        return createSignalLoop(cleanData, [skewness, z], (i) => {
            const skew = skewness[i];
            const score = z[i];
            if (skew === null || score === null) return null;

            // A skewed return distribution is a nascent trend; only fade when
            // the distribution is symmetric enough to be noise around a level.
            if (Math.abs(skew) > SYMMETRY_BAND) return null;

            if (score <= -DEVIATION_BAND) {
                return createBuySignal(cleanData, i, `Symmetric-regime buy: skew ${skew.toFixed(2)} symmetric, close z ${score.toFixed(2)}`);
            }
            if (score >= DEVIATION_BAND) {
                return createSellSignal(cleanData, i, `Symmetric-regime sell: skew ${skew.toFixed(2)} symmetric, close z ${score.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
