import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCumulativeDecaySum, extractBarMetricSeries } from "./price-action-statistics-core";

const BALANCE_THRESHOLD = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        decay: Math.min(0.999, Math.max(0.01, Number(params.decay ?? 0.9))),
    };
}

export const decayed_body_direction_balance: Strategy = {
    name: "Decayed Body Direction Balance",
    description: "Follows the current body when the decayed balance of body directions is clearly biased in its favor.",
    defaultParams: {
        decay: 0.9,
    },
    paramLabels: {
        decay: "Decay Retention",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const decay = normalizeParams(params).decay as number;
        if (cleanData.length < 2) return [];

        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const balance = buildCumulativeDecaySum(bodyDirection, decay);

        return createSignalLoop(cleanData, [], (i) => {
            const b = balance[i];

            if (b >= BALANCE_THRESHOLD && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Bullish body balance: ${b.toFixed(2)}`);
            }
            if (b <= -BALANCE_THRESHOLD && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Bearish body balance: ${b.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["decay"],
    },
};
