import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
    getOpens,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const OPEN_LOC_Z_SCORE = 2.0;
const CLOSE_LOCATION_MID = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
    };
}

export const open_location_zscore_reversion: Strategy = {
    name: "Open Location Z-Score Reversion",
    description: "Fades extreme open locations within the prior bar's range when the close reverses across the current bar's midpoint, catching failed breakouts.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    finderFixedParams: ["lookback"],
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const opens = getOpens(cleanData);

        const openLoc: number[] = new Array(cleanData.length).fill(0.5);
        for (let i = 1; i < cleanData.length; i++) {
            const priorRange = highs[i - 1] - lows[i - 1];
            if (priorRange > 0) {
                openLoc[i] = (opens[i] - lows[i - 1]) / priorRange;
            }
        }
        const openLocZ = buildRollingZScore(openLoc, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [openLocZ], (i) => {
            const z = openLocZ[i];
            if (z === null) return null;

            if (z < -OPEN_LOC_Z_SCORE && closeLocation[i] > CLOSE_LOCATION_MID) {
                return createBuySignal(cleanData, i, `Open location z ${z.toFixed(2)} reversed upward`);
            }
            if (z > OPEN_LOC_Z_SCORE && closeLocation[i] < CLOSE_LOCATION_MID) {
                return createSellSignal(cleanData, i, `Open location z ${z.toFixed(2)} reversed downward`);
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
