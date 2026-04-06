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
import { 
  extractBarMetricSeries
} from './price-action-statistics-core';
import { buildRollingAverage } from './price-action-frequency-core';
import { calculateDonchianChannels } from '../indicators';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    channelLookback: Math.max(2, Math.round(params.channelLookback ?? 20)),
    volMultiplier: Number(params.volMultiplier ?? 2.5),
    closeLocThreshold: Number(params.closeLocThreshold ?? 0.75)
  };
}

export const donchian_climax_absorption: Strategy = {
  name: 'Donchian Climax Absorption',
  description: 'Buys structural channel breakdowns exactly when massive volume prints but the close is completely rejected, signaling the breakdown was a manufactured liquidity sweep.',
  defaultParams: {
    channelLookback: 20,
    volMultiplier: 2.5,
    closeLocThreshold: 0.75
  },
  paramLabels: {
    channelLookback: 'Donchian Lookback',
    volMultiplier: 'Volume Multiplier',
    closeLocThreshold: 'Close Loc Threshold'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['channelLookback', 'volMultiplier', 'closeLocThreshold']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { channelLookback, volMultiplier, closeLocThreshold } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const volumes = getVolumes(cleanData);
    
    const donchian = calculateDonchianChannels(highs, lows, channelLookback);
    const volSMA = buildRollingAverage(volumes, channelLookback);
    const closeLocation = extractBarMetricSeries(cleanData, 'closeLocation');

    return createSignalLoop(
      cleanData,
      [donchian.lower, donchian.upper, volSMA, closeLocation],
      (i) => {
        if (i === 0) return null;
        if (donchian.lower[i-1] === null || donchian.upper[i-1] === null || volSMA[i] === null || closeLocation[i] === null) return null;

        const currentClose = closes[i];
        const currentVol = volumes[i];
        const avgVol = volSMA[i]!;

        if (currentClose < donchian.lower[i-1]! && currentVol > avgVol * volMultiplier && closeLocation[i]! > closeLocThreshold) {
          return createBuySignal(cleanData, i, 'Donchian Climax Absorption Buy');
        }

        if (currentClose > donchian.upper[i-1]! && currentVol > avgVol * volMultiplier && closeLocation[i]! < (1.0 - closeLocThreshold)) {
          return createSellSignal(cleanData, i, 'Donchian Climax Absorption Sell');
        }

        return null;
      }
    );
  }
};
