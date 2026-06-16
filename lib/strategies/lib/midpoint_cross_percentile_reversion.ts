import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import {
    buildRollingZScore,
    buildThresholdCrossingCount,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 35))),
        minCrosses: Math.max(1, Math.round(Number(params.minCrosses ?? 6))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 1.8)),
    };
}

export const midpoint_cross_percentile_reversion: Strategy = {
    name: "Midpoint Cross Percentile Reversion",
    description: "Fades typical price z-score deviations in high-whipsaw regimes confirmed by frequent midpoint crossings.",
    defaultParams: {
        lookback: 35,
        minCrosses: 6,
        zThreshold: 1.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        minCrosses: "Min Crossings",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const avg = buildRollingAverage(closes, lookback);

        const diffs = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const a = avg[i];
            diffs[i] = a !== null ? closes[i] - a : 0;
        }

        const crossCount = buildThresholdCrossingCount(diffs, lookback, 0);

        const typical = getTypicalPrices(cleanData);
        const typicalZ = buildRollingZScore(typical, lookback);

        return createSignalLoop(cleanData, [crossCount, typicalZ], (i) => {
            const cc = crossCount[i];
            const z = typicalZ[i];
            if (cc === null || z === null) return null;

            if (cc >= p.minCrosses) {
                // Buy: reverting regime and typical price z-score is below -zThreshold -> long reversion
                if (z < -p.zThreshold) {
                    return createBuySignal(cleanData, i, `Midpoint cross reversion buy: CC ${cc}, typical Z ${z.toFixed(2)}`);
                }
                // Sell: reverting regime and typical price z-score is above zThreshold -> short reversion
                if (z > p.zThreshold) {
                    return createSellSignal(cleanData, i, `Midpoint cross reversion sell: CC ${cc}, typical Z ${z.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minCrosses", "zThreshold"],
    },
};
