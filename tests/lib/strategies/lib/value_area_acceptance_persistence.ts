import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
} from "../strategy-helpers";
import { buildCloseAcceptanceSeries } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";
import { buildRollingValueArea } from "./value-area-acceptance-core";

// #COMPLETION_DRIVE: Assuming durable moves outside Value Area are verified by close acceptance streaks.
// #SUGGEST_VERIFY: Verify minStreak (>= 1) prevents front-running unconfirmed value breakouts.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 60))),
        minStreak: Math.max(1, Math.round(Number(params.minStreak ?? 5))),
    };
}

export const value_area_acceptance_persistence: Strategy = {
    name: "Value Area Acceptance Persistence",
    description: "Signals breakouts outside VAH/VAL when price exhibits a persistent close acceptance streak.",
    defaultParams: {
        lookback: 60,
        minStreak: 5,
    },
    paramLabels: {
        lookback: "Lookback",
        minStreak: "Min Streak",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const minStreak = p.minStreak as number;
        if (cleanData.length < lookback + minStreak + 2) return [];

        const closes = getCloses(cleanData);
        const { vah, val } = buildRollingValueArea(cleanData, lookback);
        const acceptance = buildCloseAcceptanceSeries(cleanData);
        const streaks = buildStreakCount(acceptance);

        return createSignalLoop(cleanData, [val, vah], (i) => {
            const currentClose = closes[i];
            const currentVal = val[i];
            const currentVah = vah[i];
            const streak = streaks[i];

            if (currentVal === null || currentVah === null) return null;

            // Buy: Close is above VAH, streak of positive acceptance reaches minStreak
            if (currentClose > currentVah && streak >= minStreak) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish persistence: close ${currentClose.toFixed(2)} > VAH ${currentVah.toFixed(2)} with acceptance streak of ${streak}`
                );
            }

            // Sell: Close is below VAL, streak of negative acceptance reaches minStreak
            if (currentClose < currentVal && streak <= -minStreak) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish persistence: close ${currentClose.toFixed(2)} < VAL ${currentVal.toFixed(2)} with acceptance streak of ${streak}`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "minStreak"],
    },
};
