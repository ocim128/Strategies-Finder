import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildCloseAcceptanceSeries, buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming volume Z-score / ATR Z-score ratio robustly filters out low-liquidity breakouts and high ATR is handled safely.
// #SUGGEST_VERIFY: Verify that ATR Z-score division does not cause division-by-zero or extremely large ratio values.
function normalizeVolumeVolatilityRatioBoundaryBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        ratioThreshold: Math.max(0.1, Number(params.ratioThreshold ?? 1.5)),
    };
}

export const volume_volatility_ratio_boundary_breakout: Strategy = {
    name: "Volume Volatility Ratio Boundary Breakout",
    description: "Signals boundary breakouts only when accompanied by a volume surge that scales beyond current background ATR volatility.",
    defaultParams: {
        lookback: 30,
        ratioThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        ratioThreshold: "Ratio Threshold",
    },
    normalizeParams: normalizeVolumeVolatilityRatioBoundaryBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeVolatilityRatioBoundaryBreakoutParams(params);
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
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [highest, lowest, volumeZ, atrZ, closeAcceptance], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const hi = highest[i];
            const lo = lowest[i];
            const vz = volumeZ[i];
            const az = atrZ[i];
            const acc = closeAcceptance[i];

            if (hi === null || lo === null || vz === null || az === null || acc === null) return null;
            if (Math.abs(az) < 1e-6) return null;

            const ratio = vz / az;

            // Buy logic: Close breaks above trailing high, close acceptance is positive, and the volume Z-score divided by ATR Z-score is greater than ratioThreshold
            if (currentClose > hi && acc > 0 && ratio > p.ratioThreshold) {
                return createBuySignal(cleanData, i, `Volume Volatility Breakout Bullish (ratio=${ratio.toFixed(2)}, vz=${vz.toFixed(2)}, az=${az.toFixed(2)})`);
            }

            // Sell logic: Close breaks below trailing low, close acceptance is negative, and the volume Z-score divided by ATR Z-score is greater than ratioThreshold
            if (currentClose < lo && acc < 0 && ratio > p.ratioThreshold) {
                return createSellSignal(cleanData, i, `Volume Volatility Breakout Bearish (ratio=${ratio.toFixed(2)}, vz=${vz.toFixed(2)}, az=${az.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "ratioThreshold"],
    },
};
