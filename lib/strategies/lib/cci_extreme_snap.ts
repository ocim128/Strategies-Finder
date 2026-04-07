import { Strategy } from "../../types/strategies";
import { getHighs, getLows, getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { calculateCCI } from '../indicators';

export const cci_extreme_snap: Strategy = {
  name: 'CCI Extreme Snap',
  description: 'CCI measures deviation of typical price from its statistical mean in standard deviation units. Extreme CCI readings identify statistically anomalous price distances that tend to snap back.',
  defaultParams: { cciPeriod: 20, cciThreshold: 150 },
  paramLabels: { cciPeriod: 'CCI Lookback', cciThreshold: 'Extreme Threshold' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['cciPeriod', 'cciThreshold'] },
  execute: (data, params) => {
    const { cciPeriod, cciThreshold } = params as { cciPeriod: number; cciThreshold: number };
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    
    const cci = calculateCCI(highs, lows, closes, cciPeriod);

    return createSignalLoop(cleanData, [], (i: number) => {
      const currCci = cci[i];
      const prevCci = cci[i - 1];

      if (currCci === null || prevCci === null) return null;

      if (prevCci < -cciThreshold && currCci >= -cciThreshold) return createBuySignal(cleanData, i, 'cci_extreme_snap_buy');
      if (prevCci > cciThreshold && currCci <= cciThreshold) return createSellSignal(cleanData, i, 'cci_extreme_snap_sell');
      
      return null;
    });
  }
};