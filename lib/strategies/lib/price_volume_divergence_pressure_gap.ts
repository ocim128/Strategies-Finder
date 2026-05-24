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

const PRICE_ROC_FLAT_THRESHOLD = 0.001;

function normalizePriceVolumeDivergencePressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 5),
        clvThreshold: normalizeNumberParam(params.clvThreshold, 0.65, 0.5, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const price_volume_divergence_pressure_gap: Strategy = {
    name: "Price-Volume Divergence with Pressure Gap",
    description: "Trades flat-price close-location accumulation or distribution only when Polymarket pressure edge supports the latent move.",
    defaultParams: {
        lookback: 35,
        clvThreshold: 0.65,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        clvThreshold: "Close Location Threshold",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizePriceVolumeDivergencePressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizePriceVolumeDivergencePressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const typicals = getTypicalPrices(cleanData);
        const typicalRoc = buildRateOfChange(typicals, lookback);
        const closeLocationAverage = buildRollingAverage(buildCloseLocationSeries(cleanData), lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [typicalRoc, closeLocationAverage, pressure.longEdge, pressure.shortEdge], (i) => {
            const roc = typicalRoc[i];
            const clv = closeLocationAverage[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (roc === null || clv === null || longEdge === null || shortEdge === null) return null;
            if (Math.abs(roc) > PRICE_ROC_FLAT_THRESHOLD) return null;

            if (clv >= p.clvThreshold && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Flat typical price with high close-location accumulation and YES pressure edge");
            }
            if (clv <= 1 - p.clvThreshold && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Flat typical price with low close-location distribution and NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "clvThreshold", "minEdge"],
    },
};
