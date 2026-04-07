import { Strategy } from "../../types/strategies";
import { getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-frequency-core';
import { buildRateOfChange, buildPercentileRank } from './price-action-statistics-core';

export const synthetic_velocity_shockwave: Strategy = {
  name: 'Synthetic Velocity Shockwave',
  description: 'Surfs algorithmic momentum shockwaves where the sheer rate of change is historically unprecedented, and the underlying price geometry is almost entirely solid body.',
  defaultParams: { rocLookback: 3, percentileLookback: 200, bodyPctLimit: 0.85 },
  paramLabels: { rocLookback: 'ROC Window', percentileLookback: 'Percentile Window', bodyPctLimit: 'Min Body %' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['rocLookback', 'percentileLookback', 'bodyPctLimit'] },
  execute: (data, params) => {
    const { rocLookback, percentileLookback, bodyPctLimit } = params as { rocLookback: number; percentileLookback: number; bodyPctLimit: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const roc = buildRateOfChange(closes, rocLookback);
    // Use Math.round to ensure it stays valid
    const rocPercentile = buildPercentileRank(roc.map(r => r === null ? 0 : r), Math.round(percentileLookback));
    const bodyPct = extractBarMetricSeries(cleanData, 'bodyPct');

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < percentileLookback) return null;
      
      const currRoc = roc[i];
      const currPctRank = rocPercentile[i];
      const currBodyPct = bodyPct[i];

      if (currRoc === null || currPctRank === null || currBodyPct === null) return null;

      if (currBodyPct > bodyPctLimit) {
        if (currRoc > 0 && currPctRank > 0.99) return createBuySignal(cleanData, i, 'synthetic_velocity_shockwave_buy');
        if (currRoc < 0 && currPctRank < 0.01) return createSellSignal(cleanData, i, 'synthetic_velocity_shockwave_sell');
      }
      return null;
    });
  }
};