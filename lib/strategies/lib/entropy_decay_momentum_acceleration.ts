import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore, buildPercentileRank, buildRollingEntropy } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        entropyPercentileMax: Math.max(0.01, Math.min(0.99, Number(params.entropyPercentileMax ?? 0.30))),
    };
}

export const entropy_decay_momentum_acceleration: Strategy = {
    name: "Entropy Decay Momentum Acceleration",
    description: "Triggers trend-following entries when typical price z-score velocity accelerates out of a low-entropy state.",
    defaultParams: {
        lookback: 30,
        entropyPercentileMax: 0.30,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyPercentileMax: "Max Entropy Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const typical = getTypicalPrices(cleanData);
        const entropy = buildRollingEntropy(typical, lookback);
        const entropyClean = entropy.map((v) => v ?? 0);

        const entropyPct = buildPercentileRank(entropyClean, lookback);
        const typicalZ = buildRollingZScore(typical, lookback);
        const typicalZClean = typicalZ.map((v) => v ?? 0);

        const typicalZVel = buildRateOfChange(typicalZClean, 1);

        return createSignalLoop(cleanData, [entropyPct, typicalZVel], (i) => {
            const ep = entropyPct[i];
            const tzVel = typicalZVel[i];
            if (ep === null || tzVel === null) return null;

            // Ensure lookback for prior compression check
            if (i < 2) return null;
            const ep1 = entropyPct[i - 1];
            const ep2 = entropyPct[i - 2];
            if (ep1 === null || ep2 === null) return null;

            // Entropy was compressed within the last 3 bars
            const wasCompressed = ep < p.entropyPercentileMax || ep1 < p.entropyPercentileMax || ep2 < p.entropyPercentileMax;
            if (!wasCompressed) return null;

            // Buy: velocity of z-score is positive and accelerating
            if (tzVel > 0.50) {
                return createBuySignal(cleanData, i, `Entropy decay velocity buy: Vel ${tzVel.toFixed(2)}`);
            }
            // Sell: velocity of z-score is negative and accelerating
            if (tzVel < -0.50) {
                return createSellSignal(cleanData, i, `Entropy decay velocity sell: Vel ${tzVel.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyPercentileMax"],
    },
};
