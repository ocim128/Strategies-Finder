import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildThresholdCrossingCount } from "./price-action-statistics-core";

const WHIPSAW_CROSSINGS = 5;
const ACCEPTANCE_BAND = 0.3;
const EXTREME_LOCATION = 0.25;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const acceptance_whipsaw_chop_fade: Strategy = {
    name: "Acceptance Whipsaw Chop Fade",
    description: "Fades extreme close locations only when close-acceptance band crossings certify a whipsaw, chop regime.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Whipsaw Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const crossings = buildThresholdCrossingCount(acceptance, lookback, ACCEPTANCE_BAND);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [crossings, closeLocation], (i) => {
            const count = crossings[i];
            const loc = closeLocation[i];
            if (count === null || loc === null) return null;

            // Whipsaw regime: one-sided closes flip often, so extremes are noise.
            if (count >= WHIPSAW_CROSSINGS && loc <= EXTREME_LOCATION) {
                return createBuySignal(cleanData, i, `Whipsaw fade buy: ${count} acceptance crossings, extreme low close loc ${loc.toFixed(2)}`);
            }
            if (count >= WHIPSAW_CROSSINGS && loc >= 1 - EXTREME_LOCATION) {
                return createSellSignal(cleanData, i, `Whipsaw fade sell: ${count} acceptance crossings, extreme high close loc ${loc.toFixed(2)}`);
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
