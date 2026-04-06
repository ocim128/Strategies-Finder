import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getHighs,
  getLows,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildPercentileRank,
  extractBarMetricSeries
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    rankLookback: Math.max(10, Math.round(params.rankLookback ?? 100)),
    compressionPercentile: Number(params.compressionPercentile ?? 0.05)
  };
}

export const range_contraction_momentum_snap: Strategy = {
  name: 'Range Contraction Momentum Snap',
  description: 'An ultra-compact structural volatility squeeze that triggers when a single bar\'s range hits a historic low percentile, entering on the subsequent bar\'s geometric breakout.',
  defaultParams: {
    rankLookback: 100,
    compressionPercentile: 0.05
  },
  paramLabels: {
    rankLookback: 'Rank Window',
    compressionPercentile: 'Compression Percentile'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['rankLookback', 'compressionPercentile']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { rankLookback, compressionPercentile } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    
    const ranges = extractBarMetricSeries(cleanData, 'range');
    const safeRanges = ranges.map(v => v ?? 0);
    const rangeRank = buildPercentileRank(safeRanges, rankLookback);

    return createSignalLoop(
      cleanData,
      [rangeRank],
      (i) => {
        if (i === 0) return null;
        if (rangeRank[i-1] === null) return null;

        const currentClose = closes[i];
        const prevHigh = highs[i-1];
        const prevLow = lows[i-1];

        if (rangeRank[i-1]! < compressionPercentile && currentClose > prevHigh) {
          return createBuySignal(cleanData, i, 'Range Contraction Breakout Buy');
        }

        if (rangeRank[i-1]! < compressionPercentile && currentClose < prevLow) {
          return createSellSignal(cleanData, i, 'Range Contraction Breakout Sell');
        }

        return null;
      }
    );
  }
};
