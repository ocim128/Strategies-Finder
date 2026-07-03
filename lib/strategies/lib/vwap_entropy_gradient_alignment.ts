import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateVWAP } from "../indicators";
import { buildRollingEntropy, buildPercentileRank } from "./price-action-statistics-core";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        maxEntropy: Number(params.maxEntropy ?? 0.45),
    };
}

export const vwap_entropy_gradient_alignment: Strategy = {
    name: "VWAP Entropy Gradient Alignment",
    description: "Enters in the direction of the close location gradient during structured low-entropy regimes relative to VWAP center.",
    defaultParams: {
        lookback: 30,
        maxEntropy: 0.45,
    },
    paramLabels: {
        lookback: "Lookback Window",
        maxEntropy: "Max Entropy Limit",
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
        const volumes = cleanData.map((d) => d.volume);

        const vwap = calculateVWAP(highs, lows, closes, volumes, lookback);
        const returns = extractBarMetricSeries(cleanData, "closeReturn");
        const entropy = buildRollingEntropy(returns, lookback);

        const closeLoc = buildCloseLocationSeries(cleanData);
        const grad = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            grad[i] = closeLoc[i] - closeLoc[i - 1];
        }
        const gradPctl = buildPercentileRank(grad, lookback);

        return createSignalLoop(cleanData, [vwap, entropy, gradPctl], (i) => {
            if (i < lookback) return null;
            const currentVwap = vwap[i];
            const currentEntropy = entropy[i];
            const currentGradPctl = gradPctl[i];
            if (currentVwap === null || currentEntropy === null || currentGradPctl === null) return null;

            const close = closes[i];
            const maxEnt = p.maxEntropy as number;

            // Buy: entropy < maxEntropy, price > VWAP, close location gradient percentile > 0.75
            if (currentEntropy < maxEnt && close > currentVwap && currentGradPctl > 0.75) {
                return createBuySignal(cleanData, i, `VWAP Entropy Align Buy: Entropy ${currentEntropy.toFixed(2)}, GradPctl ${currentGradPctl.toFixed(2)}`);
            }
            // Sell: entropy < maxEntropy, price < VWAP, close location gradient percentile < 0.25
            if (currentEntropy < maxEnt && close < currentVwap && currentGradPctl < 0.25) {
                return createSellSignal(cleanData, i, `VWAP Entropy Align Sell: Entropy ${currentEntropy.toFixed(2)}, GradPctl ${currentGradPctl.toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxEntropy"],
    },
};
