import type {
    Strategy,
    OHLCVData,
    StrategyParams,
    StrategyExecutionContext,
} from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingCorrelation, buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildRangeSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingPairCorrelation } from "./cross-symbol-helpers";

function normalizeCorrelationRangeFragmentationParams(params: StrategyParams): StrategyParams {
    const lookback = Math.max(5, Math.round(params.lookback ?? 25));
    const corrGapThreshold = Math.max(0, Number(params.corrGapThreshold ?? 0.35));
    return {
        ...params,
        lookback,
        corrGapThreshold,
    };
}

export const correlation_range_fragmentation: Strategy = {
    name: "Correlation Range Fragmentation",
    description: "Signals when price correlation remains high but range correlation has dropped â€” volatility structure fragmenting beneath stable directional surface, likely to resolve with range catching up.",
    defaultParams: {
        lookback: 25,
        corrGapThreshold: 0.35,
    },
    paramLabels: {
        lookback: "Lookback",
        corrGapThreshold: "Correlation Gap Threshold",
    },
    normalizeParams: normalizeCorrelationRangeFragmentationParams,
    crossSymbolConfig: {
        defaultSymbol: "SOLUSDT",
        userSelectable: true,
        minBars: 50,
    },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.crossSymbol) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeCorrelationRangeFragmentationParams(params);
        if (cleanData.length < p.lookback * 2) return [];

        const secondaryData = context.crossSymbol.secondaryData;
        const primaryCloses = getCloses(cleanData);
        const secondaryCloses = getCloses(secondaryData);

        const priceCorr = buildRollingPairCorrelation(primaryCloses, secondaryCloses, p.lookback as number);

        const primaryRange = buildRangeSeries(cleanData);
        const secondaryRange = buildRangeSeries(secondaryData);
        const rangeCorr = buildRollingCorrelation(primaryRange, secondaryRange, p.lookback as number);

        const efficiency = buildEfficiencyRatio(cleanData, p.lookback as number);
        const avgRange = buildRollingAverage(primaryRange, p.lookback as number);
        const avgClose = buildRollingAverage(primaryCloses, p.lookback as number);

        return createSignalLoop(cleanData, [priceCorr, rangeCorr], (i) => {
            if (i < p.lookback * 2) return null;
            const pc = priceCorr[i];
            const rc = rangeCorr[i];
            const eff = efficiency[i];
            const aRange = avgRange[i];
            const aClose = avgClose[i];
            if (pc === null || rc === null || eff === null || aRange === null || aClose === null) return null;

            const gap = pc - rc;
            if (gap > p.corrGapThreshold && eff < 0.3 && primaryRange[i] > aRange) {
                if (primaryCloses[i] > aClose) {
                    return createBuySignal(cleanData, i, `Range fragmentation with upside resolution (gap=${gap.toFixed(2)})`);
                }
                if (primaryCloses[i] < aClose) {
                    return createSellSignal(cleanData, i, `Range fragmentation with downside resolution (gap=${gap.toFixed(2)})`);
                }
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "corrGapThreshold"],
    },
};





