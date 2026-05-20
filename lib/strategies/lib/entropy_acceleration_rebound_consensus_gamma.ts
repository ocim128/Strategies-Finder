import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingEntropy } from "./price-action-statistics-core";
import { buildPolymarket1sGammaAgreement } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(3, Math.round(Number(params.lookback ?? 25))),
        entropyDrop: Math.max(0.01, Number(params.entropyDrop ?? 0.30)),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.015)),
    };
}

export const entropy_acceleration_rebound_consensus_gamma: Strategy = {
    name: "Entropy Acceleration Rebound Consensus Gamma",
    description: "Trades decisive directional breakouts on Binance immediately following a sharp acceleration/drop in rolling entropy (disorder-to-order transition), confirming the entry via Gamma agreement consensus.",
    defaultParams: {
        lookback: 25,
        entropyDrop: 0.30,
        minEdge: 0.015,
    },
    paramLabels: {
        lookback: "Entropy/Avg Lookback",
        entropyDrop: "Entropy Drop Threshold",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const entropyDrop = p.entropyDrop as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback + 1) return [];

        const closes = getCloses(cleanData);
        const entropy = buildRollingEntropy(closes, lookback, 5);

        // Compute rolling average of closes
        const closesSma = new Array(closes.length).fill(null);
        let sum = 0;
        for (let i = 0; i < closes.length; i++) {
            sum += closes[i];
            if (i >= lookback) sum -= closes[i - lookback];
            if (i >= lookback - 1) closesSma[i] = sum / lookback;
        }

        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback: lookback });

        if (!gamma.available) return [];

        return createSignalLoop(cleanData, [entropy, closesSma, gamma.consensusLongEdge, gamma.consensusShortEdge], (i) => {
            if (i < 1) return null;

            const prevEntropy = entropy[i - 1];
            const currentEntropy = entropy[i];
            const prevClose = closes[i - 1];
            const currentClose = closes[i];
            const currentSma = closesSma[i];
            const prevSma = closesSma[i - 1];

            const consensusLong = gamma.consensusLongEdge[i];
            const consensusShort = gamma.consensusShortEdge[i];

            if (
                prevEntropy === null || currentEntropy === null ||
                currentSma === null || prevSma === null ||
                consensusLong === null || consensusShort === null
            ) return null;

            const drop = prevEntropy - currentEntropy;

            // Buy: entropy drop > entropyDrop, close crosses above rolling average, consensusLong positive
            if (drop > entropyDrop && prevClose < prevSma && currentClose >= currentSma && consensusLong >= minEdge) {
                return createBuySignal(cleanData, i, `Entropy drop ${drop.toFixed(2)} with upward breakout and consensus long edge`);
            }

            // Sell: entropy drop > entropyDrop, close crosses below rolling average, consensusShort positive
            if (drop > entropyDrop && prevClose > prevSma && currentClose <= currentSma && consensusShort >= minEdge) {
                return createSellSignal(cleanData, i, `Entropy drop ${drop.toFixed(2)} with downward breakout and consensus short edge`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "entropyDrop", "minEdge"],
    },
};
