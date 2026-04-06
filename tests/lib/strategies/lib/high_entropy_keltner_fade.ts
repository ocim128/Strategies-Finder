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
  buildRollingEntropy,
  extractBarMetricSeries
} from './price-action-statistics-core';
import { calculateKeltnerChannels } from '../indicators';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    entropyLookback: Math.max(2, Math.round(params.entropyLookback ?? 30)),
    entropyThreshold: Number(params.entropyThreshold ?? 2.5),
    keltnerPeriod: Math.max(2, Math.round(params.keltnerPeriod ?? 20))
  };
}

export const high_entropy_keltner_fade: Strategy = {
  name: 'High Entropy Keltner Fade',
  description: 'Fades structural volatility band breakouts exactly when the market phase space is in a state of maximum entropy (pure noise), ensuring breakouts will mathematically fail.',
  defaultParams: {
    entropyLookback: 30,
    entropyThreshold: 2.5,
    keltnerPeriod: 20
  },
  paramLabels: {
    entropyLookback: 'Entropy Lookback',
    entropyThreshold: 'Entropy Threshold',
    keltnerPeriod: 'Keltner Period'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['entropyLookback', 'entropyThreshold', 'keltnerPeriod']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { entropyLookback, entropyThreshold, keltnerPeriod } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    
    // Difference closes for entropy
    const diffCloses = closes.map((c, i) => i === 0 ? 0 : c - closes[i-1]);
    const entropy = buildRollingEntropy(diffCloses, entropyLookback, 10);
    
    const keltner = calculateKeltnerChannels(highs, lows, closes, keltnerPeriod, keltnerPeriod, 2.0);
    const closeLocation = extractBarMetricSeries(cleanData, 'closeLocation');

    return createSignalLoop(
      cleanData,
      [entropy, keltner.lower, keltner.upper, closeLocation],
      (i) => {
        if (entropy[i] === null || keltner.lower[i] === null || keltner.upper[i] === null || closeLocation[i] === null) return null;

        const currentClose = closes[i];

        if (entropy[i]! > entropyThreshold && currentClose < keltner.lower[i]! && closeLocation[i]! > 0.6) {
          return createBuySignal(cleanData, i, 'High Entropy Keltner Rejection Buy');
        }

        if (entropy[i]! > entropyThreshold && currentClose > keltner.upper[i]! && closeLocation[i]! < 0.4) {
          return createSellSignal(cleanData, i, 'High Entropy Keltner Rejection Sell');
        }

        return null;
      }
    );
  }
};
