import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildRangeSeries } from "./price-action-frequency-core";
import {
    buildPercentileRank,
    buildRateOfChange,
    buildStreakCount,
} from "./price-action-statistics-core";

const RANGE_PERCENTILE_WINDOW = 60;
const RANGE_RANK_MAX = 0.3;

function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        streakLength: Math.max(2, Math.round(Number(params.streakLength ?? 4))),
    };
}

export const quiet_streak_exhaustion: Strategy = {
    name: "Quiet Streak Exhaustion",
    description: "Fades same-sign return streaks exactly at the threshold when the trigger bar's range ranks in the bottom third.",
    defaultParams: {
        streakLength: 4,
    },
    paramLabels: {
        streakLength: "Streak Length",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const streakLength = p.streakLength as number;
        if (cleanData.length < RANGE_PERCENTILE_WINDOW) return [];

        const closes = getCloses(cleanData);
        const roc = buildRateOfChange(closes, 1);
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
        const rangeRank = buildPercentileRank(buildRangeSeries(cleanData), RANGE_PERCENTILE_WINDOW);

        return createSignalLoop(cleanData, [rangeRank], (i) => {
            const rank = rangeRank[i];
            const streak = streaks[i];
            if (rank === null || streak === 0) return null;

            // Fire only when the down streak first equals the threshold, on a quiet bar.
            if (streak === -streakLength && rank <= RANGE_RANK_MAX) {
                return createBuySignal(cleanData, i, `Quiet exhaustion buy: down streak ${streak} on range rank ${rank.toFixed(2)}`);
            }
            // Fire only when the up streak first equals the threshold, on a quiet bar.
            if (streak === streakLength && rank <= RANGE_RANK_MAX) {
                return createSellSignal(cleanData, i, `Quiet exhaustion sell: up streak ${streak} on range rank ${rank.toFixed(2)}`);
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
