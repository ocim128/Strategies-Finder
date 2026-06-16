import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { calculateATR } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { buildRateOfChange, buildRollingZScore } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        zThreshold: Math.max(0, Number(params.zThreshold ?? 2.2)),
    };
}

export const range_weighted_zscore_reversion: Strategy = {
    name: "Range Weighted Z-Score Reversion",
    description: "Fades ratio price extensions by normalising the rate of change by the average true range (ATR).",
    defaultParams: {
        lookback: 20,
        zThreshold: 2.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const atr = calculateATR(highs, lows, closes, lookback);
        const roc = buildRateOfChange(closes, 1);

        const weightedReturns = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const valAtr = atr[i];
            const valRoc = roc[i];
            weightedReturns[i] = (valAtr !== null && valAtr > 1e-12 && valRoc !== null) ? valRoc / valAtr : 0;
        }

        const wz = buildRollingZScore(weightedReturns, lookback);

        return createSignalLoop(cleanData, [wz], (i) => {
            const z = wz[i];
            if (z === null) return null;

            if (z < -p.zThreshold) {
                return createBuySignal(cleanData, i, `Range weighted buy: Z-score ${z.toFixed(2)}`);
            }
            if (z > p.zThreshold) {
                return createSellSignal(cleanData, i, `Range weighted sell: Z-score ${z.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "zThreshold"],
    },
};
