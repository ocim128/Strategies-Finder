import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildCloseAcceptanceSeries,
    buildRangeSeries,
    buildRollingAverage,
    buildTrailingHighLow,
} from "./price-action-frequency-core";

function normalizeRangeExpansionAcceptanceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        expansion_lookback: Math.max(2, Math.round(Number(params.expansion_lookback ?? 20))),
    };
}

export const range_expansion_acceptance: Strategy = {
    name: "Range Expansion Acceptance",
    description:
        "Chases daily range expansion only when the completed close accepts a new trailing high or low territory.",
    defaultParams: {
        expansion_lookback: 20,
    },
    paramLabels: {
        expansion_lookback: "Expansion Lookback",
    },
    normalizeParams: normalizeRangeExpansionAcceptanceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRangeExpansionAcceptanceParams(params);
        const lookback = p.expansion_lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const ranges = buildRangeSeries(cleanData);
        const averageRange = buildRollingAverage(ranges, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);

        return createSignalLoop(cleanData, [averageRange, highest, lowest], (i) => {
            const avgRange = averageRange[i];
            const priorHigh = highest[i];
            const priorLow = lowest[i];
            if (avgRange === null || priorHigh === null || priorLow === null || avgRange <= 0) return null;

            const rangeExpanding = ranges[i] > avgRange;
            if (!rangeExpanding) return null;

            if (cleanData[i].high > priorHigh && closes[i] > priorHigh && closeAcceptance[i] > 0.5) {
                return createBuySignal(cleanData, i, "Range expansion accepted above trailing high");
            }
            if (cleanData[i].low < priorLow && closes[i] < priorLow && closeAcceptance[i] < -0.5) {
                return createSellSignal(cleanData, i, "Range expansion accepted below trailing low");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["expansion_lookback"],
    },
};
