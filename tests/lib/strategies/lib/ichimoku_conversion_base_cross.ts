import { Strategy } from "../../types/strategies";
import { getHighs, getLows, getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData, checkCrossover } from '../strategy-helpers';
import { calculateIchimoku } from '../indicators';

export const ichimoku_conversion_base_cross: Strategy = {
  name: 'Ichimoku Conversion-Base Cross',
  description: 'The Ichimoku conversion line (fast midpoint) crossing the base line (slow midpoint) is the core directional signal. The crossover uses two different rolling-midpoint windows, making it a structurally grounded momentum shift detector.',
  defaultParams: { conversionPeriod: 9, basePeriod: 26 },
  paramLabels: { conversionPeriod: 'Conversion Period', basePeriod: 'Base Period' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['conversionPeriod', 'basePeriod'] },
  execute: (data, params) => {
    const { conversionPeriod, basePeriod } = params as { conversionPeriod: number; basePeriod: number };
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    
    const ichimoku = calculateIchimoku(highs, lows, closes, conversionPeriod, basePeriod);

    return createSignalLoop(cleanData, [], (i) => {
      const result = checkCrossover(ichimoku.conversion, ichimoku.base, i);
      if (result === 'bullish') return createBuySignal(cleanData, i, 'ichimoku_conversion_base_cross_buy');
      if (result === 'bearish') return createSellSignal(cleanData, i, 'ichimoku_conversion_base_cross_sell');
      
      return null;
    });
  }
};




