import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getOpens } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingAverage } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        asymmetryMin: Math.max(0.05, Math.min(0.9, Number(params.asymmetryMin ?? 0.15))),
    };
}

export const bar_symmetry_break_direction: Strategy = {
    name: "Bar Symmetry Break Direction",
    description: "Follows persistent bar asymmetry when upper/lower range imbalance aligns with close acceptance.",
    defaultParams: {
        lookback: 20,
        asymmetryMin: 0.15,
    },
    paramLabels: {
        lookback: "Lookback",
        asymmetryMin: "Min Asymmetry",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const opens = getOpens(cleanData);
        const closes = getCloses(cleanData);

        // Per-bar symmetry: (upper - lower) / range where mid = (open+close)/2
        const symmetry = closes.map((c, i) => {
            const range = highs[i] - lows[i];
            if (range <= 0) return 0;
            const mid = (opens[i] + c) / 2;
            const upper = highs[i] - mid;
            const lower = mid - lows[i];
            return (upper - lower) / range;
        });

        const smoothed = buildRollingAverage(symmetry, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [smoothed], (i) => {
            const s = smoothed[i];
            if (s === null) return null;

            const asymMin = p.asymmetryMin as number;
            const ca = closeAcceptance[i];

            if (s > asymMin && ca > 0) {
                return createBuySignal(cleanData, i, `Bar symmetry ${s.toFixed(2)} upper dominant bullish`);
            }
            if (s < -asymMin && ca < 0) {
                return createSellSignal(cleanData, i, `Bar symmetry ${s.toFixed(2)} lower dominant bearish`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "asymmetryMin"],
    },
};
