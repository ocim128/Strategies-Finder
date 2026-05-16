import { Strategy, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMedian } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        erLookback: Math.max(2, Math.round(Math.abs(params.erLookback ?? 60))),
        minER: Math.max(0, Math.abs(params.minER ?? 0.35)),
        maxAdverse: Math.max(0, Math.abs(params.maxAdverse ?? 0.05)),
    };
}

export const efficiency_median_adverse_veto: Strategy = {
    name: "Efficiency Median Adverse Veto",
    description: "A highly efficient Binance price trend dictates direction, permitted only when Polymarket isn't aggressively fighting the spot implied state.",
    defaultParams: {
        erLookback: 60,
        minER: 0.35,
        maxAdverse: 0.05,
    },
    paramLabels: {
        erLookback: "ER / Median Lookback",
        minER: "Min Efficiency Ratio",
        maxAdverse: "Max PM Adverse Gap",
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["erLookback", "minER", "maxAdverse"]
    },
    polymarket1sConfig: { required: true },
    normalizeParams,
    execute: (rawData, params, context) => {
        const cleanData = ensureCleanData(rawData);
        const closes = getCloses(cleanData);
        const { erLookback, minER, maxAdverse } = normalizeParams(params);

        const erSeries = buildEfficiencyRatio(cleanData, erLookback as number);
        const medianSeries = buildRollingMedian(closes, erLookback as number);
        
        // #COMPLETION_DRIVE: Using hardcoded volLookback of 60 as per implementation notes
        // #SUGGEST_VERIFY: Check if volLookback should be parameterized
        const pressureGap = buildPolymarket1sPressureGap(cleanData, context, {
            volLookback: 60
        });

        return createSignalLoop(
            cleanData,
            [erSeries, medianSeries],
            (i: number) => {
                const er = erSeries[i];
                const median = medianSeries[i];
                
                if (er === null || median === null) return null;

                const close = closes[i];
                
                const longAdverse = pressureGap.longAdverse[i] ?? 0;
                if (er >= (minER as number) && close > median && longAdverse <= (maxAdverse as number)) {
                    return createBuySignal(cleanData, i, "Efficiency Buy");
                }

                const shortAdverse = pressureGap.shortAdverse[i] ?? 0;
                if (er >= (minER as number) && close < median && shortAdverse <= (maxAdverse as number)) {
                    return createSellSignal(cleanData, i, "Efficiency Sell");
                }
                return null;
            }
        );
    },
};





