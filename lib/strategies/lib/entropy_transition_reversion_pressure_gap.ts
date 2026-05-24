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
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const ENTROPY_BINS = 5;
const MAX_ENTROPY = Math.log2(ENTROPY_BINS);

function normalizeEntropyTransitionReversionPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        entropyMin: normalizeNumberParam(params.entropyMin, 0.5, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.03, 0),
    };
}

export const entropy_transition_reversion_pressure_gap: Strategy = {
    name: "Entropy Transition Reversion with Pressure Gap",
    description: "Fades rolling typical-price boundaries during high-entropy return regimes when Polymarket pressure edge supports reversion.",
    defaultParams: {
        lookback: 25,
        entropyMin: 0.5,
        minEdge: 0.03,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyMin: "Minimum Normalized Entropy",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeEntropyTransitionReversionPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyTransitionReversionPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const entropy = buildRollingEntropy(returns, lookback, ENTROPY_BINS);
        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [entropy, boundary.min, boundary.max, pressure.longEdge, pressure.shortEdge], (i) => {
            const entropyValue = entropy[i];
            const low = boundary.min[i];
            const high = boundary.max[i];
            const longEdge = pressure.longEdge[i];
            const shortEdge = pressure.shortEdge[i];
            if (entropyValue === null || low === null || high === null || longEdge === null || shortEdge === null) return null;
            if ((entropyValue / MAX_ENTROPY) < p.entropyMin) return null;

            if (typicals[i] <= low && longEdge >= p.minEdge) {
                return createBuySignal(cleanData, i, "High-entropy boundary low with YES pressure edge");
            }
            if (typicals[i] >= high && shortEdge >= p.minEdge) {
                return createSellSignal(cleanData, i, "High-entropy boundary high with NO pressure edge");
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
