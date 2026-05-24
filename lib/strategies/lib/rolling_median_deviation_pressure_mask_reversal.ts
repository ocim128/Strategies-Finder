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
import { buildPolymarket1sPressureAgreementMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming rolling typical price median and ATR serve as stable reverting anchors
// #SUGGEST_VERIFY: Verify that the binary pressure agreement mask successfully gates trend extensions
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        atrMultiplier: Math.max(0.1, Number(params.atrMultiplier ?? 2.0)),
    };
}

export const rolling_median_deviation_pressure_mask_reversal: Strategy = {
    name: "Rolling Median Deviation Reversal with Pressure Agreement",
    description: "Fades extreme deviations from the rolling typical price median on Binance, gating execution with the binary Polymarket pressure agreement mask to prevent trading against severe order book pressure.",
    defaultParams: {
        lookback: 30,
        atrMultiplier: 2.0,
    },
    paramLabels: {
        lookback: "Median & ATR Lookback",
        atrMultiplier: "ATR Multiplier",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const atrMultiplier = p.atrMultiplier as number;

        if (cleanData.length < lookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const median = buildRollingMedian(typical, lookback);
        const atr = calculateATR(highs, lows, closes, lookback);
        const mask = buildPolymarket1sPressureAgreementMask(cleanData, context, { volLookback: lookback });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [median, atr],
            (i) => {
                if (i < lookback) return null;

                const currentTypical = typical[i];
                const currentMedian = median[i];
                const currentAtr = atr[i];
                const longAllowed = mask.longAllowed[i];
                const shortAllowed = mask.shortAllowed[i];

                if (currentMedian === null || currentAtr === null) return null;

                const buyBound = currentMedian - atrMultiplier * currentAtr;
                const sellBound = currentMedian + atrMultiplier * currentAtr;

                // Buy YES: typical < median - multiplier * ATR, and longAllowed is true
                if (currentTypical < buyBound && longAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Median reversal buy YES: typical ${currentTypical.toFixed(2)} < bound ${buyBound.toFixed(2)}, YES allowed`
                    );
                }

                // Buy NO (expressed as Sell signal): typical > median + multiplier * ATR, and shortAllowed is true
                if (currentTypical > sellBound && shortAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Median reversal buy NO: typical ${currentTypical.toFixed(2)} > bound ${sellBound.toFixed(2)}, NO allowed`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "atrMultiplier"],
    },
};
