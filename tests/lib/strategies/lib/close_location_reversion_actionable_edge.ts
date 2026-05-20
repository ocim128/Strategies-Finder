import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildCloseLocationSeries, buildRollingAverage } from "./price-action-frequency-core";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 15))),
        extremeThreshold: Math.max(0.01, Math.min(0.49, Number(params.extremeThreshold ?? 0.20))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.01)),
    };
}

export const close_location_reversion_actionable_edge: Strategy = {
    name: "Close Location Reversion Actionable Edge",
    description: "Trades reversions from extreme close location distributions on Binance, utilizing Polymarket's actionability mask and executable same-side edge to guarantee premium fills.",
    defaultParams: {
        lookback: 15,
        extremeThreshold: 0.20,
        minEdge: 0.01,
    },
    paramLabels: {
        lookback: "Location Lookback",
        extremeThreshold: "Extreme Threshold (from center)",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const extremeThreshold = p.extremeThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback) return [];

        const closeLocations = buildCloseLocationSeries(cleanData);
        const smoothedLocation = buildRollingAverage(closeLocations, lookback);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [smoothedLocation, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            if (i < 1) return null;

            const prevAvg = smoothedLocation[i - 1];
            const currentAvg = smoothedLocation[i];

            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            if (prevAvg === null || currentAvg === null || buyYesEdge === null || buyNoEdge === null) return null;

            // Buy: Close location crosses back above extremeThreshold (oversold reversion)
            if (prevAvg < extremeThreshold && currentAvg >= extremeThreshold && actionability.yesActionable[i] && buyYesEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Close location average ${currentAvg.toFixed(2)} crossed above oversold threshold with YES edge`);
            }

            // Sell: Close location crosses back below (1.0 - extremeThreshold) (overbought reversion)
            const upperExtreme = 1.0 - extremeThreshold;
            if (prevAvg > upperExtreme && currentAvg <= upperExtreme && actionability.noActionable[i] && buyNoEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Close location average ${currentAvg.toFixed(2)} crossed below overbought threshold with NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "extremeThreshold", "minEdge"],
    },
};
