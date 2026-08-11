import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildBodyPctSeries } from "./price-action-frequency-core";
import { buildRollingRobustZScore } from "./price-action-statistics-core";

const VOLUME_OUTLIER_Z = 2.0;
const BODY_CONVICTION = 0.6;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.round(Number(params.lookback ?? 30))),
    };
}

export const robust_volume_conviction_follow: Strategy = {
    name: "Robust Volume Conviction Follow",
    description: "Follows robust median/MAD volume outliers when the bar carries a large directional body: outlier participation as conviction.",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Volume Outlier Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const volumeZ = buildRollingRobustZScore(getVolumes(cleanData), lookback);
        const bodyPct = buildBodyPctSeries(cleanData);

        return createSignalLoop(cleanData, [volumeZ, bodyPct], (i) => {
            const z = volumeZ[i];
            const body = bodyPct[i];
            if (z === null || body === null) return null;

            if (z > VOLUME_OUTLIER_Z && body >= BODY_CONVICTION && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Robust volume conviction buy: vol z ${z.toFixed(2)} with body ${body.toFixed(2)}`);
            }
            if (z > VOLUME_OUTLIER_Z && body >= BODY_CONVICTION && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Robust volume conviction sell: vol z ${z.toFixed(2)} with body ${body.toFixed(2)}`);
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
