import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingSkewness } from "./price-action-statistics-core";

function normalizeSymmetricPlacementFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const symmetric_placement_fade: Strategy = {
    name: "Symmetric Placement Fade",
    description: "Fades placement edges when close-location skewness is near zero, marking a symmetric oscillating market.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeSymmetricPlacementFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSymmetricPlacementFadeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const skewness = buildRollingSkewness(closeLocation, lookback);

        return createSignalLoop(cleanData, [skewness], (i) => {
            if (i < lookback) return null;
            const skew = skewness[i];
            if (skew === null) return null;

            if (Math.abs(skew) <= 0.25 && closeLocation[i] <= 0.25) {
                return createBuySignal(cleanData, i, `Symmetric placement (skew ${skew.toFixed(2)}) with bottom close ${closeLocation[i].toFixed(2)}`);
            }
            if (Math.abs(skew) <= 0.25 && closeLocation[i] >= 0.75) {
                return createSellSignal(cleanData, i, `Symmetric placement (skew ${skew.toFixed(2)}) with top close ${closeLocation[i].toFixed(2)}`);
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
