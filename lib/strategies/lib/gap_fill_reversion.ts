import { Strategy } from "../../types/strategies";
import { createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-frequency-core';

export const gap_fill_reversion: Strategy = {
  name: 'Gap Fill Reversion',
  description: 'Large gaps between open and prior close tend to partially fill within the same bar or shortly after, as liquidity returns and counter-party flow absorbs the imbalance.',
  defaultParams: { gapThreshold: 1.0 },
  paramLabels: { gapThreshold: 'Gap Percentage Threshold' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['gapThreshold'] },
  execute: (data, params) => {
    const { gapThreshold } = params as { gapThreshold: number };
    const cleanData = ensureCleanData(data);
    const gapPct = extractBarMetricSeries(cleanData, 'gapPct');

    return createSignalLoop(cleanData, [], (i: number) => {
      const gap = gapPct[i];
      if (gap === null) return null;

      if (gap < -gapThreshold) return createBuySignal(cleanData, i, 'gap_fill_reversion_buy');
      if (gap > gapThreshold) return createSellSignal(cleanData, i, 'gap_fill_reversion_sell');
      
      return null;
    });
  }
};