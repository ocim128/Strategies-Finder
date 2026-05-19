import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildStreakCount } from "./price-action-statistics-core";

function normalizeAlgorithmicPersistenceTrapParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    streak_threshold: Math.max(2, Math.round(params.streak_threshold ?? 7)),
  };
}

export const algorithmic_persistence_trap: Strategy = {
  name: "Algorithmic Persistence Trap",
  description: "HFT programs often run in strict linear loops (e.g. 7 consecutive up-ticks). When the loop ends after an unusually long run, fade the entire sequence.",
  defaultParams: {
    streak_threshold: 7,
  },
  paramLabels: {
    streak_threshold: "Min Streak Count",
  },
  normalizeParams: normalizeAlgorithmicPersistenceTrapParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeAlgorithmicPersistenceTrapParams(params);
    const streakThreshold = p.streak_threshold as number;

    if (cleanData.length < streakThreshold + 1) return [];

    const closes = getCloses(cleanData);
    const streaks = buildStreakCount(closes);

    return createSignalLoop(cleanData, [streaks], (i) => {
      if (i < 1) return null;
      
      const prevStreak = streaks[i - 1];
      if (prevStreak === null) return null;

      const currClose = closes[i];
      const prevClose = closes[i - 1];

      // Buy: Previous Streak <= -streak_threshold AND Current Close > Previous Close
      if (prevStreak <= -streakThreshold && currClose > prevClose) {
        return createBuySignal(cleanData, i, "Fade broken downside execution loop");
      }

      // Sell: Previous Streak >= streak_threshold AND Current Close < Previous Close
      if (prevStreak >= streakThreshold && currClose < prevClose) {
        return createSellSignal(cleanData, i, "Fade broken upside execution loop");
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