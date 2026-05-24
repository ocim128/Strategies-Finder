import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingCorrelation } from "./price-action-statistics-core";
import { buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizePriceVolumeCorrelationPressureVetoParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 5),
        minCorrelation: normalizeNumberParam(params.minCorrelation, 0.4, 0, 1),
    };
}

export const price_volume_correlation_pressure_veto: Strategy = {
    name: "Price-Volume Correlation with Pressure Veto",
    description: "Requires strong rolling price-volume return agreement and Polymarket pressure agreement before entering directional moves.",
    defaultParams: {
        lookback: 35,
        minCorrelation: 0.4,
    },
    paramLabels: {
        lookback: "Lookback",
        minCorrelation: "Minimum Correlation",
    },
    normalizeParams: normalizePriceVolumeCorrelationPressureVetoParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizePriceVolumeCorrelationPressureVetoParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const closeReturns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const volumeReturns = volumes.map((volume, i) => i === 0 || volumes[i - 1] <= 0 || volume <= 0 ? 0 : Math.log(volume / volumes[i - 1]));
        const correlation = buildRollingCorrelation(closeReturns, volumeReturns, lookback);
        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [correlation], (i) => {
            const corr = correlation[i];
            if (corr === null || corr < p.minCorrelation) return null;

            if (closeReturns[i] > 0 && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Positive price-volume correlation on rising price with pressure agreement");
            }
            if (closeReturns[i] < 0 && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Positive price-volume correlation on falling price with pressure agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minCorrelation"],
    },
};
