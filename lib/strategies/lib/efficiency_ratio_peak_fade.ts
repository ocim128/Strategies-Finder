import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeEfficiencyRatioPeakFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        er_lookback: Math.max(2, Math.round(Number(params.er_lookback ?? 14))),
        er_threshold: Math.max(0, Math.min(1, Number(params.er_threshold ?? 0.8))),
    };
}

export const efficiency_ratio_peak_fade: Strategy = {
    name: "Efficiency Ratio Peak Fade",
    description:
        "Fades highly efficient directional runs once the current bar still closes with the dominant trend body color, assuming the move is overextended.",
    defaultParams: {
        er_lookback: 14,
        er_threshold: 0.8,
    },
    paramLabels: {
        er_lookback: "ER Lookback",
        er_threshold: "ER Threshold",
    },
    normalizeParams: normalizeEfficiencyRatioPeakFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyRatioPeakFadeParams(params);
        const lookback = p.er_lookback as number;
        const threshold = p.er_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [efficiencyRatio], (i) => {
            const erValue = efficiencyRatio[i];
            if (erValue === null || erValue <= threshold) return null;

            const trendDelta = cleanData[i].close - cleanData[i - lookback].close;
            const bearishBar = cleanData[i].close < cleanData[i].open;
            const bullishBar = cleanData[i].close > cleanData[i].open;

            if (trendDelta < 0 && bearishBar) {
                return createBuySignal(cleanData, i, `ER ${erValue.toFixed(2)} in efficient downtrend`);
            }
            if (trendDelta > 0 && bullishBar) {
                return createSellSignal(cleanData, i, `ER ${erValue.toFixed(2)} in efficient uptrend`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["er_lookback", "er_threshold"],
    },
};
