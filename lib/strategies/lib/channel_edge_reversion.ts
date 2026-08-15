import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";

const EDGE_LOW_BAND = 0.08;
const EDGE_HIGH_BAND = 0.92;

function normalizeChannelEdgeReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const channel_edge_reversion: Strategy = {
    name: "Channel Edge Reversion",
    description: "Fades closes pinned near their own trailing close min/max channel edges, reverting toward the channel middle.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeChannelEdgeReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeChannelEdgeReversionParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const { min, max } = buildRollingMinMax(closes, lookback, true);

        return createSignalLoop(cleanData, [min, max], (i) => {
            if (i < lookback) return null;
            const lo = min[i];
            const hi = max[i];
            if (lo === null || hi === null || hi <= lo) return null;
            const position = (closes[i] - lo) / (hi - lo);

            if (position < EDGE_LOW_BAND) {
                return createBuySignal(cleanData, i, `Channel edge buy: close position ${position.toFixed(3)} at the channel low`);
            }
            if (position > EDGE_HIGH_BAND) {
                return createSellSignal(cleanData, i, `Channel edge sell: close position ${position.toFixed(3)} at the channel high`);
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
