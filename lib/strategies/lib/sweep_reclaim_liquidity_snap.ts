import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import {
    buildCloseLocationSeries,
    buildSweepReclaimScoreSeries,
} from "./price-action-frequency-core";

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        threshold: Math.max(0.01, Number(params.threshold ?? 0.35)),
    };
}

export const sweep_reclaim_liquidity_snap: Strategy = {
    name: "Sweep Reclaim Liquidity Snap",
    description: "Enters liquidity sweep reclaims where continuous sweep magnitude exceeds threshold with supportive close location.",
    defaultParams: {
        threshold: 0.35,
    },
    paramLabels: {
        threshold: "Sweep Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const threshold = p.threshold as number;
        if (cleanData.length < 2) return [];

        const sweepScore = buildSweepReclaimScoreSeries(cleanData);
        const closeLocation = buildCloseLocationSeries(cleanData);

        return createSignalLoop(cleanData, [sweepScore, closeLocation], (i) => {
            const score = sweepScore[i];
            const cl = closeLocation[i];
            if (score === null || cl === null) return null;

            if (score >= threshold && cl >= 0.60) {
                return createBuySignal(cleanData, i, `Bullish sweep snap: sweepScore ${score.toFixed(3)} >= ${threshold}, closeLocation ${cl.toFixed(2)} >= 0.60`);
            }
            if (score <= -threshold && cl <= 0.40) {
                return createSellSignal(cleanData, i, `Bearish sweep snap: sweepScore ${score.toFixed(3)} <= -${threshold}, closeLocation ${cl.toFixed(2)} <= 0.40`);
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["threshold"],
    },
};
