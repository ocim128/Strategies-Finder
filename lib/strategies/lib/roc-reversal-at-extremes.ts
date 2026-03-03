import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";

export const roc_reversal_at_extremes: Strategy = {
    name: "Rate-of-Change Reversal at Extremes",
    description: "Counter-trend entry when ROC hits rolling z-score extremes and starts reverting.",
    defaultParams: {
        rocPeriod: 12,
        zLookback: 100,
        zThreshold: 2,
    },
    paramLabels: {
        rocPeriod: "ROC Period",
        zLookback: "Z-Score Lookback",
        zThreshold: "Z-Score Extreme",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < 10) return [];

        const rocPeriod = Math.max(2, Math.round(params.rocPeriod ?? 12));
        const zLookback = Math.max(20, Math.round(params.zLookback ?? 100));
        const zThreshold = Math.max(0.5, params.zThreshold ?? 2);

        const closes = getCloses(cleanData);
        const roc: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = rocPeriod; i < cleanData.length; i++) {
            const base = closes[i - rocPeriod];
            if (base === 0) continue;
            roc[i] = (closes[i] - base) / base;
        }

        const zScore: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = 0; i < cleanData.length; i++) {
            if (i < rocPeriod + zLookback - 1 || roc[i] === null) continue;

            const start = i - zLookback + 1;
            let sum = 0;
            let count = 0;
            for (let j = start; j <= i; j++) {
                const v = roc[j];
                if (v === null) continue;
                sum += v;
                count++;
            }
            if (count < zLookback) continue;

            const mean = sum / count;
            let varianceSum = 0;
            for (let j = start; j <= i; j++) {
                const v = roc[j];
                if (v === null) continue;
                const diff = v - mean;
                varianceSum += diff * diff;
            }
            const stdDev = Math.sqrt(varianceSum / count);
            if (stdDev <= 0) continue;
            zScore[i] = ((roc[i] as number) - mean) / stdDev;
        }

        return createSignalLoop(cleanData, [roc, zScore], (i) => {
            const z = zScore[i] as number;
            const prevRoc = roc[i - 1] as number;
            const currRoc = roc[i] as number;

            if (z <= -zThreshold && currRoc > prevRoc) {
                return createBuySignal(cleanData, i, "ROC z-extreme bullish reversion");
            }
            if (z >= zThreshold && currRoc < prevRoc) {
                return createSellSignal(cleanData, i, "ROC z-extreme bearish reversion");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rocPeriod", "zLookback", "zThreshold"],
    },
};

