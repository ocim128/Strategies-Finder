import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses } from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        entropyPercentileMax: Math.max(0.1, Math.min(0.9, Number(params.entropyPercentileMax ?? 0.35))),
    };
}

export const return_sign_entropy_direction: Strategy = {
    name: "Return Sign Entropy Direction",
    description: "Follows directional acceptance when return sign entropy is low, confirming an ordered trending regime.",
    defaultParams: {
        lookback: 30,
        entropyPercentileMax: 0.35,
    },
    paramLabels: {
        lookback: "Lookback",
        entropyPercentileMax: "Max Entropy Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        // Map returns to sign flags: +1 positive, -1 negative, 0 zero
        const signFlags = returns.map(v => v === null ? 0 : v > 0 ? 1 : v < 0 ? -1 : 0);
        // Shift to positive range for entropy: -1->0, 0->1, +1->2
        const signBins = signFlags.map(v => v + 1);
        const entropy = buildRollingEntropy(signBins, lookback, 3);
        const entPctl = buildPercentileRank(entropy.map(v => v ?? 0), lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [entPctl], (i) => {
            const ep = entPctl[i];
            if (ep === null) return null;
            if (ep >= (p.entropyPercentileMax as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `Sign entropy pctl ${ep.toFixed(2)} ordered regime bullish`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `Sign entropy pctl ${ep.toFixed(2)} ordered regime bearish`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyPercentileMax"],
    },
};
