import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getHighs, getLows, getVolumes } from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRollingEntropy, buildStreakCount } from "./price-action-statistics-core";

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

// #COMPLETION_DRIVE: Assuming high entropy combined with money flow divergence and close acceptance streaks confirms durable reversions.
// #SUGGEST_VERIFY: Verify return entropy percentile bounds and close-location threshold properties in standard simulation.
function normalizeVolumeWeightedEntropyRegimeReversalParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        entropyThreshold: Math.max(0.01, Number(params.entropyThreshold ?? 0.75)),
    };
}

export const volume_weighted_entropy_regime_reversal: Strategy = {
    name: "Volume Weighted Entropy Regime Reversal",
    description: "Reversion signals triggered when a trend reaches high return entropy on elevated volume followed by a close acceptance streak in the opposite direction.",
    defaultParams: {
        lookback: 30,
        entropyThreshold: 0.75,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyThreshold: "Entropy Threshold",
    },
    normalizeParams: normalizeVolumeWeightedEntropyRegimeReversalParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeWeightedEntropyRegimeReversalParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const returns = getReturns(cleanData);
        const entropy = buildRollingEntropy(returns, lookback);
        const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        const flags = closeAcceptance.map(v => v > 0 ? 1 : v < 0 ? -1 : 0);
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [entropy, cmf], (i) => {
            if (i < lookback) return null;
            const ent = entropy[i];
            const currentCmf = cmf[i];
            const currentStreak = streaks[i];

            if (ent === null || currentCmf === null) return null;

            if (ent > p.entropyThreshold) {
                // Buy logic: CMF is negative, and positive close acceptance streak reaches >= 3
                if (currentCmf < 0 && currentStreak >= 3) {
                    return createBuySignal(cleanData, i, `Bullish Entropy Reversal (entropy=${ent.toFixed(3)}, CMF=${currentCmf.toFixed(3)}, streak=${currentStreak})`);
                }
                // Sell logic: CMF is positive, and negative close acceptance streak reaches <= -3
                if (currentCmf > 0 && currentStreak <= -3) {
                    return createSellSignal(cleanData, i, `Bearish Entropy Reversal (entropy=${ent.toFixed(3)}, CMF=${currentCmf.toFixed(3)}, streak=${currentStreak})`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyThreshold"],
    },
};
