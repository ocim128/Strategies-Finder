import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getOpens } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRollingAverage } from "./price-action-frequency-core";

function normalizeBarSymmetryMeanReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 20))),
        asymmetryMin: Math.max(0, Number(params.asymmetryMin ?? 0.15)),
    };
}

export const bar_symmetry_mean_reversion: Strategy = {
    name: "Bar Symmetry Mean Reversion",
    description: "Bar symmetry break as structural mean reversion signal.",
    defaultParams: {
        lookback: 20,
        asymmetryMin: 0.15,
    },
    paramLabels: {
        lookback: "Lookback",
        asymmetryMin: "Asymmetry Min",
    },
    normalizeParams: normalizeBarSymmetryMeanReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBarSymmetryMeanReversionParams(params);
        const lookback = p.lookback as number;
        const asymmetryMin = p.asymmetryMin as number;
        if (cleanData.length < lookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const opens = getOpens(cleanData);
        const closes = getCloses(cleanData);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        const symmetry: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const h = highs[i];
            const l = lows[i];
            const range = h - l;
            if (range > 0) {
                const mid = (opens[i] + closes[i]) / 2;
                symmetry[i] = ((h - mid) - (mid - l)) / range;
            } else {
                symmetry[i] = 0;
            }
        }

        const smoothedSymmetry = buildRollingAverage(symmetry, lookback);

        return createSignalLoop(cleanData, [smoothedSymmetry], (i) => {
            const sym = smoothedSymmetry[i];
            if (sym === null) return null;

            const acc = closeAcceptance[i];
            // Buy: smoothed bar symmetry score below -asymmetryMin and close acceptance < 0 (lower range dominates, expect reversion up)
            if (sym < -asymmetryMin && acc < 0) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Symmetry extreme down ${sym.toFixed(2)} with close acceptance ${acc.toFixed(2)}`
                );
            }
            // Sell: smoothed bar symmetry score above asymmetryMin and close acceptance > 0 (upper range dominates, expect reversion down)
            if (sym > asymmetryMin && acc > 0) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Symmetry extreme up ${sym.toFixed(2)} with close acceptance ${acc.toFixed(2)}`
                );
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
