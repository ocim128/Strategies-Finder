import { Strategy } from "../../types/strategies";
import { getCloses, getOpens, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-frequency-core';
import { buildStreakCount } from './price-action-statistics-core';

export const holographic_trend_persistence: Strategy = {
  name: 'Holographic Trend Persistence',
  description: 'Fades synthetic, uninterrupted robotic trends by counting consecutive bars where the True Range is expanding AND the close strictly follows the trend. Fades upon terminal exhaustion.',
  defaultParams: { streakThreshold: 5 },
  paramLabels: { streakThreshold: 'Exhaustion Streak' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['streakThreshold'] },
  execute: (data, params) => {
    const { streakThreshold } = params as { streakThreshold: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    const tr = extractBarMetricSeries(cleanData, 'trueRange');
    
    const upStreakCondition = new Array(cleanData.length).fill(0);
    const downStreakCondition = new Array(cleanData.length).fill(0);

    for (let i = 1; i < cleanData.length; i++) {
      if (tr[i] === null || tr[i - 1] === null) continue;
      
      const isExpanding = tr[i]! > tr[i - 1]!;
      if (isExpanding) {
        if (closes[i]! < opens[i]!) downStreakCondition[i] = 1;
        if (closes[i]! > opens[i]!) upStreakCondition[i] = 1;
      }
    }

    const downStreak = buildStreakCount(downStreakCondition);
    const upStreak = buildStreakCount(upStreakCondition);

    return createSignalLoop(cleanData, [], (i: number) => {
      const dStreak = downStreak[i];
      const uStreak = upStreak[i];

      if (dStreak === null || uStreak === null) return null;

      // Buy when a persistent down-streak is exhausted
      if (dStreak >= streakThreshold) return createBuySignal(cleanData, i, 'holographic_trend_persistence_buy');
      // Sell when a persistent up-streak is exhausted
      if (uStreak >= streakThreshold) return createSellSignal(cleanData, i, 'holographic_trend_persistence_sell');

      return null;
    });
  }
};