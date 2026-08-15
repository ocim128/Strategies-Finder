import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const EXPANSION_PERCENTILE_BAND = 0.8;
const EXHAUSTION_LOW_BAND = 0.33;
const EXHAUSTION_HIGH_BAND = 0.67;

function normalizeExpansionExhaustionFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const expansion_exhaustion_fade: Strategy = {
    name: "Expansion Exhaustion Fade",
    description: "Fades an expansion bar when the very next bar closes on the opposite side of its own range, reading one-bar exhaustion.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeExpansionExhaustionFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeExpansionExhaustionFadeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const rangePct = buildPercentileRank(buildRangeSeries(cleanData), lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangePct], (i) => {
            if (i < lookback) return null;
            const priorExpansion = rangePct[i - 1];
            if (priorExpansion === null) return null;

            if (priorExpansion > EXPANSION_PERCENTILE_BAND && closeLocation[i] < EXHAUSTION_LOW_BAND) {
                return createBuySignal(cleanData, i, `Expansion exhaustion buy: prior range rank ${priorExpansion.toFixed(2)}, next bar closed lower-third`);
            }
            if (priorExpansion > EXPANSION_PERCENTILE_BAND && closeLocation[i] > EXHAUSTION_HIGH_BAND) {
                return createSellSignal(cleanData, i, `Expansion exhaustion sell: prior range rank ${priorExpansion.toFixed(2)}, next bar closed upper-third`);
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
