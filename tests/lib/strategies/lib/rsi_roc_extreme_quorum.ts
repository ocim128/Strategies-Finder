import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateRSI } from "../indicators";
import { buildPercentileRank, buildRateOfChange } from "./price-action-statistics-core";

function normalizeRsiRocExtremeQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        percentile_lookback: Math.max(2, Math.round(Number(params.percentile_lookback ?? 200))),
    };
}

export const rsi_roc_extreme_quorum: Strategy = {
    name: "RSI-ROC Extreme Quorum",
    description:
        "Requires RSI and ROC percentile ranks to agree at long-horizon extremes before signaling.",
    defaultParams: {
        lookback: 20,
        percentile_lookback: 200,
    },
    paramLabels: {
        lookback: "Lookback",
        percentile_lookback: "Percentile Lookback",
    },
    normalizeParams: normalizeRsiRocExtremeQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRsiRocExtremeQuorumParams(params);
        const lookback = p.lookback as number;
        const percentileLookback = p.percentile_lookback as number;
        if (cleanData.length < lookback + percentileLookback) return [];

        const closes = getCloses(cleanData);
        const rsi = calculateRSI(closes, lookback);
        const roc = buildRateOfChange(closes, lookback);
        const rsiRank = buildPercentileRank(rsi.map((value) => value ?? 50), percentileLookback);
        const rocRank = buildPercentileRank(roc.map((value) => value ?? 0), percentileLookback);

        return createSignalLoop(cleanData, [rsi, roc, rsiRank, rocRank], (i) => {
            const rsiPercentile = rsiRank[i];
            const rocPercentile = rocRank[i];
            if (rsiPercentile === null || rocPercentile === null) return null;

            if (rsiPercentile > 0.7 && rocPercentile > 0.7) {
                return createBuySignal(cleanData, i, `RSI/ROC percentile quorum long rsi=${rsiPercentile.toFixed(2)} roc=${rocPercentile.toFixed(2)}`);
            }
            if (rsiPercentile < 0.3 && rocPercentile < 0.3) {
                return createSellSignal(cleanData, i, `RSI/ROC percentile quorum short rsi=${rsiPercentile.toFixed(2)} roc=${rocPercentile.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "percentile_lookback"],
    },
};
