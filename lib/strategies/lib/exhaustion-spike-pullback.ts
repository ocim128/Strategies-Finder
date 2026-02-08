import { Strategy, OHLCVData, StrategyParams } from '../types';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from '../strategy-helpers';
import { calculateATR, calculateEMA, calculateSMA } from '../indicators';

export const exhaustion_spike_pullback: Strategy = {
    name: 'Exhaustion Spike Pullback',
    description: 'After a range and volume spike, waits for a pullback to trend mean and trades continuation.',
    defaultParams: {
        spikeAtrMult: 2.2,
        pullbackEma: 20,
        maxWaitBars: 8
    },
    paramLabels: {
        spikeAtrMult: 'Spike Range (ATR)',
        pullbackEma: 'Pullback EMA',
        maxWaitBars: 'Max Wait (bars)'
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const spikeAtrMult = Math.max(0.5, params.spikeAtrMult ?? 2.2);
        const pullbackEma = Math.max(3, Math.round(params.pullbackEma ?? 20));
        const maxWaitBars = Math.max(1, Math.round(params.maxWaitBars ?? 8));

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);

        const atr = calculateATR(highs, lows, closes, 14);
        const ema = calculateEMA(closes, pullbackEma);
        const volSma = calculateSMA(volumes, 20);

        type PendingSetup = {
            dir: 'up' | 'down';
            startIndex: number;
        } | null;

        let pending: PendingSetup = null;

        return createSignalLoop(cleanData, [atr, ema, volSma], (i) => {
            if (pending && i - pending.startIndex > maxWaitBars) {
                pending = null;
            }

            const prevAtr = atr[i - 1] as number;
            const prevVolSma = volSma[i - 1] as number;
            const prevRange = highs[i - 1] - lows[i - 1];
            const prevVolume = volumes[i - 1];
            const prevOpen = cleanData[i - 1].open;
            const prevClose = closes[i - 1];

            const spikeRange = prevRange >= prevAtr * spikeAtrMult;
            const spikeVolume = prevVolSma <= 0 ? false : prevVolume > prevVolSma;

            if (!pending && spikeRange && spikeVolume) {
                if (prevClose > prevOpen) {
                    pending = { dir: 'up', startIndex: i - 1 };
                } else if (prevClose < prevOpen) {
                    pending = { dir: 'down', startIndex: i - 1 };
                }
            }

            if (!pending) return null;

            const emaNow = ema[i] as number;
            const closeNow = closes[i];
            const lowNow = lows[i];
            const highNow = highs[i];

            if (pending.dir === 'up') {
                const pulledToMean = lowNow <= emaNow;
                const resumedUp = closeNow > emaNow;
                if (pulledToMean && resumedUp) {
                    pending = null;
                    return createBuySignal(cleanData, i, 'Spike Pullback Continue Up');
                }
            } else {
                const pulledToMean = highNow >= emaNow;
                const resumedDown = closeNow < emaNow;
                if (pulledToMean && resumedDown) {
                    pending = null;
                    return createSellSignal(cleanData, i, 'Spike Pullback Continue Down');
                }
            }

            return null;
        });
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['spikeAtrMult', 'pullbackEma', 'maxWaitBars']
    }
};
