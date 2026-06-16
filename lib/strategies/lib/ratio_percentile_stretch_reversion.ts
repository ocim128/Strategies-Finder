import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
        stretchPctl: Math.max(0.5, Math.min(1.0, Number(params.stretchPctl ?? 0.90))),
    };
}

export const ratio_percentile_stretch_reversion: Strategy = {
    name: "Ratio Percentile Stretch Reversion",
    description: "Fades extreme close percentile ranks of the ratio.",
    defaultParams: {
        lookback: 40,
        stretchPctl: 0.9,
    },
    paramLabels: {
        lookback: "Lookback Window",
        stretchPctl: "Stretch Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const percentile = buildPercentileRank(closes, lookback);

        return createSignalLoop(cleanData, [percentile], (i) => {
            const pRank = percentile[i];
            if (pRank === null) return null;

            if (pRank < (1 - p.stretchPctl)) {
                return createBuySignal(cleanData, i, `Ratio percentile stretch buy: rank ${pRank.toFixed(2)}`);
            }
            if (pRank > p.stretchPctl) {
                return createSellSignal(cleanData, i, `Ratio percentile stretch sell: rank ${pRank.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "stretchPctl"],
    },
};
