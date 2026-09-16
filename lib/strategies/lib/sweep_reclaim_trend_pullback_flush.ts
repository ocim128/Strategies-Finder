import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const sweep_reclaim_trend_pullback_flush: Strategy = {
    name: "Sweep Reclaim Trend Pullback Flush",
    description: "Restricts liquidity sweep reclaims strictly to the direction of the macro trend, capturing high-conviction pullback stop-runs.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Macro Trend Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const sweep = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweep], (i) => {
            if (i < lookback) return null;
            const score = sweep[i];
            if (score === null) return null;

            if (score >= 0.20 && closes[i] > closes[i - lookback]) {
                return createBuySignal(cleanData, i, `Bullish trend pullback flush: spring sweep ${score.toFixed(3)} >= 0.20, macro uptrend (close > close[i-${lookback}])`);
            }
            if (score <= -0.20 && closes[i] < closes[i - lookback]) {
                return createSellSignal(cleanData, i, `Bearish trend pullback flush: upthrust sweep ${score.toFixed(3)} <= -0.20, macro downtrend (close < close[i-${lookback}])`);
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
