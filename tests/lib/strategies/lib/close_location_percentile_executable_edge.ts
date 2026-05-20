import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        percentileWindow: Math.max(5, Math.round(Number(params.percentileWindow ?? 60))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const close_location_percentile_executable_edge: Strategy = {
    name: "Close Location Percentile Executable Edge",
    description: "Capitalizes on extreme bar close locations relative to the high-low range on Binance, entering momentum continuations only when Polymarket market-makers fail to adjust and present a highly favorable executable pricing edge.",
    defaultParams: {
        lookback: 20,
        percentileWindow: 60,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Location Lookback",
        percentileWindow: "Percentile Window",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const percentileWindow = p.percentileWindow as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback + percentileWindow) return [];

        const closeLocs = buildCloseLocationSeries(cleanData);
        const rank = buildPercentileRank(closeLocs, percentileWindow);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [rank, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            const currentRank = rank[i];
            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            if (currentRank === null || buyYesEdge === null || buyNoEdge === null) return null;

            // Buy: close location percentile rank > 0.90, yesActionable is true, same-side edge positive
            if (currentRank > 0.90 && actionability.yesActionable[i] && buyYesEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Close location percentile ${currentRank.toFixed(2)} with YES edge ${buyYesEdge.toFixed(3)}`);
            }

            // Sell: close location percentile rank < 0.10, noActionable is true, same-side edge positive
            if (currentRank < 0.10 && actionability.noActionable[i] && buyNoEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Close location percentile ${currentRank.toFixed(2)} with NO edge ${buyNoEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "percentileWindow", "minEdge"],
    },
};
