import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming high efficiency moves backed by volume and ATR expansion capture clean institutional momentum.
// #SUGGEST_VERIFY: Verify rolling averages of volume and ATR handle startup periods safely without leakage.
function normalizePvvEfficiencyAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minEfficiency: Math.max(0.01, Math.min(0.99, Number(params.minEfficiency ?? 0.6))),
    };
}

export const pvv_efficiency_alignment: Strategy = {
    name: "Price-Volume-Volatility Efficiency Alignment",
    description: "Signals clean, highly efficient price moves supported by rising volume and ATR expansion.",
    defaultParams: {
        lookback: 30,
        minEfficiency: 0.6,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minEfficiency: "Min Efficiency",
    },
    normalizeParams: normalizePvvEfficiencyAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePvvEfficiencyAlignmentParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        
        const avgVol = buildRollingAverage(volumes, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const atrClean = atr.map(v => v ?? 0);
        const avgAtr = buildRollingAverage(atrClean, lookback);

        return createSignalLoop(cleanData, [efficiency, avgVol, atr, avgAtr], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const currentOpen = cleanData[i].open;
            const currentVol = volumes[i];
            const currentAtr = atr[i];
            
            const eff = efficiency[i];
            const av = avgVol[i];
            const aa = avgAtr[i];

            if (eff === null || av === null || aa === null || currentAtr === null) return null;
            if (eff <= p.minEfficiency) return null;

            // Volume and ATR must both be above their respective rolling averages
            if (currentVol > av && currentAtr > aa) {
                // Buy logic: Close is above open
                if (currentClose > currentOpen) {
                    return createBuySignal(cleanData, i, `PVV Efficiency Alignment Bullish (eff=${eff.toFixed(3)}, vol=${currentVol.toFixed(0)} > avg=${av.toFixed(0)})`);
                }
                // Sell logic: Close is below open
                if (currentClose < currentOpen) {
                    return createSellSignal(cleanData, i, `PVV Efficiency Alignment Bearish (eff=${eff.toFixed(3)}, vol=${currentVol.toFixed(0)} > avg=${av.toFixed(0)})`);
                }
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
