import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import {
    buildPolymarket1sPressureGap,
    buildPolymarket1sReactionGap,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEventOpenAccelerationReactionGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 50, 5),
        rocLookback: normalizeIntegerParam(params.rocLookback, 8, 1),
        minLag: normalizeNumberParam(params.minLag, 0.02, 0),
    };
}

export const event_open_acceleration_reaction_gap: Strategy = {
    name: "Event Open Acceleration with Reaction Gap",
    description: "Trades z-scored event-open distance acceleration only when Polymarket reaction lag leaves a same-side edge.",
    defaultParams: {
        volLookback: 50,
        rocLookback: 8,
        minLag: 0.02,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        rocLookback: "Distance ROC Lookback",
        minLag: "Minimum Lag Edge",
    },
    normalizeParams: normalizeEventOpenAccelerationReactionGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenAccelerationReactionGapParams(params);
        if (cleanData.length < p.volLookback + p.rocLookback + 1) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: p.volLookback });
        if (!pressure.available) return [];
        const reaction = buildPolymarket1sReactionGap(cleanData, context, {
            volLookback: p.volLookback,
            lagSec: p.rocLookback,
        });
        if (!reaction.available) return [];

        const velocity: number[] = new Array(cleanData.length).fill(0);
        for (let i = p.rocLookback; i < cleanData.length; i++) {
            const currentDistance = pressure.distanceZ[i];
            const previousDistance = pressure.distanceZ[i - p.rocLookback];
            if (currentDistance === null || previousDistance === null) continue;
            velocity[i] = currentDistance - previousDistance;
        }
        const accelerationScore = buildRollingZScore(velocity, p.volLookback);

        return createSignalLoop(cleanData, [accelerationScore], (i) => {
            const score = accelerationScore[i];
            if (
                score === null
                || pressure.distanceZ[i] === null
                || i < p.rocLookback
                || pressure.distanceZ[i - p.rocLookback] === null
            ) return null;

            if (score >= 1.5 && (reaction.longLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createBuySignal(cleanData, i, "Positive event-open acceleration with YES reaction lag edge");
            }
            if (score <= -1.5 && (reaction.shortLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createSellSignal(cleanData, i, "Negative event-open acceleration with NO reaction lag edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "rocLookback", "minLag"],
    },
};
