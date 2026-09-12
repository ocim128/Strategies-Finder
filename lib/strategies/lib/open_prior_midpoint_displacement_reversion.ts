import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getHighs,
    getLows,
    getOpens,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildRollingZScore } from "./price-action-statistics-core";

const DISP_Z = 2.0;
const CL_MID = 0.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 24))),
    };
}

export const open_prior_midpoint_displacement_reversion: Strategy = {
    name: "Open Prior Midpoint Displacement Reversion",
    description: "Open location relative to prior bar center of gravity",
    defaultParams: {
        lookback: 24,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const opens = getOpens(cleanData);

        const midDisplacement = new Array<number>(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const priorRange = highs[i - 1] - lows[i - 1];
            if (priorRange > 0) {
                const priorMid = (highs[i - 1] + lows[i - 1]) / 2;
                midDisplacement[i] = (opens[i] - priorMid) / priorRange;
            }
        }

        const midDisplacementZ = buildRollingZScore(midDisplacement, lookback);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [midDisplacementZ], (i) => {
            const dz = midDisplacementZ[i];
            if (dz === null) return null;

            const cl = closeLocation[i];

            if (dz < -DISP_Z && cl > CL_MID) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Open-to-prior-midpoint displacement z ${dz.toFixed(2)} with top-half close CL ${cl.toFixed(2)}`
                );
            }
            if (dz > DISP_Z && cl < CL_MID) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Open-to-prior-midpoint displacement z ${dz.toFixed(2)} with bottom-half close CL ${cl.toFixed(2)}`
                );
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
