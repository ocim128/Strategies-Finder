import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";
import { buildPercentileRank } from "./price-action-statistics-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(10, Math.floor(Number(params.lookback ?? 32))),
    };
}

export const sweep_reclaim_absorption_asymmetry_skew: Strategy = {
    name: "Sweep Reclaim Absorption Asymmetry Skew",
    description: "Enters liquidity absorption skew when positive sweep percentile is high while negative sweep percentile is suppressed.",
    defaultParams: {
        lookback: 32,
    },
    paramLabels: {
        lookback: "Lookback Period",
    },
    normalizeParams,
    execute(data: OHLCVData[], rawParams: StrategyParams = {}) {
        const cleanData = ensureCleanData(data);
        const params = normalizeParams(rawParams);
        const lookback = Number(params.lookback);

        const rawScores = buildSweepReclaimScoreSeries(cleanData);
        const springs = rawScores.map((v) => Math.max(0, v));
        const upthrusts = rawScores.map((v) => Math.max(0, -v));

        const pctSpring = buildPercentileRank(springs, lookback);
        const pctUpthrust = buildPercentileRank(upthrusts, lookback);

        return createSignalLoop(cleanData, [pctSpring, pctUpthrust], (i) => {
            const pSpring = pctSpring[i];
            const pUpthrust = pctUpthrust[i];
            if (pSpring === null || pUpthrust === null) return null;

            if (pSpring >= 0.90 && pUpthrust <= 0.10 && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish sweep asymmetry skew: springPct=${(pSpring * 100).toFixed(0)}%>=90%, upthrustPct=${(pUpthrust * 100).toFixed(0)}%<=10%`);
            }
            if (pUpthrust >= 0.90 && pSpring <= 0.10 && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish sweep asymmetry skew: upthrustPct=${(pUpthrust * 100).toFixed(0)}%>=90%, springPct=${(pSpring * 100).toFixed(0)}%<=10%`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback"],
    },
};
