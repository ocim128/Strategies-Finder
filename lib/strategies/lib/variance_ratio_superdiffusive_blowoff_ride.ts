import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildBodyPctSeries } from "./price-action-frequency-core";
import { buildVarianceRatio } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_vr: Math.max(1.0, Number(params.min_vr ?? 1.35)),
    };
}

export const variance_ratio_superdiffusive_blowoff_ride: Strategy = {
    name: "Variance Ratio Superdiffusive Blowoff Ride",
    description: "Rides superdiffusive overdrive when the Variance Ratio reaches extreme dispersion levels with dominant candle bodies.",
    defaultParams: {
        min_vr: 1.35,
    },
    paramLabels: {
        min_vr: "Minimum Variance Ratio",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const minVr = Number(params.min_vr);
        const closes = getCloses(cleanData);

        const vr = buildVarianceRatio(closes, 24, 4);
        const bodyPct = buildBodyPctSeries(cleanData);

        return createSignalLoop(cleanData, [vr, bodyPct], (i) => {
            const vrVal = vr[i];
            const bp = bodyPct[i];
            if (vrVal === null || bp === null || vrVal < minVr) return null;
            if (bp < 0.75) return null;

            if (cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish superdiffusive blowoff: VR=${vrVal.toFixed(2)}>=${minVr}, bodyPct=${(bp * 100).toFixed(1)}%`);
            }
            if (cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish superdiffusive blowoff: VR=${vrVal.toFixed(2)}>=${minVr}, bodyPct=${(bp * 100).toFixed(1)}%`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_vr"],
    },
};
