import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const EXPANSION_PERCENTILE_BAND = 0.8;
const PLACEMENT_MID = 0.5;

function normalizeExpansionFailureReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const expansion_failure_reversion: Strategy = {
    name: "Expansion Failure Reversion",
    description: "Fades high-percentile range bars that close against their own body direction, reading an intrabar expansion failure.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeExpansionFailureReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeExpansionFailureReversionParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const rangePct = buildPercentileRank(buildRangeSeries(cleanData), lookback);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangePct], (i) => {
            if (i < lookback) return null;
            const rank = rangePct[i];
            if (rank === null) return null;

            if (rank > EXPANSION_PERCENTILE_BAND && bodyDirection[i] < 0 && closeLocation[i] > PLACEMENT_MID) {
                return createBuySignal(cleanData, i, `Expansion failure buy: range rank ${rank.toFixed(2)}, bearish expansion closed upper-half`);
            }
            if (rank > EXPANSION_PERCENTILE_BAND && bodyDirection[i] > 0 && closeLocation[i] < PLACEMENT_MID) {
                return createSellSignal(cleanData, i, `Expansion failure sell: range rank ${rank.toFixed(2)}, bullish expansion closed lower-half`);
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
