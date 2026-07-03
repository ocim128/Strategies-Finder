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
        volThreshold: Number(params.volThreshold ?? 0.7),
    };
}

export const typical_volume_confirmed_divergence: Strategy = {
    name: "Typical Volume Confirmed Divergence",
    description: "Trades divergence between typical price and close momentum when backed by high volume percentile rank.",
    defaultParams: {
        lookback: 30,
        volThreshold: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volThreshold: "Vol Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const volumes = cleanData.map((d) => d.volume);
        const volPct = buildPercentileRank(volumes, lookback);

        const typicalMom = buildRateOfChange(typical, lookback);
        const closeMom = buildRateOfChange(closes, lookback);

        return createSignalLoop(cleanData, [volPct, typicalMom, closeMom], (i) => {
            if (i < lookback) return null;
            const currentVolPct = volPct[i];
            const currentTypMom = typicalMom[i];
            const currentCloseMom = closeMom[i];
            if (currentVolPct === null || currentTypMom === null || currentCloseMom === null) return null;

            const volThresh = p.volThreshold as number;

            // Buy: volume percentile > volThreshold, typical price momentum > 0, close momentum < 0
            if (currentVolPct > volThresh && currentTypMom > 0 && currentCloseMom < 0) {
                return createBuySignal(cleanData, i, `Typical Vol Div Buy: VolPct ${currentVolPct.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}, CloseMom ${currentCloseMom.toFixed(4)}`);
            }
            // Sell: volume percentile > volThreshold, typical price momentum < 0, close momentum > 0
            if (currentVolPct > volThresh && currentTypMom < 0 && currentCloseMom > 0) {
                return createSellSignal(cleanData, i, `Typical Vol Div Sell: VolPct ${currentVolPct.toFixed(2)}, TypMom ${currentTypMom.toFixed(4)}, CloseMom ${currentCloseMom.toFixed(4)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volThreshold"],
    },
};
