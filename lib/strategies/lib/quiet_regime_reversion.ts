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
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

const QUIET_REGIME_PCT = 0.3;
const STRETCH_GATE = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
    };
}

export const quiet_regime_reversion: Strategy = {
    name: "Quiet Regime Reversion",
    description: "Fades closes at least 1.5 ATR from the rolling median only while ATR sits at or below the 30th percentile of its own history.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "ATR Period & Percentile Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, lookback);
        // Mask warm-up nulls as NaN so the percentile window fills only with
        // real ATR values instead of ranking zeros as tiny volatility.
        const atrMasked: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const atrValue = atr[i];
            atrMasked[i] = atrValue === null ? Number.NaN : atrValue;
        }
        const atrPct = buildPercentileRank(atrMasked, lookback);
        const median = buildRollingMedian(closes, lookback);

        return createSignalLoop(cleanData, [atr, atrPct], (i) => {
            const a = atr[i];
            const m = median[i];
            const pct = atrPct[i];
            if (a === null || a <= 0 || m === null || pct === null) return null;
            if (pct > QUIET_REGIME_PCT) return null;

            const stretch = (closes[i] - m) / a;
            if (stretch <= -STRETCH_GATE) {
                return createBuySignal(cleanData, i, `Stretch ${stretch.toFixed(2)} ATR below median in quiet regime (ATR pct ${pct.toFixed(2)})`);
            }
            if (stretch >= STRETCH_GATE) {
                return createSellSignal(cleanData, i, `Stretch ${stretch.toFixed(2)} ATR above median in quiet regime (ATR pct ${pct.toFixed(2)})`);
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
