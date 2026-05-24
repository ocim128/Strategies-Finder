import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getTypicalPrices,
} from "../strategy-helpers";
import { calculateATR } from "../indicators";
import { buildRollingMedian } from "./price-action-statistics-core";
import { buildPolymarket1sReactionAgreementMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming volRatioMin threshold indicates a sudden transition from low to high volatility
// #SUGGEST_VERIFY: Verify the breakout from typical median identifies emerging momentum correctly
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        volRatioMin: Math.max(0.1, Number(params.volRatioMin ?? 1.5)),
        lagSec: Math.max(1, Math.round(Number(params.lagSec ?? 5))),
    };
}

export const regime_shift_reaction_arbitrage: Strategy = {
    name: "Regime Shift Reaction Arbitrage",
    description: "Arbitrages Polymarket's delay in pricing rapid shifts in the binomial probability model's step size, caused by sudden transitions from low to high volatility on Binance.",
    defaultParams: {
        lookback: 30,
        volRatioMin: 1.5,
        lagSec: 5,
    },
    paramLabels: {
        lookback: "Volatility Lookback",
        volRatioMin: "Volatility Ratio Min",
        lagSec: "Lag Seconds",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const volRatioMin = p.volRatioMin as number;
        const lagSec = p.lagSec as number;

        const slowLookback = lookback * 4;
        if (cleanData.length < slowLookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const typicalMedian = buildRollingMedian(typical, lookback);
        const fastAtr = calculateATR(highs, lows, closes, lookback);
        const slowAtr = calculateATR(highs, lows, closes, slowLookback);

        const mask = buildPolymarket1sReactionAgreementMask(cleanData, context, { volLookback: lookback, lagSec });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [typicalMedian, fastAtr, slowAtr],
            (i) => {
                if (i < slowLookback + 1) return null;

                const currentTypical = typical[i];
                const prevTypical = typical[i - 1];
                const currentMedian = typicalMedian[i];
                const prevMedian = typicalMedian[i - 1];

                const fast = fastAtr[i];
                const slow = slowAtr[i];
                const longAllowed = mask.longAllowed[i];
                const shortAllowed = mask.shortAllowed[i];

                if (
                    currentMedian === null ||
                    prevMedian === null ||
                    fast === null ||
                    slow === null ||
                    slow <= 0
                ) {
                    return null;
                }

                const ratio = fast / slow;
                if (ratio < volRatioMin) return null;

                const crossAbove = prevTypical <= prevMedian && currentTypical > currentMedian;
                const crossBelow = prevTypical >= prevMedian && currentTypical < currentMedian;

                // Buy YES: typical price breaks above median, fast/slow ATR ratio >= volRatioMin, and longAllowed is true
                if (crossAbove && longAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Regime shift buy YES: ratio ${ratio.toFixed(2)} >= ${volRatioMin}, typical crossed above median, lag agreement allowed`
                    );
                }

                // Buy NO (expressed as Sell signal): typical price breaks below median, fast/slow ATR ratio >= volRatioMin, and shortAllowed is true
                if (crossBelow && shortAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Regime shift buy NO: ratio ${ratio.toFixed(2)} >= ${volRatioMin}, typical crossed below median, lag agreement allowed`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volRatioMin", "lagSec"],
    },
};
