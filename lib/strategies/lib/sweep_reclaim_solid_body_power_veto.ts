import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildBodyPctSeries,
    buildSweepReclaimScoreSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_body_pct: Math.max(0.01, Math.min(1, Number(params.min_body_pct ?? 0.7))),
    };
}

export const sweep_reclaim_solid_body_power_veto: Strategy = {
    name: "Sweep Reclaim Solid Body Power Veto",
    description: "Enters liquidity sweep reclaims reinforced by directional candle bodies occupying at least min_body_pct of the bar range.",
    defaultParams: {
        min_body_pct: 0.7,
    },
    paramLabels: {
        min_body_pct: "Min Body Pct",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const minBodyPct = p.min_body_pct as number;
        if (cleanData.length < 2) return [];

        const sweepScore = buildSweepReclaimScoreSeries(cleanData);
        const bodyPct = buildBodyPctSeries(cleanData);

        return createSignalLoop(cleanData, [sweepScore, bodyPct], (i) => {
            if (i < 1) return null;
            const score = sweepScore[i];
            const bp = bodyPct[i];
            if (bp < minBodyPct) return null;

            if (score >= 0.20 && cleanData[i].close > cleanData[i].open) {
                return createBuySignal(cleanData, i, `Bullish sweep solid body reclaim: score ${score.toFixed(3)} >= 0.20, bodyPct ${bp.toFixed(2)} >= ${minBodyPct}`);
            }
            if (score <= -0.20 && cleanData[i].close < cleanData[i].open) {
                return createSellSignal(cleanData, i, `Bearish sweep solid body reclaim: score ${score.toFixed(3)} <= -0.20, bodyPct ${bp.toFixed(2)} >= ${minBodyPct}`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_body_pct"],
    },
};
