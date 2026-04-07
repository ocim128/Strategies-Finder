import { Strategy } from "../../types/strategies";
import { getHighs, getLows, getCloses, createSignalLoop, createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';
import { calculateParabolicSAR } from '../indicators';

export const sar_direction_flip: Strategy = {
  name: 'SAR Direction Flip',
  description: 'Parabolic SAR tracks a trailing stop that accelerates toward price. When SAR flips from above price to below (or vice versa), it signals a directional regime change with built-in momentum acceleration.',
  defaultParams: { sarStep: 0.02, sarMax: 0.2 },
  paramLabels: { sarStep: 'SAR Step', sarMax: 'SAR Max' },
  metadata: { role: 'entry', direction: 'both', walkForwardParams: ['sarStep', 'sarMax'] },
  execute: (data, params) => {
    const { sarStep, sarMax } = params as { sarStep: number; sarMax: number };
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    const closes = getCloses(cleanData);
    
    const sar = calculateParabolicSAR(highs, lows, sarStep, sarMax, sarMax);

    return createSignalLoop(cleanData, [], (i: number) => {
      const currSar = sar[i];
      const prevSar = sar[i - 1];
      const currClose = closes[i];
      const prevClose = closes[i - 1];

      if (currSar === null || prevSar === null || currClose === null || prevClose === null) return null;

      if (prevSar > prevClose && currSar < currClose) return createBuySignal(cleanData, i, 'sar_direction_flip_buy');
      if (prevSar < prevClose && currSar > currClose) return createSellSignal(cleanData, i, 'sar_direction_flip_sell');
      
      return null;
    });
  }
};