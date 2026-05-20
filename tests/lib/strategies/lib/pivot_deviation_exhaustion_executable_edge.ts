import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    buildPivotFlags,
} from "../strategy-helpers";
import {
    buildPolymarket1sActionabilityMask,
    buildPolymarket1sExecutableEdge,
} from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(2, Math.round(Number(params.lookback ?? 20))),
        devThreshold: Math.max(0.0001, Number(params.devThreshold ?? 0.001)),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.01)),
    };
}

export const pivot_deviation_exhaustion_executable_edge: Strategy = {
    name: "Pivot Deviation Exhaustion Executable Edge",
    description: "Fades price exhaustion moves that extend beyond local pivot points on Binance, entering mean reversions only when Polymarket market-makers lag behind the pivot sweep and present a highly-favorable executable edge.",
    defaultParams: {
        lookback: 20,
        devThreshold: 0.001,
        minEdge: 0.01,
    },
    paramLabels: {
        lookback: "Pivot Lookback",
        devThreshold: "Deviation Threshold",
        minEdge: "Minimum Executable Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const devThreshold = p.devThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback * 2 + 2) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);

        const { pivotHighs, pivotLows } = buildPivotFlags(highs, lows, lookback);
        const edge = buildPolymarket1sExecutableEdge(cleanData, context, { volLookback: lookback });
        const actionability = buildPolymarket1sActionabilityMask(cleanData, context, {
            volLookback: lookback,
            minEventProgress: 0.02,
            maxEventProgress: 0.96,
            minSecondsRemaining: 8,
        });

        if (!edge.available || !actionability.available) return [];

        return createSignalLoop(cleanData, [edge.buyYesEdge, edge.buyNoEdge], (i) => {
            if (i < lookback * 2 + 2) return null;

            // Search back for last confirmed pivot highs and lows causally
            let lastPivHigh = -1;
            let lastPivLow = -1;
            for (let j = i - lookback; j >= 0; j--) {
                if (lastPivHigh < 0 && pivotHighs[j]) lastPivHigh = j;
                if (lastPivLow < 0 && pivotLows[j]) lastPivLow = j;
                if (lastPivHigh >= 0 && lastPivLow >= 0) break;
            }

            if (lastPivHigh < 0 || lastPivLow < 0) return null;

            const pivHigh = highs[lastPivHigh];
            const pivLow = lows[lastPivLow];
            const span = pivHigh - pivLow;
            if (span <= 0) return null;

            const buyYesEdge = edge.buyYesEdge[i];
            const buyNoEdge = edge.buyNoEdge[i];
            const currentClose = closes[i];

            if (buyYesEdge === null || buyNoEdge === null) return null;

            // Buy: Close deviates below swing low pivot by devThreshold
            if (currentClose < pivLow - devThreshold * span && actionability.yesActionable[i] && buyYesEdge >= minEdge) {
                return createBuySignal(cleanData, i, `Close ${currentClose.toFixed(2)} below pivot low ${pivLow.toFixed(2)} with YES edge ${buyYesEdge.toFixed(3)}`);
            }

            // Sell: Close deviates above swing high pivot by devThreshold
            if (currentClose > pivHigh + devThreshold * span && actionability.noActionable[i] && buyNoEdge >= minEdge) {
                return createSellSignal(cleanData, i, `Close ${currentClose.toFixed(2)} above pivot high ${pivHigh.toFixed(2)} with NO edge ${buyNoEdge.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "devThreshold", "minEdge"],
    },
};
