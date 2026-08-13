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
import { calculateATR } from "../indicators";
import { buildPercentileRank } from "./price-action-statistics-core";

const ACTIVE_REGIME_PERCENTILE = 0.8;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const atr_regime_follow: Strategy = {
    name: "ATR Regime Follow",
    description: "Trades single-bar direction only when ATR sits at a high percentile of its own history.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "ATR / Regime Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);
        // Mask the warm-up nulls as NaN so buildPercentileRank excludes them from the window.
        const maskedAtr = atr.map((v) => (v === null ? NaN : v));
        const pct = buildPercentileRank(maskedAtr, lookback);

        return createSignalLoop(cleanData, [pct], (i) => {
            const pr = pct[i];
            if (pr === null || pr < ACTIVE_REGIME_PERCENTILE) return null;

            if (closes[i] > closes[i - 1]) {
                return createBuySignal(cleanData, i, `Active ATR regime, up bar: rank ${pr.toFixed(2)}`);
            }
            if (closes[i] < closes[i - 1]) {
                return createSellSignal(cleanData, i, `Active ATR regime, down bar: rank ${pr.toFixed(2)}`);
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
