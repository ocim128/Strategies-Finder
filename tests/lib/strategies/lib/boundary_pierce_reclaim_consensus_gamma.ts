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
import { buildRollingMinMax } from "./polymarket-1s-strategy-utils";
import { buildPolymarket1sGammaAgreement } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 30))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const boundary_pierce_reclaim_consensus_gamma: Strategy = {
    name: "Boundary Pierce Reclaim Consensus Gamma",
    description: "Trades high-conviction reclaim breakouts after a false pierce of trailing distribution boundaries on Binance, using Gamma consensus to confirm options flow supports the movement.",
    defaultParams: {
        lookback: 30,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Boundary Lookback",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback + 2) return [];

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const bounds = buildRollingMinMax(closes, lookback, false); // trailing excludes current bar
        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback: lookback });

        if (!gamma.available) return [];

        return createSignalLoop(cleanData, [bounds.min, bounds.max, gamma.consensusLongEdge, gamma.consensusShortEdge], (i) => {
            if (i < 2) return null;

            const prevClose = closes[i - 1];
            const currentClose = closes[i];
            const prevLow = lows[i - 1];
            const prevHigh = highs[i - 1];

            const trailingLowPrev = bounds.min[i - 1];
            const trailingHighPrev = bounds.max[i - 1];
            const trailingHighCurr = bounds.max[i];
            const trailingLowCurr = bounds.min[i];

            const consensusLong = gamma.consensusLongEdge[i];
            const consensusShort = gamma.consensusShortEdge[i];

            if (
                trailingLowPrev === null || trailingHighPrev === null ||
                trailingHighCurr === null || trailingLowCurr === null ||
                consensusLong === null || consensusShort === null
            ) return null;

            // Buy: false pierce of low at i-1, next close breaks above trailing max
            const falseLowPierce = prevLow < trailingLowPrev && prevClose >= trailingLowPrev;
            if (falseLowPierce && currentClose > trailingHighCurr && consensusLong >= minEdge) {
                return createBuySignal(cleanData, i, `False low pierce reclaimed with breakout above ${trailingHighCurr.toFixed(2)} and consensus edge`);
            }

            // Sell: false pierce of high at i-1, next close breaks below trailing min
            const falseHighPierce = prevHigh > trailingHighPrev && prevClose <= trailingHighPrev;
            if (falseHighPierce && currentClose < trailingLowCurr && consensusShort >= minEdge) {
                return createSellSignal(cleanData, i, `False high pierce reclaimed with breakout below ${trailingLowCurr.toFixed(2)} and consensus edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minEdge"],
    },
};
