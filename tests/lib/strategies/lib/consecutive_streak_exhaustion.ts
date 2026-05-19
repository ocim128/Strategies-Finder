import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeConsecutiveStreakExhaustionParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    streak_threshold: Math.max(2, Math.round(params.streak_threshold ?? 5)),
  };
}

export const consecutive_streak_exhaustion: Strategy = {
  name: "Consecutive Streak Exhaustion",
  description: "Extended streaks of consecutive higher or lower closes represent unsustainable linear participation. Once a counter-candle prints, the rubber band snaps back.",
  defaultParams: {
    streak_threshold: 5,
  },
  paramLabels: {
    streak_threshold: "Min Streak Count",
  },
  normalizeParams: normalizeConsecutiveStreakExhaustionParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeConsecutiveStreakExhaustionParams(params);
    const streakThreshold = p.streak_threshold as number;

    if (cleanData.length < streakThreshold + 1) return [];

    const closes = getCloses(cleanData);
    const streaks = buildStreakCount(closes);

    return createSignalLoop(cleanData, [streaks], (i) => {
      if (i < 1) return null;
      
      const prevStreak = streaks[i - 1];
      if (prevStreak === null) return null;

      const currBar = cleanData[i];

      // Buy: Prior bar Streak Count <= -streak_threshold AND current bar Close > Open (green reversal candle)
      if (prevStreak <= -streakThreshold && currBar.close > currBar.open) {
        return createBuySignal(cleanData, i, "Reversion from downside exhaustion streak");
      }

      // Sell: Prior bar Streak Count >= streak_threshold AND current bar Close < Open (red reversal candle)
      if (prevStreak >= streakThreshold && currBar.close < currBar.open) {
        return createSellSignal(cleanData, i, "Reversion from upside exhaustion streak");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["streak_threshold"],
  },
};