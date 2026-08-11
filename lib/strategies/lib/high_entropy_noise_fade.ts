import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRateOfChange,
    buildRollingEntropy,
    buildRollingZScore,
} from "./price-action-statistics-core";

const ENTROPY_RANK_MIN = 0.7;
const Z_FADE_DEPTH = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 40))),
    };
}

export const high_entropy_noise_fade: Strategy = {
    name: "High Entropy Noise Fade",
    description: "Fades z-score extremes only when rolling return entropy ranks in the top tier, proving a maximum-disorder regime.",
    defaultParams: {
        lookback: 40,
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

        const closes = getCloses(cleanData);
        // One-bar returns with the leading null coerced; entropy bins these.
        const returns = buildRateOfChange(closes, 1).map((v) => (v === null ? 0 : v));
        // buildPercentileRank skips non-finite warm-up nulls inside the window,
        // so the entropy series is passed through as-is (cast for typing only).
        const entropy = buildRollingEntropy(returns, lookback);
        const entropyRank = buildPercentileRank(entropy as number[], lookback);
        const z = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [entropyRank, z], (i) => {
            const rank = entropyRank[i];
            const zNow = z[i];
            if (rank === null || zNow === null) return null;

            if (rank >= ENTROPY_RANK_MIN && zNow <= -Z_FADE_DEPTH) {
                return createBuySignal(cleanData, i, `Noise fade buy: entropy rank ${rank.toFixed(2)}, z ${zNow.toFixed(2)}`);
            }
            if (rank >= ENTROPY_RANK_MIN && zNow >= Z_FADE_DEPTH) {
                return createSellSignal(cleanData, i, `Noise fade sell: entropy rank ${rank.toFixed(2)}, z ${zNow.toFixed(2)}`);
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
