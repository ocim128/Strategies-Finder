import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import {
    buildPercentileRank,
    buildRateOfChange,
    buildRollingZScore,
} from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        volThreshold: Math.max(0, Math.min(1, Number(params.volThreshold ?? 0.70))),
        rocZThreshold: Math.max(0, Number(params.rocZThreshold ?? 1.5)),
    };
}

export const volume_confirmed_ratio_drift: Strategy = {
    name: "Volume Confirmed Ratio Drift",
    description: "Enters trends confirmed by high relative volume on the illiquid leg.",
    defaultParams: {
        lookback: 30,
        volThreshold: 0.70,
        rocZThreshold: 1.5,
    },
    paramLabels: {
        lookback: "Lookback Window",
        volThreshold: "Volume Percentile Threshold",
        rocZThreshold: "ROC Z-Score Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const volPercentile = buildPercentileRank(volumes, lookback);

        // ROC over 1 bar (returns) z-scored over lookback window
        const roc = buildRateOfChange(closes, 1);
        const rocNumbers: number[] = roc.map((v) => (v !== null ? v : 0));
        const rocZ = buildRollingZScore(rocNumbers, lookback);

        return createSignalLoop(cleanData, [volPercentile, rocZ], (i) => {
            const vp = volPercentile[i];
            const rz = rocZ[i];
            if (vp === null || rz === null) return null;

            if (vp > p.volThreshold) {
                if (rz > p.rocZThreshold) {
                    return createBuySignal(cleanData, i, `Volume confirmed buy: ROC Z-Score ${rz.toFixed(2)} with vol percentile ${vp.toFixed(2)}`);
                }
                if (rz < -p.rocZThreshold) {
                    return createSellSignal(cleanData, i, `Volume confirmed sell: ROC Z-Score ${rz.toFixed(2)} with vol percentile ${vp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volThreshold", "rocZThreshold"],
    },
};
