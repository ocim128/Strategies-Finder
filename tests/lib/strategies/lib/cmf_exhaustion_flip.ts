import { Strategy, StrategyParams } from '../../types/strategies';
import { 
  getHighs,
  getLows,
  getCloses,
  getVolumes,
  ensureCleanData,
  createBuySignal,
  createSellSignal,
  createSignalLoop
} from '../strategy-helpers';
import { calculateCMF } from '../indicators';
import { buildStreakCount } from './price-action-statistics-core';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    streakRequired: Math.max(1, Math.round(params.streakRequired ?? 5))
  };
}

export const cmf_exhaustion_flip: Strategy = {
  name: 'CMF Exhaustion Flip',
  description: 'Detects prolonged periods of buying/selling pressure via Chaikin Money Flow, entering a reversal only when the pressure finally flips sign.',
  defaultParams: {
    lookback: 20,
    streakRequired: 5
  },
  paramLabels: {
    lookback: 'CMF Lookback',
    streakRequired: 'Consecutive Bars Required'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'streakRequired']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, streakRequired } = normalizeParams(params);

    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);

    const cmf = calculateCMF(highs, lows, closes, volumes, lookback);
    
    const posFlag = cmf.map(val => (val !== null && val > 0) ? 1 : 0);
    const negFlag = cmf.map(val => (val !== null && val < 0) ? 1 : 0);

    const posStreak = buildStreakCount(posFlag);
    const negStreak = buildStreakCount(negFlag);

    return createSignalLoop(
      cleanData,
      [cmf],
      (i) => {
        if (i < streakRequired) return null;
        if (cmf[i] === null || cmf[i-1] === null) return null;

        // Buy: CMF has been negative for at least `streakRequired` consecutive bars, and on the current bar crosses above 0.
        if (negStreak[i-1] >= streakRequired && cmf[i]! > 0 && cmf[i-1]! < 0) {
          return createBuySignal(cleanData, i, 'CMF Exhaustion Buy');
        }

        // Sell: CMF has been positive for at least `streakRequired` consecutive bars, and on the current bar crosses below 0.
        if (posStreak[i-1] >= streakRequired && cmf[i]! < 0 && cmf[i-1]! > 0) {
          return createSellSignal(cleanData, i, 'CMF Exhaustion Sell');
        }

        return null;
      }
    );
  }
};


