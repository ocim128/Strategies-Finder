import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const BODY_THRUST_Z = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(20, Math.round(Number(params.lookback ?? 60))),
    };
}

export const body_thrust_continuation: Strategy = {
    name: "Body Thrust Continuation",
    description: "Rides bars whose signed body share (body size times direction) is a statistical outlier.",
    defaultParams: {
        lookback: 60,
    },
    paramLabels: {
        lookback: "Body Thrust Window",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        // Signed body share in [-1, 1]; zero-range bars read 0.
        const signedShare = bodyPct.map((b, i) => (b === null ? 0 : b * (bodyDirection[i] ?? 0)));
        const thrustZ = buildRollingZScore(signedShare, lookback);

        return createSignalLoop(cleanData, [thrustZ], (i) => {
            const z = thrustZ[i];
            if (z === null) return null;

            if (z >= BODY_THRUST_Z) {
                return createBuySignal(cleanData, i, `Body thrust buy: signed body z ${z.toFixed(2)} (dominant up body)`);
            }
            if (z <= -BODY_THRUST_Z) {
                return createSellSignal(cleanData, i, `Body thrust sell: signed body z ${z.toFixed(2)} (dominant down body)`);
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
