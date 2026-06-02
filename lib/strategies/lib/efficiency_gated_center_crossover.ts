import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    checkCrossover,
} from "../strategy-helpers";
import { buildRollingMedian, buildEfficiencyRatio } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming crossovers are highly durable when path efficiency is high.
// #SUGGEST_VERIFY: Verify minEfficiency (>= 0.1) gates breakouts efficiently.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
        minEfficiency: Math.max(0.01, Math.min(1.0, Number(params.minEfficiency ?? 0.6))),
    };
}

export const efficiency_gated_center_crossover: Strategy = {
    name: "Efficiency Gated Center Crossover",
    description: "Signals crossovers of the rolling median only when path efficiency is high, confirming coordinated drive.",
    defaultParams: {
        lookback: 40,
        minEfficiency: 0.6,
    },
    paramLabels: {
        lookback: "Lookback",
        minEfficiency: "Min Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minEfficiency = p.minEfficiency as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        return createSignalLoop(cleanData, [median, efficiency], (i) => {
            const m = median[i];
            const eff = efficiency[i];
            if (m === null || eff === null) return null;

            if (eff > minEfficiency) {
                const cross = checkCrossover(closes, median, i);
                if (cross === "bullish") {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish crossover above median with high efficiency (${eff.toFixed(3)} > ${minEfficiency})`
                    );
                }
                if (cross === "bearish") {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish crossover below median with high efficiency (${eff.toFixed(3)} > ${minEfficiency})`
                    );
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
