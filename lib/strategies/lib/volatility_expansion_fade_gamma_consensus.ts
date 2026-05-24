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
import { buildPolymarket1sGammaConsensusMask } from "./polymarket-1s-helpers";

// #COMPLETION_DRIVE: Assuming fast/slow ATR ratio spikes represent peak volatility expansion exhaustion
// #SUGGEST_VERIFY: Verify under test that the volatility ratio is calculated using slow lookback as 4 * lookback
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        volRatioThreshold: Math.max(0.1, Number(params.volRatioThreshold ?? 1.6)),
    };
}

export const volatility_expansion_fade_gamma_consensus: Strategy = {
    name: "Volatility Expansion Fade with Gamma Consensus",
    description: "Fades extreme boundary breaches on Binance during rapid volatility expansion spikes, using Gamma consensus to confirm backing by options market maker hedges.",
    defaultParams: {
        lookback: 30,
        volRatioThreshold: 1.6,
    },
    paramLabels: {
        lookback: "Volatility Lookback",
        volRatioThreshold: "Volatility Ratio Threshold",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const volRatioThreshold = p.volRatioThreshold as number;

        const slowLookback = lookback * 4;
        if (cleanData.length < slowLookback) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const typical = getTypicalPrices(cleanData);

        const median = buildRollingMedian(typical, lookback);
        const fastAtr = calculateATR(highs, lows, closes, lookback);
        const slowAtr = calculateATR(highs, lows, closes, slowLookback);

        const mask = buildPolymarket1sGammaConsensusMask(cleanData, context, { volLookback: lookback });

        if (!mask.available) return [];

        return createSignalLoop(
            cleanData,
            [median, fastAtr, slowAtr],
            (i) => {
                if (i < slowLookback) return null;

                const currentTypical = typical[i];
                const currentMedian = median[i];
                const fast = fastAtr[i];
                const slow = slowAtr[i];
                const longAllowed = mask.longAllowed[i];
                const shortAllowed = mask.shortAllowed[i];

                if (currentMedian === null || fast === null || slow === null || slow <= 0) return null;

                const ratio = fast / slow;
                if (ratio < volRatioThreshold) return null;

                const buyBound = currentMedian - 2.0 * fast;
                const sellBound = currentMedian + 2.0 * fast;

                // Buy YES: typical is below rolling median - 2.0 * ATR, ratio >= volRatioThreshold, longAllowed is true
                if (currentTypical < buyBound && longAllowed) {
                    return createBuySignal(
                        cleanData,
                        i,
                        `Vol expansion fade buy YES: ratio ${ratio.toFixed(2)} >= ${volRatioThreshold}, typical ${currentTypical.toFixed(2)} < bound ${buyBound.toFixed(2)}, Gamma consensus long allowed`
                    );
                }

                // Buy NO (expressed as Sell signal): typical is above rolling median + 2.0 * ATR, ratio >= volRatioThreshold, shortAllowed is true
                if (currentTypical > sellBound && shortAllowed) {
                    return createSellSignal(
                        cleanData,
                        i,
                        `Vol expansion fade buy NO: ratio ${ratio.toFixed(2)} >= ${volRatioThreshold}, typical ${currentTypical.toFixed(2)} > bound ${sellBound.toFixed(2)}, Gamma consensus short allowed`
                    );
                }

                return null;
            }
        );
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "volRatioThreshold"],
    },
};
