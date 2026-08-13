import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildPercentileRank, buildRollingMedian } from "./price-action-statistics-core";

const ATR_PERIOD = 20;
const STRETCH_GATE = 1.5;
const CLIMAX_VOLUME_PCT = 0.9;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
    };
}

export const climax_volume_reversion: Strategy = {
    name: "Climax Volume Reversion",
    description: "Fades closes at least 1.5 ATR from the rolling median when the bar's volume ranks at or above the 90th percentile.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Median & Volume Percentile Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, ATR_PERIOD);
        // Volume enters only as a relative percentile proxy, never a raw level.
        const volPct = buildPercentileRank(getVolumes(cleanData), lookback);

        return createSignalLoop(cleanData, [atr, volPct], (i) => {
            const m = median[i];
            const a = atr[i];
            const vp = volPct[i];
            if (m === null || a === null || a <= 0 || vp === null) return null;
            if (vp < CLIMAX_VOLUME_PCT) return null;

            const stretch = (closes[i] - m) / a;
            if (stretch <= -STRETCH_GATE) {
                return createBuySignal(cleanData, i, `Climax-volume downside stretch ${stretch.toFixed(2)} ATR (vol pct ${vp.toFixed(2)})`);
            }
            if (stretch >= STRETCH_GATE) {
                return createSellSignal(cleanData, i, `Climax-volume upside stretch ${stretch.toFixed(2)} ATR (vol pct ${vp.toFixed(2)})`);
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
