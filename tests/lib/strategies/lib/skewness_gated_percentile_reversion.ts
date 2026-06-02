import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildPercentileRank, buildRollingSkewness } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming extreme price percentile ranks accompanied by opposite return distribution skewness correctly signal exhaustion.
// #SUGGEST_VERIFY: Verify return skewness and close price percentile ranks are causal and aligned.
function normalizeSkewnessGatedPercentileReversionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 50))),
        skewLimit: Math.max(0.1, Number(params.skewLimit ?? 1.2)),
    };
}

export const skewness_gated_percentile_reversion: Strategy = {
    name: "Skewness Gated Percentile Reversion",
    description: "Reverts extreme price percentile ranks when return skewness is opposite, indicating a building exhaust block.",
    defaultParams: {
        lookback: 50,
        skewLimit: 1.2,
    },
    paramLabels: {
        lookback: "Lookback Window",
        skewLimit: "Skewness Limit",
    },
    normalizeParams: normalizeSkewnessGatedPercentileReversionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeSkewnessGatedPercentileReversionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const closes = getCloses(cleanData);
        const returns = getReturns(cleanData);

        const rank = buildPercentileRank(closes, lookback);
        const skewness = buildRollingSkewness(returns, lookback);

        return createSignalLoop(cleanData, [rank, skewness], (i) => {
            if (i < lookback) return null;
            const currentRank = rank[i];
            const currentSkew = skewness[i];

            if (currentRank === null || currentSkew === null) return null;

            // Buy logic: Percentile rank of close is < 15% and rolling return skewness is > skewLimit (bullish reversal)
            if (currentRank < 0.15 && currentSkew > p.skewLimit) {
                return createBuySignal(cleanData, i, `Bullish Skewness Percentile Reversion (rank=${(currentRank * 100).toFixed(0)}%, skew=${currentSkew.toFixed(2)})`);
            }

            // Sell logic: Percentile rank of close is > 85% and rolling return skewness is < -skewLimit (bearish reversal)
            if (currentRank > 0.85 && currentSkew < -(p.skewLimit as number)) {
                return createSellSignal(cleanData, i, `Bearish Skewness Percentile Reversion (rank=${(currentRank * 100).toFixed(0)}%, skew=${currentSkew.toFixed(2)})`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "skewLimit"],
    },
};
