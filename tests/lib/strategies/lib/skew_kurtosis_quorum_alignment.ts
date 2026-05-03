import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRollingKurtosis,
    buildRollingMedian,
    buildRollingSkewness,
} from "./price-action-statistics-core";

function normalizeSkewKurtosisQuorumAlignmentParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 63))),
        quorum_threshold: Math.max(1, Math.min(3, Math.round(Number(params.quorum_threshold ?? 2)))),
    };
}

export const skew_kurtosis_quorum_alignment: Strategy = {
    name: "Skew Kurtosis Quorum Alignment",
    description:
        "Requires quorum across skew direction, relative kurtosis stability, and percentile rank before taking completed-bar directional distribution signals.",
    defaultParams: {
        lookback: 63,
        quorum_threshold: 2,
    },
    paramLabels: {
        lookback: "Lookback",
        quorum_threshold: "Quorum Threshold",
    },
    normalizeParams: normalizeSkewKurtosisQuorumAlignmentParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSkewKurtosisQuorumAlignmentParams(params);
        const lookback = p.lookback as number;
        const quorum = p.quorum_threshold as number;
        if (cleanData.length < lookback * 2) return [];

        const closes = getCloses(cleanData);
        const skewness = buildRollingSkewness(closes, lookback);
        const kurtosis = buildRollingKurtosis(closes, lookback);
        const closeMedian = buildRollingMedian(closes, lookback);
        const percentileRank = buildPercentileRank(closes, lookback);
        const kurtosisMedian = buildRollingMedian(kurtosis.map((value) => value ?? 0), lookback);

        return createSignalLoop(cleanData, [skewness, kurtosis, closeMedian, percentileRank, kurtosisMedian], (i) => {
            if (i < lookback * 2 - 2) return null;

            const skew = skewness[i];
            const kurt = kurtosis[i];
            const median = closeMedian[i];
            const percentile = percentileRank[i];
            const kurtMedian = kurtosisMedian[i];
            if (skew === null || kurt === null || median === null || percentile === null || kurtMedian === null) return null;

            let longVotes = 0;
            let shortVotes = 0;

            if (skew > 0 && closes[i] > median) longVotes++;
            if (skew < 0 && closes[i] < median) shortVotes++;

            if (kurt < kurtMedian && closes[i] > median) longVotes++;
            if (kurt < kurtMedian && closes[i] < median) shortVotes++;

            if (percentile > 0.6) longVotes++;
            if (percentile < 0.4) shortVotes++;

            const longSignal = longVotes >= quorum;
            const shortSignal = shortVotes >= quorum;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Distribution quorum long ${longVotes}/3`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Distribution quorum short ${shortVotes}/3`);
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
