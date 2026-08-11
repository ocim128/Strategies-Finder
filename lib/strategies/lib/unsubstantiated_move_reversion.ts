import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRateOfChange,
    buildRollingZScore,
} from "./price-action-statistics-core";

const MOVE_Z_DEPTH = 2;
const VOLUME_RANK_MAX = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 60))),
    };
}

export const unsubstantiated_move_reversion: Strategy = {
    name: "Unsubstantiated Move Reversion",
    description: "Fades large one-bar moves made on bottom-third relative volume, treating them as liquidity noise.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Lookback Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        // One-bar returns with the leading null coerced, then standardized.
        const returns = buildRateOfChange(getCloses(cleanData), 1).map((v) => (v === null ? 0 : v));
        const returnZ = buildRollingZScore(returns, lookback);
        const volumeRank = buildPercentileRank(getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [returnZ, volumeRank], (i) => {
            const z = returnZ[i];
            const volRank = volumeRank[i];
            if (z === null || volRank === null) return null;

            if (z <= -MOVE_Z_DEPTH && volRank <= VOLUME_RANK_MAX) {
                return createBuySignal(cleanData, i, `Unsubstantiated move buy: return z ${z.toFixed(2)} on volume rank ${volRank.toFixed(2)}`);
            }
            if (z >= MOVE_Z_DEPTH && volRank <= VOLUME_RANK_MAX) {
                return createSellSignal(cleanData, i, `Unsubstantiated move sell: return z ${z.toFixed(2)} on volume rank ${volRank.toFixed(2)}`);
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
