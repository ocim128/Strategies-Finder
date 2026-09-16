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
        min_initial_score: Math.max(0.05, Number(params.min_initial_score ?? 0.35)),
    };
}

export const sweep_reclaim_absorption_decay_fade: Strategy = {
    name: "Sweep Reclaim Absorption Decay Fade",
    description: "Fades exhausted support/resistance when sweep reclaim scores decay across 3 consecutive bars.",
    defaultParams: {
        min_initial_score: 0.35,
    },
    paramLabels: {
        min_initial_score: "Minimum Initial Sweep Score",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const minInitial = Number(params.min_initial_score);

        const sweepScores = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweepScores], (i) => {
            if (i < 2) return null;
            const s0 = sweepScores[i];
            const s1 = sweepScores[i - 1];
            const s2 = sweepScores[i - 2];
            if (s0 === null || s1 === null || s2 === null) return null;

            // Decaying upthrust defense: fading decayed resistance probes into upside breakdown/reversal
            if (s2 <= -minInitial && s1 < 0 && s0 < 0 && s2 < s1 && s1 < s0) {
                return createBuySignal(cleanData, i, `Bullish sweep absorption decay fade: decaying resistance (${s2.toFixed(2)} -> ${s1.toFixed(2)} -> ${s0.toFixed(2)})`);
            }

            // Decaying spring defense: fading decayed support defenses into downside breakdown
            if (s2 >= minInitial && s1 > 0 && s0 > 0 && s2 > s1 && s1 > s0) {
                return createSellSignal(cleanData, i, `Bearish sweep absorption decay fade: decaying support (${s2.toFixed(2)} -> ${s1.toFixed(2)} -> ${s0.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_initial_score"],
    },
};
