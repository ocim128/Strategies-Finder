import { Strategy, OHLCVData, Signal } from '../../types/strategies';
import { getHighs, getLows, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';
import { extractBarMetricSeries } from './price-action-statistics-core';

export const trailing_extreme_rejection_fade: Strategy = {
  name: 'Trailing Extreme Rejection Fade',
  description: 'Identifies bars that push to a new N-bar high or low but get violently rejected intra-bar, signaling a trapped extreme.',
  defaultParams: {
    lookback: 20,
    rejectionLimit: 0.25
  },
  paramLabels: {
    lookback: 'Trailing Lookback',
    rejectionLimit: 'Rejection Limit'
  },
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['lookback', 'rejectionLimit']
  },
  execute(data: OHLCVData[], params) {
    const cleanData = ensureCleanData(data);
    const highs = getHighs(cleanData);
    const lows = getLows(cleanData);
    
    const trailingHighs = new Array(cleanData.length).fill(null);
    const trailingLows = new Array(cleanData.length).fill(null);
    
    for (let i = params.lookback; i < cleanData.length; i++) {
        let max = -Infinity;
        let min = Infinity;
        for (let j = 1; j <= params.lookback; j++) {
            if (highs[i - j] > max) max = highs[i - j];
            if (lows[i - j] < min) min = lows[i - j];
        }
        trailingHighs[i - 1] = max;
        trailingLows[i - 1] = min;
    }

    const closeLocation = extractBarMetricSeries(cleanData, 'closeLocation');

    const signals: Signal[] = [];
    
    for (let i = params.lookback; i < cleanData.length; i++) {
        const prevLow = trailingLows[i - 1];
        const prevHigh = trailingHighs[i - 1];
        const cLoc = closeLocation[i];
        
        if (prevLow === null || prevHigh === null || cLoc === undefined) continue;
        
        if (lows[i] <= prevLow && cLoc > (1.0 - params.rejectionLimit)) {
            signals.push(createBuySignal(cleanData, i, 'Trailing Extreme Rejection Fade'));
        }
        else if (highs[i] >= prevHigh && cLoc < params.rejectionLimit) {
            signals.push(createSellSignal(cleanData, i, 'Trailing Extreme Rejection Fade'));
        }
    }
    
    return signals;
  }
};
