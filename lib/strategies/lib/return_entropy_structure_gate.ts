import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import {
    extractBarMetricSeries,
    buildRollingEntropy,
} from "./price-action-statistics-core";

const ENTROPY_LOOKBACK = 20;
const ENTROPY_BINS = 5;

function normalizeReturnEntropyStructureGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        entropyThreshold: Math.max(0.5, Math.min(2.0, Number(params.entropyThreshold ?? 1.3))),
    };
}

export const return_entropy_structure_gate: Strategy = {
    name: "Return Entropy Structure Gate",
    description: "Follows close placement direction when rolling return entropy is below a magic threshold marking a structured regime.",
    defaultParams: {
        entropyThreshold: 1.3,
    },
    paramLabels: {
        entropyThreshold: "Entropy Threshold",
    },
    normalizeParams: normalizeReturnEntropyStructureGateParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeReturnEntropyStructureGateParams(params);
        const entropyThreshold = p.entropyThreshold as number;
        if (cleanData.length < ENTROPY_LOOKBACK) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const entropy = buildRollingEntropy(closeReturn, ENTROPY_LOOKBACK, ENTROPY_BINS);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [entropy], (i) => {
            if (i < ENTROPY_LOOKBACK) return null;
            const e = entropy[i];
            if (e === null) return null;

            if (e < entropyThreshold && closeLocation[i] > 0.6) {
                return createBuySignal(cleanData, i, `Structured return regime: entropy ${e.toFixed(2)} with upper close ${closeLocation[i].toFixed(2)}`);
            }
            if (e < entropyThreshold && closeLocation[i] < 0.4) {
                return createSellSignal(cleanData, i, `Structured return regime: entropy ${e.toFixed(2)} with lower close ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["entropyThreshold"],
    },
};
