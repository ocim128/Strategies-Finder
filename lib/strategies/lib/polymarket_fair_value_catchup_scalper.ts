import type { Strategy, OHLCVData, Signal, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
    buildPolymarket1sReactionGap,
} from "./polymarket-1s-helpers";
import { normalizeIntegerParam, normalizeNumberParam } from "./range-conviction-core";

const VOL_LOOKBACK = 45;
const MAX_QUOTE_AGE_SEC = 1;
const MIN_SECONDS_TO_EVENT_END = 180;

type ActiveSide = "yes" | "no" | null;

function normalizePolymarketFairValueCatchupScalperParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        entryEdgeCents: normalizeNumberParam(params.entryEdgeCents, 3, 0, 99),
        exitEdgeCents: normalizeNumberParam(params.exitEdgeCents, 0, 0, 99),
        reactionLagSec: normalizeIntegerParam(params.reactionLagSec, 5, 1, 60),
    };
}

export const polymarket_fair_value_catchup_scalper: Strategy = {
    name: "Polymarket Fair Value Catch-Up Scalper",
    description: "Trades executable Polymarket fair-value gaps only when Binance-implied probability is moving faster than the market, then flips on opposite catch-up pressure.",
    defaultParams: {
        entryEdgeCents: 3,
        exitEdgeCents: 0,
        reactionLagSec: 5,
    },
    paramLabels: {
        entryEdgeCents: "Entry Edge (cents)",
        exitEdgeCents: "Exit Flip Edge (cents)",
        reactionLagSec: "Reaction Lag Seconds",
    },
    normalizeParams: normalizePolymarketFairValueCatchupScalperParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizePolymarketFairValueCatchupScalperParams(params);
        const reactionLagSec = p.reactionLagSec;
        if (cleanData.length < VOL_LOOKBACK + reactionLagSec + 1) return [];

        const helperOptions = {
            volLookback: VOL_LOOKBACK,
            maxQuoteAgeSec: MAX_QUOTE_AGE_SEC,
        };
        const reactionOptions = {
            ...helperOptions,
            lagSec: reactionLagSec,
        };
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, helperOptions);
        if (!edge.available) return [];
        const reaction = buildPolymarket1sReactionGap(cleanData, context, reactionOptions);
        if (!reaction.available) return [];
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, helperOptions);
        if (!actionability.available) return [];

        const entryEdge = p.entryEdgeCents / 100;
        const exitEdge = p.exitEdgeCents / 100;
        let activeSide: ActiveSide = null;
        let previousEventProgress: number | null = null;

        return createSignalLoop(cleanData, [], (i): Signal | null => {
            const eventProgress = edge.eventProgress[i];
            if (eventProgress !== null && previousEventProgress !== null && eventProgress < previousEventProgress) {
                activeSide = null;
            }
            if (eventProgress !== null) {
                previousEventProgress = eventProgress;
            }

            const secondsRemaining = edge.secondsRemaining[i];
            const entryWindowOpen = secondsRemaining !== null && secondsRemaining > MIN_SECONDS_TO_EVENT_END;
            const yesEdge = actionability.yesActionable[i] ? edge.buyYesEdge[i] : null;
            const noEdge = actionability.noActionable[i] ? edge.buyNoEdge[i] : null;
            const yesCatchup = (reaction.longLagEdge[i] ?? 0) > 0;
            const noCatchup = (reaction.shortLagEdge[i] ?? 0) > 0;

            const yesEntry = entryWindowOpen && yesEdge !== null && yesEdge >= entryEdge && yesCatchup;
            const noEntry = entryWindowOpen && noEdge !== null && noEdge >= entryEdge && noCatchup;
            const yesFlip = yesEdge !== null && yesEdge >= exitEdge && yesCatchup;
            const noFlip = noEdge !== null && noEdge >= exitEdge && noCatchup;

            if (activeSide === null) {
                if (yesEntry && (!noEntry || yesEdge >= noEdge)) {
                    activeSide = "yes";
                    return createBuySignal(cleanData, i, `YES catch-up edge ${(yesEdge * 100).toFixed(1)}c`);
                }
                if (noEntry && noEdge !== null) {
                    activeSide = "no";
                    return createSellSignal(cleanData, i, `NO catch-up edge ${(noEdge * 100).toFixed(1)}c`);
                }
                return null;
            }

            if (activeSide === "yes" && noFlip) {
                activeSide = "no";
                return createSellSignal(cleanData, i, `Flip to NO catch-up edge ${(noEdge! * 100).toFixed(1)}c`);
            }
            if (activeSide === "no" && yesFlip) {
                activeSide = "yes";
                return createBuySignal(cleanData, i, `Flip to YES catch-up edge ${(yesEdge! * 100).toFixed(1)}c`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["entryEdgeCents", "exitEdgeCents", "reactionLagSec"],
    },
};
