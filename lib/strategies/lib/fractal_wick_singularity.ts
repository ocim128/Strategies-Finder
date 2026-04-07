import { Strategy } from "../../types/strategies";
import { createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-frequency-core';
import { buildCumulativeDecaySum, buildRollingZScore } from './price-action-statistics-core';

export const fractal_wick_singularity: Strategy = {
  name: 'Fractal Wick Singularity',
  description: 'Models sequential, high-frequency wick rejections as a coiled kinetic spring using a decayed cumulative sum. Enters when this statistical tension reaches a mathematical singularity.',
  defaultParams: { decayFactor: 0.8, zscoreThreshold: 3.5 },
  paramLabels: { decayFactor: 'Decay Factor', zscoreThreshold: 'Z-Score Limit' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['decayFactor', 'zscoreThreshold'] },
  execute: (data, params) => {
    const { decayFactor, zscoreThreshold } = params as { decayFactor: number; zscoreThreshold: number };
    const cleanData = ensureCleanData(data);
    
    const wickImbalance = extractBarMetricSeries(cleanData, 'wickImbalance');
    const decaySum = buildCumulativeDecaySum(wickImbalance, decayFactor);
    // Let's use a 50-period lookback for Z-Score to normalize the decay sum
    const decayZScore = buildRollingZScore(decaySum, 50); 
    const closeLocation = extractBarMetricSeries(cleanData, 'closeMidpointDev');

    return createSignalLoop(cleanData, [], (i: number) => {
      if (i < 50) return null;
      
      const currZ = decayZScore[i];
      const cLoc = closeLocation[i];

      if (currZ === null || cLoc === null) return null;

      if (currZ < -zscoreThreshold && cLoc > 0.5) return createBuySignal(cleanData, i, 'fractal_wick_singularity_buy');
      if (currZ > zscoreThreshold && cLoc < 0.5) return createSellSignal(cleanData, i, 'fractal_wick_singularity_sell');
      
      return null;
    });
  }
};