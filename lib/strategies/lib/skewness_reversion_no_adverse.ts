import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeSkewnessReversionNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 40, 5),
        skewThreshold: normalizeNumberParam(params.skewThreshold, 1.3, 0),
    };
}

export const skewness_reversion_no_adverse: Strategy = {
    name: "Skewness Reversion with No Adverse Mask",
    description: "Fades extreme rolling typical-price skewness only when the Polymarket no-adverse actionable mask permits the matching side.",
    defaultParams: {
        lookback: 40,
        skewThreshold: 1.3,
    },
    paramLabels: {
        lookback: "Lookback",
        skewThreshold: "Skewness Threshold",
    },
    normalizeParams: normalizeSkewnessReversionNoAdverseParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessReversionNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const skewness = buildRollingSkewness(getTypicalPrices(cleanData), lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [skewness], (i) => {
            const skew = skewness[i];
            if (skew === null) return null;

            if (skew <= -p.skewThreshold && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Negative typical-price skewness reversion with no adverse YES mask");
            }
            if (skew >= p.skewThreshold && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Positive typical-price skewness reversion with no adverse NO mask");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold"],
    },
};
