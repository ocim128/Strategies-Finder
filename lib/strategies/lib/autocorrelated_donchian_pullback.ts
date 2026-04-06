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
  buildRollingAutoCorrelation
} from './price-action-statistics-core';
import { calculateDonchianChannels } from '../indicators';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    channelLookback: Math.max(2, Math.round(params.channelLookback ?? 20)),
    autoCorrLookback: Math.max(10, Math.round(params.autoCorrLookback ?? 30)),
    autoCorrThreshold: Number(params.autoCorrThreshold ?? 0.5)
  };
}

export const autocorrelated_donchian_pullback: Strategy = {
  name: 'Autocorrelated Donchian Pullback',
  description: 'Treats the Donchian midpoint as a dynamic trend line, buying crosses exclusively when the asset\'s autocorrelation proves a deep, mathematically persistent regime.',
  defaultParams: {
    channelLookback: 20,
    autoCorrLookback: 30,
    autoCorrThreshold: 0.5
  },
  paramLabels: {
    channelLookback: 'Donchian Lookback',
    autoCorrLookback: 'AutoCorr Lookback',
    autoCorrThreshold: 'AutoCorr Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['channelLookback', 'autoCorrLookback', 'autoCorrThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { channelLookback, autoCorrLookback, autoCorrThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    
    const donchian = calculateDonchianChannels(highs, lows, channelLookback);
    const autocorrelation = buildRollingAutoCorrelation(closes, autoCorrLookback);

    return createSignalLoop(
      cleanData,
      [autocorrelation, donchian.middle],
      (i) => {
        if (i === 0) return null;
        if (autocorrelation[i] === null || donchian.middle[i] === null || donchian.middle[i-1] === null) return null;

        const currentClose = closes[i];
        const prevClose = closes[i-1];
        const currentMid = donchian.middle[i]!;
        const prevMid = donchian.middle[i-1]!;

        if (autocorrelation[i]! > autoCorrThreshold && currentClose > currentMid && prevClose <= prevMid) {
          return createBuySignal(cleanData, i, 'Autocorrelated Donchian Buy');
        }

        if (autocorrelation[i]! > autoCorrThreshold && currentClose < currentMid && prevClose >= prevMid) {
          return createSellSignal(cleanData, i, 'Autocorrelated Donchian Sell');
        }

        return null;
      }
    );
  }
};
