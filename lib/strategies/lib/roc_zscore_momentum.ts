import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRateOfChange, buildRollingZScore } from './price-action-statistics-core';

export const roc_zscore_momentum: Strategy = {
  name: 'ROC Z-Score Momentum',
  description: 'Z-scoring the rate-of-change normalizes momentum against its own recent distribution. When z-scored ROC exceeds a threshold, the current momentum is statistically extreme relative to its recent history, signaling acceleration worth following.',
  defaultParams: { rocPeriod: 10, zThreshold: 2.0 },
  paramLabels: { rocPeriod: 'ROC Window', zThreshold: 'Z-Score Threshold' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['rocPeriod', 'zThreshold'] },
  execute: (data, params) => {
    const { rocPeriod, zThreshold } = params as { rocPeriod: number; zThreshold: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const roc = buildRateOfChange(closes, rocPeriod);
    const rocNumeric = roc.map(v => v === null ? 0 : v);
    const rocZScore = buildRollingZScore(rocNumeric, rocPeriod * 3);

    return createSignalLoop(cleanData, [], (i: number) => {
      const currZ = rocZScore[i];
      const prevZ = rocZScore[i - 1];

      if (currZ === null || prevZ === null) return null;

      if (prevZ < zThreshold && currZ >= zThreshold) return createBuySignal(cleanData, i, 'roc_zscore_momentum_buy');
      if (prevZ > -zThreshold && currZ <= -zThreshold) return createSellSignal(cleanData, i, 'roc_zscore_momentum_sell');
      
      return null;
    });
  }
};