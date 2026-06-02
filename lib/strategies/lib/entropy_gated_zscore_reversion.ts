import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildRollingEntropy, buildRollingZScore, buildPercentileRank } from "./price-action-statistics-core";

const _returns = new WeakMap<OHLCVData[], number[]>();
function getReturns(data: OHLCVData[]): number[] {
    let r = _returns.get(data);
    if (!r) {
        const closes = getCloses(data);
        r = new Array(data.length).fill(0);
        for (let i = 1; i < data.length; i++) {
            r[i] = closes[i] - closes[i - 1];
        }
        _returns.set(data, r);
    }
    return r;
}

// #COMPLETION_DRIVE: Assuming return entropy can be used as a regime filter to isolate high-noise price extensions.
// #SUGGEST_VERIFY: Verify return entropy percentile bounds and Z-score threshold properties in standard simulation.
function normalizeEntropyGatedZscoreReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
        zThreshold: Math.max(0.1, Number(params.zThreshold ?? 2.0)),
    };
}

export const entropy_gated_zscore_reversion: Strategy = {
    name: "Entropy Gated Z-Score Reversion",
    description: "Volatility-normalized price deviations mean-revert with high reliability when return distribution exhibits high entropy.",
    defaultParams: {
        lookback: 40,
        zThreshold: 2.0,
    },
    paramLabels: {
        lookback: "Lookback Window",
        zThreshold: "Z-Score Threshold",
    },
    normalizeParams: normalizeEntropyGatedZscoreReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeEntropyGatedZscoreReversionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const zscore = buildRollingZScore(closes, lookback);

        const returns = getReturns(cleanData);
        const entropy = buildRollingEntropy(returns, lookback);
        const entropyClean = entropy.map(v => v ?? 0);
        const entRank = buildPercentileRank(entropyClean, lookback);

        return createSignalLoop(cleanData, [zscore, entRank], (i) => {
            if (i < lookback) return null;
            const z = zscore[i];
            const rank = entRank[i];

            if (z === null || rank === null) return null;

            // Buy: Z-score is less than -zThreshold while return entropy is in the top 30% of history (rank > 0.7)
            if (z < -p.zThreshold && rank > 0.7) {
                return createBuySignal(cleanData, i, `Bullish Entropy Z-Reversion (z=${z.toFixed(2)}, entropyRank=${(rank * 100).toFixed(0)}%)`);
            }

            // Sell: Z-score is greater than zThreshold while return entropy is in the top 30% of history (rank > 0.7)
            if (z > p.zThreshold && rank > 0.7) {
                return createSellSignal(cleanData, i, `Bearish Entropy Z-Reversion (z=${z.toFixed(2)}, entropyRank=${(rank * 100).toFixed(0)}%)`);
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
