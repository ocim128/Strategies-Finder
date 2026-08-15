import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildCumulativeDecaySum } from "./price-action-statistics-core";

const ACCEPTANCE_THRESHOLD = 1.0;
const MIN_SERIES_LENGTH = 10;

function normalizeAcceptanceDecayMomentumContinuationParams(params: StrategyParams): StrategyParams {
    const decay = Number(params.decay ?? 0.95);
    return {
        ...params,
        decay: Math.max(0.01, Math.min(1, Number.isFinite(decay) ? decay : 0.95)),
    };
}

export const acceptance_decay_momentum_continuation: Strategy = {
    name: "Acceptance Decay Momentum Continuation",
    description: "Exponentially decays per-bar close acceptance; entries fire when the memory-weighted score crosses a fixed magnitude.",
    defaultParams: {
        decay: 0.95,
    },
    paramLabels: {
        decay: "Decay Factor",
    },
    normalizeParams: normalizeAcceptanceDecayMomentumContinuationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const decay = normalizeAcceptanceDecayMomentumContinuationParams(params).decay as number;
        if (cleanData.length < MIN_SERIES_LENGTH) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const decayed = buildCumulativeDecaySum(acceptance, decay);

        return createCurrentBarSignalLoop(cleanData, [], (i) => {
            if (decayed[i] >= ACCEPTANCE_THRESHOLD) {
                return createBuySignal(cleanData, i, `Acceptance decay buy: memory score ${decayed[i].toFixed(3)} at or above ${ACCEPTANCE_THRESHOLD}`);
            }
            if (decayed[i] <= -ACCEPTANCE_THRESHOLD) {
                return createSellSignal(cleanData, i, `Acceptance decay sell: memory score ${decayed[i].toFixed(3)} at or below ${-ACCEPTANCE_THRESHOLD}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["decay"],
    },
};
