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
        lookback: Math.max(4, Math.round(Number(params.lookback ?? 30))),
    };
}

export const sweep_reclaim_void_breakout: Strategy = {
    name: "Sweep Reclaim Void Breakout",
    description: "Enters frictionless breakouts following an extended period of zero liquidity sweeps (sweep void).",
    defaultParams: {
        lookback: 30,
    },
    paramLabels: {
        lookback: "Lookback",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        if (cleanData.length < lookback + 1) return [];

        const sweep = buildSweepReclaimScoreSeries(cleanData);
        const absSweep = sweep.map((v) => Math.abs(v));
        const pctAbsSweep = buildPercentileRank(absSweep, lookback);

        return createSignalLoop(cleanData, [pctAbsSweep], (i) => {
            if (i < 1) return null;
            const priorPctl = pctAbsSweep[i - 1];
            if (priorPctl === null || priorPctl > 0.10) return null;

            if (cleanData[i].close > cleanData[i - 1].high) {
                return createBuySignal(cleanData, i, `Bullish sweep void breakout: prior abs sweep percentile ${priorPctl.toFixed(3)} <= 0.10, close > prior high`);
            }
            if (cleanData[i].close < cleanData[i - 1].low) {
                return createSellSignal(cleanData, i, `Bearish sweep void breakout: prior abs sweep percentile ${priorPctl.toFixed(3)} <= 0.10, close < prior low`);
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
