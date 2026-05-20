import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingAutoCorrelation, buildRollingMedian } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 20))),
        autocorrThreshold: Math.min(-0.01, Number(params.autocorrThreshold ?? -0.2)),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.01)),
    };
}

export const autocorrelation_reversal_actionability_mask: Strategy = {
    name: "Autocorrelation Reversal Actionability Mask",
    description: "Detects high-probability mean-reverting regimes on Binance (negative rolling autocorrelation of returns) and executes reversions only under perfect Polymarket execution hygiene conditions.",
    defaultParams: {
        lookback: 20,
        autocorrThreshold: -0.2,
        minEdge: 0.01,
    },
    paramLabels: {
        lookback: "Autocorrelation Lookback",
        autocorrThreshold: "Autocorr Max Threshold",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const autocorrThreshold = p.autocorrThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);

        // Calculate close returns
        const returns = new Array(cleanData.length).fill(0);
        for (let i = 1; i < cleanData.length; i++) {
            const prev = cleanData[i - 1].close;
            returns[i] = prev > 0 ? (cleanData[i].close - prev) / prev : 0;
        }

        const autocorr = buildRollingAutoCorrelation(returns, lookback, 1);
        const median = buildRollingMedian(closes, lookback);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [autocorr, median, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            const currentClose = closes[i];
            const currentAutocorr = autocorr[i];
            const currentMedian = median[i];

            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            if (currentAutocorr === null || currentMedian === null || buyYesEdge === null || buyNoEdge === null) return null;

            // Buy: autocorrelation < autocorrThreshold, close < median, yesActionable is true, buyYesEdge >= minEdge
            if (currentAutocorr < autocorrThreshold && currentClose < currentMedian && actionability.yesActionable[i] && buyYesEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Mean-reverting regime ${currentAutocorr.toFixed(2)} close below median with YES edge`);
            }

            // Sell: autocorrelation < autocorrThreshold, close > median, noActionable is true, buyNoEdge >= minEdge
            if (currentAutocorr < autocorrThreshold && currentClose > currentMedian && actionability.noActionable[i] && buyNoEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Mean-reverting regime ${currentAutocorr.toFixed(2)} close above median with NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "autocorrThreshold", "minEdge"],
    },
};
