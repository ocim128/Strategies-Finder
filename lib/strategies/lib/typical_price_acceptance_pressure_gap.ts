import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeTypicalPriceAcceptancePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        minAcceptanceRatio: normalizeNumberParam(params.minAcceptanceRatio, 0.65, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.03, 0),
    };
}

export const typical_price_acceptance_pressure_gap: Strategy = {
    name: "Typical Price Acceptance with Pressure Gap",
    description: "Trades persistent upper or lower range acceptance only when Polymarket pressure gap underprices the migration side.",
    defaultParams: {
        lookback: 30,
        minAcceptanceRatio: 0.65,
        minEdge: 0.03,
    },
    paramLabels: {
        lookback: "Lookback",
        minAcceptanceRatio: "Minimum Acceptance Ratio",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeTypicalPriceAcceptancePressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeTypicalPriceAcceptancePressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const upperAcceptance = buildRollingAverage(closeLocation.map((value) => value >= 0.75 ? 1 : 0), lookback);
        const lowerAcceptance = buildRollingAverage(closeLocation.map((value) => value <= 0.25 ? 1 : 0), lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [upperAcceptance, lowerAcceptance, pressure.longEdge, pressure.shortEdge], (i) => {
            const upperRatio = upperAcceptance[i];
            const lowerRatio = lowerAcceptance[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (upperRatio === null || lowerRatio === null || longEdge === null || shortEdge === null) return null;

            if (upperRatio >= p.minAcceptanceRatio && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Upper-quartile range acceptance with YES pressure edge");
            }
            if (lowerRatio >= p.minAcceptanceRatio && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Lower-quartile range acceptance with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minAcceptanceRatio", "minEdge"],
    },
};
