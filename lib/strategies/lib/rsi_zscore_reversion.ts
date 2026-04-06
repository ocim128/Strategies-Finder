import { Strategy, OHLCVData, Signal, StrategyParams } from '../../types/strategies';
import { getCloses, getOpens, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';
import { buildRollingZScore } from './price-action-statistics-core';
import { calculateRSI } from '../indicators';

export const rsi_zscore_reversion: Strategy = {
  name: 'RSI Z-Score Reversion',
  description: 'Normalizes RSI into a rolling Z-Score to dynamically adapt to changing momentum regimes, fading statistically extreme RSI dislocations.',
  defaultParams: {
    rsiPeriod: 14,
    zscoreLookback: 50,
    zscoreExtreme: 2.5
  },
  paramLabels: {
    rsiPeriod: 'RSI Period',
    zscoreLookback: 'Z-Score Lookback',
    zscoreExtreme: 'Z-Score Extreme'
  },
  normalizeParams: (params: StrategyParams) => ({
    rsiPeriod: Math.max(2, Math.round(params.rsiPeriod ?? 14)),
    zscoreLookback: Math.max(2, Math.round(params.zscoreLookback ?? 50)),
    zscoreExtreme: Math.max(0, Number(params.zscoreExtreme ?? 2.5))
  }),
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['rsiPeriod', 'zscoreLookback', 'zscoreExtreme']
  },
  execute(data: OHLCVData[], params) {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const opens = getOpens(cleanData);
    
    const rsi = calculateRSI(closes, params.rsiPeriod);
    const rsiNonNull = rsi.map(v => v ?? 0);
    const rsiZscore = buildRollingZScore(rsiNonNull, params.zscoreLookback);

    const signals: Signal[] = [];
    
    for (let i = Math.max(params.rsiPeriod, params.zscoreLookback); i < cleanData.length; i++) {
        const z = rsiZscore[i];
        if (z === null) continue;
        
        if (z < -params.zscoreExtreme && closes[i] > opens[i]) {
            signals.push(createBuySignal(cleanData, i, 'RSI Z-Score Reversion'));
        }
        else if (z > params.zscoreExtreme && closes[i] < opens[i]) {
            signals.push(createSellSignal(cleanData, i, 'RSI Z-Score Reversion'));
        }
    }
    
    return signals;
  }
};
