import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import {
    extractBarMetricSeries,
    buildRollingRobustZScore,
} from "./price-action-statistics-core";

function normalizeVolumeProxyRobustZExhaustionParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 40))),
    };
}

export const volume_proxy_robust_z_exhaustion: Strategy = {
    name: "Volume Proxy Robust Z Exhaustion",
    description: "Fades extreme MAD-robust volume-proxy spikes that close against their own bar direction.",
    defaultParams: {
        lookback: 40,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams: normalizeVolumeProxyRobustZExhaustionParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeProxyRobustZExhaustionParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const volumes = getVolumes(cleanData);
        const volZ = buildRollingRobustZScore(volumes, lookback);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [volZ], (i) => {
            if (i < lookback) return null;
            const z = volZ[i];
            if (z === null) return null;

            if (z > 3.0 && bodyDirection[i] < 0 && closeLocation[i] > 0.6) {
                return createBuySignal(cleanData, i, `Volume proxy robust z ${z.toFixed(2)} on a down bar absorbed at close location ${closeLocation[i].toFixed(2)}`);
            }
            if (z > 3.0 && bodyDirection[i] > 0 && closeLocation[i] < 0.4) {
                return createSellSignal(cleanData, i, `Volume proxy robust z ${z.toFixed(2)} on an up bar absorbed at close location ${closeLocation[i].toFixed(2)}`);
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
