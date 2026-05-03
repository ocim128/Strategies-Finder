import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { calculateEMA } from "../indicators";
import {
    buildRateOfChange,
    buildRollingAutoCorrelation,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeAutocorrelationPersistenceRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 40))),
    };
}

export const autocorrelation_persistence_router: Strategy = {
    name: "Autocorrelation Persistence Router",
    description:
        "Routes positive return autocorrelation to EMA-aligned persistence and non-persistent regimes to close z-score reversion.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeAutocorrelationPersistenceRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeAutocorrelationPersistenceRouterParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 3) return [];

        const closes = getCloses(cleanData);
        const returns = buildRateOfChange(closes, 1).map((value) => value ?? 0);
        const autocorrelation = buildRollingAutoCorrelation(returns, lookback, 1);
        const ema = calculateEMA(closes, lookback);
        const zScore = buildRollingZScore(closes, lookback);

        return createSignalLoop(cleanData, [autocorrelation, ema, zScore], (i) => {
            const autoCorr = autocorrelation[i];
            const priorAutoCorr = autocorrelation[i - 1];
            const trendAnchor = ema[i];
            const closeZ = zScore[i];
            if (autoCorr === null || priorAutoCorr === null || trendAnchor === null || closeZ === null) return null;

            if (autoCorr > 0.2) {
                if (autoCorr > priorAutoCorr && closes[i] > trendAnchor) {
                    return createBuySignal(cleanData, i, `Autocorrelation persistence long ${autoCorr.toFixed(2)}`);
                }
                if (autoCorr > priorAutoCorr && closes[i] < trendAnchor) {
                    return createSellSignal(cleanData, i, `Autocorrelation persistence short ${autoCorr.toFixed(2)}`);
                }
                return null;
            }

            if (closeZ < -2) {
                return createBuySignal(cleanData, i, `Negative autocorrelation lower z-score ${closeZ.toFixed(2)}`);
            }
            if (closeZ > 2) {
                return createSellSignal(cleanData, i, `Negative autocorrelation upper z-score ${closeZ.toFixed(2)}`);
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
