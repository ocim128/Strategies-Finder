import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const TYPICAL_ROC_COMPRESSION = 0.001;

function normalizeCloseLocationImbalancePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        minEdge: normalizeNumberParam(params.minEdge, 0.03, 0),
    };
}

export const close_location_imbalance_pressure_gap: Strategy = {
    name: "Close Location Imbalance with Pressure Gap",
    description: "Trades close-location absorption imbalances only when typical price is compressed and Polymarket pressure gap favors the reversal side.",
    defaultParams: {
        lookback: 20,
        minEdge: 0.03,
    },
    paramLabels: {
        lookback: "Lookback",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeCloseLocationImbalancePressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCloseLocationImbalancePressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const closeLocationAverage = buildRollingAverage(buildCloseLocationSeries(cleanData), lookback);
        const typicalRoc = buildRateOfChange(typicals, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [closeLocationAverage, typicalRoc, pressure.pressureGap], (i) => {
            const closeLocation = closeLocationAverage[i];
            const roc = typicalRoc[i];
            const pressureGap = pressure.pressureGap[i];
            if (closeLocation === null || roc === null || pressureGap === null) return null;
            if (Math.abs(roc) > TYPICAL_ROC_COMPRESSION) return null;

            if (closeLocation <= 0.25 && pressureGap >= p.minEdge) {
                return createBuySignal(cleanData, i, "Low close-location absorption with compressed typical price and YES pressure gap");
            }
            if (closeLocation >= 0.75 && pressureGap <= -p.minEdge) {
                return createSellSignal(cleanData, i, "High close-location absorption with compressed typical price and NO pressure gap");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEdge"],
    },
};
