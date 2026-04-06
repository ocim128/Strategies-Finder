import { Strategy, OHLCVData, Signal } from '../../types/strategies';
import { calculateBollingerBands } from '../indicators';
import { getCloses, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';

export const bollinger_expansion_breakout: Strategy = {
  name: 'Bollinger Expansion Breakout',
  description: 'Triggers only when the Bollinger Bandwidth violently expands past its rolling average simultaneously with a price breakout of the outer bands.',
  defaultParams: {
    bbPeriod: 20,
    bbMultiplier: 2.0,
    expansionMultiplier: 1.5
  },
  paramLabels: {
    bbPeriod: 'BB Period',
    bbMultiplier: 'BB Multiplier',
    expansionMultiplier: 'Expansion Multiplier'
  },
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['bbPeriod', 'bbMultiplier', 'expansionMultiplier']
  },
  execute(data: OHLCVData[], params) {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    
    const { upper, lower } = calculateBollingerBands(closes, params.bbPeriod, params.bbMultiplier);
    
    const bandwidth: (number | null)[] = cleanData.map((_, i) => {
      if (upper[i] === null || lower[i] === null) return null;
      return upper[i]! - lower[i]!;
    });
    
    // We need to implement buildRollingAverage or calculate it. I'll just calculate it simply here or check if it exists in price-action-statistics-core.ts
    // In previous error it said buildRollingAverage doesn't exist in strategy-helpers. Wait, let me just build it inline if it doesn't exist, or use buildRollingMean if it exists.
    
    // Let's implement rolling average inline to be safe.
    const avgBandwidth = new Array(cleanData.length).fill(null);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < cleanData.length; i++) {
        if (bandwidth[i] !== null) {
            sum += bandwidth[i]!;
            count++;
            if (count > params.bbPeriod) {
                sum -= bandwidth[i - params.bbPeriod]!;
                count--;
            }
            if (count === params.bbPeriod) {
                avgBandwidth[i] = sum / count;
            }
        }
    }

    const signals: Signal[] = [];
    
    for (let i = params.bbPeriod; i < cleanData.length; i++) {
        const bw = bandwidth[i];
        const avgBw = avgBandwidth[i];
        const up = upper[i];
        const dn = lower[i];
        
        if (bw === null || avgBw === null || up === null || dn === null) continue;
        
        const isExpanding = bw > (avgBw * params.expansionMultiplier);
        
        if (isExpanding && closes[i] > up) {
            signals.push(createBuySignal(cleanData, i, 'Bollinger Expansion Breakout'));
        }
        else if (isExpanding && closes[i] < dn) {
            signals.push(createSellSignal(cleanData, i, 'Bollinger Expansion Breakout'));
        }
    }
    
    return signals;
  }
};
