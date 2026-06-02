import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildTrailingHighLow } from "./price-action-frequency-core";
import { buildRollingStdDev, buildRollingEntropy } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming low volatility compression followed by boundary breakout under low-entropy regime acts as explosive launch.
// #SUGGEST_VERIFY: Verify standard deviation ranking and entropy calculations are causal and do not contain off-by-one future leaks.
function normalizeVolatilityCompressionEntropyBreakoutParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
        entropyMax: Math.max(0.01, Number(params.entropyMax ?? 0.45)),
    };
}

export const volatility_compression_entropy_breakout: Strategy = {
    name: "Volatility Compression Entropy Breakout",
    description: "Signals breakouts from extreme volatility squeezes under a low-entropy regime, capturing explosive trend launches.",
    defaultParams: {
        lookback: 40,
        entropyMax: 0.45,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyMax: "Maximum Entropy",
    },
    normalizeParams: normalizeVolatilityCompressionEntropyBreakoutParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolatilityCompressionEntropyBreakoutParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 10) return [];

        const closes = getCloses(cleanData);
        const returns = getReturns(cleanData);

        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback);
        const stddev = buildRollingStdDev(returns, lookback);
        const entropy = buildRollingEntropy(returns, lookback);

        // Precompute standard deviation percentile ranks within their trailing window
        const stddevClean = stddev.map(v => v ?? 0);
        const stdPercentiles: number[] = new Array(cleanData.length).fill(0.5);

        for (let i = lookback; i < cleanData.length; i++) {
            const start = i - lookback + 1;
            const currentVal = stddevClean[i];
            let lowerCount = 0;
            let totalCount = 0;
            for (let j = start; j <= i; j++) {
                totalCount++;
                if (stddevClean[j] < currentVal) {
                    lowerCount++;
                }
            }
            stdPercentiles[i] = totalCount > 0 ? lowerCount / totalCount : 0.5;
        }

        return createSignalLoop(cleanData, [highest, lowest, stddev, entropy], (i) => {
            if (i < lookback) return null;
            const currentClose = closes[i];
            const hi = highest[i];
            const lo = lowest[i];
            const ent = entropy[i];
            const pct = stdPercentiles[i];

            if (hi === null || lo === null || ent === null) return null;

            // Volatility compression check: stddev is in the bottom 20% of its trailing window (pct <= 0.20)
            if (pct <= 0.20 && ent < p.entropyMax) {
                // Buy: Close breaks above trailing high
                if (currentClose > hi) {
                    return createBuySignal(cleanData, i, `Volatility Compression Breakout Bullish (stdPct=${(pct * 100).toFixed(0)}%, entropy=${ent.toFixed(3)})`);
                }
                // Sell: Close breaks below trailing low
                if (currentClose < lo) {
                    return createSellSignal(cleanData, i, `Volatility Compression Breakout Bearish (stdPct=${(pct * 100).toFixed(0)}%, entropy=${ent.toFixed(3)})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyMax"],
    },
};
