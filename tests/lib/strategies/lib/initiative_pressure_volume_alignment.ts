import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import {
    buildInitiativePressureSeries,
    buildRollingAverage,
} from "./price-action-frequency-core";
import { buildPercentileRank, extractBarMetricSeries } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 30))),
        pressureThreshold: Math.max(0.5, Math.min(1.0, Number(params.pressureThreshold ?? 0.60))),
        volThreshold: Math.max(0, Math.min(1, Number(params.volThreshold ?? 0.70))),
    };
}

export const initiative_pressure_volume_alignment: Strategy = {
    name: "Initiative Pressure Volume Alignment",
    description: "Follows ratio momentum when initiative pressure and return direction align under volume support.",
    defaultParams: {
        lookback: 30,
        pressureThreshold: 0.60,
        volThreshold: 0.70,
    },
    paramLabels: {
        lookback: "Lookback Window",
        pressureThreshold: "Pressure Threshold",
        volThreshold: "Volume Percentile Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const pressure = buildInitiativePressureSeries(cleanData, lookback);
        const pressureNumbers = pressure.map((v) => (v !== null ? v : 0));
        const smoothedPressure = buildRollingAverage(pressureNumbers, lookback);

        const volumes = getVolumes(cleanData);
        const volPercentile = buildPercentileRank(volumes, lookback);

        const returns = extractBarMetricSeries(cleanData, "closeReturn");

        return createSignalLoop(cleanData, [smoothedPressure, volPercentile], (i) => {
            const sp = smoothedPressure[i];
            const vp = volPercentile[i];
            if (sp === null || vp === null) return null;

            const ret = returns[i];
            // Normalize initiative pressure average from [-3, 3] range to [0, 1] range
            const normSp = (sp + 3) / 6;

            if (vp > p.volThreshold) {
                // Buy: high initiative pressure and positive return
                if (normSp > p.pressureThreshold && ret > 0) {
                    return createBuySignal(cleanData, i, `Initiative pressure buy: pressure avg ${normSp.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
                // Sell: low initiative pressure and negative return
                if (normSp < (1 - p.pressureThreshold) && ret < 0) {
                    return createSellSignal(cleanData, i, `Initiative pressure sell: pressure avg ${normSp.toFixed(2)}, vol rank ${vp.toFixed(2)}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pressureThreshold", "volThreshold"],
    },
};
