import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getOpens,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  extractBarMetricSeries,
} from './price-action-statistics-core';
import { buildRollingAverage } from './price-action-frequency-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    multiplier: Number(params.multiplier ?? 2.5)
  };
}

export const body_expansion_thrust: Strategy = {
  name: 'Body Expansion Thrust',
  description: 'Identifies sudden, massive structural body expansions relative to the rolling average body, acting as a momentum continuation trigger.',
  defaultParams: {
    lookback: 20,
    multiplier: 2.5
  },
  paramLabels: {
    lookback: 'Average Body Lookback',
    multiplier: 'Expansion Multiplier'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'multiplier']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, multiplier } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    const bodies = extractBarMetricSeries(cleanData, 'body');
    const closeLocations = extractBarMetricSeries(cleanData, 'closeLocation');
    
    // Replace nulls with 0 for rolling average
    const cleanBodies = bodies.map(b => b ?? 0);
    const avgBody = buildRollingAverage(cleanBodies, lookback);

    return createSignalLoop(
      cleanData,
      [avgBody, closeLocations, bodies],
      (i) => {
        if (avgBody[i] === null || closeLocations[i] === null || bodies[i] === null) return null;

        const currentClose = closes[i];
        const currentOpen = opens[i];
        const currentBody = bodies[i]!;
        const avgB = avgBody[i]!;
        const loc = closeLocations[i]!;

        if (currentBody > avgB * multiplier && currentClose > currentOpen && loc > 0.8) {
          return createBuySignal(cleanData, i, 'Body Expansion Thrust Buy');
        }

        if (currentBody > avgB * multiplier && currentClose < currentOpen && loc < 0.2) {
          return createSellSignal(cleanData, i, 'Body Expansion Thrust Sell');
        }

        return null;
      }
    );
  }
};
