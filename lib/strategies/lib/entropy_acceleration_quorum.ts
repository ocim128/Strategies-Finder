import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingEntropy, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEntropyAccelerationQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        entropy_lookback: Math.max(3, Math.round(Number(params.entropy_lookback ?? 55))),
        quorum_threshold: Math.max(1, Math.min(2, Math.round(Number(params.quorum_threshold ?? 2)))),
    };
}

export const entropy_acceleration_quorum: Strategy = {
    name: "Entropy Acceleration Quorum",
    description:
        "Requires agreement between entropy decline and negative entropy acceleration before entering low-entropy directional closes.",
    defaultParams: {
        entropy_lookback: 55,
        quorum_threshold: 2,
    },
    paramLabels: {
        entropy_lookback: "Entropy Lookback",
        quorum_threshold: "Quorum Threshold",
    },
    normalizeParams: normalizeEntropyAccelerationQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyAccelerationQuorumParams(params);
        const lookback = p.entropy_lookback as number;
        const quorum = p.quorum_threshold as number;
        if (cleanData.length < lookback * 2 + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const entropy = buildRollingEntropy(returns, lookback);
        const entropyRoc = buildRateOfChange(entropy.map((value) => value ?? 0), lookback);
        const closeMedian = buildRollingMedian(closes, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [entropy, entropyRoc, closeMedian], (i) => {
            if (i < lookback * 2) return null;

            const currentEntropy = entropy[i];
            const previousEntropy = entropy[i - 1];
            const acceleration = entropyRoc[i];
            const median = closeMedian[i];
            if (currentEntropy === null || previousEntropy === null || acceleration === null || median === null) return null;

            let longVotes = 0;
            let shortVotes = 0;

            if (currentEntropy < previousEntropy && closes[i] > median) longVotes++;
            if (currentEntropy < previousEntropy && closes[i] < median) shortVotes++;

            if (acceleration < 0 && closeLocation[i] > 0.55) longVotes++;
            if (acceleration < 0 && closeLocation[i] < 0.45) shortVotes++;

            const longSignal = longVotes >= quorum;
            const shortSignal = shortVotes >= quorum;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Entropy quorum long ${longVotes}/2`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Entropy quorum short ${shortVotes}/2`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["entropy_lookback", "quorum_threshold"],
    },
};
