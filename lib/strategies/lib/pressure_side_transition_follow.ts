import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildInitiativePressureSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizePressureSideTransitionFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.40))),
    };
}

export const pressure_side_transition_follow: Strategy = {
    name: "Pressure Side Transition Follow",
    description: "Initiative pressure side transition as order flow regime shift.",
    defaultParams: {
        lookback: 25,
        efficiencyMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizePressureSideTransitionFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePressureSideTransitionFollowParams(params);
        const lookback = p.lookback as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 1) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const cleanPressure = pressure.map(pr => pr ?? 0);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [efficiencyRatio], (i) => {
            const eff = efficiencyRatio[i];
            if (eff === null || i < 2) return null;

            const prCurrent = cleanPressure[i];
            const prPrior = cleanPressure[i - 1];
            const prPrior2 = cleanPressure[i - 2];

            // Crossover negative to positive (buy)
            const buyCrossCurrent = prCurrent > 0 && prPrior <= 0;
            const buyCrossPrior = prPrior > 0 && prPrior2 <= 0;
            const buyCrossed = buyCrossCurrent || buyCrossPrior;

            // Crossover positive to negative (sell)
            const sellCrossCurrent = prCurrent < 0 && prPrior >= 0;
            const sellCrossPrior = prPrior < 0 && prPrior2 >= 0;
            const sellCrossed = sellCrossCurrent || sellCrossPrior;

            if (eff > efficiencyMin) {
                if (buyCrossed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Initiative pressure crossed positive with efficiency ${eff.toFixed(2)}`
                    );
                }
                if (sellCrossed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Initiative pressure crossed negative with efficiency ${eff.toFixed(2)}`
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
