import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
  getVolumes,
} from "../strategy-helpers";
import { buildStreakCount, buildRollingZScore } from "./price-action-statistics-core";

function normalizeInventoryExhaustionFadeParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    streak_threshold: Math.max(2, Math.round(params.streak_threshold ?? 4)),
    vol_z_exhaustion: Math.min(-0.1, Number(params.vol_z_exhaustion ?? -1.0)),
  };
}

export const inventory_exhaustion_fade: Strategy = {
  name: "Inventory Exhaustion Fade",
  description: "If an algorithm prints a continuous streak of higher/lower closes, but volume drops significantly below average, the algo has run out of inventory. Fade the top/bottom.",
  defaultParams: {
    streak_threshold: 4,
    vol_z_exhaustion: -1.0,
  },
  paramLabels: {
    streak_threshold: "Min Streak Count",
    vol_z_exhaustion: "Vol Z-Score Exhaustion",
  },
  normalizeParams: normalizeInventoryExhaustionFadeParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeInventoryExhaustionFadeParams(params);
    const streakThreshold = p.streak_threshold as number;
    const volZExhaustion = p.vol_z_exhaustion as number;

    // #COMPLETION_DRIVE: Assumed standard 20-period lookback for the Volume Z-score
    // #SUGGEST_VERIFY: Test exposing a `vol_lookback` parameter for tuning
    const lookback = 20;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    
    const streaks = buildStreakCount(closes);
    const volZScore = buildRollingZScore(volumes, lookback);

    return createSignalLoop(cleanData, [streaks, volZScore], (i) => {
      if (i < lookback) return null;
      
      const prevStreak = streaks[i - 1];
      const currVolZ = volZScore[i];
      
      if (prevStreak === null || currVolZ === null) return null;

      const currClose = closes[i];
      const prevClose = closes[i - 1];

      // Buy: Previous Streak <= -streak_threshold AND Volume Z-Score < vol_z_exhaustion AND Close > previous Close
      if (prevStreak <= -streakThreshold && currVolZ < volZExhaustion && currClose > prevClose) {
        return createBuySignal(cleanData, i, "Upside reversal (downward inventory exhaustion)");
      }

      // Sell: Previous Streak >= streak_threshold AND Volume Z-Score < vol_z_exhaustion AND Close < previous Close
      if (prevStreak >= streakThreshold && currVolZ < volZExhaustion && currClose < prevClose) {
        return createSellSignal(cleanData, i, "Downside reversal (upward inventory exhaustion)");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["streak_threshold", "vol_z_exhaustion"],
  },
};