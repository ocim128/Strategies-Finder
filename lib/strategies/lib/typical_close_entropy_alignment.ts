import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingEntropy } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        maxEntropy: Number(params.maxEntropy ?? 0.45),
    };
}

export const typical_close_entropy_alignment: Strategy = {
    name: "Typical Close Entropy Alignment",
    description: "Enters typical vs close price divergences when typical price return entropy is low (indicating a structured trend).",
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

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);
        const typicalMom1 = buildRateOfChange(typical, 1);
        const typicalReturns = typicalMom1.map((v) => v ?? 0);

        const entropy = buildRollingEntropy(typicalReturns, lookback);
        const typicalMom = buildRateOfChange(typical, lookback);
        const closeMom = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [entropy, typicalMom, closeMom], (i) => {
            if (i < lookback) return null;
            const currentEntropy = entropy[i];
            const currentTypMom = typicalMom[i];
            const currentCloseMom = closeMom[i];
            if (currentEntropy === null || currentTypMom === null || currentCloseMom === null) return null;

            const maxEnt = p.maxEntropy as number;

            // Buy: typical price return entropy < maxEntropy, typical price momentum > 0, close momentum < 0
            if (currentEntropy < maxEnt && currentTypMom > 0 && currentCloseMom < 0) {
                return createBuySignal(cleanData, i, `Typical Entropy Align Buy: Entropy ${currentEntropy.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}`);
            }
            // Sell: typical price return entropy < maxEntropy, typical price momentum < 0, close momentum > 0
            if (currentEntropy < maxEnt && currentTypMom < 0 && currentCloseMom > 0) {
                return createSellSignal(cleanData, i, `Typical Entropy Align Sell: Entropy ${currentEntropy.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}`);
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
