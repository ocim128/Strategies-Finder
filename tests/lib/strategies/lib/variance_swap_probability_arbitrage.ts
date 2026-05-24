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
import { buildPolymarket1sActionabilityMask, buildPolymarket1sExecutableEdge } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming volRatioMax threshold indicates a sudden realized volatility collapse relative to slow baseline
// #SUGGEST_VERIFY: Validate under test that ratio calculation handles identical ATR values gracefully without NaN
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
        volRatioMax: Math.max(0.01, Math.min(2.0, Number(params.volRatioMax ?? 0.65))),
        minEdge: Math.max(0.0, Number(params.minEdge ?? 0.02)),
    };
}

export const variance_swap_probability_arbitrage: Strategy = {
    name: "Variance Swap Probability Arbitrage",
    description: "Exploits discrepancy between realized Binance high-frequency volatility and the priced implied volatility of Polymarket contracts, entering when a rapid drop in realized volatility makes boundary breaches mathematically highly improbable.",
    defaultParams: {
        lookback: 20,
        volRatioMax: 0.65,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Volatility Lookback",
        volRatioMax: "Volatility Ratio Max",
        minEdge: "Minimum Edge Magnitude",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const volRatioMax = p.volRatioMax as number;
        const minEdge = p.minEdge as number;

        const slowLookback = lookback * 4;
        if (cleanData.length < slowLookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const typical = getTypicalPrices(cleanData);
        const typicalMedian = buildRollingMedian(typical, lookback);

        const fastAtr = calculateATR(highs, lows, closes, lookback);
        const slowAtr = calculateATR(highs, lows, closes, slowLookback);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, { volLookback: lookback });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(
            cleanData,
            [typicalMedian, fastAtr, slowAtr, edge.buyYesEdge, edge.buyNoEdge],
            (i) => {
                if (i < slowLookback) return null;

                const currentTypical = typical[i];
                const currentMedian = typicalMedian[i];
                const fast = fastAtr[i];
                const slow = slowAtr[i];
                const buyYesEdge = edge.buyYesEdge[i];
                const buyNoEdge = edge.buyNoEdge[i];
                const yesActionable = actionability.yesActionable[i];
                const noActionable = actionability.noActionable[i];

                if (
                    currentMedian === null ||
                    fast === null ||
                    slow === null ||
                    buyYesEdge === null ||
                    buyNoEdge === null ||
                    slow <= 0
                ) {
                    return null;
                }

                const ratio = fast / slow;
                if (ratio > volRatioMax) return null;

                // YES buy: Typical price above median, yes actionable, buyYesEdge >= minEdge
                if (currentTypical > currentMedian && yesActionable && buyYesEdge >= minEdge) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Vol ratio ${ratio.toFixed(3)} typical > median, YES actionable with edge ${buyYesEdge.toFixed(3)}`
                    );
                }

                // NO buy (expressed as Sell signal): Typical price below median, no actionable, buyNoEdge >= minEdge
                if (currentTypical < currentMedian && noActionable && buyNoEdge >= minEdge) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Vol ratio ${ratio.toFixed(3)} typical < median, NO actionable with edge ${buyNoEdge.toFixed(3)}`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volRatioMax", "minEdge"],
    },
};
