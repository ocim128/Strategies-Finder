import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildEfficiencyRatio, buildRollingMinMax } from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

function normalizeEfficiencyDecayReversionReactionAgreementParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: normalizeIntegerParam(params.lookback, 35, 5),
        maxEfficiency: normalizeNumberParam(params.maxEfficiency, 0.35, 0, 1),
        lagSec: normalizeIntegerParam(params.lagSec, 5, 1),
    };
}

export const efficiency_decay_reversion_reaction_agreement: Strategy = {
    name: "Efficiency Decay Reversion with Reaction Agreement",
    description: "Fades rolling typical-price boundaries when trend efficiency has decayed and the Polymarket reaction agreement mask permits the side.",
    defaultParams: {
        lookback: 35,
        maxEfficiency: 0.35,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        maxEfficiency: "Maximum Efficiency Ratio",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizeEfficiencyDecayReversionReactionAgreementParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeEfficiencyDecayReversionReactionAgreementParams(params);
        const lookback = p.lookback;
        if (cleanData.length < lookback + p.lagSec + 1) return [];

        const efficiency = buildEfficiencyRatio(cleanData, lookback);
        const typicals = getTypicalPrices(cleanData);
        const boundary = buildRollingMinMax(typicals, lookback);
        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, {
            volLookback: lookback,
            lagSec: p.lagSec,
        });
        if (!mask.available) return [];

        return createSignalLoop(cleanData, [efficiency, boundary.min, boundary.max], (i) => {
            const er = efficiency[i];
            const low = boundary.min[i];
            const high = boundary.max[i];
            if (er === null || low === null || high === null || er > p.maxEfficiency) return null;

            if (typicals[i] <= low && mask.longAllowed[i]) {
                return createBuySignal(cleanData, i, "Low-efficiency range boundary low with reaction agreement");
            }
            if (typicals[i] >= high && mask.shortAllowed[i]) {
                return createSellSignal(cleanData, i, "Low-efficiency range boundary high with reaction agreement");
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "maxEfficiency", "lagSec"],
    },
};
