import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy } from "./price-action-statistics-core";
import { buildPolymarket1sPressureGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const ENTROPY_BINS = 5;
const MAX_ENTROPY = Math.log2(ENTROPY_BINS);

function normalizeEntropyShockInversionPressureGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        entropyThreshold: normalizeNumberParam(params.entropyThreshold, 0.4, 0, 1),
        minEdge: normalizeNumberParam(params.minEdge, 0.03, 0),
    };
}

export const entropy_shock_inversion_pressure_gap: Strategy = {
    name: "Entropy Shock Inversion with Pressure Gap",
    description: "Trades high-to-low entropy trend transitions only when Polymarket pressure gap underprices the side.",
    defaultParams: {
        lookback: 25,
        entropyThreshold: 0.4,
        minEdge: 0.03,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyThreshold: "Maximum Normalized Entropy",
        minEdge: "Minimum Pressure Edge",
    },
    normalizeParams: normalizeEntropyShockInversionPressureGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyShockInversionPressureGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const entropy = buildRollingEntropy(returns, lookback, ENTROPY_BINS);
        const average = buildRollingAverage(closes, lookback);
        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: lookback });
        if (!pressure.available) return [];

        return createSignalLoop(cleanData, [entropy, average, pressure.pressureGap], (i) => {
            const entropyValue = entropy[i];
            const previousEntropyValue = entropy[i - 1];
            const center = average[i];
            const gap = pressure.pressureGap[i];
            if (entropyValue === null || previousEntropyValue === null || center === null || gap === null) return null;

            const normalizedEntropy = entropyValue / MAX_ENTROPY;
            const previousNormalizedEntropy = previousEntropyValue / MAX_ENTROPY;
            if (previousNormalizedEntropy <= 0.6 || normalizedEntropy > p.entropyThreshold) return null;

            if (closes[i] > center && closes[i] > closes[i - 1] && gap >= p.minEdge) {
                return createBuySignal(cleanData, i, "Entropy shock inverted upward with YES pressure gap");
            }
            if (closes[i] < center && closes[i] < closes[i - 1] && gap <= -p.minEdge) {
                return createSellSignal(cleanData, i, "Entropy shock inverted downward with NO pressure gap");
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
