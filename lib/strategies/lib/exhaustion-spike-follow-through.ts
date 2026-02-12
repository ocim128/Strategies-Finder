import { Strategy, OHLCVData, StrategyParams } from '../../types/strategies';
import { createBuySignal, createSellSignal, createSignalLoop, ensureCleanData, getHighs, getLows, getCloses, getVolumes } from '../strategy-helpers';
import { calculateATR, calculateEMA, calculateSMA } from '../indicators';

export const exhaustion_spike_follow_through: Strategy = {
    name: 'Exhaustion Spike Follow Through',
    description: 'Exhaustion spike pullback variant that only enters high-quality continuations with stronger early follow-through characteristics.',
    defaultParams: {
        pullbackEma: 20,
        maxWaitBars: 8,
        minSignalBodyPct: 45,
        minCloseLocationPct: 60,
        minSignalVolumeRatio: 0.9,
        continuationBufferAtr: 0.05
    },
    paramLabels: {
        pullbackEma: 'Pullback EMA',
        maxWaitBars: 'Max Wait (bars)',
        minSignalBodyPct: 'Min Signal Body (%)',
        minCloseLocationPct: 'Min Signal Close Location (%)',
        minSignalVolumeRatio: 'Min Signal Volume Ratio',
        continuationBufferAtr: 'Continuation Buffer (ATR)'
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const spikeAtrMult = 0; // hardcoded: spike range check always passes
        const pullbackEma = Math.max(3, Math.round(params.pullbackEma ?? 20));
        const maxWaitBars = Math.max(1, Math.round(params.maxWaitBars ?? 8));
        const minSignalBodyPct = Math.max(0, Math.min(100, params.minSignalBodyPct ?? 45));
        const minCloseLocationPct = Math.max(0, Math.min(100, params.minCloseLocationPct ?? 60));
        const minSignalVolumeRatio = Math.max(0, params.minSignalVolumeRatio ?? 0.9);
        const continuationBufferAtr = Math.max(0, params.continuationBufferAtr ?? 0.05);

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
            const atrNow = atr[i] as number;
            const closeNow = closes[i];
            const openNow = cleanData[i].open;
            const lowNow = lows[i];
            const highNow = highs[i];
            const prevHigh = highs[i - 1];
            const prevLow = lows[i - 1];
            const volSmaNow = volSma[i] as number;
            const signalVolumeRatio = volSmaNow > 0 ? volumes[i] / volSmaNow : 0;

            const rangeNow = Math.max(highNow - lowNow, Number.EPSILON);
            const bodyPct = (Math.abs(closeNow - openNow) / rangeNow) * 100;
            const longCloseLocationPct = ((closeNow - lowNow) / rangeNow) * 100;
            const shortCloseLocationPct = ((highNow - closeNow) / rangeNow) * 100;
            const continuationBuffer = atrNow * continuationBufferAtr;
            const hasSignalQuality = bodyPct >= minSignalBodyPct && signalVolumeRatio >= minSignalVolumeRatio;

            if (pending.dir === 'up') {
                const pulledToMean = lowNow <= emaNow;
                const resumedUp = closeNow > emaNow;
                const strongClose = longCloseLocationPct >= minCloseLocationPct;
                const immediateFollowThrough = closeNow > prevClose;
                const continuationBreak = closeNow >= prevHigh - continuationBuffer;
                if (pulledToMean && resumedUp && strongClose && immediateFollowThrough && continuationBreak && hasSignalQuality) {
                    pending = null;
                    return createBuySignal(cleanData, i, 'Spike Pullback Follow Through Up');
                }
            } else {
                const pulledToMean = highNow >= emaNow;
                const resumedDown = closeNow < emaNow;
                const strongClose = shortCloseLocationPct >= minCloseLocationPct;
                const immediateFollowThrough = closeNow < prevClose;
                const continuationBreak = closeNow <= prevLow + continuationBuffer;
                if (pulledToMean && resumedDown && strongClose && immediateFollowThrough && continuationBreak && hasSignalQuality) {
                    pending = null;
                    return createSellSignal(cleanData, i, 'Spike Pullback Follow Through Down');
                }
            }

            return null;
        });
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: [
            'pullbackEma',
            'maxWaitBars',
            'minSignalBodyPct',
            'minCloseLocationPct',
            'minSignalVolumeRatio',
            'continuationBufferAtr'
        ]
    }
};
