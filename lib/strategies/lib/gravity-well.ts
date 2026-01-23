import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR, calculateEMA } from '../indicators';
import { COLORS } from '../constants';

/**
 * The "Gravity Well" Strategy (Simplified)
 * 
 * A structural asymmetry exploiter designed to work on simple mock data (v1).
 * 
 * SIMPLIFIED VERSION: Reduced from 9 parameters to 3 for faster Finder optimization.
 * 
 * Hardcoded values based on structural analysis:
 * - momentumPeriod: 5 (standard short-term momentum)
 * - atrPeriod: 14 (standard ATR)
 * - volNormPeriod: lookback / 2 (derived)
 * - momentumThreshold: 0.5 (derived from typical price moves)
 * - slingshotBonus: 0.3 (fixed bonus for rapid reversals)
 * - trailMultHigh: trailMult / 2 (derived from main trail mult)
 */

// Hardcoded constants
const MOMENTUM_PERIOD = 5;
const ATR_PERIOD = 14;
const MOMENTUM_THRESHOLD = 0.5;
const SLINGSHOT_BONUS = 0.3;

interface GravityWellState {
    position: 'none' | 'long';
    entryPrice: number;
    entryIndex: number;
    peakPrice: number;
    trailStop: number;
}

/**
 * Calculate the "gravity zone" - a normalized measure of how close price is to the floor.
 * Returns a value from 0 (at ceiling) to 1 (at floor).
 */
function calculateGravityZone(closes: number[], lookback: number): (number | null)[] {
    const result: (number | null)[] = [];
    const maxDeque: number[] = [];
    const minDeque: number[] = [];

    for (let i = 0; i < closes.length; i++) {
        while (maxDeque.length > 0 && closes[maxDeque[maxDeque.length - 1]] <= closes[i]) {
            maxDeque.pop();
        }
        maxDeque.push(i);
        if (maxDeque[0] <= i - lookback) maxDeque.shift();

        while (minDeque.length > 0 && closes[minDeque[minDeque.length - 1]] >= closes[i]) {
            minDeque.pop();
        }
        minDeque.push(i);
        if (minDeque[0] <= i - lookback) minDeque.shift();

        if (i < lookback - 1) {
            result.push(null);
        } else {
            const maxPrice = closes[maxDeque[0]];
            const minPrice = closes[minDeque[0]];
            const range = maxPrice - minPrice;

            if (range <= 0) {
                result.push(0.5);
            } else {
                result.push((maxPrice - closes[i]) / range);
            }
        }
    }

    return result;
}

/**
 * Calculate short-term momentum (rate of change over N bars).
 */
function calculateMomentumRoc(closes: number[], period: number): (number | null)[] {
    const result: (number | null)[] = [];

    for (let i = 0; i < closes.length; i++) {
        if (i < period) {
            result.push(null);
        } else {
            const prev = closes[i - period];
            if (prev === 0) {
                result.push(0);
            } else {
                result.push((closes[i] - prev) / prev * 100);
            }
        }
    }

    return result;
}

/**
 * Calculate normalized volatility (current ATR / median ATR).
 */
function calculateNormalizedVol(
    highs: number[],
    lows: number[],
    closes: number[],
    atrPeriod: number,
    normPeriod: number
): (number | null)[] {
    const atr = calculateATR(highs, lows, closes, atrPeriod);
    const result: (number | null)[] = [];

    for (let i = 0; i < closes.length; i++) {
        if (i < normPeriod - 1 || atr[i] === null) {
            result.push(null);
            continue;
        }

        const atrWindow: number[] = [];
        for (let j = i - normPeriod + 1; j <= i; j++) {
            if (atr[j] !== null) {
                atrWindow.push(atr[j]!);
            }
        }

        if (atrWindow.length === 0) {
            result.push(null);
            continue;
        }

        atrWindow.sort((a, b) => a - b);
        const mid = Math.floor(atrWindow.length / 2);
        const medianAtr = atrWindow.length % 2 !== 0
            ? atrWindow[mid]
            : (atrWindow[mid - 1] + atrWindow[mid]) / 2;

        if (medianAtr === 0) {
            result.push(1);
        } else {
            result.push(atr[i]! / medianAtr);
        }
    }

    return result;
}

