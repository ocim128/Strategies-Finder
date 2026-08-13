import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

const CASCADE_STREAK_FLOOR = 4;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(1, Math.round(Number(params.lookback ?? 30))),
    };
}

export const volatility_cascade_streak: Strategy = {
    name: "Volatility Cascade Streak",
    description: "Follows the net direction when consecutive expanding-range bars form a volatility cascade.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Net-Change Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const ranges = buildRangeSeries(cleanData);

        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            flags[i] = ranges[i] > ranges[i - 1] ? 1 : 0;
        }
        const streak = buildStreakCount(flags);

        return createSignalLoop(cleanData, [], (i) => {
            if (i < lookback) return null;

            const cascade = streak[i];
            if (cascade < CASCADE_STREAK_FLOOR) return null;

            if (closes[i] > closes[i - lookback] && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Volatility cascade up: streak ${cascade}`);
            }
            if (closes[i] < closes[i - lookback] && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Volatility cascade down: streak ${cascade}`);
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
