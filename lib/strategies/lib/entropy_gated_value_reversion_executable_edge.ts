import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingEntropy, buildRollingMinMax } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const ENTROPY_BINS = 5;
const MAX_ENTROPY = Math.log2(ENTROPY_BINS);

function normalizeEntropyGatedValueReversionExecutableEdgeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 5),
        entropyMin: normalizeNumberParam(params.entropyMin, 0.55, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.02, 0),
    };
}

export const entropy_gated_value_reversion_executable_edge: Strategy = {
    name: "Entropy-Gated Value Reversion with Executable Edge",
    description: "Fades rolling typical-price boundaries in noisy high-entropy regimes only when the matching Polymarket ask is actionable and underpriced.",
    defaultParams: {
        lookback: 35,
        entropyMin: 0.55,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyMin: "Minimum Normalized Entropy",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams: normalizeEntropyGatedValueReversionExecutableEdgeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyGatedValueReversionExecutableEdgeParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const entropy = buildRollingEntropy(returns, lookback, ENTROPY_BINS);
        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });
        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [entropy, boundary.min, boundary.max], (i) => {
            const entropyValue = entropy[i];
            const low = boundary.min[i];
            const high = boundary.max[i];
            if (entropyValue === null || low === null || high === null) return null;

            const normalizedEntropy = entropyValue / MAX_ENTROPY;
            if (normalizedEntropy < p.entropyMin) return null;

            if (typicals[i] <= low && actionability.yesActionable[i] && (edge.buyYesEdge[i] ?? -Infinity) >= p.minEdge) {
                return createBuySignal(cleanData, i, "High-entropy value low reversion with executable YES edge");
            }
            if (typicals[i] >= high && actionability.noActionable[i] && (edge.buyNoEdge[i] ?? -Infinity) >= p.minEdge) {
                return createSellSignal(cleanData, i, "High-entropy value high reversion with executable NO edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyMin", "minEdge"],
    },
};
