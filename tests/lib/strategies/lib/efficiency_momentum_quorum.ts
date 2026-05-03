import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

function normalizeEfficiencyMomentumQuorumParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 55))),
        quorum_threshold: Math.max(1, Math.min(2, Math.round(Number(params.quorum_threshold ?? 2)))),
    };
}

export const efficiency_momentum_quorum: Strategy = {
    name: "Efficiency Momentum Quorum",
    description:
        "Requires quorum between rising path efficiency and median-aligned ROC momentum before entering daily trends.",
    defaultParams: {
        lookback: 55,
        quorum_threshold: 2,
    },
    paramLabels: {
        lookback: "Lookback",
        quorum_threshold: "Quorum Threshold",
    },
    normalizeParams: normalizeEfficiencyMomentumQuorumParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyMomentumQuorumParams(params);
        const lookback = p.lookback as number;
        const quorum = p.quorum_threshold as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const roc = buildRateOfChange(closes, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [efficiency, roc, median], (i) => {
            const er = efficiency[i];
            const priorEr = efficiency[i - 1];
            const rate = roc[i];
            const med = median[i];
            if (er === null || priorEr === null || rate === null || med === null) return null;

            let longVotes = 0;
            let shortVotes = 0;
            if (er > priorEr && closes[i] > med) longVotes++;
            if (er > priorEr && closes[i] < med) shortVotes++;

            if (rate > 0 && closes[i] > med) longVotes++;
            if (rate < 0 && closes[i] < med) shortVotes++;

            const longSignal = longVotes >= quorum;
            const shortSignal = shortVotes >= quorum;
            if (longSignal && !shortSignal) {
                return createBuySignal(cleanData, i, `Efficiency momentum quorum long ${longVotes}/2`);
            }
            if (shortSignal && !longSignal) {
                return createSellSignal(cleanData, i, `Efficiency momentum quorum short ${shortVotes}/2`);
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
