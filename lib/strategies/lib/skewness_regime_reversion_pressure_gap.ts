import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingSkewness } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeSkewnessRegimeReversionPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 40, 5),
        skewThreshold: normalizeNumberParam(params.skewThreshold, 1.5, 0),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

export const skewness_regime_reversion_pressure_gap: Strategy = {
    name: "Skewness Regime Reversion with Pressure Gap",
    description: "Fades extreme rolling close-return skewness when Polymarket pressure edge supports the reversion side.",
    defaultParams: {
        lookback: 40,
        skewThreshold: 1.5,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Lookback",
        skewThreshold: "Skewness Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeSkewnessRegimeReversionPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessRegimeReversionPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const skewness = buildRollingSkewness(returns, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [skewness, pressure.longEdge, pressure.shortEdge], (i) => {
            const skew = skewness[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (skew === null || longEdge === null || shortEdge === null) return null;

            if (skew <= -p.skewThreshold && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Negative return skewness with YES pressure edge");
            }
            if (skew >= p.skewThreshold && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Positive return skewness with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewThreshold", "minEdge"],
    },
};
