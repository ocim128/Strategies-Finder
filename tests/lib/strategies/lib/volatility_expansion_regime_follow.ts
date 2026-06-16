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
    buildRollingStdDev,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        pctlThreshold: Math.max(0, Math.min(1, Number(params.pctlThreshold ?? 0.7))),
    };
}

export const volatility_expansion_regime_follow: Strategy = {
    name: "Volatility Expansion Regime Follow",
    description: "Enters trend direction on volatility breakouts from low-volatility compression.",
    defaultParams: {
        lookback: 30,
        pctlThreshold: 0.7,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pctlThreshold: "Percentile Threshold",
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

        const stdDev = buildRollingStdDev(retNumbers, lookback);
        const stdDevNumbers = stdDev.map((v) => (v !== null ? v : 0));
        const percentile = buildPercentileRank(stdDevNumbers, lookback);

        return createSignalLoop(cleanData, [percentile], (i) => {
            const rank = percentile[i];
            if (rank === null || i < 1) return null;

            const prevRank = percentile[i - 1];
            if (prevRank === null) return null;

            const crossedAbove = prevRank <= p.pctlThreshold && rank > p.pctlThreshold;
            if (!crossedAbove) return null;

            const bar = cleanData[i];

            if (bar.close > bar.open) {
                return createBuySignal(cleanData, i, `Volatility breakout buy: rank ${rank.toFixed(2)} crossed above ${p.pctlThreshold}`);
            }
            if (bar.close < bar.open) {
                return createSellSignal(cleanData, i, `Volatility breakout sell: rank ${rank.toFixed(2)} crossed above ${p.pctlThreshold}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctlThreshold"],
    },
};
