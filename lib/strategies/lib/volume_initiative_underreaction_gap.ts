import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildInitiativePressureSeries, buildRollingAverage } from "./price-action-frequency-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const INITIATIVE_PRESSURE_THRESHOLD = 0.5;

function normalizeVolumeInitiativeUnderreactionGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
        minLag: normalizeNumberParam(params.minLag, 0.02, 0),
    };
}

export const volume_initiative_underreaction_gap: Strategy = {
    name: "Volume Initiative with Underreaction Gap",
    description: "Trades sustained volume-weighted initiative pressure only when Polymarket has underreacted over the configured lag.",
    defaultParams: {
        lookback: 20,
        lagSec: 5,
        minLag: 0.02,
    },
    paramLabels: {
        lookback: "Lookback",
        lagSec: "Reaction Lag Seconds",
        minLag: "Minimum Lag Edge",
    },
    normalizeParams: normalizeVolumeInitiativeUnderreactionGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeVolumeInitiativeUnderreactionGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + p.lagSec + 1) return [];

        const initiative = buildInitiativePressureSeries(cleanData, lookback);
        const cumulativeInitiative = buildRollingAverage(initiative.map((value) => value ?? 0), lookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [initiative, cumulativeInitiative, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            const pressure = cumulativeInitiative[i];
            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];
            if (pressure === null || longLagEdge === null || shortLagEdge === null) return null;

            if (pressure >= INITIATIVE_PRESSURE_THRESHOLD && longLagEdge >= p.minLag) {
                return createBuySignal(cleanData, i, "Positive initiative pressure with YES underreaction gap");
            }
            if (pressure <= -INITIATIVE_PRESSURE_THRESHOLD && shortLagEdge >= p.minLag) {
                return createSellSignal(cleanData, i, "Negative initiative pressure with NO underreaction gap");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "lagSec", "minLag"],
    },
};
