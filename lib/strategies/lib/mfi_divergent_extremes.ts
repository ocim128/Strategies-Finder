import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getHighs, 
  getLows,
  getVolumes,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { calculateMFI } from '../indicators';
import { buildRollingMinMax } from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    mfiThreshold: Number(params.mfiThreshold ?? 30)
  };
}

export const mfi_divergent_extremes: Strategy = {
  name: 'MFI Divergent Extremes',
  description: 'Fades new local price extremes when the Money Flow Index (MFI) fails to confirm the momentum, signaling volume exhaustion.',
  defaultParams: {
    lookback: 20,
    mfiThreshold: 30
  },
  paramLabels: {
    lookback: 'Lookback Period',
    mfiThreshold: 'MFI Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'mfiThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, mfiThreshold } = normalizeParams(params);

    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    
    const mfi = calculateMFI(highs, lows, closes, volumes, lookback);
    
    const highMinMax = buildRollingMinMax(highs, lookback);
    const lowMinMax = buildRollingMinMax(lows, lookback);

    return createSignalLoop(
      cleanData,
      [mfi, highMinMax.max, lowMinMax.min],
      (i) => {
        if (i === 0) return null;
        if (mfi[i] === null) return null;

        const currentLow = lows[i];
        const currentHigh = highs[i];
        const prevMin = lowMinMax.min[i - 1];
        const prevMax = highMinMax.max[i - 1];

        if (prevMin === null || prevMax === null) return null;

        if (currentLow < prevMin && mfi[i]! > mfiThreshold) {
          return createBuySignal(cleanData, i, 'MFI Divergence Buy');
        }

        if (currentHigh > prevMax && mfi[i]! < (100 - mfiThreshold)) {
          return createSellSignal(cleanData, i, 'MFI Divergence Sell');
        }

        return null;
      }
    );
  }
};



