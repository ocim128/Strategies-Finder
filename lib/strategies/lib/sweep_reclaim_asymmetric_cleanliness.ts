import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_score: Math.max(0.01, Number(params.min_score ?? 0.25)),
    };
}

export const sweep_reclaim_asymmetric_cleanliness: Strategy = {
    name: "Sweep Reclaim Asymmetric Cleanliness",
    description: "Enters pure one-sided liquidity sweep reclaims that leave the opposing boundary strictly unviolated.",
    defaultParams: {
        min_score: 0.25,
    },
    paramLabels: {
        min_score: "Min Sweep Score",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minScore = p.min_score as number;
        if (cleanData.length < 2) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweep], (i) => {
            if (i < 1) return null;
            const score = sweep[i];
            if (score === null) return null;

            // Buy: Spring sweep of low (score >= minScore) with opposing ceiling untouched (high <= prior high)
            if (score >= minScore && cleanData[i].high <= cleanData[i - 1].high) {
                return createBuySignal(cleanData, i, `Bullish clean sweep: spring score ${score.toFixed(3)} >= ${minScore}, high <= prior high`);
            }

            // Sell: Upthrust sweep of high (score <= -minScore) with opposing floor untouched (low >= prior low)
            if (score <= -minScore && cleanData[i].low >= cleanData[i - 1].low) {
                return createSellSignal(cleanData, i, `Bearish clean sweep: upthrust score ${score.toFixed(3)} <= -${minScore}, low >= prior low`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_score"],
    },
};