export const gravity_well: Strategy = {
    name: 'Gravity Well',
    description: 'Exploits volatility asymmetry. Simplified to 3 parameters for fast optimization.',
    defaultParams: {
        gravityLookback: 100,      // Lookback for price range (floor/ceiling detection)
        gravityThreshold: 0.6,     // Enter when gravity zone > this (0.6 = lower 40% of range)
        trailMult: 2.5,            // Trail stop ATR multiplier (adjusts dynamically)
    },
    paramLabels: {
        gravityLookback: 'Lookback',
        gravityThreshold: 'Entry Zone',
        trailMult: 'Trail ATR',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        const lookback = Math.floor(params.gravityLookback);
        const volNormPeriod = Math.max(20, Math.floor(lookback / 2));

        if (cleanData.length < lookback + MOMENTUM_PERIOD) {
            return [];
        }

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        // Calculate indicators
        const gravityZone = calculateGravityZone(closes, lookback);
        const momentum = calculateMomentumRoc(closes, MOMENTUM_PERIOD);
        const atr = calculateATR(highs, lows, closes, ATR_PERIOD);
        const normalizedVol = calculateNormalizedVol(highs, lows, closes, ATR_PERIOD, volNormPeriod);

        // Momentum EMA for slingshot detection
        const momentumEma = calculateEMA(
            momentum.map(m => m ?? 0),
            Math.max(3, Math.floor(MOMENTUM_PERIOD / 2))
        );

        // Derive trail multipliers from single param
        const trailMultLow = params.trailMult * 1.2;   // Wide when in gravity well
        const trailMultHigh = params.trailMult * 0.6;  // Tight when at ceiling

        const signals: Signal[] = [];
        const state: GravityWellState = {
            position: 'none',
            entryPrice: 0,
            entryIndex: 0,
            peakPrice: 0,
            trailStop: 0,
        };

        const warmup = Math.max(lookback, volNormPeriod, ATR_PERIOD);

        for (let i = warmup; i < cleanData.length; i++) {
            const bar = cleanData[i];
            const gravity = gravityZone[i];
            const mom = momentum[i];
            const momPrev = momentum[i - 1];
            const currentAtr = atr[i];
            const normVol = normalizedVol[i];
            const momEmaCurr = momentumEma[i];
            const momEmaPrev = momentumEma[i - 1];

            if (gravity === null || mom === null || momPrev === null ||
                currentAtr === null || normVol === null ||
                momEmaCurr === null || momEmaPrev === null) {
                continue;
            }

            if (state.position === 'none') {
                // --- ENTRY LOGIC ---
                const isSlingshot = momEmaPrev! < -MOMENTUM_THRESHOLD * 2 && momEmaCurr! > 0;
                const effectiveGravityThreshold = isSlingshot
                    ? params.gravityThreshold - SLINGSHOT_BONUS
                    : params.gravityThreshold;

                const inGravityWell = gravity >= effectiveGravityThreshold;
                const momentumTurningUp = momPrev! < 0 && mom! > MOMENTUM_THRESHOLD;
                const strongMomentumBurst = mom! > MOMENTUM_THRESHOLD * 2;

                if (inGravityWell && (momentumTurningUp || strongMomentumBurst || isSlingshot)) {
                    signals.push(createBuySignal(cleanData, i,
                        isSlingshot ? 'Gravity Slingshot Entry' : 'Gravity Well Entry'));

                    state.position = 'long';
                    state.entryPrice = bar.close;
                    state.entryIndex = i;
                    state.peakPrice = bar.close;

                    const trailMult = trailMultLow - (trailMultLow - trailMultHigh) * (1 - gravity);
                    state.trailStop = bar.close - currentAtr * trailMult;
                }
            } else {
                // --- EXIT LOGIC ---
                if (bar.close > state.peakPrice) {
                    state.peakPrice = bar.close;
                }

                const trailMult = trailMultLow - (trailMultLow - trailMultHigh) * (1 - gravity);
                const newTrailStop = state.peakPrice - currentAtr * trailMult;

                if (newTrailStop > state.trailStop) {
                    state.trailStop = newTrailStop;
                }

                const hitTrailStop = bar.low <= state.trailStop;
                const momentumCollapse = gravity < 0.3 && mom! < -MOMENTUM_THRESHOLD * 1.5;

                if (hitTrailStop || momentumCollapse) {
                    signals.push(createSellSignal(cleanData, i,
                        hitTrailStop ? 'Trail Stop Exit' : 'Momentum Collapse Exit'));

                    state.position = 'none';
                    state.entryPrice = 0;
                    state.entryIndex = 0;
                    state.peakPrice = 0;
                    state.trailStop = 0;
                }
            }
        }

        return signals;
    },
    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        const lookback = Math.floor(params.gravityLookback);

        if (cleanData.length < lookback) {
            return [];
        }

        const closes = getCloses(cleanData);
        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);

        const atr = calculateATR(highs, lows, closes, ATR_PERIOD);

        // Calculate the "gravity floor" line (entry zone visualization)
        const gravityFloor: (number | null)[] = [];
        const gravityCeiling: (number | null)[] = [];

        const maxDeque: number[] = [];
        const minDeque: number[] = [];

        for (let i = 0; i < closes.length; i++) {
            while (maxDeque.length > 0 && closes[maxDeque[maxDeque.length - 1]] <= closes[i]) {
                maxDeque.pop();
            }
            maxDeque.push(i);
            if (maxDeque[0] <= i - lookback) maxDeque.shift();

            while (minDeque.length > 0 && closes[minDeque[minDeque.length - 1]] >= closes[i]) {
                minDeque.pop();
            }
            minDeque.push(i);
            if (minDeque[0] <= i - lookback) minDeque.shift();

            if (i < lookback - 1) {
                gravityFloor.push(null);
                gravityCeiling.push(null);
            } else {
                const maxPrice = closes[maxDeque[0]];
                const minPrice = closes[minDeque[0]];
                const range = maxPrice - minPrice;

                gravityFloor.push(minPrice);
                gravityCeiling.push(minPrice + range * (1 - params.gravityThreshold));
            }
        }

        return [
            { name: 'Gravity Floor', type: 'line', values: gravityFloor, color: '#10b981' },
            { name: 'Gravity Entry Zone', type: 'line', values: gravityCeiling, color: '#10b981' },
            { name: 'ATR', type: 'line', values: atr, color: COLORS.Neutral },
        ];
    },
    metadata: {
        role: 'entry',
        direction: 'long',
    },
};
