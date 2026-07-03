import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRateOfChange, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        typicalPercentileMin: Number(params.typicalPercentileMin ?? 0.8),
    };
}

export const failed_typical_breakout_fade: Strategy = {
    name: "Failed Typical Breakout Fade",
    description: "Fades extreme typical price breakouts when close momentum fails to support it and instead reverses.",
    defaultParams: {
        lookback: 30,
        typicalPercentileMin: 0.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        typicalPercentileMin: "Typical Percentile Min",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const typicalMom = buildRateOfChange(typical, lookback);
        const typicalMomClean = typicalMom.map((v) => v ?? 0);
        const typicalMomPct = buildPercentileRank(typicalMomClean, lookback);

        const closeMom = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [typicalMomPct, closeMom], (i) => {
            if (i < lookback) return null;
            const currentTypMomPct = typicalMomPct[i];
            const currentCloseMom = closeMom[i];
            if (currentTypMomPct === null || currentCloseMom === null) return null;

            const threshold = p.typicalPercentileMin as number;

            // Buy: typical price momentum percentile < 1 - threshold, close momentum > 0 (reversing up)
            if (currentTypMomPct < (1 - threshold) && currentCloseMom > 0) {
                return createBuySignal(cleanData, i, `Failed Typical Breakout Buy: TypMomPct ${currentTypMomPct.toFixed(2)}, CloseMom ${currentCloseMom.toFixed(4)}`);
            }
            // Sell: typical price momentum percentile > threshold, close momentum < 0 (reversing down)
            if (currentTypMomPct > threshold && currentCloseMom < 0) {
                return createSellSignal(cleanData, i, `Failed Typical Breakout Sell: TypMomPct ${currentTypMomPct.toFixed(2)}, CloseMom ${currentCloseMom.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "typicalPercentileMin"],
    },
};
