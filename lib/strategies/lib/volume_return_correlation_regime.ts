import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingCorrelation } from "./price-action-statistics-core";

const CORRELATION_GATE = 0.3;

function normalizeVolumeReturnCorrelationRegimeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volume_return_correlation_regime: Strategy = {
    name: "Volume Return Correlation Regime",
    description: "Trades the current bar's direction when the rolling correlation of one-bar returns with the volume proxy is strongly aligned.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeVolumeReturnCorrelationRegimeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeVolumeReturnCorrelationRegimeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const corr = buildRollingCorrelation(returns, volumes, lookback);

        return createSignalLoop(cleanData, [corr], (i) => {
            if (i < lookback) return null;
            const correlation = corr[i];
            if (correlation === null) return null;

            if (correlation > CORRELATION_GATE && returns[i] > 0) {
                return createBuySignal(cleanData, i, `Volume-return correlation buy: corr ${correlation.toFixed(2)} with positive return`);
            }
            if (correlation < -CORRELATION_GATE && returns[i] < 0) {
                return createSellSignal(cleanData, i, `Volume-return correlation sell: corr ${correlation.toFixed(2)} with negative return`);
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
