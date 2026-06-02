import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getVolumes,
} from "../strategy-helpers";
import { buildRollingAverage } from "./price-action-frequency-core";
import { buildStreakCount } from "./price-action-statistics-core";

// #COMPLETION_DRIVE: Assuming consecutive bars of price-volume agreement indicate highly persistent momentum.
// #SUGGEST_VERIFY: Verify streakThreshold (>= 2) is suitable for low-noise signals.
function normalizeParams(params: StrategyParams): StrategyParams {
    return {
        ...params,
        lookback: Math.max(5, Math.round(Number(params.lookback ?? 20))),
        streakThreshold: Math.max(1, Math.round(Number(params.streakThreshold ?? 4))),
    };
}

export const price_volume_agreement_streak: Strategy = {
    name: "Price Volume Agreement Streak",
    description: "Enters on strong trend momentum when both price return direction and volume growth consecutively agree.",
    defaultParams: {
        lookback: 20,
        streakThreshold: 4,
    },
    paramLabels: {
        lookback: "Lookback",
        streakThreshold: "Streak Threshold",
    },
    normalizeParams,
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        const p = normalizeParams(params);
        const lookback = p.lookback as number;
        const streakThreshold = p.streakThreshold as number;
        if (cleanData.length < lookback + 1) return [];

        const volumes = getVolumes(cleanData);
        const avgVolumes = buildRollingAverage(volumes, lookback);

        // Pre-build the agreement flags: 1 = bullish agreement, -1 = bearish agreement, 0 = no agreement
        const agreementFlags: number[] = new Array(cleanData.length).fill(0);
        for (let i = 0; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const avgVol = avgVolumes[i];
            if (avgVol === null || avgVol <= 0) continue;

            const isBullish = bar.close > bar.open && bar.volume > avgVol;
            const isBearish = bar.close < bar.open && bar.volume > avgVol;

            agreementFlags[i] = isBullish ? 1 : isBearish ? -1 : 0;
        }

        const streaks = buildStreakCount(agreementFlags);

        return createSignalLoop(cleanData, [avgVolumes], (i) => {
            const streak = streaks[i];

            // Buy: Consecutively bullish agreement reaches positive streakThreshold
            if (streak >= streakThreshold) {
                return createBuySignal(
                    cleanData,
                    i,
                    `Bullish momentum: price-volume agreement streak reached ${streak} consecutive bars`
                );
            }

            // Sell: Consecutively bearish agreement reaches negative streakThreshold
            if (streak <= -streakThreshold) {
                return createSellSignal(
                    cleanData,
                    i,
                    `Bearish momentum: price-volume agreement streak reached ${streak} consecutive bars`
                );
            }

            return null;
        });
    },
    metadata: {
        role: "entry",
        direction: "both",
        walkForwardParams: ["lookback", "streakThreshold"],
    },
};
