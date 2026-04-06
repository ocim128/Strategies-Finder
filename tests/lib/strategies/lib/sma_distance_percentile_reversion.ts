import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop,
  getOpens
} from '../strategy-helpers';
import { buildPercentileRank } from './price-action-statistics-core';
import { buildRollingAverage } from './price-action-frequency-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    smaLookback: Math.max(2, Math.round(params.smaLookback ?? 50)),
    rankLookback: Math.max(10, Math.round(params.rankLookback ?? 100)),
    percentileExtreme: Number(params.percentileExtreme ?? 0.05)
  };
}

export const sma_distance_percentile_reversion: Strategy = {
  name: 'SMA Distance Percentile Reversion',
  description: 'Ranks the percentage distance from the SMA against its own history, fading when the distance reaches a historically extreme percentile.',
  defaultParams: {
    smaLookback: 50,
    rankLookback: 100,
    percentileExtreme: 0.05
  },
  paramLabels: {
    smaLookback: 'SMA Period',
    rankLookback: 'Percentile Rank Window',
    percentileExtreme: 'Percentile Extreme'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['smaLookback', 'rankLookback', 'percentileExtreme']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { smaLookback, rankLookback, percentileExtreme } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    const sma = buildRollingAverage(closes, smaLookback);
    
    const distance = closes.map((c, i) => {
      if (sma[i] === null) return null;
      return c - sma[i]!;
    });
    
    const safeDistance = distance.map(v => v ?? 0);
    const distanceRank = buildPercentileRank(safeDistance, rankLookback);

    return createSignalLoop(
      cleanData,
      [distanceRank],
      (i) => {
        if (i < smaLookback + rankLookback) return null;
        if (distanceRank[i] === null) return null;

        const currentClose = closes[i];
        const currentOpen = opens[i];

        if (distanceRank[i]! < percentileExtreme && currentClose > currentOpen) {
          return createBuySignal(cleanData, i, 'SMA Distance Reversion Buy');
        }

        if (distanceRank[i]! > (1.0 - percentileExtreme) && currentClose < currentOpen) {
          return createSellSignal(cleanData, i, 'SMA Distance Reversion Sell');
        }

        return null;
      }
    );
  }
};
