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
    buildRollingRobustZScore,
} from "./price-action-statistics-core";

function normalizeRobustReturnDislocationParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const robust_return_dislocation_reversion: Strategy = {
    name: "Robust Return Dislocation Reversion",
    description: "Fades MAD-robust return dislocations that close back inside their own bar against the extreme move.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRobustReturnDislocationParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRobustReturnDislocationParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closeReturn = extractBarMetricSeries(cleanData, "closeReturn");
        const robustZ = buildRollingRobustZScore(closeReturn, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [robustZ], (i) => {
            if (i < lookback) return null;
            const z = robustZ[i];
            if (z === null) return null;

            if (z < -3.0 && closeLocation[i] > 0.65) {
                return createBuySignal(cleanData, i, `Robust return dislocation ${z.toFixed(2)} with upper-bar close location ${closeLocation[i].toFixed(2)}`);
            }
            if (z > 3.0 && closeLocation[i] < 0.35) {
                return createSellSignal(cleanData, i, `Robust return dislocation ${z.toFixed(2)} with lower-bar close location ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
