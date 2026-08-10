import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRangeSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeBarConversionEfficiencyGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        conversionThreshold: Math.max(0.1, Math.min(0.95, Number(params.conversionThreshold ?? 0.6))),
    };
}

export const bar_conversion_efficiency_gate: Strategy = {
    name: "Bar Conversion Efficiency Gate",
    description: "Follows bars whose net close-to-close move consumes a magic share of their own range as real work.",
    defaultParams: {
        conversionThreshold: 0.6,
    },
    paramLabels: {
        conversionThreshold: "Conversion Threshold",
    },
    normalizeParams: normalizeBarConversionEfficiencyGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBarConversionEfficiencyGateParams(params);
        const conversionThreshold = p.conversionThreshold as number;
        if (cleanData.length < 2) return [];

        const closes = getCloses(cleanData);
        const ranges = buildRangeSeries(cleanData);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");

        return createSignalLoop(cleanData, [], (i) => {
            if (i < 1) return null;
            const range = ranges[i];
            if (range <= 0) return null;

            const conversion = Math.abs(closes[i] - closes[i - 1]) / range;
            if (conversion > conversionThreshold && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Conversion bar: ${(conversion * 100).toFixed(0)}% of range converted`);
            }
            if (conversion > conversionThreshold && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Conversion bar: ${(conversion * 100).toFixed(0)}% of range converted`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["conversionThreshold"],
    },
};
