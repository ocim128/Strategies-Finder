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

type EfficiencyRatioRegimePressureGapPrepared = {
    cleanData: OHLCVData[];
    closes: number[];
    efficiencyByLookback: Map<number, (number | null)[]>;
    rocByLookback: Map<number, (number | null)[]>;
};

function normalizeEfficiencyRatioRegimePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        minEfficiency: normalizeNumberParam(params.minEfficiency, 0.55, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.025, 0),
    };
}

function prepareEfficiencyRatioRegimePressureGapData(data: OHLCVData[]): EfficiencyRatioRegimePressureGapPrepared {
    const cleanData = ensureCleanData(data);
    return {
        cleanData,
        closes: getCloses(cleanData),
        efficiencyByLookback: new Map(),
        rocByLookback: new Map(),
    };
}

function getPreparedEfficiencyRatioRegimePressureGapData(
    preparedData: unknown,
    data: OHLCVData[]
): EfficiencyRatioRegimePressureGapPrepared {
    if (
        preparedData
        && typeof preparedData === "object"
        && "efficiencyByLookback" in preparedData
        && "rocByLookback" in preparedData
    ) {
        return preparedData as EfficiencyRatioRegimePressureGapPrepared;
    }
    return prepareEfficiencyRatioRegimePressureGapData(data);
}

function getPreparedEfficiency(
    prepared: EfficiencyRatioRegimePressureGapPrepared,
    lookback: number
): (number | null)[] {
    let efficiency = prepared.efficiencyByLookback.get(lookback);
    if (!efficiency) {
        efficiency = buildEfficiencyRatio(prepared.cleanData, lookback);
        prepared.efficiencyByLookback.set(lookback, efficiency);
    }
    return efficiency;
}

function getPreparedRoc(
    prepared: EfficiencyRatioRegimePressureGapPrepared,
    lookback: number
): (number | null)[] {
    let roc = prepared.rocByLookback.get(lookback);
    if (!roc) {
        roc = buildRateOfChange(prepared.closes, lookback);
        prepared.rocByLookback.set(lookback, roc);
    }
    return roc;
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
    prepareFinderData: (data) => prepareEfficiencyRatioRegimePressureGapData(data),
    executePrepared: (preparedData: unknown, params: StrategyParams, data: OHLCVData[], context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const prepared = getPreparedEfficiencyRatioRegimePressureGapData(preparedData, data);
        const cleanData = prepared.cleanData;
        const p = normalizeEfficiencyRatioRegimePressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const efficiency = getPreparedEfficiency(prepared, lookback);
        const roc = getPreparedRoc(prepared, lookback);
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
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) =>
        efficiency_ratio_regime_pressure_gap.executePrepared?.(
            prepareEfficiencyRatioRegimePressureGapData(data),
            params,
            data,
            context
        ) ?? [],
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency", "minEdge"],
    },
};
