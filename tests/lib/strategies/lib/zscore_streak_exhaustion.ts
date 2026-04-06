import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getOpens,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildStreakCount,
  buildRollingZScore
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    streakRequired: Math.max(1, Math.round(params.streakRequired ?? 5)),
    zscoreLookback: Math.max(10, Math.round(params.zscoreLookback ?? 40)),
    zscoreExtreme: Number(params.zscoreExtreme ?? 2.5)
  };
}

export const zscore_streak_exhaustion: Strategy = {
  name: 'Z-Score Streak Exhaustion',
  description: 'Fades directional closing streaks only when the continuous streak duration coincides with a mathematically extreme price Z-Score, guaranteeing the move is statistically broken.',
  defaultParams: {
    streakRequired: 5,
    zscoreLookback: 40,
    zscoreExtreme: 2.5
  },
  paramLabels: {
    streakRequired: 'Consecutive Closes',
    zscoreLookback: 'Z-Score Lookback',
    zscoreExtreme: 'Z-Score Extreme'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['streakRequired', 'zscoreLookback', 'zscoreExtreme']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { streakRequired, zscoreLookback, zscoreExtreme } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    const upFlags = closes.map((c, i) => (i > 0 && c > closes[i-1]) ? 1 : 0);
    const downFlags = closes.map((c, i) => (i > 0 && c < closes[i-1]) ? 1 : 0);

    const upStreak = buildStreakCount(upFlags);
    const downStreak = buildStreakCount(downFlags);
    const zscore = buildRollingZScore(closes, zscoreLookback);

    return createSignalLoop(
      cleanData,
      [upStreak, downStreak, zscore],
      (i) => {
        if (zscore[i] === null) return null;

        const currentClose = closes[i];
        const currentOpen = opens[i];

        if (downStreak[i] >= streakRequired && zscore[i]! < -zscoreExtreme && currentClose > currentOpen) {
          return createBuySignal(cleanData, i, 'Z-Score Streak Exhaustion Buy');
        }

        if (upStreak[i] >= streakRequired && zscore[i]! > zscoreExtreme && currentClose < currentOpen) {
          return createSellSignal(cleanData, i, 'Z-Score Streak Exhaustion Sell');
        }

        return null;
      }
    );
  }
};
