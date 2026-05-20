import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        extremeThreshold: Math.max(0.01, Math.min(0.49, Number(params.extremeThreshold ?? 0.15))),
        maxAdverse: Math.max(0, Number(params.maxAdverse ?? 0.03)),
    };
}

export const midpoint_deviation_rebound_pressure_gap: Strategy = {
    name: "Midpoint Deviation Rebound Pressure Gap",
    description: "Fades extreme price deviations from local high-low midpoint ranges on Binance upon a confirmed counter-trend crossing, using the Polymarket pressure gap to veto trades if already overpriced.",
    defaultParams: {
        lookback: 20,
        extremeThreshold: 0.15,
        maxAdverse: 0.03,
    },
    paramLabels: {
        lookback: "Midpoint Lookback",
        extremeThreshold: "Extreme Threshold",
        maxAdverse: "Maximum Adverse Gap",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const extremeThreshold = p.extremeThreshold as number;
        const maxAdverse = p.maxAdverse as number;

        if (cleanData.length < lookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const len = cleanData.length;

        // Compute trailing close-to-midpoint ratio
        const ratios = new Array(len).fill(0.5);
        for (let i = lookback - 1; i < len; i++) {
            let hi = -Infinity;
            let lo = Infinity;
            for (let j = i - lookback + 1; j <= i; j++) {
                if (highs[j] > hi) hi = highs[j];
                if (lows[j] < lo) lo = lows[j];
            }
            const range = hi - lo;
            ratios[i] = range > 0 ? (closes[i] - lo) / range : 0.5;
        }

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });

        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [pressure.longAdverse, pressure.shortAdverse], (i) => {
            if (i < lookback + 1) return null;

            const prevRatio = ratios[i - 1];
            const currentRatio = ratios[i];
            const longAdverse = pressure.longAdverse[i];
            const shortAdverse = pressure.shortAdverse[i];

            if (currentRatio === null || prevRatio === null || longAdverse === null || shortAdverse === null) return null;

            // Gather trailing lookback ratios to check if extreme was reached
            let minTrailing = Infinity;
            let maxTrailing = -Infinity;
            for (let j = i - lookback; j < i; j++) {
                if (ratios[j] < minTrailing) minTrailing = ratios[j];
                if (ratios[j] > maxTrailing) maxTrailing = ratios[j];
            }

            // Buy: crosses back above 0.5 after being below extremeThreshold
            if (prevRatio < 0.5 && currentRatio >= 0.5 && minTrailing < extremeThreshold && longAdverse <= maxAdverse) {
                return createBuySignal(cleanData, i, `Midpoint deviation rebounded above 0.5 after reaching ${minTrailing.toFixed(2)} with low adverse gap`);
            }

            // Sell: crosses back below 0.5 after being above (1.0 - extremeThreshold)
            const upperExtreme = 1.0 - extremeThreshold;
            if (prevRatio > 0.5 && currentRatio <= 0.5 && maxTrailing > upperExtreme && shortAdverse <= maxAdverse) {
                return createSellSignal(cleanData, i, `Midpoint deviation rebounded below 0.5 after reaching ${maxTrailing.toFixed(2)} with low adverse gap`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "extremeThreshold", "maxAdverse"],
    },
};
