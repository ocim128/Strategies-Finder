import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import { calculateCMF } from "../indicators";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from "../strategy-helpers";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeChaikinMoneyFlowReactionGapParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 5),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
        cmfThreshold: normalizeNumberParam(params.cmfThreshold, 0.25, 0, 1),
        minLag: normalizeNumberParam(params.minLag, 0.015, 0),
    };
}

export const chaikin_money_flow_reaction_gap: Strategy = {
    name: "Chaikin Money Flow with Reaction Gap",
    description: "Trades persistent Chaikin money flow only when Polymarket reaction lag leaves a same-side edge.",
    defaultParams: {
        lookback: 20,
        lagSec: 5,
        cmfThreshold: 0.25,
        minLag: 0.015,
    },
    paramLabels: {
        lookback: "CMF Lookback",
        lagSec: "Reaction Lag Seconds",
        cmfThreshold: "CMF Threshold",
        minLag: "Minimum Lag Edge",
    },
    normalizeParams: normalizeChaikinMoneyFlowReactionGapParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeChaikinMoneyFlowReactionGapParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + p.lagSec + 1) return [];

        const cmf = calculateCMF(
            getHighs(cleanData),
            getLows(cleanData),
            getCloses(cleanData),
            getVolumes(cleanData),
            lookback
        );
        const reaction = buildPolymarket1sReactionGap(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [cmf], (i) => {
            const flow = cmf[i];
            if (flow === null) return null;

            if (flow >= p.cmfThreshold && (reaction.longLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createBuySignal(cleanData, i, "Chaikin money flow accumulation with YES reaction lag edge");
            }
            if (flow <= -p.cmfThreshold && (reaction.shortLagEdge[i] ?? -Infinity) >= p.minLag) {
                return createSellSignal(cleanData, i, "Chaikin money flow distribution with NO reaction lag edge");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "lagSec", "cmfThreshold", "minLag"],
    },
};
