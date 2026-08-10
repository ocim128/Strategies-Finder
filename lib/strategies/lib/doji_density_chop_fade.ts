import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries, buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";

const DOJI_BODY_PCT = 0.2;

function normalizeDojiDensityChopFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 40))),
    };
}

export const doji_density_chop_fade: Strategy = {
    name: "Doji Density Chop Fade",
    description: "Fades placement edges when most recent bars are dojis, marking an undecided oscillating regime.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeDojiDensityChopFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeDojiDensityChopFadeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const flags: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            flags[i] = bodyPct[i] < DOJI_BODY_PCT ? 1 : 0;
        }
        const dojiDensity = buildRollingAverage(flags, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [dojiDensity], (i) => {
            if (i < lookback) return null;
            const density = dojiDensity[i];
            if (density === null) return null;

            if (density > 0.5 && closeLocation[i] <= 0.25) {
                return createBuySignal(cleanData, i, `Doji-dense chop (density ${density.toFixed(2)}) with bottom close ${closeLocation[i].toFixed(2)}`);
            }
            if (density > 0.5 && closeLocation[i] >= 0.75) {
                return createSellSignal(cleanData, i, `Doji-dense chop (density ${density.toFixed(2)}) with top close ${closeLocation[i].toFixed(2)}`);
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
