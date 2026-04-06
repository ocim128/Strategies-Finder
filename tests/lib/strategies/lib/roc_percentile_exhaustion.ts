import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildRateOfChange,
  buildPercentileRank
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    rocLookback: Math.max(1, Math.round(params.rocLookback ?? 3)),
    percentileLookback: Math.max(10, Math.round(params.percentileLookback ?? 100)),
    percentileExtreme: Number(params.percentileExtreme ?? 0.98)
  };
}

export const roc_percentile_exhaustion: Strategy = {
  name: 'ROC Percentile Exhaustion',
  description: 'Evaluates the rate of change relative to its own rolling percentile rank, fading mathematically extreme velocity snaps.',
  defaultParams: {
    rocLookback: 3,
    percentileLookback: 100,
    percentileExtreme: 0.98
  },
  paramLabels: {
    rocLookback: 'ROC Lookback',
    percentileLookback: 'Percentile Window',
    percentileExtreme: 'Percentile Extreme'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['rocLookback', 'percentileLookback', 'percentileExtreme']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { rocLookback, percentileLookback, percentileExtreme } = normalizeParams(params);

    const closes = getCloses(cleanData);
    
    const roc = buildRateOfChange(closes, rocLookback);
    // Fill nulls with 0 so buildPercentileRank works properly
    const rocFilled = roc.map(v => v ?? 0);
    const rocPercentile = buildPercentileRank(rocFilled, percentileLookback);

    return createSignalLoop(
      cleanData,
      [rocPercentile],
      (i) => {
        if (i < rocLookback + percentileLookback) return null; // Ensure warm-up
        if (rocPercentile[i] === null) return null;

        if (rocPercentile[i]! < (1.0 - percentileExtreme)) {
          return createBuySignal(cleanData, i, 'ROC Percentile Buy');
        }

        if (rocPercentile[i]! > percentileExtreme) {
          return createSellSignal(cleanData, i, 'ROC Percentile Sell');
        }

        return null;
      }
    );
  }
};

