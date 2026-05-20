import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";
import { buildSweepReclaimSeries } from "./polymarket-1s-strategy-utils";

function normalizeSweepReclaimEfficiencyReactionLagParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 20, 2),
        reclaimThreshold: normalizeNumberParam(params.reclaimThreshold, 0.70, 0, 1),
        minEfficiency: normalizeNumberParam(params.minEfficiency, 0.40, 0, 1),
    };
}

export const sweep_reclaim_efficiency_reaction_lag: Strategy = {
    name: "Sweep Reclaim Efficiency Reaction Lag",
    description: "Trades efficient Binance sweep-reclaims only when Polymarket lags the same-side reclaim impulse.",
    defaultParams: {
        lookback: 20,
        reclaimThreshold: 0.70,
        minEfficiency: 0.40,
    },
    paramLabels: {
        lookback: "Lookback",
        reclaimThreshold: "Reclaim Threshold",
        minEfficiency: "Minimum Efficiency Ratio",
    },
    normalizeParams: normalizeSweepReclaimEfficiencyReactionLagParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeSweepReclaimEfficiencyReactionLagParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + 2) return [];

        const reclaim = buildSweepReclaimSeries(cleanData, lookback);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback });
        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [efficiency, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < lookback) return null;
            if ((efficiency[i] ?? -Infinity) <= p.minEfficiency) return null;

            if (reclaim[i] >= p.reclaimThreshold && (reaction.longLagEdge[i] ?? -Infinity) >= 0.01) {
                return createBuySignal(cleanData, i, "Efficient bullish sweep reclaim with long reaction lag");
            }
            if (reclaim[i] <= -p.reclaimThreshold && (reaction.shortLagEdge[i] ?? -Infinity) >= 0.01) {
                return createSellSignal(cleanData, i, "Efficient bearish sweep reclaim with short reaction lag");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "reclaimThreshold", "minEfficiency"],
    },
};
