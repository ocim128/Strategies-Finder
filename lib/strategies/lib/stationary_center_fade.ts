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
import { buildRollingMedian } from "./price-action-statistics-core";

const ATR_PERIOD = 20;
const DRIFT_GATE = 0.5;
const STRETCH_GATE = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
    };
}

export const stationary_center_fade: Strategy = {
    name: "Stationary Center Fade",
    description: "Fades closes at least 1.5 ATR from the rolling median only when the median itself has drifted less than 0.5 ATR over the window.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Median Anchor Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < 2 * lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, ATR_PERIOD);

        return createSignalLoop(cleanData, [atr], (i) => {
            if (i < 2 * lookback) return null;
            const a = atr[i];
            const m = median[i];
            const mPast = median[i - lookback];
            if (a === null || a <= 0 || m === null || mPast === null) return null;

            const drift = (m - mPast) / a;
            if (Math.abs(drift) > DRIFT_GATE) return null;

            const stretch = (closes[i] - m) / a;
            if (stretch <= -STRETCH_GATE) {
                return createBuySignal(cleanData, i, `Stretch ${stretch.toFixed(2)} ATR below stationary median`);
            }
            if (stretch >= STRETCH_GATE) {
                return createSellSignal(cleanData, i, `Stretch ${stretch.toFixed(2)} ATR above stationary median`);
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
