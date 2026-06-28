import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeWickRejectionReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        wickImbalanceMin: Math.max(0, Math.min(1, Number(params.wickImbalanceMin ?? 0.30))),
        rangePercentileMin: Math.max(0, Math.min(1, Number(params.rangePercentileMin ?? 0.50))),
    };
}

export const wick_rejection_reversion: Strategy = {
    name: "Wick Rejection Reversion",
    description: "Reversion entry after strong wick rejection (wick imbalance) with close near bar center.",
    defaultParams: {
        lookback: 25,
        wickImbalanceMin: 0.30,
        rangePercentileMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback",
        wickImbalanceMin: "Wick Imbalance Min",
        rangePercentileMin: "Range Percentile Min",
    },
    normalizeParams: normalizeWickRejectionReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeWickRejectionReversionParams(params);
        const lookback = p.lookback as number;
        const wickImbalanceMin = p.wickImbalanceMin as number;
        const rangePercentileMin = p.rangePercentileMin as number;
        if (cleanData.length < lookback + 1) return [];

        const wickImbalance = extractBarMetricSeries(cleanData, "wickImbalance");
        const closeLocation = buildCloseLocationSeries(cleanData);
        const ranges = buildRangeSeries(cleanData);
        const rangePercentile = buildPercentileRank(ranges, lookback);

        return createSignalLoop(cleanData, [rangePercentile, wickImbalance], (i) => {
            const rngPct = rangePercentile[i];
            const imb = wickImbalance[i];
            if (rngPct === null || imb === null) return null;

            const cl = closeLocation[i];
            const closeNearCenter = cl >= 0.40 && cl <= 0.60;

            if (rngPct > rangePercentileMin && closeNearCenter) {
                // Buy on downside rejection (buying pressure wick at bottom, wickImbalance < -wickImbalanceMin)
                if (imb < -wickImbalanceMin) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Wick rejection buy: imbalance ${imb.toFixed(2)}, close location ${cl.toFixed(2)}, range pct ${rngPct.toFixed(2)}`
                    );
                }
                // Sell on upside rejection (selling pressure wick at top, wickImbalance > wickImbalanceMin)
                if (imb > wickImbalanceMin) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Wick rejection sell: imbalance ${imb.toFixed(2)}, close location ${cl.toFixed(2)}, range pct ${rngPct.toFixed(2)}`
                    );
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "wickImbalanceMin", "rangePercentileMin"],
    },
};
