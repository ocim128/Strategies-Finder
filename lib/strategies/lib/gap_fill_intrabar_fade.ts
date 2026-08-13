import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

const HIGH_GAP_PCT = 0.9;
const LOW_GAP_PCT = 0.1;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 24))),
    };
}

export const gap_fill_intrabar_fade: Strategy = {
    name: "Gap Fill Intrabar Fade",
    description: "Fades extreme gaps that the same bar recovers intrabar back through the gap level.",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Gap Percentile Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const lookback = normalizeParams(params).lookback as number;
        if (cleanData.length < lookback) return [];

        const gaps = extractBarMetricSeries(cleanData, "gapPct");
        const pct = buildPercentileRank(gaps, lookback);

        return createSignalLoop(cleanData, [pct], (i) => {
            const pr = pct[i];
            if (pr === null) return null;

            const close = cleanData[i].close;
            const open = cleanData[i].open;

            // A deep down gap recovered intrabar: fade it back up.
            if (pr <= LOW_GAP_PCT && close > open) {
                return createBuySignal(cleanData, i, `Extreme down gap recovered: rank ${pr.toFixed(2)}`);
            }
            // A large up gap recovered intrabar: fade it back down.
            if (pr >= HIGH_GAP_PCT && close < open) {
                return createSellSignal(cleanData, i, `Extreme up gap recovered: rank ${pr.toFixed(2)}`);
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
