import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildTrailingHighLow, extractBarMetricSeries, buildRollingAverage } from "./price-action-frequency-core";

// #COMPLETION_DRIVE: Assuming low true range at boundary breakouts represents exhausted micro-moves.
// #SUGGEST_VERIFY: Verify rangeThreshold (<= 1.5) restricts breakouts to low range.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 30))),
        rangeThreshold: Math.max(0.1, Number(params.rangeThreshold ?? 0.8)),
    };
}

export const boundary_exhaustion_volatility_spread_fade: Strategy = {
    name: "Boundary Exhaustion Volatility Spread Fade",
    description: "Fades boundary breakouts when the true range of the breakout bar is below average, showing liquidity exhaustion.",
    defaultParams: {
        lookback: 30,
        rangeThreshold: 0.8,
    },
    paramLabels: {
        lookback: "Lookback",
        rangeThreshold: "Range Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const rangeThreshold = p.rangeThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        // IncludeCurrent = false to avoid look-ahead bias on boundaries
        const { highest, lowest } = buildTrailingHighLow(cleanData, lookback, false);
        const trueRange = extractBarMetricSeries(cleanData, "trueRange");
        const avgTrueRange = buildRollingAverage(trueRange, lookback);

        return createSignalLoop(cleanData, [highest, lowest, avgTrueRange], (i) => {
            const currentClose = closes[i];
            const currentHigh = highest[i];
            const currentLow = lowest[i];
            const tr = trueRange[i];
            const atr = avgTrueRange[i];

            if (currentHigh === null || currentLow === null || atr === null || atr <= 0) return null;

            // Buy: Close breaks below the trailing low boundary, but true range is small (exhausted seller pressure)
            if (currentClose < currentLow && tr < rangeThreshold * atr) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish fade: close ${currentClose.toFixed(2)} < low boundary ${currentLow.toFixed(2)} with small range (${tr.toFixed(4)} < ${(rangeThreshold * atr).toFixed(4)})`
                );
            }

            // Sell: Close breaks above the trailing high boundary, but true range is small (exhausted buyer pressure)
            if (currentClose > currentHigh && tr < rangeThreshold * atr) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish fade: close ${currentClose.toFixed(2)} > high boundary ${currentHigh.toFixed(2)} with small range (${tr.toFixed(4)} < ${(rangeThreshold * atr).toFixed(4)})`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "rangeThreshold"],
    },
};
