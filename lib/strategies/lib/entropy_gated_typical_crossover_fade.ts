import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
    checkCrossover,
} from "../strategy-helpers";
import { buildRollingMedian, buildRollingEntropy, extractBarMetricSeries } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming high return entropy isolates a noise-driven false crossover regime.
// #SUGGEST_VERIFY: Verify return entropy lookback (>= 3) and minEntropy (> 0).
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
        minEntropy: Math.max(0.1, Number(params.minEntropy ?? 0.65)),
    };
}

export const entropy_gated_typical_crossover_fade: Strategy = {
    name: "Entropy Gated Typical Crossover Fade",
    description: "Fades typical price crossovers of the rolling median when return entropy is high, indicating a noisy mean-reverting regime.",
    defaultParams: {
        lookback: 40,
        minEntropy: 0.65,
    },
    paramLabels: {
        lookback: "Lookback",
        minEntropy: "Min Entropy",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minEntropy = p.minEntropy as number;
        if (cleanData.length < lookback + 1) return [];

        const typical = getTypicalPrices(cleanData);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const entropy = buildRollingEntropy(returns, lookback);
        const median = buildRollingMedian(typical, lookback);

        return createSignalLoop(cleanData, [entropy, median], (i) => {
            const ent = entropy[i];
            const m = median[i];
            if (ent === null || m === null) return null;

            if (ent > minEntropy) {
                const cross = checkCrossover(typical, median, i);
                // Typical crosses below median -> fade it with a Buy
                if (cross === "bearish") {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Bullish reversion: typical crossed below median under high entropy (${ent.toFixed(3)} > ${minEntropy})`
                    );
                }
                // Typical crosses above median -> fade it with a Sell
                if (cross === "bullish") {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Bearish reversion: typical crossed above median under high entropy (${ent.toFixed(3)} > ${minEntropy})`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEntropy"],
    },
};
