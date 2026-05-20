import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { buildRollingMinMax } from "./polymarket-1s-strategy-utils";

function normalizeTypicalPriceAutocorrelationActionableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 3),
        autocorrThreshold: normalizeNumberParam(params.autocorrThreshold, 0.35, -1, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.015, 0),
    };
}

export const typical_price_autocorrelation_actionable_edge: Strategy = {
    name: "Typical Price Autocorrelation Actionable Edge",
    description: "Trades persistent typical-price breakouts only when the matching Polymarket side is actionable and underpriced.",
    defaultParams: {
        lookback: 30,
        autocorrThreshold: 0.35,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Lookback",
        autocorrThreshold: "Autocorrelation Threshold",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeTypicalPriceAutocorrelationActionableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPriceAutocorrelationActionableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 3) return [];

        const typical = getTypicalPrices(cleanData);
        const autocorr = buildRollingAutoCorrelation(typical, lookback);
        const boundaries = buildRollingMinMax(typical, lookback, false);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [autocorr, boundaries.min, boundaries.max], (i) => {
            if (i < lookback + 1 || (autocorr[i] ?? -Infinity) <= p.autocorrThreshold) return null;

            const crossedUpper = typical[i] > (boundaries.max[i] ?? Infinity)
                && typical[i - 1] <= (boundaries.max[i - 1] ?? -Infinity);
            if (
                crossedUpper
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Typical price autocorrelation breakout with YES edge");
            }

            const crossedLower = typical[i] < (boundaries.min[i] ?? -Infinity)
                && typical[i - 1] >= (boundaries.min[i - 1] ?? Infinity);
            if (
                crossedLower
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Typical price autocorrelation breakdown with NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autocorrThreshold", "minEdge"],
    },
};
