import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getCloses, getVolumes } from "../strategy-helpers";
import { buildRollingMedian, buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 25))),
        efficiencyMin: Math.max(0.1, Math.min(0.95, Number(params.efficiencyMin ?? 0.40))),
        volumePercentileMin: Math.max(0.1, Math.min(0.95, Number(params.volumePercentileMin ?? 0.40))),
    };
}

export const median_pullback_volume_entry: Strategy = {
    name: "Median Pullback Volume Entry",
    description: "Enters at rolling median pullbacks in confirmed trends with proxy volume confirmation.",
    defaultParams: {
        lookback: 25,
        efficiencyMin: 0.40,
        volumePercentileMin: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        efficiencyMin: "Min Efficiency",
        volumePercentileMin: "Min Volume Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const volPctl = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [median, efficiency, volPctl], (i) => {
            const med = median[i];
            const er = efficiency[i];
            const vp = volPctl[i];
            if (med === null || er === null || vp === null) return null;
            if (er < (p.efficiencyMin as number)) return null;
            if (vp < (p.volumePercentileMin as number)) return null;

            // Close near median (within 0.5%)
            const distPct = Math.abs(closes[i] - med) / med;
            if (distPct > 0.005) return null;

            // Direction from efficiency and close position relative to median
            if (closes[i] >= med) {
                return createBuySignal(cleanData, i, `Median pullback dist ${(distPct * 100).toFixed(2)}% eff ${er.toFixed(2)} vol ${vp.toFixed(2)}`);
            }
            if (closes[i] < med) {
                return createSellSignal(cleanData, i, `Median pullback dist ${(distPct * 100).toFixed(2)}% eff ${er.toFixed(2)} vol ${vp.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "efficiencyMin", "volumePercentileMin"],
    },
};
