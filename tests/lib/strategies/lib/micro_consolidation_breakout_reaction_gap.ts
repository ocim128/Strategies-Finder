import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { extractBarMetricSeries } from "./price-action-frequency-core";
import { buildRollingMinMax, buildRollingZScore } from "./price-action-statistics-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeMicroConsolidationBreakoutReactionGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 40, 5),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
        minLag: normalizeNumberParam(params.minLag, 0.025, 0),
    };
}

export const micro_consolidation_breakout_reaction_gap: Strategy = {
    name: "Micro-Consolidation Breakout with Reaction Gap",
    description: "Trades breakouts from compressed true-range regimes only when Polymarket reaction lag leaves a same-side edge.",
    defaultParams: {
        lookback: 40,
        lagSec: 5,
        minLag: 0.025,
    },
    paramLabels: {
        lookback: "Lookback",
        lagSec: "Reaction Lag Seconds",
        minLag: "Minimum Lag Edge",
    },
    normalizeParams: normalizeMicroConsolidationBreakoutReactionGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeMicroConsolidationBreakoutReactionGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + p.lagSec + 1) return [];

        const closes = getCloses(cleanData);
        const trueRangeZ = buildRollingZScore(extractBarMetricSeries(cleanData, "trueRange"), lookback);
        const boundary = buildRollingMinMax(closes, lookback, false);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [trueRangeZ, boundary.min, boundary.max], (i) => {
            const previousRangeZ = trueRangeZ[i - 1];
            const high = boundary.max[i];
            const low = boundary.min[i];
            if (previousRangeZ === null || high === null || low === null || previousRangeZ > -1) return null;

            if (closes[i] > high && (reaction.longLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createBuySignal(cleanData, i, "Compressed true range broke above channel with YES reaction lag edge");
            }
            if (closes[i] < low && (reaction.shortLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createSellSignal(cleanData, i, "Compressed true range broke below channel with NO reaction lag edge");
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
