import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minEfficiency: Number(params.minEfficiency ?? 0.6),
    };
}

export const typical_momentum_efficiency_alignment: Strategy = {
    name: "Typical Momentum Efficiency Alignment",
    description: "Follows efficient typical price trends when typical price momentum leads close momentum.",
    defaultParams: {
        lookback: 30,
        minEfficiency: 0.6,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minEfficiency: "Min Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const typicalOhlcv = cleanData.map((d, idx) => ({ ...d, close: typical[idx] }));
        const er = buildEfficiencyRatio(typicalOhlcv, lookback);

        const typicalMom = buildRateOfChange(typical, lookback);
        const closeMom = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [er, typicalMom, closeMom], (i) => {
            if (i < lookback) return null;
            const currentEr = er[i];
            const currentTypMom = typicalMom[i];
            const currentCloseMom = closeMom[i];
            if (currentEr === null || currentTypMom === null || currentCloseMom === null) return null;

            const minEff = p.minEfficiency as number;

            // Buy: typical price efficiency > minEfficiency, typical mom positive, and typical mom > close mom
            if (currentEr > minEff && currentTypMom > 0 && currentTypMom > currentCloseMom) {
                return createBuySignal(cleanData, i, `Typical Mom Eff Buy: ER ${currentEr.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}, CloseMom ${currentCloseMom.toFixed(4)}`);
            }
            // Sell: typical price efficiency > minEfficiency, typical mom negative, and typical mom < close mom
            if (currentEr > minEff && currentTypMom < 0 && currentTypMom < currentCloseMom) {
                return createSellSignal(cleanData, i, `Typical Mom Eff Sell: ER ${currentEr.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}, CloseMom ${currentCloseMom.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency"],
    },
};
