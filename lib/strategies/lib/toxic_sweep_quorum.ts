import { Strategy, OHLCVData, StrategyParams } from "../../types/strategies";
import {
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  ensureCleanData,
  getCloses,
} from "../strategy-helpers";
import { buildStreakCount, buildEfficiencyRatio, buildRollingZScore } from "./price-action-statistics-core";

function normalizeToxicSweepQuorumParams(params: StrategyParams): StrategyParams {
  return {
    ...params,
    lookback: Math.max(3, Math.round(params.lookback ?? 8)),
    er_threshold: Math.max(0.1, Math.min(1.0, Number(params.er_threshold ?? 0.8))),
  };
}

export const toxic_sweep_quorum: Strategy = {
  name: "Toxic Sweep Quorum",
  description: "A true toxic flow sweep requires a unanimous quorum: consecutive tick streaks, extreme linear efficiency, and absolute price displacement.",
  defaultParams: {
    lookback: 8,
    er_threshold: 0.8,
  },
  paramLabels: {
    lookback: "Lookback",
    er_threshold: "Efficiency Threshold",
  },
  normalizeParams: normalizeToxicSweepQuorumParams,
  execute: (data: OHLCVData[], params: StrategyParams) => {
    const cleanData = ensureCleanData(data);
    const p = normalizeToxicSweepQuorumParams(params);
    const lookback = p.lookback as number;
    const erThreshold = p.er_threshold as number;

    if (cleanData.length < lookback) return [];

    const closes = getCloses(cleanData);
    const streaks = buildStreakCount(closes);
    const er = buildEfficiencyRatio(cleanData, lookback);
    const zScore = buildRollingZScore(closes, lookback);

    return createSignalLoop(cleanData, [streaks, er, zScore], (i) => {
      if (i < lookback) return null;
      
      const currStreak = streaks[i];
      const currEr = er[i];
      const currZ = zScore[i];
      
      if (currStreak === null || currEr === null || currZ === null) return null;

      const currClose = closes[i];
      const lookbackClose = closes[i - lookback];

      // Buy Quorum: Streak >= 3 AND ER > er_threshold AND Close > Close[lookback] AND Z-Score > 2.0
      if (currStreak >= 3 && currEr > erThreshold && currClose > lookbackClose && currZ > 2.0) {
        return createBuySignal(cleanData, i, "Upside toxic sweep quorum");
      }

      // Sell Quorum: Streak <= -3 AND ER > er_threshold AND Close < Close[lookback] AND Z-Score < -2.0
      if (currStreak <= -3 && currEr > erThreshold && currClose < lookbackClose && currZ < -2.0) {
        return createSellSignal(cleanData, i, "Downside toxic sweep quorum");
      }

      return null;
    });
  },
  metadata: {
    role: "entry",
    direction: "both",
    walkForwardParams: ["lookback", "er_threshold"],
  },
};