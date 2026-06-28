import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        gapPercentileMin: Math.max(0.5, Math.min(0.99, Number(params.gapPercentileMin ?? 0.75))),
        efficiencyMin: Math.max(0.1, Math.min(0.95, Number(params.efficiencyMin ?? 0.40))),
    };
}

export const gap_percentile_efficiency_follow: Strategy = {
    name: "Gap Percentile Efficiency Follow",
    description: "Follows directional session gaps backed by efficiency ratio and close acceptance, capturing inter-session leg decoupling.",
    defaultParams: {
        lookback: 30,
        gapPercentileMin: 0.75,
        efficiencyMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        gapPercentileMin: "Min Gap Percentile",
        efficiencyMin: "Min Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const gapPct = extractBarMetricSeries(cleanData, "gapPct");
        // Use absolute gap for percentile ranking (magnitude matters)
        const absGap = gapPct.map(v => Math.abs(v));
        const gapPctl = buildPercentileRank(absGap, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [gapPctl, efficiency], (i) => {
            const gp = gapPctl[i];
            const er = efficiency[i];
            if (gp === null || er === null) return null;
            if (gp < (p.gapPercentileMin as number)) return null;
            if (er < (p.efficiencyMin as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `Gap pctl ${gp.toFixed(2)} eff ${er.toFixed(2)} bullish acceptance`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `Gap pctl ${gp.toFixed(2)} eff ${er.toFixed(2)} bearish acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "gapPercentileMin", "efficiencyMin"],
    },
};
