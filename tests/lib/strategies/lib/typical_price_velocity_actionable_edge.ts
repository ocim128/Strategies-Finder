import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
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
import { calculateATR } from "../indicators";
import { buildRateOfChange } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeTypicalPriceVelocityActionableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 15, 1),
        atrLookback: normalizeIntegerParam(params.atrLookback, 20, 2),
        minEdge: normalizeNumberParam(params.minEdge, 0.015, 0),
    };
}

export const typical_price_velocity_actionable_edge: Strategy = {
    name: "Typical Price Velocity Actionable Edge",
    description: "Trades rapid normalized typical-price velocity only when Polymarket quotes are actionable and underpriced.",
    defaultParams: {
        lookback: 15,
        atrLookback: 20,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Velocity Lookback",
        atrLookback: "ATR Lookback",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeTypicalPriceVelocityActionableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPriceVelocityActionableEdgeParams(params);
        const maxLookback = Math.max(p.lookback, p.atrLookback);
        if (cleanData.length < maxLookback + 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);
        const typicalRoc = buildRateOfChange(typical, p.lookback);
        const atr = calculateATR(highs, lows, closes, p.atrLookback);
        const normalizedAtr = atr.map((value, i) => value === null || typical[i] <= 0 ? null : value / typical[i]);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: p.atrLookback });
        if (!edge.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: p.atrLookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!actionability.available) return [];

        return createSignalLoop(cleanData, [typicalRoc, normalizedAtr], (i) => {
            if (i < maxLookback) return null;
            const threshold = (normalizedAtr[i] ?? Infinity) * 1.5;
            const roc = typicalRoc[i];
            if (roc === null || !Number.isFinite(threshold)) return null;

            if (roc > threshold && actionability.yesActionable[i] && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge) {
                return createBuySignal(cleanData, i, "Typical price velocity burst with executable YES edge");
            }
            if (roc < -threshold && actionability.noActionable[i] && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge) {
                return createSellSignal(cleanData, i, "Typical price velocity burst with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrLookback", "minEdge"],
    },
};
