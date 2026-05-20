import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
} from "../strategy-helpers";
import { calculateParabolicSAR } from "../indicators";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        sarStep: Math.max(0.001, Math.min(0.20, Number(params.sarStep ?? 0.02))),
        sarMax: Math.max(0.01, Math.min(0.80, Number(params.sarMax ?? 0.20))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const parabolic_sar_breakout_actionable_edge: Strategy = {
    name: "Parabolic SAR Breakout Actionable Edge",
    description: "Enters trend-following breakouts on Binance triggered by the Parabolic SAR, using Polymarket's actionability mask and executable edge to guarantee execution quality during high-trend periods.",
    defaultParams: {
        sarStep: 0.02,
        sarMax: 0.20,
        minEdge: 0.015,
    },
    paramLabels: {
        sarStep: "Acceleration Step",
        sarMax: "Maximum Acceleration",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const sarStep = p.sarStep as number;
        const sarMax = p.sarMax as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < 5) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const sar = calculateParabolicSAR(highs, lows, sarStep, sarMax);

        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: 25 });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: 25,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [sar, edge.buyYesEdge, edge.buyNoEdge], (i) => {
            if (i < 2) return null;

            const prevClose = closes[i - 1];
            const currentClose = closes[i];
            const prevSar = sar[i - 1];
            const currentSar = sar[i];

            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];

            if (currentSar === null || prevSar === null || buyYesEdge === null || buyNoEdge === null) return null;

            // Buy: Close crosses above Parabolic SAR
            if (prevClose < prevSar && currentClose >= currentSar && actionability.yesActionable[i] && buyYesEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Close crossed above Parabolic SAR ${currentSar.toFixed(2)} with YES edge`);
            }

            // Sell: Close crosses below Parabolic SAR
            if (prevClose > prevSar && currentClose <= currentSar && actionability.noActionable[i] && buyNoEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Close crossed below Parabolic SAR ${currentSar.toFixed(2)} with NO edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["sarStep", "sarMax", "minEdge"],
    },
};
