import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRateOfChange, buildRollingAutoCorrelation, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        autocorrMax: Math.max(0.0, Math.min(0.5, Number(params.autocorrMax ?? 0.15))),
        returnZThreshold: Math.max(0.5, Number(params.returnZThreshold ?? 1.5)),
    };
}

export const autocorrelation_break_reversal: Strategy = {
    name: "Autocorrelation Break Reversal",
    description: "Reverts stretched ratios when return autocorrelation collapses, confirming the trend coupling has broken.",
    defaultParams: {
        lookback: 30,
        autocorrMax: 0.15,
        returnZThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrMax: "Max Autocorrelation",
        returnZThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closes = getCloses(cleanData);

        // 1-bar returns for autocorrelation
        const returns = buildRateOfChange(closes, 1);
        const returnsClean = returns.map(v => v ?? 0);
        const autocorr = buildRollingAutoCorrelation(returnsClean, lookback);

        // Z-score of close for stretch
        const zscore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [autocorr, zscore], (i) => {
            const ac = autocorr[i];
            const z = zscore[i];
            if (ac === null || z === null) return null;
            if (ac >= (p.autocorrMax as number)) return null;

            const zThresh = p.returnZThreshold as number;
            const ret = returnsClean[i];

            // Buy: stretched down, coupling broken, early reversal
            if (z < -zThresh && ret > 0) {
                return createBuySignal(cleanData, i, `Autocorr break ${ac.toFixed(2)} z-score ${z.toFixed(2)} reversal buy`);
            }
            // Sell: stretched up, coupling broken, early reversal
            if (z > zThresh && ret < 0) {
                return createSellSignal(cleanData, i, `Autocorr break ${ac.toFixed(2)} z-score ${z.toFixed(2)} reversal sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autocorrMax", "returnZThreshold"],
    },
};
