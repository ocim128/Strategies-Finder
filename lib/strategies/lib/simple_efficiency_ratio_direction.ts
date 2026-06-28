import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";

function normalizeSimpleEfficiencyRatioDirectionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.50))),
    };
}

export const simple_efficiency_ratio_direction: Strategy = {
    name: "Simple Efficiency Ratio Direction",
    description: "Efficiency ratio as standalone direction signal.",
    defaultParams: {
        lookback: 20,
        efficiencyMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizeSimpleEfficiencyRatioDirectionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSimpleEfficiencyRatioDirectionParams(params);
        const lookback = p.lookback as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);
        const returns = buildRateOfChange(closes, 1);

        return createSignalLoop(cleanData, [efficiencyRatio, returns], (i) => {
            const eff = efficiencyRatio[i];
            const ret = returns[i];
            if (eff === null || ret === null) return null;

            if (eff > efficiencyMin && ret > 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Efficiency ratio ${eff.toFixed(2)} with positive return`
                );
            }
            if (eff > efficiencyMin && ret < 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Efficiency ratio ${eff.toFixed(2)} with negative return`
                );
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiencyMin"],
    },
};
