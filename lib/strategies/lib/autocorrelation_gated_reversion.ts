import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingAutoCorrelation,
    buildRollingZScore,
} from "./price-action-statistics-core";

const REVERSION_REGIME_GATE = -0.2;
const Z_EXTREME = 2.0;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
    };
}

export const autocorrelation_gated_reversion: Strategy = {
    name: "Autocorrelation Gated Reversion",
    description: "Fades close z-score extremes only while lag-1 return autocorrelation marks a mean-reverting regime.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length <= lookback) return [];

        const closes = getCloses(cleanData);
        const rawReturns = buildRateOfChange(closes, 1);
        const returns = rawReturns.map((value) => (value === null ? 0 : value));
        const rawAutocorrelation = buildRollingAutoCorrelation(returns, lookback, 1);
        const autocorrelation = rawAutocorrelation.map((value) =>
            value === null || !Number.isFinite(value) ? null : value
        );
        const zScore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [autocorrelation, zScore], (i) => {
            const regime = autocorrelation[i];
            const z = zScore[i];
            if (regime === null || z === null) return null;
            if (regime >= REVERSION_REGIME_GATE) return null;

            if (z <= -Z_EXTREME) {
                return createBuySignal(cleanData, i, `Reversion-gated fade: z ${z.toFixed(2)}, autocorr ${regime.toFixed(2)}`);
            }
            if (z >= Z_EXTREME) {
                return createSellSignal(cleanData, i, `Reversion-gated fade: z ${z.toFixed(2)}, autocorr ${regime.toFixed(2)}`);
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
