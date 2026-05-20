import { Strategy, OHLCVData, StrategyExecutionContext, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRollingKurtosis } from "./price-action-statistics-core";
import { calculateEMA } from "../indicators";
import { buildPolymarket1sGammaAgreement } from "./polymarket-1s-helpers";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 40))),
        kurtosisThreshold: Math.max(0.1, Number(params.kurtosisThreshold ?? 3.5)),
        minEdge: Math.max(0, Number(params.minEdge ?? 0.02)),
    };
}

export const rolling_kurtosis_reversion_consensus_gamma: Strategy = {
    name: "Rolling Kurtosis Reversion Consensus Gamma",
    description: "Fades extreme fat-tailed distribution extensions on Binance (high rolling kurtosis), entering trend reversals only when Gamma consensus confirms the mean-reversion move.",
    defaultParams: {
        lookback: 40,
        kurtosisThreshold: 3.5,
        minEdge: 0.02,
    },
    paramLabels: {
        lookback: "Kurtosis Lookback",
        kurtosisThreshold: "Kurtosis Threshold",
        minEdge: "Minimum Consensus Edge",
    },
    normalizeParams,
    polymarket1sConfig: { required: true },
    execute: (data: OHLCVData[], params: StrategyParams, context?: StrategyExecutionContext) => {
        if (!context?.polymarket1s) return [];

        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const kurtosisThreshold = p.kurtosisThreshold as number;
        const minEdge = p.minEdge as number;

        if (cleanData.length < lookback) return [];

        const closes = getCloses(cleanData);
        const kurtosis = buildRollingKurtosis(closes, lookback);
        const ema = calculateEMA(closes, 10);
        const gamma = buildPolymarket1sGammaAgreement(cleanData, context, { volLookback: lookback });

        if (!gamma.available) return [];

        return createSignalLoop(cleanData, [kurtosis, ema, gamma.consensusLongEdge, gamma.consensusShortEdge], (i) => {
            if (i < 1) return null;

            const currentKurtosis = kurtosis[i];
            const prevClose = cleanData[i - 1].close;
            const currentClose = cleanData[i].close;
            const prevEma = ema[i - 1];
            const currentEma = ema[i];

            const consensusLong = gamma.consensusLongEdge[i];
            const consensusShort = gamma.consensusShortEdge[i];

            if (
                currentKurtosis === null ||
                prevEma === null || currentEma === null ||
                consensusLong === null || consensusShort === null
            ) return null;

            // Buy: highly fat-tailed spot return profile, price crosses back above fast EMA baseline, supported by consensus long edge
            if (currentKurtosis > kurtosisThreshold && prevClose < prevEma && currentClose >= currentEma && consensusLong >= minEdge) {
                return createBuySignal(cleanData, i, `Rolling kurtosis ${currentKurtosis.toFixed(2)} above threshold with consensus long edge ${consensusLong.toFixed(3)}`);
            }

            // Sell: highly fat-tailed spot return profile, price crosses back below fast EMA baseline, supported by consensus short edge
            if (currentKurtosis > kurtosisThreshold && prevClose > prevEma && currentClose <= currentEma && consensusShort >= minEdge) {
                return createSellSignal(cleanData, i, `Rolling kurtosis ${currentKurtosis.toFixed(2)} above threshold with consensus short edge ${consensusShort.toFixed(3)}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "kurtosisThreshold", "minEdge"],
    },
};
