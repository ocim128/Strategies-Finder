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
import { calculateDonchianChannels } from '../indicators';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 20))
  };
}

export const donchian_turtle_soup_fade: Strategy = {
  name: 'Donchian Turtle Soup Fade',
  description: 'Fades false breakouts of the Donchian channel. Triggers when price pokes a new high/low but closes back inside the range, trapping breakout traders.',
  defaultParams: {
    lookback: 20
  },
  paramLabels: {
    lookback: 'Donchian Period'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    
    const donchian = calculateDonchianChannels(highs, lows, lookback);

    return createSignalLoop(
      cleanData,
      [donchian.upper, donchian.lower],
      (i) => {
        if (i === 0) return null;
        if (donchian.upper[i-1] === null || donchian.lower[i-1] === null) return null;

        const currentClose = closes[i];
        const currentHigh = highs[i];
        const currentLow = lows[i];
        const prevUpper = donchian.upper[i-1]!;
        const prevLower = donchian.lower[i-1]!;

        // False breakdown: High < Upper, Low < Lower, but Close > Lower
        if (currentHigh < prevUpper && currentLow < prevLower && currentClose > prevLower) {
          return createBuySignal(cleanData, i, 'Turtle Soup Buy');
        }

        // False breakout: Low > Lower, High > Upper, but Close < Upper
        if (currentLow > prevLower && currentHigh > prevUpper && currentClose < prevUpper) {
          return createSellSignal(cleanData, i, 'Turtle Soup Sell');
        }

        return null;
      }
    );
  }
};
