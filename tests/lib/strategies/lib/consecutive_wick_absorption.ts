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
  extractBarMetricSeries,
  buildStreakCount
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    wickRatio: Number(params.wickRatio ?? 0.5),
    streakRequired: Math.max(1, Math.round(params.streakRequired ?? 3))
  };
}

export const consecutive_wick_absorption: Strategy = {
  name: 'Consecutive Wick Absorption',
  description: 'Tracks sequential bars showing heavy rejection on the same side, entering opposite to the wicks when absorption is proven.',
  defaultParams: {
    wickRatio: 0.5,
    streakRequired: 3
  },
  paramLabels: {
    wickRatio: 'Wick Ratio Threshold',
    streakRequired: 'Consecutive Bars'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['wickRatio', 'streakRequired']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { wickRatio, streakRequired } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    const lowerWicks = extractBarMetricSeries(cleanData, 'lowerWick');
    const upperWicks = extractBarMetricSeries(cleanData, 'upperWick');
    const ranges = extractBarMetricSeries(cleanData, 'range');

    const lowerWickRatios = lowerWicks.map((val, i) => (ranges[i] !== null && ranges[i]! > 0) ? (val! / ranges[i]!) : 0);
    const upperWickRatios = upperWicks.map((val, i) => (ranges[i] !== null && ranges[i]! > 0) ? (val! / ranges[i]!) : 0);

    const lowerWickFlags = lowerWickRatios.map(val => val > wickRatio ? 1 : 0);
    const upperWickFlags = upperWickRatios.map(val => val > wickRatio ? 1 : 0);

    const lowerWickStreak = buildStreakCount(lowerWickFlags);
    const upperWickStreak = buildStreakCount(upperWickFlags);

    return createSignalLoop(
      cleanData,
      [lowerWickStreak, upperWickStreak], // Just dummy indicators for length sync if needed, though they aren't null-padded typically
      (i) => {
        if (i < streakRequired) return null;

        const currentClose = closes[i];
        const currentOpen = opens[i];

        if (lowerWickStreak[i] >= streakRequired && currentClose > currentOpen) {
          return createBuySignal(cleanData, i, 'Lower Wick Absorption Buy');
        }

        if (upperWickStreak[i] >= streakRequired && currentClose < currentOpen) {
          return createSellSignal(cleanData, i, 'Upper Wick Absorption Sell');
        }

        return null;
      }
    );
  }
};
