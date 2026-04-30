import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

const VELOCITY_ZSCORE_THRESHOLD = 1.5;

function normalizePriceVelocityZScoreRegimeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        rocWindow: Math.max(1, Math.round(params.rocWindow ?? 10)),
        zLookback: Math.max(2, Math.round(params.zLookback ?? 63)),
    };
}

export const price_velocity_zscore_regime: Strategy = {
    name: "Price Velocity Z-Score Regime",
    description:
        "Normalizes price velocity with a rolling z-score and enters only when momentum reaches escape velocity relative to its recent regime.",
    defaultParams: {
        rocWindow: 10,
        zLookback: 63,
    },
    paramLabels: {
        rocWindow: "ROC Window",
        zLookback: "Z-Score Lookback",
    },
    normalizeParams: normalizePriceVelocityZScoreRegimeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePriceVelocityZScoreRegimeParams(params);
        const rocWindow = p.rocWindow as number;
        const zLookback = p.zLookback as number;
        const minBars = rocWindow + zLookback - 1;
        if (cleanData.length < minBars + 1) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, rocWindow);
        const rocValues = roc.map((value) => value ?? 0);
        const zScore = buildRollingZScore(rocValues, zLookback);

        return createSignalLoop(cleanData, [zScore], (i) => {
            if (i < minBars) return null;

            const velocityZ = zScore[i];
            if (velocityZ === null) return null;

            if (velocityZ > VELOCITY_ZSCORE_THRESHOLD) {
                return createBuySignal(cleanData, i, `Velocity z-score ${velocityZ.toFixed(2)} above escape threshold`);
            }
            if (velocityZ < -VELOCITY_ZSCORE_THRESHOLD) {
                return createSellSignal(cleanData, i, `Velocity z-score ${velocityZ.toFixed(2)} below escape threshold`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rocWindow", "zLookback"],
    },
};
