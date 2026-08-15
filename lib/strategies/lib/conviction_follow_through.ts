import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries, buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const CONVICTION_PERCENTILE_BAND = 0.85;
const FOLLOW_PLACEMENT_HIGH = 0.6;
const FOLLOW_PLACEMENT_LOW = 0.4;

function normalizeConvictionFollowThroughParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const conviction_follow_through: Strategy = {
    name: "Conviction Follow Through",
    description: "Follows the bar right after a high body-proportion conviction bar when it closes in the same direction with placement agreement.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeConvictionFollowThroughParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeConvictionFollowThroughParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const bodyPctPctl = buildPercentileRank(buildBodyPctSeries(cleanData), lookback);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [bodyPctPctl], (i) => {
            if (i < lookback) return null;
            const priorConviction = bodyPctPctl[i - 1];
            if (priorConviction === null) return null;

            if (priorConviction > CONVICTION_PERCENTILE_BAND && bodyDirection[i - 1] > 0 && bodyDirection[i] > 0 && closeLocation[i] > FOLLOW_PLACEMENT_HIGH) {
                return createBuySignal(cleanData, i, `Conviction follow buy: prior body rank ${priorConviction.toFixed(2)}, same-direction close at placement ${closeLocation[i].toFixed(2)}`);
            }
            if (priorConviction > CONVICTION_PERCENTILE_BAND && bodyDirection[i - 1] < 0 && bodyDirection[i] < 0 && closeLocation[i] < FOLLOW_PLACEMENT_LOW) {
                return createSellSignal(cleanData, i, `Conviction follow sell: prior body rank ${priorConviction.toFixed(2)}, same-direction close at placement ${closeLocation[i].toFixed(2)}`);
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
