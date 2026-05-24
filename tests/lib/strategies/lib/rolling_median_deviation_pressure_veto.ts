import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import { buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeRollingMedianDeviationPressureVetoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        multiplier: normalizeNumberParam(params.multiplier, 1.5, 0.1),
    };
}

export const rolling_median_deviation_pressure_veto: Strategy = {
    name: "Rolling Median Deviation with Pressure Veto",
    description: "Trades ATR-sized typical-price deviations from a rolling median only when Polymarket pressure agreement permits the side.",
    defaultParams: {
        lookback: 30,
        multiplier: 1.5,
    },
    paramLabels: {
        lookback: "Lookback",
        multiplier: "ATR Multiplier",
    },
    normalizeParams: normalizeRollingMedianDeviationPressureVetoParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeRollingMedianDeviationPressureVetoParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const median = buildRollingMedian(typicals, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), getCloses(cleanData), lookback);
        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [median, atr], (i) => {
            const center = median[i];
            const atrValue = atr[i];
            if (center === null || atrValue === null) return null;

            const threshold = p.multiplier * atrValue;
            if (typicals[i] > center + threshold && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Typical price above median deviation with pressure agreement");
            }
            if (typicals[i] < center - threshold && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Typical price below median deviation with pressure agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "multiplier"],
    },
};
