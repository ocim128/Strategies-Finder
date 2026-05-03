import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { calculateCMF } from "../indicators";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildRateOfChange, buildRollingMedian } from "./price-action-statistics-core";

function normalizeVolumeRocRegimeRouterParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volume_lookback: Math.max(2, Math.round(Number(params.volume_lookback ?? 20))),
        regime_threshold: Number(params.regime_threshold ?? 0),
    };
}

export const volume_roc_regime_router: Strategy = {
    name: "Volume ROC Regime Router",
    description:
        "Routes rising volume to median trend alignment and falling volume to value-boundary reversion.",
    defaultParams: {
        volume_lookback: 20,
        regime_threshold: 0,
    },
    paramLabels: {
        volume_lookback: "Volume Lookback",
        regime_threshold: "Regime Threshold",
    },
    normalizeParams: normalizeVolumeRocRegimeRouterParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeRocRegimeRouterParams(params);
        const lookback = p.volume_lookback as number;
        const threshold = p.regime_threshold as number;
        if (cleanData.length < lookback * 2) return [];

        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const median = buildRollingMedian(closes, lookback);
        const volumeRoc = buildRateOfChange(volumes, lookback);
        const cmf = calculateCMF(getHighs(cleanData), getLows(cleanData), closes, volumes, lookback);
        const absoluteDistance = closes.map((close, i) => {
            const med = median[i];
            return med === null ? 0 : Math.abs(close - med);
        });
        const averageDistance = buildRollingAverage(absoluteDistance, lookback);

        return createSignalLoop(cleanData, [volumeRoc, median, cmf, averageDistance], (i) => {
            const volRate = volumeRoc[i];
            const med = median[i];
            const flow = cmf[i];
            const avgDistance = averageDistance[i];
            if (volRate === null || med === null || flow === null || avgDistance === null || avgDistance <= 0) return null;

            if (volRate > threshold) {
                if (closes[i] > med && flow >= 0) {
                    return createBuySignal(cleanData, i, `Rising volume trend long ROC ${volRate.toFixed(2)}`);
                }
                if (closes[i] < med && flow <= 0) {
                    return createSellSignal(cleanData, i, `Rising volume trend short ROC ${volRate.toFixed(2)}`);
                }
                return null;
            }

            if (closes[i] <= med - avgDistance) {
                return createBuySignal(cleanData, i, `Falling volume lower value reversion ROC ${volRate.toFixed(2)}`);
            }
            if (closes[i] >= med + avgDistance) {
                return createSellSignal(cleanData, i, `Falling volume upper value reversion ROC ${volRate.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volume_lookback", "regime_threshold"],
    },
};
