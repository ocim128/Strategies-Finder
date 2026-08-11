import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getVolumes,
} from "../strategy-helpers";
import {
    buildRateOfChange,
    buildRollingZScore,
    buildStreakCount,
} from "./price-action-statistics-core";

const VOLUME_Z_WINDOW = 60;
const VOLUME_Z_SURGE = 1.5;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakLength: Math.max(2, Math.round(Number(params.streakLength ?? 3))),
    };
}

export const capitulation_streak_fade: Strategy = {
    name: "Capitulation Streak Fade",
    description: "Fades same-sign return streaks exactly at the threshold when the terminal bar prints a relative-volume surge.",
    defaultParams: {
        streakLength: 3,
    },
    paramLabels: {
        streakLength: "Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const streakLength = p.streakLength as number;
        if (cleanData.length < VOLUME_Z_WINDOW) return [];

        const roc = buildRateOfChange(getCloses(cleanData), 1);
        const flags = new Array<number>(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const r = roc[i];
            if (r === null || r === 0) {
                flags[i] = 0;
            } else {
                flags[i] = r > 0 ? 1 : -1;
            }
        }
        const streaks = buildStreakCount(flags);
        const volumeZ = buildRollingZScore(getVolumes(cleanData), VOLUME_Z_WINDOW);

        return createSignalLoop(cleanData, [volumeZ], (i) => {
            const volZ = volumeZ[i];
            const streak = streaks[i];
            if (volZ === null || streak === 0) return null;

            // Capitulating down streak ends on a volume surge.
            if (streak === -streakLength && volZ >= VOLUME_Z_SURGE) {
                return createBuySignal(cleanData, i, `Capitulation buy: down streak ${streak} on volume z ${volZ.toFixed(2)}`);
            }
            // Climactic up streak ends on a volume surge.
            if (streak === streakLength && volZ >= VOLUME_Z_SURGE) {
                return createSellSignal(cleanData, i, `Capitulation sell: up streak ${streak} on volume z ${volZ.toFixed(2)}`);
            }
            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["streakLength"],
    },
};
