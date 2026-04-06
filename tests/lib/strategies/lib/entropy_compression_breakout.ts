import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildRollingMinMax, 
  buildRateOfChange, 
  buildRollingEntropy 
} from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    entropyThreshold: Number(params.entropyThreshold ?? 1.5)
  };
}

export const entropy_compression_breakout: Strategy = {
  name: 'Entropy Compression Breakout',
  description: 'Buys directional breakouts exclusively from low-entropy (highly ordered/compressed) regimes, filtering out choppy or random price action.',
  defaultParams: {
    lookback: 20,
    entropyThreshold: 1.5
  },
  paramLabels: {
    lookback: 'Lookback Period',
    entropyThreshold: 'Entropy Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'entropyThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, entropyThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    
    const roc = buildRateOfChange(closes, 1);
    const rocFilled = roc.map(val => val ?? 0);
    // Use ROC for entropy to capture meaningful bits
    const entropy = buildRollingEntropy(rocFilled, lookback, 10);
    const minMax = buildRollingMinMax(closes, lookback);

    return createSignalLoop(
      cleanData,
      [entropy, minMax.min, minMax.max],
      (i) => {
        if (i === 0) return null;
        if (entropy[i] === null) return null;

        const currentClose = closes[i];
        const prevMin = minMax.min[i - 1];
        const prevMax = minMax.max[i - 1];

        if (prevMin === null || prevMax === null) return null;

        if (entropy[i]! < entropyThreshold && currentClose > prevMax) {
          return createBuySignal(cleanData, i, 'Entropy Compression Breakout Buy');
        }

        if (entropy[i]! < entropyThreshold && currentClose < prevMin) {
          return createSellSignal(cleanData, i, 'Entropy Compression Breakout Sell');
        }

        return null;
      }
    );
  }
};

