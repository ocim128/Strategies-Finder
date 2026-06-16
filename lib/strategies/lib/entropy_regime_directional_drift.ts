import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import {
    buildPercentileRank,
    buildRateOfChange,
    buildRollingEntropy,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
        entropyMax: Math.max(0, Math.min(1, Number(params.entropyMax ?? 0.8))),
    };
}

export const entropy_regime_directional_drift: Strategy = {
    name: "Entropy Regime Directional Drift",
    description: "Follows close location drift in low-entropy (predictable) regimes.",
    defaultParams: {
        lookback: 20,
        entropyMax: 0.8,
    },
    paramLabels: {
        lookback: "Lookback Window",
        entropyMax: "Max Entropy Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1);
        const retNumbers = returns.map((v) => (v !== null ? v : 0));

        const entropy = buildRollingEntropy(retNumbers, lookback, 5);
        const entropyNumbers = entropy.map((v) => (v !== null ? v : 0));
        const entropyPercentile = buildPercentileRank(entropyNumbers, lookback);

        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [entropyPercentile], (i) => {
            const ep = entropyPercentile[i];
            if (ep === null) return null;

            const cl = closeLocation[i];

            if (ep < p.entropyMax) {
                // Buy: low entropy and positive close location -> follow drift
                if (cl > 0.65) {
                    return createBuySignal(cleanData, i, `Entropy drift buy: percentile ${ep.toFixed(2)}, CL ${cl.toFixed(2)}`);
                }
                // Sell: low entropy and negative close location -> follow drift
                if (cl < 0.35) {
                    return createSellSignal(cleanData, i, `Entropy drift sell: percentile ${ep.toFixed(2)}, CL ${cl.toFixed(2)}`);
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
