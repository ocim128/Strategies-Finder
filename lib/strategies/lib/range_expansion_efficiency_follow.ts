import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
        rangePercentileMin: Math.max(0.5, Math.min(0.99, Number(params.rangePercentileMin ?? 0.75))),
        efficiencyMin: Math.max(0.1, Math.min(0.95, Number(params.efficiencyMin ?? 0.40))),
    };
}

export const range_expansion_efficiency_follow: Strategy = {
    name: "Range Expansion Efficiency Follow",
    description: "Follows high-percentile range expansions backed by strong efficiency ratio, filtering out noisy two-sided dislocations.",
    defaultParams: {
        lookback: 30,
        rangePercentileMin: 0.75,
        efficiencyMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        rangePercentileMin: "Min Range Percentile",
        efficiencyMin: "Min Efficiency",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const ranges = buildRangeSeries(cleanData);
        const rangePctl = buildPercentileRank(ranges, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const closeAcceptance = buildCloseAcceptanceSeries(cleanData);

        return createSignalLoop(cleanData, [rangePctl, efficiency], (i) => {
            const rp = rangePctl[i];
            const er = efficiency[i];
            if (rp === null || er === null) return null;
            if (rp < (p.rangePercentileMin as number)) return null;
            if (er < (p.efficiencyMin as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `Range pctl ${rp.toFixed(2)} eff ${er.toFixed(2)} bullish acceptance`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `Range pctl ${rp.toFixed(2)} eff ${er.toFixed(2)} bearish acceptance`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentileMin", "efficiencyMin"],
    },
};
