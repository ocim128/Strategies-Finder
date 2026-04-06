import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getVolumes,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildRollingCorrelation,
  buildRollingZScore
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 30)),
    zscoreThreshold: Number(params.zscoreThreshold ?? 2.5)
  };
}

export const negative_correlation_fade: Strategy = {
  name: 'Negative Correlation Fade',
  description: 'Fades extreme price moves if price and volume are negatively correlated, indicating the market is moving fast but on thin/failing liquidity.',
  defaultParams: {
    lookback: 30,
    zscoreThreshold: 2.5
  },
  paramLabels: {
    lookback: 'Lookback Period',
    zscoreThreshold: 'Z-Score Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'zscoreThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, zscoreThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    
    const correlation = buildRollingCorrelation(closes, volumes, lookback);
    const zscore = buildRollingZScore(closes, lookback);

    return createSignalLoop(
      cleanData,
      [correlation, zscore],
      (i) => {
        if (correlation[i] === null || zscore[i] === null) return null;

        if (zscore[i]! < -zscoreThreshold && correlation[i]! < -0.5) {
          return createBuySignal(cleanData, i, 'Negative Correlation Fade Buy');
        }

        if (zscore[i]! > zscoreThreshold && correlation[i]! < -0.5) {
          return createSellSignal(cleanData, i, 'Negative Correlation Fade Sell');
        }

        return null;
      }
    );
  }
};

