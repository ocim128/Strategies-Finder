import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getTypicalPrices,
} from "../strategy-helpers";
import { buildPercentileRank } from "./price-action-statistics-core";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming typical price rolling percentile rank maps distribution tail extremes
// #SUGGEST_VERIFY: Verify pctExtreme correctly scales bottom/top extremes (e.g. <= pctExtreme or >= 1 - pctExtreme)
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 35))),
        pctExtreme: Math.max(0.01, Math.min(0.49, Number(params.pctExtreme ?? 0.10))),
        lagSec: Math.max(1, Math.round(Number(params.lagSec ?? 5))),
        minLag: Math.max(0.0, Number(params.minLag ?? 0.015)),
    };
}

export const percentile_extremes_reaction_gap_reversal: Strategy = {
    name: "Percentile Extremes Reversal with Reaction Gap",
    description: "Fades typical price distribution tails on Binance, capitalizing on a lagging Polymarket market maker reaction gap to secure underpriced execution.",
    defaultParams: {
        lookback: 35,
        pctExtreme: 0.10,
        lagSec: 5,
        minLag: 0.015,
    },
    paramLabels: {
        lookback: "Percentile Lookback",
        pctExtreme: "Percentile Extreme",
        lagSec: "Lag Seconds",
        minLag: "Minimum Lag Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const pctExtreme = p.pctExtreme as number;
        const lagSec = p.lagSec as number;
        const minLag = p.minLag as number;

        if (cleanData.length < lookback) return [];

        const typical = getTypicalPrices(cleanData);
        const percentile = buildPercentileRank(typical, lookback);
        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback, lagSec });

        if (!reaction.available) return [];

        return createSignalLoop(
            cleanData,
            [percentile, reaction.longLagEdge, reaction.shortLagEdge],
            (i) => {
                if (i < lookback) return null;

                const pct = percentile[i];
                const longLagEdge = reaction.longLagEdge[i];
                const shortLagEdge = reaction.shortLagEdge[i];

                if (pct === null || longLagEdge === null || shortLagEdge === null) return null;

                // Buy YES: percentile rank <= pctExtreme and longLagEdge >= minLag
                if (pct <= pctExtreme && longLagEdge >= minLag) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Percentile oversold buy YES: percentile ${pct.toFixed(3)} <= ${pctExtreme}, edge ${longLagEdge.toFixed(3)}`
                    );
                }

                // Buy NO (expressed as Sell signal): percentile rank >= 1 - pctExtreme and shortLagEdge >= minLag
                if (pct >= (1 - pctExtreme) && shortLagEdge >= minLag) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Percentile overbought buy NO: percentile ${pct.toFixed(3)} >= ${(1 - pctExtreme)}, edge ${shortLagEdge.toFixed(3)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "pctExtreme", "lagSec", "minLag"],
    },
};
