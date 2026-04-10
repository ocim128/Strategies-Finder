import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingCorrelation } from "./price-action-statistics-core";

function normalizeToxicFlowDecouplingParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        corr_lookback: Math.max(2, Math.round(params.corr_lookback ?? 20)),
        toxic_corr_threshold: Number(params.toxic_corr_threshold ?? -0.5)
    };
}

export const toxic_flow_decoupling: Strategy = {
    name: "Toxic Flow Decoupling",
    description: "When the correlation between trend efficiency and volume turns deeply negative, high volume yields zero net progress, revealing hidden institutional absorption.",
    defaultParams: {
        corr_lookback: 20,
        toxic_corr_threshold: -0.5
    },
    paramLabels: {
        corr_lookback: "Correlation Lookback",
        toxic_corr_threshold: "Toxic Correlation Threshold"
    },
    normalizeParams: normalizeToxicFlowDecouplingParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeToxicFlowDecouplingParams(params);
        const lookback = p.corr_lookback as number;
        if (cleanData.length < lookback * 2) return [];

        const er = buildEfficiencyRatio(cleanData, lookback);
        const vols = getVolumes(cleanData);
        const erValues = er.map(x => x ?? 0);
        const corr = buildRollingCorrelation(erValues, vols, lookback);

        return createSignalLoop(cleanData, [corr], (i) => {
            if (i < lookback) return null;
            const currentCorr = corr[i];
            if (currentCorr === null) return null;

            const toxicThresh = p.toxic_corr_threshold as number;
            const currentClose = cleanData[i].close;
            const currentOpen = cleanData[i].open;
            const prevClose = cleanData[i - 1].close;
            const prevOpen = cleanData[i - 1].open;

            if (currentCorr < toxicThresh && currentClose < currentOpen && prevClose < prevOpen) {
                return createBuySignal(cleanData, i, `Correlation < ${toxicThresh} and 2x down-candles`);
            }
            if (currentCorr < toxicThresh && currentClose > currentOpen && prevClose > prevOpen) {
                return createSellSignal(cleanData, i, `Correlation < ${toxicThresh} and 2x up-candles`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["corr_lookback", "toxic_corr_threshold"]
    }
};
