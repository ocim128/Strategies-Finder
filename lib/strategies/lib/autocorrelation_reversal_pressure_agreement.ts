import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation, buildRollingMedian } from "./price-action-statistics-core";
import { buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeAutocorrelationReversalPressureAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        autoCorrThreshold: normalizeNumberParam(params.autoCorrThreshold, -0.25, -1, 0),
    };
}

export const autocorrelation_reversal_pressure_agreement: Strategy = {
    name: "Autocorrelation Reversal with Pressure Agreement",
    description: "Trades mean-reversion around the trailing typical-price median when close returns show strongly negative autocorrelation and Polymarket pressure agrees.",
    defaultParams: {
        lookback: 30,
        autoCorrThreshold: -0.25,
    },
    paramLabels: {
        lookback: "Lookback",
        autoCorrThreshold: "Autocorrelation Threshold",
    },
    normalizeParams: normalizeAutocorrelationReversalPressureAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeAutocorrelationReversalPressureAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const autocorrelation = buildRollingAutoCorrelation(returns, lookback);
        const typicals = getTypicalPrices(cleanData);
        const median = buildRollingMedian(typicals, lookback);
        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [autocorrelation, median], (i) => {
            const autocorr = autocorrelation[i];
            const center = median[i];
            if (autocorr === null || center === null || autocorr > p.autoCorrThreshold) return null;

            if (typicals[i] < center && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Negative return autocorrelation below median with pressure agreement");
            }
            if (typicals[i] > center && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Negative return autocorrelation above median with pressure agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autoCorrThreshold"],
    },
};
