import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildEfficiencyRatio } from "./price-action-statistics-core";

const EFFICIENCY_GATE = 0.5;
const ACCEPTANCE_BAND = 0.3;
const PLACEMENT_MID = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const efficiency_acceptance_continuation: Strategy = {
    name: "Efficiency Acceptance Continuation",
    description: "Continues high-efficiency trends only when close acceptance and placement settle on the trend side.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Efficiency Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [efficiency], (i) => {
            const ratio = efficiency[i];
            if (ratio === null || ratio <= EFFICIENCY_GATE) return null;

            if (acceptance[i] > ACCEPTANCE_BAND && closeLocation[i] > PLACEMENT_MID) {
                return createBuySignal(cleanData, i, `Efficient trend with acceptance: ER ${ratio.toFixed(2)}`);
            }
            if (acceptance[i] < -ACCEPTANCE_BAND && closeLocation[i] < PLACEMENT_MID) {
                return createSellSignal(cleanData, i, `Efficient trend with acceptance: ER ${ratio.toFixed(2)}`);
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
