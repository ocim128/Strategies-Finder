import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";

const ALTERNATION_LEVEL = -0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 20))),
    };
}

export const direction_alternation_fade: Strategy = {
    name: "Direction Alternation Fade",
    description: "Fades the completed bar's direction when serial bar-direction autocorrelation certifies an alternating regime.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Alternation Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const direction = extractBarMetricSeries(cleanData, "bodyDirection");
        const autocorr = buildRollingAutoCorrelation(direction, lookback, 1);

        return createSignalLoop(cleanData, [autocorr], (i) => {
            const ac = autocorr[i];
            if (ac === null) return null;

            // Strong negative autocorrelation of direction: after a down bar an
            // up bar follows, so fade the completed bar's own direction.
            if (ac < ALTERNATION_LEVEL && cleanData[i].close < cleanData[i].open) {
                return createBuySignal(cleanData, i, `Alternation fade buy: direction ac ${ac.toFixed(2)} after a down bar`);
            }
            if (ac < ALTERNATION_LEVEL && cleanData[i].close > cleanData[i].open) {
                return createSellSignal(cleanData, i, `Alternation fade sell: direction ac ${ac.toFixed(2)} after an up bar`);
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
