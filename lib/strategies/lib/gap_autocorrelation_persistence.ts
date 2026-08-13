import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation, extractBarMetricSeries } from "./price-action-statistics-core";

const AUTOCORR_GATE = 0.2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
    };
}

export const gap_autocorrelation_persistence: Strategy = {
    name: "Gap Autocorrelation Persistence",
    description: "Follows the current gap when gap directions have been serially dependent over the window.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Autocorrelation Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const gaps = extractBarMetricSeries(cleanData, "gapPct");
        const gapSigns = gaps.map((v) => Math.sign(v));
        const corr = buildRollingAutoCorrelation(gapSigns, lookback, 1);

        return createSignalLoop(cleanData, [corr], (i) => {
            const c = corr[i];
            if (c === null || Number.isNaN(c) || c < AUTOCORR_GATE) return null;

            const currentGap = gapSigns[i];
            const close = cleanData[i].close;
            const open = cleanData[i].open;

            if (currentGap > 0 && close >= open) {
                return createBuySignal(cleanData, i, `Persistent up gaps: autocorr ${c.toFixed(2)}`);
            }
            if (currentGap < 0 && close <= open) {
                return createSellSignal(cleanData, i, `Persistent down gaps: autocorr ${c.toFixed(2)}`);
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
