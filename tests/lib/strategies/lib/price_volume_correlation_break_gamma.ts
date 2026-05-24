import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingMinMax, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizePriceVolumeCorrelationBreakGammaParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        volZThreshold: normalizeNumberParam(params.volZThreshold, 1.8, 0),
    };
}

export const price_volume_correlation_break_gamma: Strategy = {
    name: "Price-Volume Correlation Break with Gamma Consensus",
    description: "Fades high-volume flat-price absorption near trailing boundaries when Polymarket Gamma consensus agrees.",
    defaultParams: {
        lookback: 25,
        volZThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback",
        volZThreshold: "Volume Z-Score Threshold",
    },
    normalizeParams: normalizePriceVolumeCorrelationBreakGammaParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizePriceVolumeCorrelationBreakGammaParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const typicals = getTypicalPrices(cleanData);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const clvAverage = buildRollingAverage(buildCloseLocationSeries(cleanData), lookback);
        const closeRoc = buildRateOfChange(closes, lookback);
        const boundary = buildRollingMinMax(typicals, lookback);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [volumeZ, clvAverage, closeRoc, boundary.min, boundary.max], (i) => {
            const volScore = volumeZ[i];
            const clv = clvAverage[i];
            const roc = closeRoc[i];
            const low = boundary.min[i];
            const high = boundary.max[i];
            if (volScore === null || clv === null || roc === null || low === null || high === null) return null;
            if (volScore < p.volZThreshold || Math.abs(roc) > 0.001) return null;

            const width = Math.max(1e-12, high - low);
            if (typicals[i] <= low + width * 0.1 && clv >= 0.7 && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "High-volume flat-price absorption near low with Gamma consensus");
            }
            if (typicals[i] >= high - width * 0.1 && clv <= 0.3 && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "High-volume flat-price absorption near high with Gamma consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volZThreshold"],
    },
};
