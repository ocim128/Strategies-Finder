import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming event open (data[0].open) serves as a stable anchor for resolution outcomes.
// #SUGGEST_VERIFY: Verify data[0] is present and cleanData is not empty.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        distanceThreshold: Math.max(0.1, Number(params.distanceThreshold ?? 2.5)),
    };
}

export const event_open_efficiency_decay_reversion: Strategy = {
    name: "Event Open Efficiency Decay Reversion",
    description: "Fades large extensions from the event open price when price path efficiency decays, predicting a collapse.",
    defaultParams: {
        lookback: 50,
        distanceThreshold: 2.5,
    },
    paramLabels: {
        lookback: "Lookback",
        distanceThreshold: "Distance ATR Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const distanceThreshold = p.distanceThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const eventOpen = cleanData[0].open;
        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [atr, efficiency], (i) => {
            const currentClose = closes[i];
            const currentAtr = atr[i];
            const eff = efficiency[i];
            if (currentAtr === null || currentAtr <= 0 || eff === null) return null;

            const distance = currentClose - eventOpen;
            const normalizedDistance = distance / currentAtr;

            // Buy: Close is significantly below event open, efficiency is low (decayed)
            if (normalizedDistance < -distanceThreshold && eff < 0.3) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish reversion: price ${normalizedDistance.toFixed(2)} ATR below open with low efficiency (${eff.toFixed(3)})`
                );
            }

            // Sell: Close is significantly above event open, efficiency is low (decayed)
            if (normalizedDistance > distanceThreshold && eff < 0.3) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish reversion: price ${normalizedDistance.toFixed(2)} ATR above open with low efficiency (${eff.toFixed(3)})`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "distanceThreshold"],
    },
};
