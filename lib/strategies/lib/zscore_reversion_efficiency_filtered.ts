import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

function normalizeZScoreReversionEfficiencyFilteredParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.5)),
        efficiencyMax: Math.max(0, Math.min(1, Number(params.efficiencyMax ?? 0.30))),
    };
}

export const zscore_reversion_efficiency_filtered: Strategy = {
    name: "Z-Score Reversion Efficiency Filtered",
    description: "Z-score mean reversion with efficiency noise filter.",
    defaultParams: {
        lookback: 25,
        zThreshold: 1.5,
        efficiencyMax: 0.30,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
        efficiencyMax: "Efficiency Max",
    },
    normalizeParams: normalizeZScoreReversionEfficiencyFilteredParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeZScoreReversionEfficiencyFilteredParams(params);
        const lookback = p.lookback as number;
        const zThreshold = p.zThreshold as number;
        const efficiencyMax = p.efficiencyMax as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const zscore = buildRollingZScore(closes, lookback);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [zscore, efficiencyRatio], (i) => {
            const z = zscore[i];
            const eff = efficiencyRatio[i];
            if (z === null || eff === null) return null;

            if (eff < efficiencyMax) {
                if (z < -zThreshold) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Z-score extreme down ${z.toFixed(2)} with low efficiency ${eff.toFixed(2)}`
                    );
                }
                if (z > zThreshold) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Z-score extreme up ${z.toFixed(2)} with low efficiency ${eff.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold", "efficiencyMax"],
    },
};
