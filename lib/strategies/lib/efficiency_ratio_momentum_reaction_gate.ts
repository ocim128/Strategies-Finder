import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRateOfChange } from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEfficiencyRatioMomentumReactionGateParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 30, 5),
        minEfficiency: normalizeNumberParam(params.minEfficiency, 0.6, 0, 1),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

export const efficiency_ratio_momentum_reaction_gate: Strategy = {
    name: "Efficiency Ratio Momentum with Reaction Gate",
    description: "Routes high-efficiency close momentum through Polymarket reaction agreement before entering either side.",
    defaultParams: {
        lookback: 30,
        minEfficiency: 0.6,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        minEfficiency: "Minimum Efficiency Ratio",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeEfficiencyRatioMomentumReactionGateParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyRatioMomentumReactionGateParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + p.lagSec + 1) return [];

        const closes = getCloses(cleanData);
        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const roc = buildRateOfChange(closes, lookback);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [efficiency, roc], (i) => {
            const er = efficiency[i];
            const change = roc[i];
            if (er === null || change === null || er < p.minEfficiency) return null;

            if (change > 0 && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "High-efficiency positive ROC with reaction agreement");
            }
            if (change < 0 && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "High-efficiency negative ROC with reaction agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEfficiency", "lagSec"],
    },
};
