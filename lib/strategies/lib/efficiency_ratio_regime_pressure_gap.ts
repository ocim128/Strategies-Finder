import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEfficiencyRatioRegimePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        minEfficiency: normalizeNumberParam(params.minEfficiency, 0.55, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

export const efficiency_ratio_regime_pressure_gap: Strategy = {
    name: "Efficiency Ratio Regime with Pressure Gap",
    description: "Joins high-efficiency close trends only when Polymarket pressure edge confirms same-side underpricing.",
    defaultParams: {
        lookback: 30,
        minEfficiency: 0.55,
        minEdge: 0.025,
    },
    paramLabels: {
        lookback: "Lookback",
        minEfficiency: "Minimum Efficiency Ratio",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeEfficiencyRatioRegimePressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyRatioRegimePressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const roc = buildRateOfChange(closes, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [efficiency, roc, pressure.longEdge, pressure.shortEdge], (i) => {
            const er = efficiency[i];
            const change = roc[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (er === null || change === null || longEdge === null || shortEdge === null || er < p.minEfficiency) return null;

            if (change > 0 && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "High-efficiency positive ROC with YES pressure edge");
            }
            if (change < 0 && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "High-efficiency negative ROC with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency", "minEdge"],
    },
};
