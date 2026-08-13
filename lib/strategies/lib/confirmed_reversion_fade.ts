import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createCurrentBarSignalLoop,
    createSellSignal,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

const ATR_PERIOD = 20;
const STRETCH_GATE = 1.5;
const ROC_GATE = 0.15;
const ROC_BARS = 3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 40))),
    };
}

export const confirmed_reversion_fade: Strategy = {
    name: "Confirmed Reversion Fade",
    description: "Fades closes still at least 1.5 ATR from the rolling median once the stretch has started collapsing over the prior 3 bars.",
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
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const atr = calculateATR(getHighs(cleanData), getLows(cleanData), closes, ATR_PERIOD);

        // Dense stretch series (0 where the anchor or ATR is not yet valid) so
        // the rate-of-change helper stays finite; null ROC means no-signal.
        const stretchNumbers: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const m = median[i];
            const a = atr[i];
            if (m !== null && a !== null && a > 0) {
                stretchNumbers[i] = (closes[i] - m) / a;
            }
        }
        const roc = buildRateOfChange(stretchNumbers, ROC_BARS);

        // The ROC is a current-bar read of a 3-bar lookback helper, so the
        // current-bar loop is used to avoid the one-bar delay the standard
        // loop imposes on strategies that compare indicator values at i-1.
        return createCurrentBarSignalLoop(cleanData, [atr, roc], (i) => {
            const m = median[i];
            const a = atr[i];
            const r = roc[i];
            if (m === null || a === null || a <= 0 || r === null) return null;

            const stretch = (closes[i] - m) / a;
            if (stretch <= -STRETCH_GATE && r >= ROC_GATE) {
                return createBuySignal(cleanData, i, `Stretch ${stretch.toFixed(2)} ATR below median, ROC ${r.toFixed(2)} confirming bounce`);
            }
            if (stretch >= STRETCH_GATE && r <= -ROC_GATE) {
                return createSellSignal(cleanData, i, `Stretch ${stretch.toFixed(2)} ATR above median, ROC ${r.toFixed(2)} confirming fall`);
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
