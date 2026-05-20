import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy, buildRollingStdDev } from "./price-action-statistics-core";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";
import {
    buildLogReturnSeries,
    buildTrailingWindowSpan,
} from "./polymarket-1s-strategy-utils";

function normalizeVolatilityRegimeEntropyReactionLagParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        entropyThreshold: normalizeNumberParam(params.entropyThreshold, 1.15, 0),
        volMultiplier: normalizeNumberParam(params.volMultiplier, 2.2, 0.1),
    };
}

export const volatility_regime_entropy_reaction_lag: Strategy = {
    name: "Volatility Regime Entropy Reaction Lag",
    description: "Trades ordered Binance momentum bursts only when Polymarket reaction lag leaves the same-side contract underadjusted.",
    defaultParams: {
        lookback: 25,
        entropyThreshold: 1.15,
        volMultiplier: 2.2,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyThreshold: "Entropy Threshold",
        volMultiplier: "Volatility Multiplier",
    },
    normalizeParams: normalizeVolatilityRegimeEntropyReactionLagParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityRegimeEntropyReactionLagParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildLogReturnSeries(cleanData);
        const entropy = buildRollingEntropy(returns, lookback);
        const stdDev = buildRollingStdDev(closes, lookback);
        const span = buildTrailingWindowSpan(closes, lookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [entropy, stdDev, span, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < lookback) return null;
            const entropyValue = entropy[i];
            const deviation = stdDev[i];
            const rangeSpan = span[i];
            if (entropyValue === null || deviation === null || rangeSpan === null || deviation <= 0) return null;
            if (entropyValue >= p.entropyThreshold || rangeSpan / deviation <= p.volMultiplier) return null;

            if (cleanData[i].close > cleanData[i].open && (reaction.longLagEdge[i] ?? -Infinity) >= 0.01) {
                return createBuySignal(cleanData, i, "Ordered volatility regime with long reaction lag");
            }
            if (cleanData[i].close < cleanData[i].open && (reaction.shortLagEdge[i] ?? -Infinity) >= 0.01) {
                return createSellSignal(cleanData, i, "Ordered volatility regime with short reaction lag");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold", "volMultiplier"],
    },
};
