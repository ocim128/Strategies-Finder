import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildSweepReclaimScoreSeries } from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_score: Math.max(0.01, Number(params.min_score ?? 0.25)),
    };
}

export const sweep_reclaim_body_engulf_veto: Strategy = {
    name: "Sweep Reclaim Body Engulf Veto",
    description: "Requires liquidity sweep reclaims to completely engulf the prior bar's open price, confirming decisive absorption.",
    defaultParams: {
        min_score: 0.25,
    },
    paramLabels: {
        min_score: "Min Sweep Score",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const min_score = p.min_score as number;
        if (cleanData.length < 2) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);

        return createSignalLoop(cleanData, [sweep], (i) => {
            if (i < 1) return null;
            const score = sweep[i];
            if (score === null) return null;

            if (score >= min_score && cleanData[i].close > cleanData[i - 1].open) {
                return createBuySignal(cleanData, i, `Bullish sweep body engulf: sweep score ${score.toFixed(3)} >= ${min_score}, close > prior open`);
            }
            if (score <= -min_score && cleanData[i].close < cleanData[i - 1].open) {
                return createSellSignal(cleanData, i, `Bearish sweep body engulf: sweep score ${score.toFixed(3)} <= -${min_score}, close < prior open`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_score"],
    },
};
