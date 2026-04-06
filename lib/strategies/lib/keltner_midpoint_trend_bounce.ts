import { Strategy, OHLCVData, Signal } from '../../types/strategies';
import { calculateKeltnerChannels } from '../indicators';
import { getCloses, getHighs, getLows, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';

export const keltner_midpoint_trend_bounce: Strategy = {
  name: 'Keltner Midpoint Trend Bounce',
  description: 'Treats the Keltner Channel midpoint as a dynamic trend baseline, entering when price pulls back and crosses back over it in the direction of the macro slope.',
  defaultParams: {
    lookback: 20,
    slopeLookback: 5
  },
  paramLabels: {
    lookback: 'Keltner Period',
    slopeLookback: 'Slope Lookback'
  },
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'slopeLookback']
  },
  execute(data: OHLCVData[], params) {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    
    // Using ATR multiplier 2.0 and EMA period same as lookback (common defaults)
    const { middle } = calculateKeltnerChannels(highs, lows, closes, params.lookback, params.lookback, 2.0);
    
    const signals: Signal[] = [];
    const lookback = params.slopeLookback;
    
    for (let i = Math.max(params.lookback, lookback); i < cleanData.length; i++) {
        const mid = middle[i];
        const midPrev = middle[i - lookback];
        
        if (mid === null || midPrev === null) continue;
        
        // Buy logic: Midpoint higher than it was `slopeLookback` bars ago, Close crosses above Midpoint
        if (mid > midPrev && closes[i] > mid && closes[i-1] <= middle[i-1]!) {
            signals.push(createBuySignal(cleanData, i, 'Keltner Midpoint Trend Bounce'));
        }
        // Sell logic: Midpoint lower than it was `slopeLookback` bars ago, Close crosses below Midpoint
        else if (mid < midPrev && closes[i] < mid && closes[i-1] >= middle[i-1]!) {
            signals.push(createSellSignal(cleanData, i, 'Keltner Midpoint Trend Bounce'));
        }
    }
    
    return signals;
  }
};
