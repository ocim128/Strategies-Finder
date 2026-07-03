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
import { extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        compressionLimit: Number(params.compressionLimit ?? 0.35),
    };
}

export const typical_range_squeeze_divergence: Strategy = {
    name: "Typical Range Squeeze Divergence",
    description: "Breakout from compression range when typical price momentum spikes while close momentum lags.",
    defaultParams: {
        lookback: 30,
        compressionLimit: 0.35,
    },
    paramLabels: {
        lookback: "Lookback Window",
        compressionLimit: "Compression Limit",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const trPct = buildPercentileRank(trueRange, lookback);

        const typicalMom = buildRateOfChange(typical, lookback);
        const closeMom = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [trPct, typicalMom, closeMom], (i) => {
            if (i < lookback || i < 1) return null;
            const prevPct = trPct[i - 1];
            const currentPct = trPct[i];
            const currentTypMom = typicalMom[i];
            const currentCloseMom = closeMom[i];
            if (prevPct === null || currentPct === null || currentTypMom === null || currentCloseMom === null) return null;

            const limit = p.compressionLimit as number;

            // Buy: prior range percentile < compressionLimit, current range percentile > 0.7, typical momentum > 0, close momentum < 0
            if (prevPct < limit && currentPct > 0.7 && currentTypMom > 0 && currentCloseMom < 0) {
                return createBuySignal(cleanData, i, `Typical Squeeze Buy: PrevPct ${prevPct.toFixed(2)}, CurrPct ${currentPct.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}`);
            }
            // Sell: prior range percentile < compressionLimit, current range percentile > 0.7, typical momentum < 0, close momentum > 0
            if (prevPct < limit && currentPct > 0.7 && currentTypMom < 0 && currentCloseMom > 0) {
                return createSellSignal(cleanData, i, `Typical Squeeze Sell: PrevPct ${prevPct.toFixed(2)}, CurrPct ${currentPct.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "compressionLimit"],
    },
};
