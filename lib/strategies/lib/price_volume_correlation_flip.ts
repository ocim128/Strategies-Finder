import { Strategy } from "../../types/strategies";
import { getVolumes, getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingCorrelation } from './price-action-statistics-core';

export const price_volume_correlation_flip: Strategy = {
  name: 'Price-Volume Correlation Flip',
  description: 'Rolling correlation between close returns and volume changes captures the participation-pressure relationship. When correlation flips sign, it signals a shift from trend-confirming to trend-exhausting volume behavior.',
  defaultParams: { lookback: 20, corrThreshold: 0.2 },
  paramLabels: { lookback: 'Window', corrThreshold: 'Threshold' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback', 'corrThreshold'] },
  execute: (data, params) => {
    const { lookback, corrThreshold } = params as { lookback: number; corrThreshold: number };
    const cleanData = ensureCleanData(data);
    const volumes = getVolumes(cleanData);
    const closes = getCloses(cleanData);
    
    const returns: number[] = new Array(closes.length).fill(0);
    const volChanges: number[] = new Array(volumes.length).fill(0);
    
    for (let i = 1; i < closes.length; i++) {
        returns[i] = closes[i]! / closes[i - 1]! - 1;
        volChanges[i] = volumes[i - 1]! !== 0 ? volumes[i]! / volumes[i - 1]! - 1 : 0;
    }

    const corr = buildRollingCorrelation(returns, volChanges, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      const currCorr = corr[i];
      const prevCorr = corr[i - 1];

      if (currCorr === null || prevCorr === null) return null;

      if (prevCorr < corrThreshold && currCorr >= corrThreshold) return createBuySignal(cleanData, i, 'price_volume_correlation_flip_buy');
      if (prevCorr > -corrThreshold && currCorr <= -corrThreshold) return createSellSignal(cleanData, i, 'price_volume_correlation_flip_sell');
      
      return null;
    });
  }
};