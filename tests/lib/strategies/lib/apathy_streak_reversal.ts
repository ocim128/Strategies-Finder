import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getVolumes } from "../strategy-helpers";
import { buildStreakCount, buildRollingZScore } from "./price-action-statistics-core";

function normalizeApathyStreakReversalParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        min_streak: Math.max(1, Math.round(params.min_streak ?? 4)),
        vol_z_apathy: Number(params.vol_z_apathy ?? -1.0)
    };
}

export const apathy_streak_reversal: Strategy = {
    name: "Apathy Streak Reversal",
    description: "Long directional streaks attract pattern traders, but if the streak happens on statistically dead volume, it is a low-liquidity drift primed for a violent mean reversion.",
    defaultParams: {
        min_streak: 4,
        vol_z_apathy: -1.0
    },
    paramLabels: {
        min_streak: "Minimum Streak",
        vol_z_apathy: "Volume Z-Score Apathy Threshold"
    },
    normalizeParams: normalizeApathyStreakReversalParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeApathyStreakReversalParams(params);
        if (cleanData.length < 20) return [];

        const flags = cleanData.map((d, i) => i === 0 ? 0 : (d.close > cleanData[i-1].close ? 1 : (d.close < cleanData[i-1].close ? -1 : 0)));
        const streak = buildStreakCount(flags);
        const vols = getVolumes(cleanData);
        const volZScore = buildRollingZScore(vols, 20);

        return createSignalLoop(cleanData, [streak, volZScore], (i) => {
            if (i < 20) return null;
            const strk = streak[i];
            const vZ = volZScore[i];
            if (strk === null || vZ === null) return null;

            const isUpCandle = cleanData[i].close > cleanData[i - 1].close;
            const isDownCandle = cleanData[i].close < cleanData[i - 1].close;
            const minStreak = p.min_streak as number;
            const volApathy = p.vol_z_apathy as number;

            if (strk <= -minStreak && vZ < volApathy && isUpCandle) {
                return createBuySignal(cleanData, i, `Down-streak <= ${-minStreak}, Vol Z < ${volApathy}, counter-trend close`);
            }
            if (strk >= minStreak && vZ < volApathy && isDownCandle) {
                return createSellSignal(cleanData, i, `Up-streak >= ${minStreak}, Vol Z < ${volApathy}, counter-trend close`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["min_streak", "vol_z_apathy"]
    }
};
