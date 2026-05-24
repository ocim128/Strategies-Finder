import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const ENTROPY_BINS = 5;
const MAX_ENTROPY = Math.log2(ENTROPY_BINS);

function normalizeEntropySqueezeTransitionPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        entropyThreshold: normalizeNumberParam(params.entropyThreshold, 0.42, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.03, 0),
    };
}

export const entropy_squeeze_transition_pressure_gap: Strategy = {
    name: "Entropy Squeeze Transition with Pressure Gap",
    description: "Trades low-entropy volume breakouts only when Polymarket pressure edge supports the same side.",
    defaultParams: {
        lookback: 25,
        entropyThreshold: 0.42,
        minEdge: 0.03,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyThreshold: "Maximum Normalized Entropy",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeEntropySqueezeTransitionPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEntropySqueezeTransitionPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const entropy = buildRollingEntropy(returns, lookback, ENTROPY_BINS);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const typicalAverage = buildRollingAverage(getTypicalPrices(cleanData), lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [entropy, volumeZ, typicalAverage, pressure.longEdge, pressure.shortEdge], (i) => {
            const entropyValue = entropy[i];
            const previousEntropyValue = entropy[i - 1];
            const volumeScore = volumeZ[i];
            const average = typicalAverage[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (
                entropyValue === null
                || previousEntropyValue === null
                || volumeScore === null
                || average === null
                || longEdge === null
                || shortEdge === null
            ) return null;

            const normalizedEntropy = entropyValue / MAX_ENTROPY;
            const previousNormalizedEntropy = previousEntropyValue / MAX_ENTROPY;
            if (previousNormalizedEntropy <= 0.6 || normalizedEntropy > p.entropyThreshold || volumeScore <= 1.5) return null;

            if (closes[i] > average && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "Entropy squeeze breakout above average with YES pressure edge");
            }
            if (closes[i] < average && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "Entropy squeeze breakdown below average with NO pressure edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold", "minEdge"],
    },
};
