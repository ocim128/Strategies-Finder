import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeRecoveryBarAfterWeakCloseParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
    };
}

export const recovery_bar_after_weak_close: Strategy = {
    name: "Recovery Bar After Weak Close",
    description: "Follows a strong opposite-placement bar that recovers immediately after a percentile-extreme weak close.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeRecoveryBarAfterWeakCloseParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeRecoveryBarAfterWeakCloseParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const closeLocation = buildCloseLocationSeries(cleanData);
        const closeLocPct = buildPercentileRank(closeLocation, lookback);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");

        return createSignalLoop(cleanData, [closeLocPct], (i) => {
            if (i < lookback || i < 1) return null;
            const prevPct = closeLocPct[i - 1];
            if (prevPct === null) return null;

            if (prevPct < 0.2 && bodyDirection[i] > 0 && closeLocation[i] > 0.5) {
                return createBuySignal(cleanData, i, `Recovery up bar after weak close (percentile ${prevPct.toFixed(2)})`);
            }
            if (prevPct > 0.8 && bodyDirection[i] < 0 && closeLocation[i] < 0.5) {
                return createSellSignal(cleanData, i, `Recovery down bar after strong close (percentile ${prevPct.toFixed(2)})`);
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
