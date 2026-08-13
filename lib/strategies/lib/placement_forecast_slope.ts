import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation, extractBarMetricSeries } from "./price-action-statistics-core";

const REGIME_GATE = 0.3;
const HIGH_PLACEMENT = 0.6;
const LOW_PLACEMENT = 0.4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
    };
}

export const placement_forecast_slope: Strategy = {
    name: "Placement Forecast Slope",
    description: "Trades the estimated rolling correlation between close placement and the next bar's return.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Estimation Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const location = buildCloseLocationSeries(cleanData);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");

        // lagged[i] = location of the PRIOR bar, so the correlation at i pairs
        // (location[j-1], return[j]) with j <= i: strictly causal.
        const lagged = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            lagged[i] = location[i - 1];
        }
        const corr = buildRollingCorrelation(lagged, returns, lookback);

        return createSignalLoop(cleanData, [corr], (i) => {
            const c = corr[i];
            if (c === null) return null;

            const currentLocation = location[i];
            if (c >= REGIME_GATE) {
                // Placement pays: high placement continues, low placement fails.
                if (currentLocation >= HIGH_PLACEMENT) {
                    return createBuySignal(cleanData, i, `Placement pays: corr ${c.toFixed(2)}, location ${currentLocation.toFixed(2)}`);
                }
                if (currentLocation <= LOW_PLACEMENT) {
                    return createSellSignal(cleanData, i, `Placement pays: corr ${c.toFixed(2)}, location ${currentLocation.toFixed(2)}`);
                }
            } else if (c <= -REGIME_GATE) {
                // Placement is faded: low placement bounces, high placement gives back.
                if (currentLocation <= LOW_PLACEMENT) {
                    return createBuySignal(cleanData, i, `Placement fades: corr ${c.toFixed(2)}, location ${currentLocation.toFixed(2)}`);
                }
                if (currentLocation >= HIGH_PLACEMENT) {
                    return createSellSignal(cleanData, i, `Placement fades: corr ${c.toFixed(2)}, location ${currentLocation.toFixed(2)}`);
                }
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
