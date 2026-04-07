import { Strategy } from "../../types/strategies";
import { getCloses, getVolumes, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { buildRollingCorrelation, buildRollingAutoCorrelation, buildRollingZScore } from './price-action-statistics-core';

export const quantum_decoherence_fade: Strategy = {
  name: 'Quantum Decoherence Fade',
  description: 'Fades extremes where price and volume become maximally negatively correlated while the price path loses all memory (zero autocorrelation), indicating a highly unstable synthetic vacuum.',
  defaultParams: { lookback: 20, zscoreExtreme: 3.0 },
  paramLabels: { lookback: 'Observation Window', zscoreExtreme: 'Z-Score Extreme' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['lookback', 'zscoreExtreme'] },
  execute: (data, params) => {
    const { lookback, zscoreExtreme } = params as { lookback: number; zscoreExtreme: number };
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    
    const correlation = buildRollingCorrelation(closes, volumes, lookback);
    const autoCorr = buildRollingAutoCorrelation(closes, lookback);
    const zscore = buildRollingZScore(closes, lookback);

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < lookback) return null;
      
      const currCorr = correlation[i];
      const currAuto = autoCorr[i];
      const currZ = zscore[i];

      if (currCorr === null || currAuto === null || currZ === null) return null;

      if (currCorr < -0.7 && Math.abs(currAuto) < 0.1) {
        if (currZ < -zscoreExtreme) return createBuySignal(cleanData, i, 'quantum_decoherence_fade_buy');
        if (currZ > zscoreExtreme) return createSellSignal(cleanData, i, 'quantum_decoherence_fade_sell');
      }
      return null;
    });
  }
};