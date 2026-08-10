import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildRollingMedian, buildRollingStdDev } from "./price-action-statistics-core";

function normalizePlacementOrderlinessFollowParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const placement_orderliness_follow: Strategy = {
    name: "Placement Orderliness Follow",
    description: "Follows the dominant placement side when close-location volatility sits at a low percentile.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizePlacementOrderlinessFollowParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizePlacementOrderlinessFollowParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const placementVol = buildRollingStdDev(closeLocation, lookback);
        const placementVolClean = placementVol.map((v) => v ?? 0);
        const placementVolPct = buildPercentileRank(placementVolClean, lookback);
        const medianPlacement = buildRollingMedian(closeLocation, lookback);

        return createSignalLoop(cleanData, [placementVolPct, medianPlacement], (i) => {
            if (i < lookback) return null;
            const volPct = placementVolPct[i];
            const median = medianPlacement[i];
            if (volPct === null || median === null) return null;

            if (volPct < 0.2 && median > 0.55 && closeLocation[i] > 0.5) {
                return createBuySignal(cleanData, i, `Orderly placement: vol percentile ${volPct.toFixed(2)}, median ${median.toFixed(2)}, upper close`);
            }
            if (volPct < 0.2 && median < 0.45 && closeLocation[i] < 0.5) {
                return createSellSignal(cleanData, i, `Orderly placement: vol percentile ${volPct.toFixed(2)}, median ${median.toFixed(2)}, lower close`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
