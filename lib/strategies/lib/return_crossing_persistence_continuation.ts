import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRateOfChange, buildThresholdCrossingCount } from "./price-action-statistics-core";

const MAX_CROSSING_FRACTION = 0.25;

function normalizeReturnCrossingPersistenceContinuationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 25))),
    };
}

export const return_crossing_persistence_continuation: Strategy = {
    name: "Return Crossing Persistence Continuation",
    description: "Rides windows where one-bar close returns rarely cross zero and the net move agrees, continuing persistent one-sided auctions.",
    defaultParams: {
        lookback: 25,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeReturnCrossingPersistenceContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeReturnCrossingPersistenceContinuationParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const crossings = buildThresholdCrossingCount(returns, lookback, 0);

        const netSum = new Array<number>(cleanData.length).fill(0);
        let acc = 0;
        for (let i = 0; i < cleanData.length; i++) {
            acc += returns[i];
            netSum[i] = acc;
        }

        return createSignalLoop(cleanData, [crossings], (i) => {
            if (i < lookback) return null;
            const count = crossings[i];
            if (count === null) return null;
            const windowSum = netSum[i] - (i >= lookback ? netSum[i - lookback] : 0);
            const fraction = count / lookback;

            if (fraction <= MAX_CROSSING_FRACTION && windowSum > 0) {
                return createBuySignal(cleanData, i, `Persistence continuation buy: ${count}/${lookback} zero crossings, net ${windowSum.toFixed(4)} positive`);
            }
            if (fraction <= MAX_CROSSING_FRACTION && windowSum < 0) {
                return createSellSignal(cleanData, i, `Persistence continuation sell: ${count}/${lookback} zero crossings, net ${windowSum.toFixed(4)} negative`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
