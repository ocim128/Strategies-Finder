import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData } from "../strategy-helpers";
import { buildCloseAcceptanceSeries, buildRangeSeries } from "./price-action-frequency-core";
import { buildPercentileRank, buildEfficiencyRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        rangePercentileMax: Math.max(0.1, Math.min(0.9, Number(params.rangePercentileMax ?? 0.30))),
        efficiencyMin: Math.max(0.2, Math.min(0.95, Number(params.efficiencyMin ?? 0.50))),
    };
}

export const tight_coupling_directional_drift: Strategy = {
    name: "Tight Coupling Directional Drift",
    description: "Follows directional drift in tight coupling regime with efficiency confirmation for minimal variance.",
    defaultParams: {
        lookback: 25,
        rangePercentileMax: 0.30,
        efficiencyMin: 0.50,
    },
    paramLabels: {
        lookback: "Lookback",
        rangePercentileMax: "Max Range Percentile",
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
            if (rp >= (p.rangePercentileMax as number)) return null;
            if (er < (p.efficiencyMin as number)) return null;

            const ca = closeAcceptance[i];
            if (ca > 0) {
                return createBuySignal(cleanData, i, `Tight coupling pctl ${rp.toFixed(2)} eff ${er.toFixed(2)} bullish drift`);
            }
            if (ca < 0) {
                return createSellSignal(cleanData, i, `Tight coupling pctl ${rp.toFixed(2)} eff ${er.toFixed(2)} bearish drift`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangePercentileMax", "efficiencyMin"],
    },
};
