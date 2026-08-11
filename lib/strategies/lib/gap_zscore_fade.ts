import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-statistics-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const GAP_Z_BAND = 2;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 90))),
    };
}

export const gap_zscore_fade: Strategy = {
    name: "Gap Z-Score Fade",
    description: "Fades abnormally large opening gaps in the ratio, standardized against recent gap size.",
    defaultParams: {
        lookback: 90,
    },
    paramLabels: {
        lookback: "Gap Standardization Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        // gapPct is known at each bar's open, so acting at that open or later
        // is non-repainting; bar 0 has no prior close and yields a zero gap.
        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        const gapZ = buildRollingZScore(gapPct, lookback);

        return createSignalLoop(cleanData, [gapZ], (i) => {
            const z = gapZ[i];
            if (z === null) return null;

            if (z <= -GAP_Z_BAND) {
                return createBuySignal(cleanData, i, `Gap fade buy: gap z ${z.toFixed(2)} (large down gap at open)`);
            }
            if (z >= GAP_Z_BAND) {
                return createSellSignal(cleanData, i, `Gap fade sell: gap z ${z.toFixed(2)} (large up gap at open)`);
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
