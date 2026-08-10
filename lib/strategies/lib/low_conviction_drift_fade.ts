import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
} from "../strategy-helpers";
import { buildBodyPctSeries, extractBarMetricSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

const SMALL_BODY_PCT = 0.4;

function normalizeLowConvictionDriftFadeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakReq: Math.max(2, Math.round(Number(params.streakReq ?? 4))),
    };
}

export const low_conviction_drift_fade: Strategy = {
    name: "Low Conviction Drift Fade",
    description: "Fades directional streaks built entirely from small, convictionless bodies.",
    defaultParams: {
        streakReq: 4,
    },
    paramLabels: {
        streakReq: "Min Small-Body Streak",
    },
    normalizeParams: normalizeLowConvictionDriftFadeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeLowConvictionDriftFadeParams(params);
        const streakReq = p.streakReq as number;
        if (cleanData.length < streakReq + 1) return [];

        const bodyPct = buildBodyPctSeries(cleanData);
        const bodyDirection = extractBarMetricSeries(cleanData, "bodyDirection");
        const flags: number[] = new Array(cleanData.length);
        for (let i = 0; i < cleanData.length; i++) {
            flags[i] = bodyPct[i] < SMALL_BODY_PCT ? bodyDirection[i] : 0;
        }
        const streaks = buildStreakCount(flags);

        return createSignalLoop(cleanData, [], (i) => {
            if (streaks[i] <= -streakReq) {
                return createBuySignal(cleanData, i, `Low-conviction down drift of ${-streaks[i]} small-body bars`);
            }
            if (streaks[i] >= streakReq) {
                return createSellSignal(cleanData, i, `Low-conviction up drift of ${streaks[i]} small-body bars`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakReq"],
    },
};
