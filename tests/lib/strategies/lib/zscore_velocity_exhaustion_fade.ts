import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.0)),
    };
}

export const zscore_velocity_exhaustion_fade: Strategy = {
    name: "Z-Score Velocity Exhaustion Fade",
    description: "Fades extreme close price z-scores when the velocity of the z-score decelerates.",
    defaultParams: {
        lookback: 30,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Close Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const closeZ = buildRollingZScore(closes, lookback);
        const closeZNumbers = closeZ.map((v) => (v !== null ? v : 0));
        // 1-bar rate of change of the close z-score
        const zRoc = buildRateOfChange(closeZNumbers, 1);

        return createSignalLoop(cleanData, [closeZ, zRoc], (i) => {
            const z = closeZ[i];
            const vel = zRoc[i];
            if (z === null || vel === null) return null;

            // Buy: close z-score is below -zThreshold and z-score ROC is positive (turning upward)
            if (z < -p.zThreshold && vel > 0) {
                return createBuySignal(cleanData, i, `Z-score velocity buy: Z ${z.toFixed(2)}, ROC ${vel.toFixed(4)}`);
            }
            // Sell: close z-score is above zThreshold and z-score ROC is negative (turning downward)
            if (z > p.zThreshold && vel < 0) {
                return createSellSignal(cleanData, i, `Z-score velocity sell: Z ${z.toFixed(2)}, ROC ${vel.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
