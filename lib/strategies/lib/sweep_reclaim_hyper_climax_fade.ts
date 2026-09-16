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
        climax_threshold: Math.max(0.01, Number(params.climax_threshold ?? 0.75)),
    };
}

export const sweep_reclaim_hyper_climax_fade: Strategy = {
    name: "Sweep Reclaim Hyper Climax Fade",
    description: "Fades hyper-extended single-bar liquidity blowoffs where sweep score reaches extreme climax levels.",
    defaultParams: {
        climax_threshold: 0.75,
    },
    paramLabels: {
        climax_threshold: "Climax Sweep Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const climax_threshold = p.climax_threshold as number;
        if (cleanData.length < 2) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweep], (i) => {
            const score = sweep[i];
            if (score === null) return null;

            if (score <= -climax_threshold) {
                return createBuySignal(cleanData, i, `Bullish climax sweep fade: sweep score ${score.toFixed(3)} <= -${climax_threshold}`);
            }
            if (score >= climax_threshold) {
                return createSellSignal(cleanData, i, `Bearish climax sweep fade: sweep score ${score.toFixed(3)} >= ${climax_threshold}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["climax_threshold"],
    },
};
