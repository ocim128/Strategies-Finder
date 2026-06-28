import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

function normalizeModernArbitrageSpeedReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.3)),
        efficiencyMax: Math.max(0, Math.min(1, Number(params.efficiencyMax ?? 0.35))),
    };
}

export const modern_arbitrage_speed_reversion: Strategy = {
    name: "Modern Arbitrage Speed Reversion",
    description: "Fast mean reversion enabled by modern arbitrage infrastructure.",
    defaultParams: {
        lookback: 25,
        zThreshold: 1.3,
        efficiencyMax: 0.35,
    },
    paramLabels: {
        lookback: "Lookback",
        zThreshold: "Z-Score Threshold",
        efficiencyMax: "Efficiency Max",
    },
    normalizeParams: normalizeModernArbitrageSpeedReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeModernArbitrageSpeedReversionParams(params);
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

            if (z < -zThreshold && eff < efficiencyMax) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Z-score stretched down at ${z.toFixed(2)} with efficiency ${eff.toFixed(2)}`
                );
            }
            if (z > zThreshold && eff < efficiencyMax) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Z-score stretched up at ${z.toFixed(2)} with efficiency ${eff.toFixed(2)}`
                );
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
