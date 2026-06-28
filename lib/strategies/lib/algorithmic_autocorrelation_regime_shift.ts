import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange, buildRollingAutoCorrelation } from "./price-action-statistics-core";

function normalizeAlgorithmicAutocorrelationRegimeShiftParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        efficiencyMin: Math.max(0, Math.min(1, Number(params.efficiencyMin ?? 0.45))),
    };
}

export const algorithmic_autocorrelation_regime_shift: Strategy = {
    name: "Algorithmic Autocorrelation Regime Shift",
    description: "Autocorrelation regime transition with efficiency confirmation.",
    defaultParams: {
        lookback: 25,
        efficiencyMin: 0.45,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMin: "Efficiency Min",
    },
    normalizeParams: normalizeAlgorithmicAutocorrelationRegimeShiftParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAlgorithmicAutocorrelationRegimeShiftParams(params);
        const lookback = p.lookback as number;
        const efficiencyMin = p.efficiencyMin as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const cleanReturns = returns.map(r => r ?? 0);
        const autocorr = buildRollingAutoCorrelation(cleanReturns, lookback, 1);
        const efficiencyRatio = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [autocorr, efficiencyRatio, returns], (i) => {
            const ac = autocorr[i];
            const eff = efficiencyRatio[i];
            const ret = returns[i];
            if (ac === null || eff === null || ret === null) return null;

            // Check crossover from negative to positive in the last 2 bars: i or i-1
            const currentCross = ac > 0 && autocorr[i - 1] !== null && autocorr[i - 1]! <= 0;
            const priorCross = i >= 1 && autocorr[i - 1] !== null && autocorr[i - 1]! > 0 && autocorr[i - 2] !== null && autocorr[i - 2]! <= 0;
            const crossed = currentCross || priorCross;

            if (crossed && eff > efficiencyMin) {
                if (ret > 0) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Autocorrelation crossover to ${ac.toFixed(2)} with efficiency ${eff.toFixed(2)}`
                    );
                }
                if (ret < 0) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Autocorrelation crossover to ${ac.toFixed(2)} with efficiency ${eff.toFixed(2)}`
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
