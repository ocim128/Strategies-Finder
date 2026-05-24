import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRollingEntropy, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sNoAdverseActionableMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const ENTROPY_BINS = 5;
const MAX_ENTROPY = Math.log2(ENTROPY_BINS);

function normalizeEntropyVolumeGatedNoAdverseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 25, 5),
        entropyThreshold: normalizeNumberParam(params.entropyThreshold, 0.45, 0, 1),
    };
}

export const entropy_volume_gated_no_adverse: Strategy = {
    name: "Entropy Volume Gated with No Adverse Mask",
    description: "Trades low-entropy high-volume directional transitions only when the Polymarket side is actionable and non-adverse.",
    defaultParams: {
        lookback: 25,
        entropyThreshold: 0.45,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyThreshold: "Maximum Normalized Entropy",
    },
    normalizeParams: normalizeEntropyVolumeGatedNoAdverseParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyVolumeGatedNoAdverseParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const returns = closes.map((close, i) => i === 0 || closes[i - 1] <= 0 ? 0 : Math.log(close / closes[i - 1]));
        const entropy = buildRollingEntropy(returns, lookback, ENTROPY_BINS);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), lookback);
        const average = buildRollingAverage(closes, lookback);
        const mask = buildPolymarket1sNoAdverseActionableMask(cleanData, context, { volLookback: lookback });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [entropy, volumeZ, average], (i) => {
            const entropyValue = entropy[i];
            const volumeScore = volumeZ[i];
            const center = average[i];
            if (entropyValue === null || volumeScore === null || center === null) return null;
            if ((entropyValue / MAX_ENTROPY) > p.entropyThreshold || volumeScore <= 0) return null;

            if (closes[i] > center && mask.yesAllowed[i]) {
                return createBuySignal(cleanData, i, "Low entropy high-volume transition above average with no adverse YES mask");
            }
            if (closes[i] < center && mask.noAllowed[i]) {
                return createSellSignal(cleanData, i, "Low entropy high-volume transition below average with no adverse NO mask");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold"],
    },
};
