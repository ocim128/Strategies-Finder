import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

function normalizeMidpointGravityFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        dev_z_threshold: Math.max(0, Number(params.dev_z_threshold ?? 2.0)),
        vol_z_min: Number(params.vol_z_min ?? 1.0)
    };
}

export const midpoint_gravity_fade: Strategy = {
    name: "Midpoint Gravity Fade",
    description: "Extreme deviations of the close from the midpoint on high volume quickly revert.",
    defaultParams: {
        dev_z_threshold: 2.0,
        vol_z_min: 1.0
    },
    paramLabels: {
        dev_z_threshold: "Midpoint Deviation Z-Score Threshold",
        vol_z_min: "Minimum Volume Z-Score"
    },
    normalizeParams: normalizeMidpointGravityFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeMidpointGravityFadeParams(params);
        if (cleanData.length < 20) return [];

        const devSeries = extractBarMetricSeries(cleanData, 'closeMidpointDev');
        const absDevSeries = devSeries.map(Math.abs);
        const devZScore = buildRollingZScore(absDevSeries, 20);

        const vols = getVolumes(cleanData);
        const volZScore = buildRollingZScore(vols, 20);

        return createSignalLoop(cleanData, [devZScore, volZScore], (i) => {
            if (i < 20) return null;
            const dZ = devZScore[i];
            const vZ = volZScore[i];
            if (dZ === null || vZ === null) return null;

            const dev = devSeries[i];
            const isBelowMidpoint = dev < 0;
            const isAboveMidpoint = dev > 0;
            const devThresh = p.dev_z_threshold as number;
            const volMin = p.vol_z_min as number;

            if (vZ > volMin && isBelowMidpoint && dZ > devThresh) {
                return createBuySignal(cleanData, i, `Close below midpoint, dev Z > ${devThresh}, vol Z > ${volMin}`);
            }
            if (vZ > volMin && isAboveMidpoint && dZ > devThresh) {
                return createSellSignal(cleanData, i, `Close above midpoint, dev Z > ${devThresh}, vol Z > ${volMin}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["dev_z_threshold", "vol_z_min"]
    }
};
