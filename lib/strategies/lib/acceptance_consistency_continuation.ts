import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingStdDev } from "./price-action-statistics-core";

const CONSISTENCY_PERCENTILE = 0.3;
const PLACEMENT_MID = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const acceptance_consistency_continuation: Strategy = {
    name: "Acceptance Consistency Continuation",
    description: "Continues directional bars while the dispersion of close acceptance sits in its low percentile range.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const acceptanceStd = buildRollingStdDev(acceptance, lookback);
        const stdFilled = acceptanceStd.map((value) => (value === null ? 0 : value));
        const stdRank = buildPercentileRank(stdFilled, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [stdRank], (i) => {
            const rank = stdRank[i];
            if (rank === null || rank >= CONSISTENCY_PERCENTILE) return null;

            const bar = cleanData[i];
            if (bar.close > bar.open && closeLocation[i] > PLACEMENT_MID) {
                return createBuySignal(cleanData, i, `Consistent bullish closes: std pctl ${rank.toFixed(2)}`);
            }
            if (bar.close < bar.open && closeLocation[i] < PLACEMENT_MID) {
                return createSellSignal(cleanData, i, `Consistent bearish closes: std pctl ${rank.toFixed(2)}`);
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
