import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

const AUTOCORRELATION_GATE = 0.2;
const PLACEMENT_MID = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
    };
}

export const range_autocorrelation_volatility_persistence: Strategy = {
    name: "Range Autocorrelation Volatility Persistence",
    description: "Continues directional bars when lag-1 range autocorrelation marks a persistent volatility regime.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const ranges = buildRangeSeries(cleanData);
        const rawPersistence = buildRollingAutoCorrelation(ranges, lookback, 1);
        const persistence = rawPersistence.map((value) =>
            value === null || !Number.isFinite(value) ? null : value
        );
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [persistence], (i) => {
            const correlation = persistence[i];
            if (correlation === null || correlation <= AUTOCORRELATION_GATE) return null;

            const bar = cleanData[i];
            if (bar.close > bar.open && closeLocation[i] > PLACEMENT_MID) {
                return createBuySignal(cleanData, i, `Persistent volatility regime: autocorr ${correlation.toFixed(2)}`);
            }
            if (bar.close < bar.open && closeLocation[i] < PLACEMENT_MID) {
                return createSellSignal(cleanData, i, `Persistent volatility regime: autocorr ${correlation.toFixed(2)}`);
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
