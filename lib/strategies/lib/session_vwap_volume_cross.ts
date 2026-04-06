import { Strategy, OHLCVData, Signal } from '../../types/strategies';
import { calculateSessionVWAP } from '../indicators';
import { getCloses, getVolumes, ensureCleanData, createBuySignal, createSellSignal } from '../strategy-helpers';

export const session_vwap_volume_cross: Strategy = {
  name: 'Session VWAP Volume Cross',
  description: 'Buys crossovers of the Session VWAP only if the crossover bar features massive relative volume, indicating institutional participation in the level reclaim.',
  defaultParams: {
    volLookback: 20,
    volMultiplier: 2.0
  },
  paramLabels: {
    volLookback: 'Volume Lookback',
    volMultiplier: 'Volume Spike Multiplier'
  },
  metadata: {
    role: 'entry',
    direction: 'both',
    walkForwardParams: ['volLookback', 'volMultiplier']
  },
  execute(data: OHLCVData[], params) {
    const cleanData = ensureCleanData(data);
    const closes = getCloses(cleanData);
    const volumes = getVolumes(cleanData);
    
    const vwap = calculateSessionVWAP(cleanData);
    
    // Calculate rolling average volume
    const avgVolume = new Array(cleanData.length).fill(null);
    let sum = 0;
    let count = 0;
    for (let i = 0; i < cleanData.length; i++) {
        sum += volumes[i];
        count++;
        if (count > params.volLookback) {
            sum -= volumes[i - params.volLookback];
            count--;
        }
        if (count === params.volLookback) {
            avgVolume[i] = sum / count;
        }
    }

    const signals: Signal[] = [];
    
    for (let i = params.volLookback; i < cleanData.length; i++) {
        const v = vwap[i];
        const vPrev = vwap[i-1];
        const avgVol = avgVolume[i];
        
        if (v === null || vPrev === null || avgVol === null) continue;
        
        const isVolumeSpike = volumes[i] > (avgVol * params.volMultiplier);
        
        if (isVolumeSpike && closes[i] > v && closes[i-1] <= vPrev) {
            signals.push(createBuySignal(cleanData, i, 'Session VWAP Volume Cross'));
        }
        else if (isVolumeSpike && closes[i] < v && closes[i-1] >= vPrev) {
            signals.push(createSellSignal(cleanData, i, 'Session VWAP Volume Cross'));
        }
    }
    
    return signals;
  }
};
