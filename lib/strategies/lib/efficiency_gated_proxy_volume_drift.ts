import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        erThreshold: Math.max(0, Math.min(1, Number(params.erThreshold ?? 0.3))),
        volPctlMin: Math.max(0, Math.min(1, Number(params.volPctlMin ?? 0.4))),
    };
}

export const efficiency_gated_proxy_volume_drift: Strategy = {
    name: "Efficiency-Gated Proxy Volume Drift",
    description: "Follows efficient ratio moves supported by healthy proxy volume on the illiquid leg.",
    defaultParams: {
        lookback: 30,
        erThreshold: 0.3,
        volPctlMin: 0.4,
    },
    paramLabels: {
        lookback: "Lookback Window",
        erThreshold: "Efficiency Threshold",
        volPctlMin: "Min Volume Percentile",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const efficiency = buildEfficiencyRatio(cleanData, lookback);

        const volumes = getVolumes(cleanData);
        const volPercentile = buildPercentileRank(volumes, lookback);

        return createSignalLoop(cleanData, [efficiency, volPercentile], (i) => {
            const er = efficiency[i];
            const vp = volPercentile[i];
            if (er === null || vp === null) return null;

            const bar = cleanData[i];

            if (er > p.erThreshold && vp > p.volPctlMin) {
                if (bar.close > bar.open) {
                    return createBuySignal(cleanData, i, `Efficiency drift buy: ER ${er.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
                if (bar.close < bar.open) {
                    return createSellSignal(cleanData, i, `Efficiency drift sell: ER ${er.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "erThreshold", "volPctlMin"],
    },
};
