import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";

const FLIP_WINDOW = 20;

function normalizeBodyFlipWhipsawFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        flipCountMin: Math.max(3, Math.min(18, Math.round(Number(params.flipCountMin ?? 10)))),
    };
}

export const body_flip_whipsaw_fade: Strategy = {
    name: "Body Flip Whipsaw Fade",
    description: "Fades placement extremes when body direction flips so often the market is clearly whipsawing.",
    defaultParams: {
        flipCountMin: 10,
    },
    paramLabels: {
        flipCountMin: "Min Direction Flips",
    },
    normalizeParams: normalizeBodyFlipWhipsawFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeBodyFlipWhipsawFadeParams(params);
        const flipCountMin = p.flipCountMin as number;
        if (cleanData.length < FLIP_WINDOW + 1) return [];

        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        // Carry the previous non-doji direction forward so dojis do not count as flips.
        const signSeries: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            signSeries[i] = bodyDirection[i] !== 0 ? bodyDirection[i] : (i > 0 ? signSeries[i - 1] : 0);
        }
        const flips = buildThresholdCrossingCount(signSeries, FLIP_WINDOW, 0);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [flips], (i) => {
            if (i < FLIP_WINDOW) return null;
            const flipCount = flips[i];
            if (flipCount === null) return null;

            if (flipCount >= flipCountMin && closeLocation[i] <= 0.3) {
                return createBuySignal(cleanData, i, `Whipsaw regime: ${flipCount} direction flips with lower placement ${closeLocation[i].toFixed(2)}`);
            }
            if (flipCount >= flipCountMin && closeLocation[i] >= 0.7) {
                return createSellSignal(cleanData, i, `Whipsaw regime: ${flipCount} direction flips with upper placement ${closeLocation[i].toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["flipCountMin"],
    },
};
