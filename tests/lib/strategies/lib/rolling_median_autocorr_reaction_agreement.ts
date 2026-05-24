import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import {
    buildRollingAutoCorrelation,
    buildRollingMedian,
} from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeRollingMedianAutocorrReactionAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        corrThreshold: normalizeNumberParam(params.corrThreshold, -0.24, -1, 0),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

export const rolling_median_autocorr_reaction_agreement: Strategy = {
    name: "Rolling Median Autocorrelation Divergence with Reaction Agreement",
    description: "Fades median deviations in negative-autocorrelation regimes only when Polymarket reaction agreement permits the side.",
    defaultParams: {
        lookback: 30,
        corrThreshold: -0.24,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        corrThreshold: "Autocorrelation Threshold",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeRollingMedianAutocorrReactionAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeRollingMedianAutocorrReactionAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const autocorr = buildRollingAutoCorrelation(returns, lookback);
        const typicals = getTypicalPrices(cleanData);
        const median = buildRollingMedian(typicals, lookback);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [autocorr, median], (i) => {
            const corr = autocorr[i];
            const center = median[i];
            if (corr === null || center === null || corr > p.corrThreshold) return null;

            if (typicals[i] < center && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Negative autocorrelation below median with reaction agreement");
            }
            if (typicals[i] > center && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Negative autocorrelation above median with reaction agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "corrThreshold", "lagSec"],
    },
};
