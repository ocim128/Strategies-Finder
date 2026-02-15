import { Strategy, OHLCVData, StrategyParams } from '../../types/strategies';
import {
    createBuySignal,
    createSellSignal,
    createSignalLoop,
    ensureCleanData,
    getCloses,
    getHighs,
    getLows,
    getVolumes,
} from '../strategy-helpers';
import { calculateDonchianChannels, calculateSMA } from '../indicators';

function clampInt(value: number, min: number, max: number): number {
    const rounded = Math.round(value);
    if (!Number.isFinite(rounded)) return min;
    return Math.max(min, Math.min(max, rounded));
}

function clamp(value: number, min: number, max: number): number {
    if (!Number.isFinite(value)) return min;
    return Math.max(min, Math.min(max, value));
}

export const liquidity_void_rider: Strategy = {
    name: 'Liquidity Void Rider',
    description: 'Detects low-liquidity vacuums and enters on the first range expansion break after volume drought.',
    defaultParams: {
        volumeLookback: 20,
        vacuumThresholdRatio: 0.5,
        minVacuumBars: 5,
        breakoutLookback: 12,
        breakoutBufferPct: 0.0005,
        cooldownBars: 4,
    },
    paramLabels: {
        volumeLookback: 'Volume Lookback',
        vacuumThresholdRatio: 'Vacuum Threshold Ratio',
        minVacuumBars: 'Minimum Vacuum Bars',
        breakoutLookback: 'Breakout Lookback',
        breakoutBufferPct: 'Breakout Buffer (pct)',
        cooldownBars: 'Cooldown Bars',
    },
    execute: (data: OHLCVData[], params: StrategyParams) => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const volumeLookback = clampInt(params.volumeLookback ?? 20, 5, 500);
        const vacuumThresholdRatio = clamp(params.vacuumThresholdRatio ?? 0.5, 0.05, 1.2);
        const minVacuumBars = clampInt(params.minVacuumBars ?? 5, 2, 30);
        const breakoutLookback = clampInt(params.breakoutLookback ?? 12, 3, 200);
        const breakoutBufferPct = clamp(params.breakoutBufferPct ?? 0.0005, 0, 0.02);
        const cooldownBars = clampInt(params.cooldownBars ?? 4, 0, 200);

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const volumes = getVolumes(cleanData);
        const volumeSma = calculateSMA(volumes, volumeLookback);
        const { upper, lower } = calculateDonchianChannels(highs, lows, breakoutLookback);

        const warmup = Math.max(volumeLookback, breakoutLookback, minVacuumBars + 1);
        let lastSignalIndex = -10_000;

        return createSignalLoop(cleanData, [upper, lower, volumeSma], (i) => {
            if (i < warmup) return null;
            if (i - lastSignalIndex <= cooldownBars) return null;

            const streakStart = i - minVacuumBars;
            if (streakStart < 0) return null;

            let hasVacuum = true;
            for (let j = streakStart; j < i; j++) {
                const avgVolume = volumeSma[j];
                const volume = volumes[j];
                if (avgVolume === null || avgVolume <= 0 || volume <= 0) {
                    hasVacuum = false;
                    break;
                }
                if (volume / avgVolume >= vacuumThresholdRatio) {
                    hasVacuum = false;
                    break;
                }
            }
            if (!hasVacuum) return null;

            const prevUpper = upper[i - 1] as number;
            const prevLower = lower[i - 1] as number;
            const prevClose = closes[i - 1];
            const close = closes[i];
            const upperBreak = prevUpper * (1 + breakoutBufferPct);
            const lowerBreak = prevLower * (1 - breakoutBufferPct);

            if (prevClose <= upperBreak && close > upperBreak) {
                lastSignalIndex = i;
                return createBuySignal(cleanData, i, 'Liquidity Vacuum Break Up');
            }

            if (prevClose >= lowerBreak && close < lowerBreak) {
                lastSignalIndex = i;
                return createSellSignal(cleanData, i, 'Liquidity Vacuum Break Down');
            }

            return null;
        });
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: [
            'volumeLookback',
            'vacuumThresholdRatio',
            'minVacuumBars',
            'breakoutLookback',
            'breakoutBufferPct',
            'cooldownBars',
        ],
    },
};

