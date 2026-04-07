import { Strategy } from "../../types/strategies";
import { getCloses } from '../strategy-helpers';
import { buildRollingEntropy, buildRollingSkewness } from './price-action-statistics-core';
import { createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';

export const phase_space_attractor_collapse: Strategy = {
  name: 'Phase Space Attractor Collapse',
  description: 'Identifies moments when the market is in maximum chaos (peak entropy) but the internal distribution violently skews, signaling a hidden algorithmic attractor pulling the noise into a new trend.',
  defaultParams: {
    lookback: 30,
    entropyThreshold: 2.5,
    skewExtreme: 1.5 },
  paramLabels: {
    lookback: 'Lookback Window',
    entropyThreshold: 'Entropy Threshold',
    skewExtreme: 'Skewness Extreme' },
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'entropyThreshold', 'skewExtreme'] },
  execute: (data, params) => {
    const { lookback, entropyThreshold, skewExtreme } = params as { lookback: number; entropyThreshold: number; skewExtreme: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const entropy = buildRollingEntropy(closes, lookback, 5);
    const skewness = buildRollingSkewness(closes, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currEntropy = entropy[i];
      const currSkew = skewness[i];
      const prevSkew = skewness[i - 1];

      if (currEntropy === null || currSkew === null || prevSkew === null) return null;

      if (currEntropy > entropyThreshold) {
        if (prevSkew <= skewExtreme && currSkew > skewExtreme) return createBuySignal(cleanData, i, 'phase_space_attractor_collapse_buy');
        if (prevSkew >= -skewExtreme && currSkew < -skewExtreme) return createSellSignal(cleanData, i, 'phase_space_attractor_collapse_sell');
      }
      return null;
    });
  }
};