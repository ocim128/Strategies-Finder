import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingMinMax } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const BOUNDARY_PROXIMITY = 0.1;

function normalizeCloseLocationImbalancePressureGapReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        clvExtreme: normalizeNumberParam(params.clvExtreme, 0.75, 0.5, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const close_location_imbalance_pressure_gap_reversion: Strategy = {
    name: "Close Location Imbalance Reversion with Pressure Gap",
    description: "Trades close-location absorption at rolling typical-price boundaries only when Polymarket pressure edge confirms the reversion side.",
    defaultParams: {
        lookback: 20,
        clvExtreme: 0.75,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        clvExtreme: "Close Location Extreme",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeCloseLocationImbalancePressureGapReversionParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseLocationImbalancePressureGapReversionParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const closeLocationAverage = buildRollingAverage(buildCloseLocationSeries(cleanData), lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [boundary.min, boundary.max, closeLocationAverage, pressure.longEdge, pressure.shortEdge], (i) => {
            const low = boundary.min[i];
            const high = boundary.max[i];
            const clv = closeLocationAverage[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (low === null || high === null || clv === null || longEdge === null || shortEdge === null) return null;

            const width = high - low;
            if (width <= 0) return null;
            const nearLow = (typicals[i] - low) / width <= BOUNDARY_PROXIMITY;
            const nearHigh = (high - typicals[i]) / width <= BOUNDARY_PROXIMITY;

            if (nearLow && clv >= p.clvExtreme && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Close-location absorption near range low with YES pressure edge");
            }
            if (nearHigh && clv <= 1 - p.clvExtreme && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Close-location absorption near range high with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "clvExtreme", "minEdge"],
    },
};
