import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy } from "./price-action-statistics-core";
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const ENTROPY_BINS = 5;
const MAX_ENTROPY = Math.log2(ENTROPY_BINS);

function normalizeEntropyExpansionGammaConsensusParams(params: StrategyParams): StrategyParams {
    const lookback = normalizeIntegerParam(params.lookback, 25, 5);
    return {
        ...params,
        lookback,
        slowLookback: Math.max(lookback + 1, normalizeIntegerParam(params.slowLookback, 100, 6)),
        entropyThreshold: normalizeNumberParam(params.entropyThreshold, 0.4, 0, 1),
    };
}

export const entropy_expansion_gamma_consensus: Strategy = {
    name: "Entropy-Gated Volatility Breakout with Gamma Consensus",
    description: "Trades ordered fast/slow ATR expansions only when Polymarket Gamma consensus agrees with the breakout side.",
    defaultParams: {
        lookback: 25,
        slowLookback: 100,
        entropyThreshold: 0.4,
    },
    paramLabels: {
        lookback: "Fast ATR Lookback",
        slowLookback: "Slow ATR Lookback",
        entropyThreshold: "Maximum Normalized Entropy",
    },
    normalizeParams: normalizeEntropyExpansionGammaConsensusParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyExpansionGammaConsensusParams(params);
        if (cleanData.length < p.slowLookback + 1) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const fastAtr = calculateATR(highs, lows, closes, p.lookback);
        const slowAtr = calculateATR(highs, lows, closes, p.slowLookback);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const entropy = buildRollingEntropy(returns, p.lookback, ENTROPY_BINS);
        const average = buildRollingAverage(closes, p.lookback);
        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: p.lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [fastAtr, slowAtr, entropy, average], (i) => {
            const fast = fastAtr[i];
            const slow = slowAtr[i];
            const entropyValue = entropy[i];
            const avg = average[i];
            if (fast === null || slow === null || slow <= 0 || entropyValue === null || avg === null) return null;
            if (fast / slow < 1.5 || entropyValue / MAX_ENTROPY > p.entropyThreshold) return null;

            if (closes[i] > avg && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Low-entropy ATR expansion above average with Gamma consensus");
            }
            if (closes[i] < avg && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Low-entropy ATR expansion below average with Gamma consensus");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "slowLookback", "entropyThreshold"],
    },
};
