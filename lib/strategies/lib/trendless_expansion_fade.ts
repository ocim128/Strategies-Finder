import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildRangeSeries,
    extractBarMetricSeries,
} from "./price-action-frequency-core";
import { buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

const EFFICIENCY_WINDOW = 20;
const RANGE_PCT_WINDOW = 30;

function normalizeTrendlessExpansionFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        chopEfficiency: Math.max(0.05, Math.min(0.6, Number(params.chopEfficiency ?? 0.3))),
    };
}

export const trendless_expansion_fade: Strategy = {
    name: "Trendless Expansion Fade",
    description: "Fades high-range-percentile bars when efficiency is low, treating the expansion as chop climax rather than ignition.",
    defaultParams: {
        chopEfficiency: 0.3,
    },
    paramLabels: {
        chopEfficiency: "Chop Efficiency Ceiling",
    },
    normalizeParams: normalizeTrendlessExpansionFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeTrendlessExpansionFadeParams(params);
        const chopEfficiency = p.chopEfficiency as number;
        if (cleanData.length < RANGE_PCT_WINDOW + 1) return [];

        const efficiency = buildEfficiencyRatio(cleanData, EFFICIENCY_WINDOW);
        const ranges = buildRangeSeries(cleanData);
        const rangePct = buildPercentileRank(ranges, RANGE_PCT_WINDOW);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [efficiency, rangePct], (i) => {
            if (i < RANGE_PCT_WINDOW) return null;
            const er = efficiency[i];
            const rp = rangePct[i];
            if (er === null || rp === null) return null;

            if (er < chopEfficiency && rp > 0.8 && bodyDirection[i] < 0 && closeLocation[i] > 0.6) {
                return createBuySignal(cleanData, i, `Trendless expansion: efficiency ${er.toFixed(2)}, range percentile ${rp.toFixed(2)}, down bar closing high`);
            }
            if (er < chopEfficiency && rp > 0.8 && bodyDirection[i] > 0 && closeLocation[i] < 0.4) {
                return createSellSignal(cleanData, i, `Trendless expansion: efficiency ${er.toFixed(2)}, range percentile ${rp.toFixed(2)}, up bar closing low`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["chopEfficiency"],
    },
};
