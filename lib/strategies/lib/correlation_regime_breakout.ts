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
  buildRollingMinMax
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    corrThreshold: Number(params.corrThreshold ?? 0.6)
  };
}

export const correlation_regime_breakout: Strategy = {
  name: 'Correlation Regime Breakout',
  description: 'Takes directional breakouts only when the correlation between price and volume is heavily positive, confirming broad participation.',
  defaultParams: {
    lookback: 20,
    corrThreshold: 0.6
  },
  paramLabels: {
    lookback: 'Lookback Period',
    corrThreshold: 'Correlation Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'corrThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, corrThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    
    const correlation = buildRollingCorrelation(closes, volumes, lookback);
    const minMax = buildRollingMinMax(closes, lookback);

    return createSignalLoop(
      cleanData,
      [correlation, minMax.min, minMax.max],
      (i) => {
        if (i === 0) return null;
        if (correlation[i] === null) return null;

        const currentClose = closes[i];
        const prevMin = minMax.min[i - 1];
        const prevMax = minMax.max[i - 1];

        if (prevMin === null || prevMax === null) return null;

        if (currentClose > prevMax && correlation[i]! > corrThreshold) {
          return createBuySignal(cleanData, i, 'Correlation Breakout Buy');
        }

        if (currentClose < prevMin && correlation[i]! > corrThreshold) {
          return createSellSignal(cleanData, i, 'Correlation Breakout Sell');
        }

        return null;
      }
    );
  }
};
