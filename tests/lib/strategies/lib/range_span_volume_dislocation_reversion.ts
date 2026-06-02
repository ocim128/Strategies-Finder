import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming volume Z-score / ATR Z-score ratio robustly filters out low-volume boundary extensions.
// #SUGGEST_VERIFY: Verify that ATR Z-score division does not cause division-by-zero or extremely large ratio values.
function normalizeRangeSpanVolumeDislocationReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        maxVolRatio: Math.max(0.01, Number(params.maxVolRatio ?? 0.5)),
    };
}

export const range_span_volume_dislocation_reversion: Strategy = {
    name: "Range Span Volume Dislocation Reversion",
    description: "Signals price overextensions beyond trailing boundaries when volume remains exceptionally low relative to ATR volatility.",
    defaultParams: {
        lookback: 30,
        maxVolRatio: 0.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxVolRatio: "Max Volume Ratio",
    },
    normalizeParams: normalizeRangeSpanVolumeDislocationReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRangeSpanVolumeDislocationReversionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const atrClean = atr.map(v => v ?? 0);

        const volumeZ = buildRollingZScore(volumes, lookback);
        const atrZ = buildRollingZScore(atrClean, lookback);

        return createSignalLoop(cleanData, [highest, lowest, volumeZ, atrZ], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const hi = highest[i];
            const lo = lowest[i];
            const vz = volumeZ[i];
            const az = atrZ[i];

            if (hi === null || lo === null || vz === null || az === null) return null;
            if (Math.abs(az) < 1e-6) return null;

            const ratio = vz / az;

            if (ratio < p.maxVolRatio) {
                // Buy logic: Close is below the trailing low boundary, but ratio of volume Z-score to ATR Z-score is less than maxVolRatio
                if (currentClose < lo) {
                    return createBuySignal(cleanData, i, `Bullish Range Dislocation (close=${currentClose.toFixed(2)} < lo=${lo.toFixed(2)}, ratio=${ratio.toFixed(2)})`);
                }
                // Sell logic: Close is above the trailing high boundary, but ratio of volume Z-score to ATR Z-score is less than maxVolRatio
                if (currentClose > hi) {
                    return createSellSignal(cleanData, i, `Bearish Range Dislocation (close=${currentClose.toFixed(2)} > hi=${hi.toFixed(2)}, ratio=${ratio.toFixed(2)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxVolRatio"],
    },
};
