import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getOpens,
  getVolumes,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  extractBarMetricSeries
} from './price-action-statistics-core';
import { buildRollingAverage } from './price-action-frequency-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    volLookback: Math.max(2, Math.round(params.volLookback ?? 20)),
    volMultiplier: Number(params.volMultiplier ?? 3.0),
    closeLocThreshold: Number(params.closeLocThreshold ?? 0.7)
  };
}

export const volume_climax_exhaustion_fade: Strategy = {
  name: 'Volume Climax Exhaustion Fade',
  description: 'Fades massive volume spikes that result in strong wick rejections, signaling institutional absorption of retail panic.',
  defaultParams: {
    volLookback: 20,
    volMultiplier: 3.0,
    closeLocThreshold: 0.7
  },
  paramLabels: {
    volLookback: 'Volume Lookback',
    volMultiplier: 'Volume Spike Multiplier',
    closeLocThreshold: 'Close Location Rejection'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['volLookback', 'volMultiplier', 'closeLocThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { volLookback, volMultiplier, closeLocThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    const volumes = getVolumes(cleanData);
    
    const avgVol = buildRollingAverage(volumes, volLookback);
    const closeLocation = extractBarMetricSeries(cleanData, 'closeLocation');

    return createSignalLoop(
      cleanData,
      [avgVol, closeLocation],
      (i) => {
        if (i === 0) return null;
        if (avgVol[i-1] === null || closeLocation[i] === null) return null;

        const currentVol = volumes[i];
        const prevAvg = avgVol[i-1]!;
        const currentClose = closes[i];
        const currentOpen = opens[i];
        const loc = closeLocation[i]!;

        if (currentVol > prevAvg * volMultiplier && loc > closeLocThreshold && currentClose > currentOpen) {
          return createBuySignal(cleanData, i, 'Volume Climax Absorption Buy');
        }

        if (currentVol > prevAvg * volMultiplier && loc < (1.0 - closeLocThreshold) && currentClose < currentOpen) {
          return createSellSignal(cleanData, i, 'Volume Climax Absorption Sell');
        }

        return null;
      }
    );
  }
};
