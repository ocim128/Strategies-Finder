import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingZScore } from "./price-action-statistics-core";
import {
    buildPolymarket1sPressureGap,
    buildPolymarket1sReactionGap,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEventOpenVolumeAccumulationReactionGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        volLookback: normalizeIntegerParam(params.volLookback, 50, 5),
        impulseThreshold: normalizeNumberParam(params.impulseThreshold, 1.3, 0),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
        minLag: normalizeNumberParam(params.minLag, 0.02, 0),
    };
}

export const event_open_volume_accumulation_reaction_gap: Strategy = {
    name: "Event Open Volume Accumulation with Reaction Gap",
    description: "Trades volume-weighted event-open distance impulses only when Polymarket reaction lag leaves a same-side edge.",
    defaultParams: {
        volLookback: 50,
        impulseThreshold: 1.3,
        lagSec: 5,
        minLag: 0.02,
    },
    paramLabels: {
        volLookback: "Volatility Lookback",
        impulseThreshold: "Impulse Z-Score Threshold",
        lagSec: "Reaction Lag Seconds",
        minLag: "Minimum Lag Edge",
    },
    normalizeParams: normalizeEventOpenVolumeAccumulationReactionGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEventOpenVolumeAccumulationReactionGapParams(params);
        if (cleanData.length < p.volLookback + p.lagSec + 1) return [];

        const pressure = buildPolymarket1sPressureGap(cleanData, context, { volLookback: p.volLookback });
        if (!pressure.available) return [];
        const reaction = buildPolymarket1sReactionGap(cleanData, context, {
            volLookback: p.volLookback,
            lagSec: p.lagSec,
        });
        if (!reaction.available) return [];

        const volumeZ = buildRollingZScore(getVolumes(cleanData), p.volLookback);
        const impulse: number[] = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const current = pressure.distanceZ[i];
            const previous = pressure.distanceZ[i - 1];
            if (current === null || previous === null) continue;
            impulse[i] = (current - previous) * (1 + Math.max(0, volumeZ[i] ?? 0));
        }
        const impulseZ = buildRollingZScore(impulse, p.volLookback);

        return createSignalLoop(cleanData, [impulseZ], (i) => {
            const score = impulseZ[i];
            if (score === null || pressure.distanceZ[i] === null || pressure.distanceZ[i - 1] === null) return null;

            if (score >= p.impulseThreshold && (reaction.longLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createBuySignal(cleanData, i, "Volume-weighted event distance impulse with YES reaction lag edge");
            }
            if (score <= -p.impulseThreshold && (reaction.shortLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createSellSignal(cleanData, i, "Volume-weighted event distance impulse with NO reaction lag edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["volLookback", "impulseThreshold", "lagSec", "minLag"],
    },
};
