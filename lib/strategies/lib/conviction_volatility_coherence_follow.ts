import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation } from "./price-action-statistics-core";

const COHERENCE_LEVEL = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(8, Math.round(Number(params.lookback ?? 24))),
    };
}

export const conviction_volatility_coherence_follow: Strategy = {
    name: "Conviction Volatility Coherence Follow",
    description: "Follows the first clean-conviction bar after range and body-proportion coherence crosses the conviction level.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Coherence Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const coherence = buildRollingCorrelation(buildRangeSeries(cleanData), buildBodyPctSeries(cleanData), lookback);

        return createSignalLoop(cleanData, [coherence], (i) => {
            const prev = coherence[i - 1];
            const curr = coherence[i];
            if (curr === null) return null;

            // Fresh cross into the coherence regime; direction read from the bar.
            const crossed = (prev === null || prev <= COHERENCE_LEVEL) && curr > COHERENCE_LEVEL;
            if (!crossed) return null;

            if (cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Conviction coherence buy: corr ${curr.toFixed(2)} crossed above ${COHERENCE_LEVEL}, up bar`);
            }
            if (cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Conviction coherence sell: corr ${curr.toFixed(2)} crossed above ${COHERENCE_LEVEL}, down bar`);
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
