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
  buildRollingMinMax,
  extractBarMetricSeries
} from './price-action-statistics-core';
import { calculateATR } from '../indicators';

function normalizeParams(params: StrategyParams): StrategyParams {
  return {
    lookback: Math.max(2, Math.round(params.lookback ?? 20)),
    atrMultiplier: Number(params.atrMultiplier ?? 1.5)
  };
}

export const atr_trend_expansion_breakout: Strategy = {
  name: 'ATR Trend Expansion Breakout',
  description: 'A trend-following entry that demands the breakout bar has a True Range significantly larger than the recent average ATR, confirming true momentum.',
  defaultParams: {
    lookback: 20,
    atrMultiplier: 1.5
  },
  paramLabels: {
    lookback: 'Lookback Window',
    atrMultiplier: 'ATR Multiplier'
  },
  normalizeParams,
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'atrMultiplier']
  },

  execute: (data, params) => {
    const cleanData = ensureCleanData(data);
    const { lookback, atrMultiplier } = normalizeParams(params);

    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    
    const minMax = buildRollingMinMax(closes, lookback);
    const atr = calculateATR(highs, lows, closes, lookback);
    const trueRange = extractBarMetricSeries(cleanData, 'trueRange');

    return createSignalLoop(
      cleanData,
      [minMax.min, minMax.max, atr, trueRange],
      (i) => {
        if (i === 0) return null;
        if (minMax.min[i-1] === null || minMax.max[i-1] === null || atr[i] === null || trueRange[i] === null) return null;

        const currentClose = closes[i];
        const prevMin = minMax.min[i-1]!;
        const prevMax = minMax.max[i-1]!;
        const tr = trueRange[i]!;
        const currentAtr = atr[i]!;

        if (currentClose > prevMax && tr > (currentAtr * atrMultiplier)) {
          return createBuySignal(cleanData, i, 'ATR Expansion Breakout Buy');
        }

        if (currentClose < prevMin && tr > (currentAtr * atrMultiplier)) {
          return createSellSignal(cleanData, i, 'ATR Expansion Breakout Sell');
        }

        return null;
      }
    );
  }
};
