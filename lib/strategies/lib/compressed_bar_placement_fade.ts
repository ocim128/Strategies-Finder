import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const RANGE_PCT_WINDOW = 30;

function normalizeCompressedBarPlacementFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        chopRangePercentile: Math.max(0.1, Math.min(0.9, Number(params.chopRangePercentile ?? 0.5))),
    };
}

export const compressed_bar_placement_fade: Strategy = {
    name: "Compressed Bar Placement Fade",
    description: "Fades edge placement on compressed-range bars as moves made without room to continue.",
    defaultParams: {
        chopRangePercentile: 0.5,
    },
    paramLabels: {
        chopRangePercentile: "Compressed Range Percentile",
    },
    normalizeParams: normalizeCompressedBarPlacementFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeCompressedBarPlacementFadeParams(params);
        const chopRangePercentile = p.chopRangePercentile as number;
        if (cleanData.length < RANGE_PCT_WINDOW + 1) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePct = buildPercentileRank(ranges, RANGE_PCT_WINDOW);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangePct], (i) => {
            if (i < RANGE_PCT_WINDOW) return null;
            const rp = rangePct[i];
            if (rp === null) return null;

            if (rp <= chopRangePercentile && closeLocation[i] <= 0.2) {
                return createBuySignal(cleanData, i, `Compressed bar (range percentile ${rp.toFixed(2)}) with bottom placement ${closeLocation[i].toFixed(2)}`);
            }
            if (rp <= chopRangePercentile && closeLocation[i] >= 0.8) {
                return createSellSignal(cleanData, i, `Compressed bar (range percentile ${rp.toFixed(2)}) with top placement ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["chopRangePercentile"],
    },
};
