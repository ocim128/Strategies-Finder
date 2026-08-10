import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingCorrelation } from "./price-action-statistics-core";

const COHERENCE_LOOKBACK = 30;

function normalizeBodyDirectionPlacementCoherenceParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        coherenceThreshold: Math.max(0.3, Math.min(0.95, Number(params.coherenceThreshold ?? 0.7))),
    };
}

export const body_direction_placement_coherence: Strategy = {
    name: "Body Direction Placement Coherence",
    description: "Follows the current bar's direction when the rolling correlation between body direction and close placement exceeds a magic threshold.",
    defaultParams: {
        coherenceThreshold: 0.7,
    },
    paramLabels: {
        coherenceThreshold: "Coherence Threshold",
    },
    normalizeParams: normalizeBodyDirectionPlacementCoherenceParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodyDirectionPlacementCoherenceParams(params);
        const coherenceThreshold = p.coherenceThreshold as number;
        if (cleanData.length < COHERENCE_LOOKBACK) return [];

        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const closeLocation = buildCloseLocationSeries(cleanData);
        const correlation = buildRollingCorrelation(bodyDirection, closeLocation, COHERENCE_LOOKBACK);

        return createSignalLoop(cleanData, [correlation], (i) => {
            if (i < COHERENCE_LOOKBACK) return null;
            const corr = correlation[i];
            if (corr === null) return null;

            if (corr > coherenceThreshold && bodyDirection[i] > 0) {
                return createBuySignal(cleanData, i, `Coherent up bar: direction-placement correlation ${corr.toFixed(2)}`);
            }
            if (corr < -coherenceThreshold && bodyDirection[i] < 0) {
                return createSellSignal(cleanData, i, `Coherent down bar: direction-placement correlation ${corr.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["coherenceThreshold"],
    },
};
