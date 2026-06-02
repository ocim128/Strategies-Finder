import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";

// #COMPLETION_DRIVE: Assuming low volume counter-trend move followed by high volume re-entry captures price-volume divergence regimes.
// #SUGGEST_VERIFY: Verify volFactor threshold doesn't get skipped in low-volume or extremely high-volume regimes.
function normalizePriceVolumeDivergenceRegimeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        volFactor: Math.max(0.1, Number(params.volFactor ?? 1.2)),
    };
}

export const price_volume_divergence_regime: Strategy = {
    name: "Price Volume Divergence Regime",
    description: "Detects low-volume exhaustion moves against the VWAP trend followed by a high-volume re-entry in the trend direction.",
    defaultParams: {
        lookback: 40,
        volFactor: 1.2,
    },
    paramLabels: {
        lookback: "VWAP & Volume Lookback",
        volFactor: "Volume Thrust Factor",
    },
    normalizeParams: normalizePriceVolumeDivergenceRegimeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePriceVolumeDivergenceRegimeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const avgVol = buildRollingAverage(volumes, lookback);

        return createSignalLoop(cleanData, [vwap, avgVol], (i) => {
            if (i < lookback + 2) return null;
            const currentClose = closes[i];
            const currentOpen = cleanData[i].open;
            const currentVol = volumes[i];
            const currentVwap = vwap[i];
            const currentAvgVol = avgVol[i];

            const prevClose = closes[i - 1];
            const prevOpen = cleanData[i - 1].open;
            const prevVol = volumes[i - 1];
            const prevAvgVol = avgVol[i - 1];

            if (currentVwap === null || currentAvgVol === null || prevAvgVol === null) return null;

            // Buy logic: Close is above the VWAP, recent bar closed down on below-average volume, and current bar closes up on volume above volFactor * average volume
            if (currentClose > currentVwap) {
                const recentExhaustion = prevClose < prevOpen && prevVol < prevAvgVol;
                const volumeThrust = currentClose > currentOpen && currentVol > p.volFactor * currentAvgVol;
                if (recentExhaustion && volumeThrust) {
                    return createBuySignal(cleanData, i, `Bullish Price-Volume Divergence Re-Entry (vol=${currentVol.toFixed(0)}, avg=${currentAvgVol.toFixed(0)})`);
                }
            }

            // Sell logic: Close is below the VWAP, recent bar closed up on below-average volume, and current bar closes down on volume above volFactor * average volume
            if (currentClose < currentVwap) {
                const recentExhaustion = prevClose > prevOpen && prevVol < prevAvgVol;
                const volumeThrust = currentClose < currentOpen && currentVol > p.volFactor * currentAvgVol;
                if (recentExhaustion && volumeThrust) {
                    return createSellSignal(cleanData, i, `Bearish Price-Volume Divergence Re-Entry (vol=${currentVol.toFixed(0)}, avg=${currentAvgVol.toFixed(0)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volFactor"],
    },
};
