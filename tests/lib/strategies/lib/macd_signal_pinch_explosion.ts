import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { calculateMACD } from "../indicators";
import { buildRollingMinMax, buildRateOfChange } from "./price-action-statistics-core";

export const macd_signal_pinch_explosion: Strategy = {
    name: "MACD Signal Pinch Explosion",
    description: "Targets microscopic equilibrium phases where the absolute distance between the MACD Line and the Signal Line compresses to an absolute rolling historical minimum. Executes on directional rate-of-change surges outward.",
    defaultParams: {
        macdFast: 12,
        lookbackMin: 40,
        rocTrigger: 1.5,
    },
    paramLabels: {
        macdFast: "MACD Fast Period",
        lookbackMin: "Pinch Depth Horizon",
        rocTrigger: "ROC Escape Magnitude",
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lMin = params.lookbackMin as number;
        const mFast = params.macdFast as number;

        if (cleanData.length < Math.max(26, lMin)) return [];
        
        // MACD structural calculation 
        const macd = calculateMACD(
            cleanData.map(d => d.close),
            Math.min(mFast, 25), // Safety guard to ensure fast < slow
            26,
            9
        );

        const absoluteDistances = cleanData.map((_, i) => {
            if (macd.macd[i] === null || macd.signal[i] === null) return Infinity; // Warmup ignoring
            return Math.abs(macd.macd[i]! - macd.signal[i]!);
        });

        const limits = buildRollingMinMax(absoluteDistances, lMin);
        const rocSeries = buildRateOfChange(cleanData.map(d => d.close), 1);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 26 + lMin || limits.min[i] === null || rocSeries[i] === null) return null;

            const pureDistance = absoluteDistances[i];
            const minimumLimit = limits.min[i]!;

            const isPinched = pureDistance <= Math.max(0.0001, minimumLimit * 1.05);
            
            const rocPct = rocSeries[i]! * 100;
            const target = params.rocTrigger as number;

            if (isPinched && rocPct > target) {
                return createBuySignal(cleanData, i, "Upside ROC explosion from zero-distance MACD/Signal equilibrium pinch");
            }
            if (isPinched && rocPct < -target) {
                return createSellSignal(cleanData, i, "Downside ROC explosion from zero-distance MACD/Signal equilibrium pinch");
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["macdFast", "lookbackMin", "rocTrigger"],
    },
};
