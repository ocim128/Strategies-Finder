import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

const RANGE_PCT_WINDOW = 30;

function normalizeNestedBarOscillationFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        rangePctThreshold: Math.max(0.1, Math.min(0.9, Number(params.rangePctThreshold ?? 0.5))),
    };
}

export const nested_bar_oscillation_fade: Strategy = {
    name: "Nested Bar Oscillation Fade",
    description: "Fades the edge of a bar fully nested inside the previous bar while the market coils at a low range percentile.",
    defaultParams: {
        rangePctThreshold: 0.5,
    },
    paramLabels: {
        rangePctThreshold: "Coil Range Percentile",
    },
    normalizeParams: normalizeNestedBarOscillationFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeNestedBarOscillationFadeParams(params);
        const rangePctThreshold = p.rangePctThreshold as number;
        if (cleanData.length < RANGE_PCT_WINDOW + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const ranges = buildRangeSeries(cleanData);
        const rangePct = buildPercentileRank(ranges, RANGE_PCT_WINDOW);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [rangePct], (i) => {
            if (i < RANGE_PCT_WINDOW || i < 1) return null;
            const rp = rangePct[i];
            if (rp === null) return null;

            const nested = highs[i] <= highs[i - 1] && lows[i] >= lows[i - 1];
            if (nested && rp <= rangePctThreshold && closeLocation[i] <= 0.25) {
                return createBuySignal(cleanData, i, `Nested coil bar (range percentile ${rp.toFixed(2)}) with bottom close ${closeLocation[i].toFixed(2)}`);
            }
            if (nested && rp <= rangePctThreshold && closeLocation[i] >= 0.75) {
                return createSellSignal(cleanData, i, `Nested coil bar (range percentile ${rp.toFixed(2)}) with top close ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["rangePctThreshold"],
    },
};
