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
        min_score: Math.max(0.01, Number(params.min_score ?? 0.2)),
    };
}

export const sweep_reclaim_alternating_ping_pong: Strategy = {
    name: "Sweep Reclaim Alternating Ping Pong",
    description: "Fades consecutive alternating two-bar liquidity sweeps after price sweeps both sides of the session bracket.",
    defaultParams: {
        min_score: 0.2,
    },
    paramLabels: {
        min_score: "Min Score Magnitude",
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
            const sPrev = sweep[i - 1];
            const sCurr = sweep[i];
            if (sPrev === null || sCurr === null) return null;

            if (sPrev <= -min_score && sCurr >= min_score) {
                return createBuySignal(cleanData, i, `Bullish ping-pong sweep: prior upthrust ${sPrev.toFixed(3)} <= -${min_score}, current spring ${sCurr.toFixed(3)} >= ${min_score}`);
            }
            if (sPrev >= min_score && sCurr <= -min_score) {
                return createSellSignal(cleanData, i, `Bearish ping-pong sweep: prior spring ${sPrev.toFixed(3)} >= ${min_score}, current upthrust ${sCurr.toFixed(3)} <= -${min_score}`);
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
