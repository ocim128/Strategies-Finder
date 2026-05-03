import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildRateOfChange, buildRollingMedian, buildRollingSkewness } from "./price-action-statistics-core";

function normalizeRocSkewnessQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 63))),
        quorum_threshold: Math.max(1, Math.min(3, Math.round(Number(params.quorum_threshold ?? 2)))),
    };
}

export const roc_skewness_quorum: Strategy = {
    name: "ROC Skewness Quorum",
    description:
        "Requires quorum across close ROC, rolling close skewness, and Chaikin money flow participation before entering.",
    defaultParams: {
        lookback: 63,
        quorum_threshold: 2,
    },
    paramLabels: {
        lookback: "Lookback",
        quorum_threshold: "Quorum Threshold",
    },
    normalizeParams: normalizeRocSkewnessQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRocSkewnessQuorumParams(params);
        const lookback = p.lookback as number;
        const quorum = p.quorum_threshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const volumes = getVolumes(cleanData);
        const roc = buildRateOfChange(closes, lookback);
        const skewness = buildRollingSkewness(closes, lookback);
        const median = buildRollingMedian(closes, lookback);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);

        return createSignalLoop(cleanData, [roc, skewness, median, cmf], (i) => {
            const rateOfChange = roc[i];
            const skew = skewness[i];
            const med = median[i];
            const flow = cmf[i];
            if (rateOfChange === null || skew === null || med === null || flow === null) return null;

            let longVotes = 0;
            let shortVotes = 0;

            if (rateOfChange > 0 && closes[i] > med) longVotes++;
            if (rateOfChange < 0 && closes[i] < med) shortVotes++;

            if (skew > 0 && closes[i] > med) longVotes++;
            if (skew < 0 && closes[i] < med) shortVotes++;

            if (flow > 0) longVotes++;
            if (flow < 0) shortVotes++;

            const longSignal = longVotes >= quorum;
            const shortSignal = shortVotes >= quorum;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `ROC/skew/CMF quorum long ${longVotes}/3`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `ROC/skew/CMF quorum short ${shortVotes}/3`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "quorum_threshold"],
    },
};
