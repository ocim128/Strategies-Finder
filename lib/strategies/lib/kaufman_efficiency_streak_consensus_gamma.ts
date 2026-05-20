import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildEfficiencyRatio } from "./price-action-statistics-core";
import { buildPolymarket1sGammaAgreement } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        erLookback: Math.max(2, Math.round(Number(params.erLookback ?? 35))),
        erThreshold: Math.max(0.01, Math.min(0.99, Number(params.erThreshold ?? 0.45))),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const kaufman_efficiency_streak_consensus_gamma: Strategy = {
    name: "Kaufman Efficiency Streak Consensus Gamma",
    description: "Identifies highly-efficient directional spot trend regimes on Binance and confirms entries using Gamma consensus, ensuring that wholesale options flow agrees the contract is underpriced.",
    defaultParams: {
        erLookback: 35,
        erThreshold: 0.45,
        minEdge: 0.015,
    },
    paramLabels: {
        erLookback: "ER Lookback",
        erThreshold: "ER Efficiency Threshold",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const erLookback = p.erLookback as number;
        const erThreshold = p.erThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < erLookback + 1) return [];

        const closes = getCloses(cleanData);
        const er = buildEfficiencyRatio(cleanData, erLookback);
        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback: erLookback });

        if (!gamma.available) return [];

        return createSignalLoop(cleanData, [er, gamma.consensusLongEdge, gamma.consensusShortEdge], (i) => {
            if (i < 1) return null;

            const currentEr = er[i];
            const currentClose = closes[i];
            const prevClose = closes[i - 1];

            const consensusLong = gamma.consensusLongEdge[i];
            const consensusShort = gamma.consensusShortEdge[i];

            if (currentEr === null || consensusLong === null || consensusShort === null) return null;

            // Buy: efficiency ratio > erThreshold, close > prevClose (uptrend), consensusLong positive
            if (currentEr > erThreshold && currentClose > prevClose && consensusLong >= minEdge) {
                return createBuySignal(cleanData, i, `Highly efficient spot uptrend ${currentEr.toFixed(2)} with Gamma consensus ${consensusLong.toFixed(3)}`);
            }

            // Sell: efficiency ratio > erThreshold, close < prevClose (downtrend), consensusShort positive
            if (currentEr > erThreshold && currentClose < prevClose && consensusShort >= minEdge) {
                return createSellSignal(cleanData, i, `Highly efficient spot downtrend ${currentEr.toFixed(2)} with Gamma consensus ${consensusShort.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["erLookback", "erThreshold", "minEdge"],
    },
};
