import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingEntropy, buildRollingAutoCorrelation } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        maxEntropy: Number(params.maxEntropy ?? 0.45),
    };
}

export const entropy_autocorrelation_momentum_gate: Strategy = {
    name: "Entropy Autocorrelation Momentum Gate",
    description: "Enters the direction of momentum when low return entropy signals structure and return autocorrelation confirms persistence.",
    defaultParams: {
        lookback: 30,
        maxEntropy: 0.45,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxEntropy: "Max Entropy Limit",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const entropy = buildRollingEntropy(returns, lookback);
        const ac = buildRollingAutoCorrelation(returns, lookback, 1);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [entropy, ac, closeLoc], (i) => {
            if (i < lookback) return null;
            const currentEntropy = entropy[i];
            const currentAc = ac[i];
            const currentLoc = closeLoc[i];
            if (currentEntropy === null || currentAc === null) return null;

            // Buy: entropy < maxEntropy, autocorrelation > 0.25, close location > 0.7
            if (currentEntropy < (p.maxEntropy as number) && currentAc > 0.25 && currentLoc > 0.7) {
                return createBuySignal(cleanData, i, `Entropy Mom Gate Buy: Entropy ${currentEntropy.toFixed(2)}, AC ${currentAc.toFixed(2)}, Loc ${currentLoc.toFixed(2)}`);
            }
            // Sell: entropy < maxEntropy, autocorrelation > 0.25, close location < 0.3
            if (currentEntropy < (p.maxEntropy as number) && currentAc > 0.25 && currentLoc < 0.3) {
                return createSellSignal(cleanData, i, `Entropy Mom Gate Sell: Entropy ${currentEntropy.toFixed(2)}, AC ${currentAc.toFixed(2)}, Loc ${currentLoc.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxEntropy"],
    },
};
