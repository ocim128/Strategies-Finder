import type { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";
import { normalizeNumberParam } from "./range-conviction-core";

const VOL_LOOKBACK = 45;
const MAX_QUOTE_AGE_SEC = 1;
const MIN_SECONDS_TO_EVENT_END = 180;

function normalizePolymarketFairValueMispricingParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        minEdgeCents: normalizeNumberParam(params.minEdgeCents, 3, 0, 99),
    };
}

export const polymarket_fair_value_mispricing: Strategy = {
    name: "Polymarket Fair Value Mispricing",
    description: "Buys the Polymarket YES or NO side when its executable ask is below a Binance-implied fair probability estimate.",
    defaultParams: {
        minEdgeCents: 3,
    },
    paramLabels: {
        minEdgeCents: "Minimum Edge (cents)",
    },
    normalizeParams: normalizePolymarketFairValueMispricingParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizePolymarketFairValueMispricingParams(params);
        if (cleanData.length < VOL_LOOKBACK + 1) return [];

        const helperOptions = {
            volLookback: VOL_LOOKBACK,
            maxQuoteAgeSec: MAX_QUOTE_AGE_SEC,
        };
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, helperOptions);
        if (!edge.available) return [];

        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            ...helperOptions,
            minSecondsRemaining: MIN_SECONDS_TO_EVENT_END,
        });
        if (!actionability.available) return [];

        const minEdge = p.minEdgeCents / 100;

        return createSignalLoop(cleanData, [], (i) => {
            const yesEdge = actionability.yesActionable[i] ? edge.buyYesEdge[i] : null;
            const noEdge = actionability.noActionable[i] ? edge.buyNoEdge[i] : null;
            const yesAllowed = yesEdge !== null && yesEdge >= minEdge;
            const noAllowed = noEdge !== null && noEdge >= minEdge;

            if (yesAllowed && (!noAllowed || yesEdge >= noEdge)) {
                return createBuySignal(cleanData, i, `YES ask under fair value by ${(yesEdge * 100).toFixed(1)}c`);
            }
            if (noAllowed && noEdge !== null) {
                return createSellSignal(cleanData, i, `NO ask under fair value by ${(noEdge * 100).toFixed(1)}c`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["minEdgeCents"],
    },
};
