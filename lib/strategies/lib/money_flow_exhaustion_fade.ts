import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildCloseLocationSeries } from "./price-action-frequency-core";

const FLOW_EXTREME = 0.3;
const CONFIRMING_LOCATION = 0.6;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
    };
}

export const money_flow_exhaustion_fade: Strategy = {
    name: "Money Flow Exhaustion Fade",
    description: "Fades the divergence between extreme multi-bar money flow and the current bar's close: persistent flow the close refuses to confirm.",
    defaultParams: {
        lookback: 20,
    },
    paramLabels: {
        lookback: "Money Flow Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const cmf = calculateCMF(highs, lows, closes, getVolumes(cleanData), lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [cmf, closeLocation], (i) => {
            const flow = cmf[i];
            const loc = closeLocation[i];
            if (flow === null || loc === null) return null;

            // Persistent flow into down closes, but the current bar closes high:
            // the auction refuses to confirm the flow.
            if (flow < -FLOW_EXTREME && loc > CONFIRMING_LOCATION) {
                return createBuySignal(cleanData, i, `Flow exhaustion buy: cmf ${flow.toFixed(2)} but close loc ${loc.toFixed(2)}`);
            }
            if (flow > FLOW_EXTREME && loc < 1 - CONFIRMING_LOCATION) {
                return createSellSignal(cleanData, i, `Flow exhaustion sell: cmf ${flow.toFixed(2)} but close loc ${loc.toFixed(2)}`);
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
