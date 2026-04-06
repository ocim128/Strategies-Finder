import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getCloses, 
  getOpens,
  getTypicalPrices,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { 
  buildRollingZScore
} from './price-action-statistics-core';
import { calculateSessionVWAP } from '../indicators';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    zscoreLookback: Math.max(10, Math.round(params.zscoreLookback ?? 50)),
    zscoreExtreme: Number(params.zscoreExtreme ?? 2.5)
  };
}

export const session_vwap_distance_zscore_exhaustion: Strategy = {
  name: 'Session VWAP Distance Z-Score Exhaustion',
  description: 'Transforms the absolute percentage distance from the Session VWAP into a rolling Z-score, fading institutional momentum exactly when it mathematically detaches from daily value.',
  defaultParams: {
    zscoreLookback: 50,
    zscoreExtreme: 2.5
  },
  paramLabels: {
    zscoreLookback: 'Z-Score Lookback',
    zscoreExtreme: 'Z-Score Extreme'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['zscoreLookback', 'zscoreExtreme']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { zscoreLookback, zscoreExtreme } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    const typicalPrices = getTypicalPrices(cleanData);
    
    const vwap = calculateSessionVWAP(cleanData);
    
    // Map an array of TypicalPrice - VWAP, replacing nulls with 0 or preserving nulls to be skipped
    const vwapDistance = typicalPrices.map((tp, i) => (vwap[i] !== null ? tp - vwap[i]! : 0));
    const zscore = buildRollingZScore(vwapDistance, zscoreLookback);

    return createSignalLoop(
      cleanData,
      [zscore],
      (i) => {
        if (zscore[i] === null) return null;

        const currentClose = closes[i];
        const currentOpen = opens[i];

        if (zscore[i]! < -zscoreExtreme && currentClose > currentOpen) {
          return createBuySignal(cleanData, i, 'Session VWAP Distance Z-Score Buy');
        }

        if (zscore[i]! > zscoreExtreme && currentClose < currentOpen) {
          return createSellSignal(cleanData, i, 'Session VWAP Distance Z-Score Sell');
        }

        return null;
      }
    );
  }
};
