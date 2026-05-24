import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateATR, calculateVWAP } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingMedian } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeVwapDeviationVolatilityGatedEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        deviationMultiplier: normalizeNumberParam(params.deviationMultiplier, 2.2, 0.1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const vwap_deviation_volatility_gated_edge: Strategy = {
    name: "VWAP Deviation Volatility-Gated Edge",
    description: "Fades high-volume typical-price deviations from rolling VWAP only when the matching Polymarket ask is actionable and underpriced.",
    defaultParams: {
        lookback: 30,
        deviationMultiplier: 2.2,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        deviationMultiplier: "Deviation ATR Multiplier",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeVwapDeviationVolatilityGatedEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVwapDeviationVolatilityGatedEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const typicals = getTypicalPrices(cleanData);
        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const volumeMedian = buildRollingMedian(volumes, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [vwap, atr, volumeMedian], (i) => {
            const center = vwap[i];
            const range = atr[i];
            const medianVolume = volumeMedian[i];
            if (center === null || range === null || medianVolume === null || volumes[i] <= medianVolume) return null;

            if (
                typicals[i] < center - p.deviationMultiplier * range
                && actionability.yesActionable[i]
                && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createBuySignal(cleanData, i, "Typical price below VWAP deviation with executable YES edge");
            }
            if (
                typicals[i] > center + p.deviationMultiplier * range
                && actionability.noActionable[i]
                && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge
            ) {
                return createSellSignal(cleanData, i, "Typical price above VWAP deviation with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "deviationMultiplier", "minEdge"],
    },
};
