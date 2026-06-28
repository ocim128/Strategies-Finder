import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getTypicalPrices } from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        momentumLookback: Math.max(1, Math.round(Number(params.momentumLookback ?? 3))),
    };
}

export const typical_price_momentum_divergence: Strategy = {
    name: "Typical Price Momentum Divergence",
    description: "Reverts toward typical price direction when close momentum diverges from typical price momentum.",
    defaultParams: {
        lookback: 20,
        momentumLookback: 3,
    },
    paramLabels: {
        lookback: "Lookback",
        momentumLookback: "Momentum Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const momLookback = p.momentumLookback as number;
        if (cleanData.length < lookback + momLookback + 2) return [];

        const closes = getCloses(cleanData);
        const typicalPrices = getTypicalPrices(cleanData);

        const closeMom = buildRateOfChange(closes, momLookback);
        const typicalMom = buildRateOfChange(typicalPrices, momLookback);
        const typicalMomPctl = buildPercentileRank(typicalMom.map(v => v ?? 0), lookback);

        return createSignalLoop(cleanData, [closeMom, typicalMom], (i) => {
            const cm = closeMom[i];
            const tm = typicalMom[i];
            const tmp = typicalMomPctl[i];
            if (cm === null || tm === null || tmp === null) return null;

            // Buy: typical price leads upward, close lags
            if (tm > 0 && cm < 0 && tmp > 0.60) {
                return createBuySignal(cleanData, i, `Typical mom ${(tm * 100).toFixed(2)}% close mom ${(cm * 100).toFixed(2)}% divergence buy`);
            }
            // Sell: typical price leads downward, close lags
            if (tm < 0 && cm > 0 && tmp > 0.60) {
                return createSellSignal(cleanData, i, `Typical mom ${(tm * 100).toFixed(2)}% close mom ${(cm * 100).toFixed(2)}% divergence sell`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "momentumLookback"],
    },
};
