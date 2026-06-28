import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeEfficiencyConfirmedCloseAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.40))),
    };
}

export const efficiency_confirmed_close_acceptance: Strategy = {
    name: "Efficiency Confirmed Close Acceptance",
    description: "Close acceptance filtered by efficiency ratio.",
    defaultParams: {
        lookback: 20,
        efficiencyMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizeEfficiencyConfirmedCloseAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyConfirmedCloseAcceptanceParams(params);
        const lookback = p.lookback as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 1) return [];

        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [efficiencyRatio], (i) => {
            const eff = efficiencyRatio[i];
            if (eff === null) return null;

            const acc = closeAcceptance[i];
            if (eff > efficiencyMin) {
                if (acc > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish acceptance with efficiency ${eff.toFixed(2)}`
                    );
                }
                if (acc < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish acceptance with efficiency ${eff.toFixed(2)}`
                    );
                }
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
