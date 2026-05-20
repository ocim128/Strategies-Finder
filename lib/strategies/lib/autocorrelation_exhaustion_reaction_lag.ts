import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation } from "./price-action-statistics-core";
import { calculateEMA } from "../indicators";
import { buildPolymarket1sReactionGap } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        autocorrDrop: Math.max(0.01, Number(params.autocorrDrop ?? 0.40)),
        lagSec: Math.max(1, Math.round(Number(params.lagSec ?? 4))),
    };
}

export const autocorrelation_exhaustion_reaction_lag: Strategy = {
    name: "Autocorrelation Exhaustion Reaction Lag",
    description: "Fades highly persistent trend regimes on Binance that show structural exhaustion, entering mean reversions when Polymarket reaction lag shows the contract is slow to adjust to the trend break.",
    defaultParams: {
        lookback: 30,
        autocorrDrop: 0.40,
        lagSec: 4,
    },
    paramLabels: {
        lookback: "Autocorrelation Lookback",
        autocorrDrop: "Required Autocorr Drop",
        lagSec: "Reaction Lag Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const autocorrDrop = p.autocorrDrop as number;
        const lagSec = p.lagSec as number;

        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const autocorr = buildRollingAutoCorrelation(closes, lookback, 1);
        const ema = calculateEMA(closes, 10);

        const reaction = buildPolymarket1sReactionGap(cleanData, context, { volLookback: lookback, lagSec });

        if (!reaction.available) return [];

        return createSignalLoop(cleanData, [autocorr, ema, reaction.longLagEdge, reaction.shortLagEdge], (i) => {
            if (i < 1) return null;

            const prevAutocorr = autocorr[i - 1];
            const currentAutocorr = autocorr[i];

            const prevClose = cleanData[i - 1].close;
            const currentClose = cleanData[i].close;
            const prevEma = ema[i - 1];
            const currentEma = ema[i];

            const longLagEdge = reaction.longLagEdge[i];
            const shortLagEdge = reaction.shortLagEdge[i];

            if (
                prevAutocorr === null || currentAutocorr === null ||
                prevEma === null || currentEma === null ||
                longLagEdge === null || shortLagEdge === null
            ) return null;

            const drop = prevAutocorr - currentAutocorr;

            // Buy: sharp drop in autocorrelation, close crosses above fast EMA baseline, and positive lag edge
            if (drop >= autocorrDrop && prevClose < prevEma && currentClose >= currentEma && longLagEdge >= 0.01) {
                return createBuySignal(cleanData, i, `Trend autocorrelation drop ${drop.toFixed(2)} with upward EMA reclaim and lag edge ${longLagEdge.toFixed(3)}`);
            }

            // Sell: sharp drop in autocorrelation, close crosses below fast EMA baseline, and positive lag edge
            if (drop >= autocorrDrop && prevClose > prevEma && currentClose <= currentEma && shortLagEdge >= 0.01) {
                return createSellSignal(cleanData, i, `Trend autocorrelation drop ${drop.toFixed(2)} with downward EMA reclaim and lag edge ${shortLagEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autocorrDrop", "lagSec"],
    },
};
