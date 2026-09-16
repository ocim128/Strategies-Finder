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
        max_body_pct: Math.max(0.01, Math.min(1, Number(params.max_body_pct ?? 0.25))),
    };
}

export const sweep_reclaim_wick_dominant_absorption: Strategy = {
    name: "Sweep Reclaim Wick Dominant Absorption",
    description: "Filters liquidity sweeps to pure rejection absorption wicks by requiring compressed candle body fraction.",
    defaultParams: {
        max_body_pct: 0.25,
    },
    paramLabels: {
        max_body_pct: "Max Body Fraction",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const max_body_pct = p.max_body_pct as number;
        if (cleanData.length < 2) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);
        const bodyPct = buildBodyPctSeries(cleanData);

        return createSignalLoop(cleanData, [sweep, bodyPct], (i) => {
            const s = sweep[i];
            const bp = bodyPct[i];
            if (s === null || bp === null) return null;

            if (bp <= max_body_pct) {
                if (s >= 0.25) {
                    return createBuySignal(cleanData, i, `Bullish wick-dominant absorption: sweep score ${s.toFixed(3)} >= 0.25, body pct ${bp.toFixed(3)} <= ${max_body_pct}`);
                }
                if (s <= -0.25) {
                    return createSellSignal(cleanData, i, `Bearish wick-dominant absorption: sweep score ${s.toFixed(3)} <= -0.25, body pct ${bp.toFixed(3)} <= ${max_body_pct}`);
                }
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["max_body_pct"],
    },
};
