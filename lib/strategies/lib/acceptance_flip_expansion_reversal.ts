import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const ACCEPTANCE_FLIP_BAND = 0.3;
const EXPANSION_FLOOR = 0.7;

function normalizeAcceptanceFlipExpansionReversalParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const acceptance_flip_expansion_reversal: Strategy = {
    name: "Acceptance Flip Expansion Reversal",
    description: "Reverses a two-bar close-acceptance sign flip when the flip bar's range expands to a high percentile.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeAcceptanceFlipExpansionReversalParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeAcceptanceFlipExpansionReversalParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const rangePct = buildPercentileRank(buildRangeSeries(cleanData), lookback);

        return createSignalLoop(cleanData, [rangePct], (i) => {
            if (i < lookback) return null;
            const rank = rangePct[i];
            if (rank === null) return null;

            if (acceptance[i - 1] < -ACCEPTANCE_FLIP_BAND && acceptance[i] > ACCEPTANCE_FLIP_BAND && rank > EXPANSION_FLOOR) {
                return createBuySignal(cleanData, i, `Acceptance flip buy: bearish ${acceptance[i - 1].toFixed(2)} to bullish ${acceptance[i].toFixed(2)}, range rank ${rank.toFixed(2)}`);
            }
            if (acceptance[i - 1] > ACCEPTANCE_FLIP_BAND && acceptance[i] < -ACCEPTANCE_FLIP_BAND && rank > EXPANSION_FLOOR) {
                return createSellSignal(cleanData, i, `Acceptance flip sell: bullish ${acceptance[i - 1].toFixed(2)} to bearish ${acceptance[i].toFixed(2)}, range rank ${rank.toFixed(2)}`);
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
