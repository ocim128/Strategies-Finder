import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries, buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        pctlExtreme: Math.max(0.5, Math.min(0.999, Number(params.pctlExtreme ?? 0.85))),
    };
}

export const body_proportion_percentile_fade: Strategy = {
    name: "Body Proportion Percentile Fade",
    description: "Fades high body-proportion conviction bars closing near extremes.",
    defaultParams: {
        lookback: 30,
        pctlExtreme: 0.85,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pctlExtreme: "Percentile Extreme",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const pctRank = buildPercentileRank(bodyPct, lookback);
        const closeLoc = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [pctRank], (i) => {
            const pr = pctRank[i];
            if (pr === null) return null;

            // Buy: High body proportion at extreme and close location at bottom
            if (pr > p.pctlExtreme && closeLoc[i] < 0.2) {
                return createBuySignal(cleanData, i, `Body proportion percentile buy: pct ${pr.toFixed(2)}, cl ${closeLoc[i].toFixed(2)}`);
            }
            // Sell: High body proportion at extreme and close location at top
            if (pr > p.pctlExtreme && closeLoc[i] > 0.8) {
                return createSellSignal(cleanData, i, `Body proportion percentile sell: pct ${pr.toFixed(2)}, cl ${closeLoc[i].toFixed(2)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctlExtreme"],
    },
};
