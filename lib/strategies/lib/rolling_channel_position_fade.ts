import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingMinMax } from "./price-action-statistics-core";

const EDGE_POSITION = 0.05;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 50))),
    };
}

export const rolling_channel_position_fade: Strategy = {
    name: "Rolling Channel Position Fade",
    description: "Fades closes in the bottom or top 5% of the ratio's own rolling min/max channel.",
    defaultParams: {
        lookback: 50,
    },
    paramLabels: {
        lookback: "Channel Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const { min, max } = buildRollingMinMax(closes, lookback);

        return createSignalLoop(cleanData, [min, max], (i) => {
            const lo = min[i];
            const hi = max[i];
            if (lo === null || hi === null) return null;

            const width = hi - lo;
            if (width <= 0) return null;

            const position = (closes[i] - lo) / width;
            if (position <= EDGE_POSITION) {
                return createBuySignal(cleanData, i, `Channel fade buy: position ${position.toFixed(3)} in bottom ${EDGE_POSITION * 100}% of channel`);
            }
            if (position >= 1 - EDGE_POSITION) {
                return createSellSignal(cleanData, i, `Channel fade sell: position ${position.toFixed(3)} in top ${EDGE_POSITION * 100}% of channel`);
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
