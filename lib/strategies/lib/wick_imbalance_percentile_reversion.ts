import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        pctlExtreme: Math.max(0.5, Math.min(1.0, Number(params.pctlExtreme ?? 0.85))),
    };
}

export const wick_imbalance_percentile_reversion: Strategy = {
    name: "Wick Imbalance Percentile Reversion",
    description: "Fades extreme wick imbalances indicating rejected price probes.",
    defaultParams: {
        lookback: 30,
        pctlExtreme: 0.85,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pctlExtreme: "Percentile Extreme",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const rawImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        // Negate the helper's (lower - upper) to get (upper - lower)
        const imbalance = rawImbalance.map((v) => -v);
        const percentile = buildPercentileRank(imbalance, lookback);

        return createSignalLoop(cleanData, [percentile], (i) => {
            const pRank = percentile[i];
            if (pRank === null) return null;

            // Buy: extreme lower wick rejection (percentile rank is very low)
            if (pRank < (1 - p.pctlExtreme)) {
                return createBuySignal(cleanData, i, `Wick imbalance buy: percentile rank ${pRank.toFixed(2)}`);
            }
            // Sell: extreme upper wick rejection (percentile rank is very high)
            if (pRank > p.pctlExtreme) {
                return createSellSignal(cleanData, i, `Wick imbalance sell: percentile rank ${pRank.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctlExtreme"],
    },
};
