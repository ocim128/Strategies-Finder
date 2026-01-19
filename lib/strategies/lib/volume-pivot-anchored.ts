import { Strategy, OHLCVData, StrategyParams, Signal, StrategyIndicator } from '../types';
import { createBuySignal, createSellSignal, ensureCleanData } from '../strategy-helpers';

// ============================================================================
// Types & Constants
// ============================================================================

interface Pivot {
    index: number;
    price: number;
    isHigh: boolean;
}

interface VolumeProfileResult {
    poc: number;          // Point of Control price
    vah: number;          // Value Area High
    val: number;          // Value Area Low
    pocLevel: number;     // POC bin index
    vahLevel: number;     // VAH bin index
    valLevel: number;     // VAL bin index
    priceHigh: number;    // Profile high
    priceLow: number;     // Profile low
    totalVolume: number;  // Total volume in profile
    volumeBins: number[]; // Volume per bin
}

// Color palette for visualization
const PROFILE_COLORS = {
    poc: '#ff0000',
    vah: '#2962ff',
    val: '#2962ff',
    valueArea: 'rgba(41, 98, 255, 0.15)',
    outsideArea: 'rgba(67, 70, 81, 0.25)',
    pivotHigh: '#f44336',
    pivotLow: '#4caf50',
    zigzag: '#ff9800',
    volumeStrong: '#006400',
    volumeWeak: '#FF9800',
};

// ============================================================================
// HELPER FUNCTIONS
// ============================================================================

/**
 * Detects pivot points (highs and lows) using a lookback window.
 * Unlike ZigZag, this is simpler and more directly matches the Pine pivothigh/pivotlow.
 */
function detectPivotPoints(
    high: number[],
    low: number[],
    leftBars: number,
    rightBars: number
): Pivot[] {
    const pivots: Pivot[] = [];
    const len = high.length;

    for (let i = leftBars; i < len - rightBars; i++) {
        // Check for pivot high
        let isHigh = true;
        for (let j = 1; j <= leftBars; j++) {
            if (high[i] <= high[i - j]) {
                isHigh = false;
                break;
            }
        }
        if (isHigh) {
            for (let j = 1; j <= rightBars; j++) {
                if (high[i] <= high[i + j]) {
                    isHigh = false;
                    break;
                }
            }
        }

        // Check for pivot low
        let isLow = true;
        for (let j = 1; j <= leftBars; j++) {
            if (low[i] >= low[i - j]) {
                isLow = false;
                break;
            }
        }
        if (isLow) {
            for (let j = 1; j <= rightBars; j++) {
                if (low[i] >= low[i + j]) {
                    isLow = false;
                    break;
                }
            }
        }

        // Create pivot - prioritize the one with larger magnitude
        if (isHigh && isLow) {
            // Both? Pick based on relative strength or just high
            const highStrength = high[i] - Math.min(high[i - 1], high[i + 1]);
            const lowStrength = Math.max(low[i - 1], low[i + 1]) - low[i];
            if (highStrength >= lowStrength) {
                pivots.push({ index: i, price: high[i], isHigh: true });
            } else {
                pivots.push({ index: i, price: low[i], isHigh: false });
            }
        } else if (isHigh) {
            pivots.push({ index: i, price: high[i], isHigh: true });
        } else if (isLow) {
            pivots.push({ index: i, price: low[i], isHigh: false });
        }
    }

    // Filter alternating pivots (no two consecutive highs or lows)
    const filtered: Pivot[] = [];
    for (let i = 0; i < pivots.length; i++) {
        const p = pivots[i];
        if (filtered.length === 0) {
            filtered.push(p);
            continue;
        }
        const last = filtered[filtered.length - 1];
        if (p.isHigh !== last.isHigh) {
            filtered.push(p);
        } else {
            // Same type - keep the more extreme one
            if (p.isHigh && p.price > last.price) {
                filtered[filtered.length - 1] = p;
            } else if (!p.isHigh && p.price < last.price) {
                filtered[filtered.length - 1] = p;
            }
        }
    }

    return filtered;
}

/**
 * Calculate Volume Profile for a specific range.
 * This is the core of the "Volume Profile, Pivot Anchored" concept.
 */
function calculatePivotAnchoredVolumeProfile(
    data: OHLCVData[],
    startIndex: number,
    endIndex: number,
    numBins: number = 25
): VolumeProfileResult | null {
    if (startIndex >= endIndex || startIndex < 0) return null;

    // Find price range
    let priceHigh = -Infinity;
    let priceLow = Infinity;

    for (let i = startIndex; i <= endIndex; i++) {
        priceHigh = Math.max(priceHigh, data[i].high);
        priceLow = Math.min(priceLow, data[i].low);
    }

    if (priceHigh <= priceLow) return null;

    const priceStep = (priceHigh - priceLow) / numBins;
    if (priceStep <= 0) return null;

    // Distribute volume into bins
    const volumeBins = new Array(numBins).fill(0);
    let totalVolume = 0;

    for (let i = startIndex; i <= endIndex; i++) {
        const bar = data[i];
        const barRange = bar.high - bar.low;
        const vol = bar.volume || 0;
        totalVolume += vol;

        if (barRange === 0) {
            // Single price bar
            const binIndex = Math.min(
                numBins - 1,
                Math.max(0, Math.floor((bar.close - priceLow) / priceStep))
            );
            volumeBins[binIndex] += vol;
        } else {
            // Distribute volume across bins proportionally
            for (let level = 0; level < numBins; level++) {
                const levelLow = priceLow + level * priceStep;
                const levelHigh = levelLow + priceStep;

                // Calculate overlap with bar's range
                const overlapLow = Math.max(bar.low, levelLow);
                const overlapHigh = Math.min(bar.high, levelHigh);

                if (overlapHigh > overlapLow) {
                    const overlap = (overlapHigh - overlapLow) / barRange;
                    volumeBins[level] += vol * overlap;
                }
            }
        }
    }

    // Find Point of Control (highest volume bin)
    let pocLevel = 0;
    let maxVol = 0;
    for (let i = 0; i < numBins; i++) {
        if (volumeBins[i] > maxVol) {
            maxVol = volumeBins[i];
            pocLevel = i;
        }
    }

    // Calculate Value Area (68% of volume, configurable)
    const valueAreaPercent = 0.68;
    const targetVolume = totalVolume * valueAreaPercent;
    let currentVolume = volumeBins[pocLevel];
    let vahLevel = pocLevel;
    let valLevel = pocLevel;

    while (currentVolume < targetVolume && (vahLevel < numBins - 1 || valLevel > 0)) {
        const upVol = vahLevel < numBins - 1 ? volumeBins[vahLevel + 1] : -1;
        const downVol = valLevel > 0 ? volumeBins[valLevel - 1] : -1;

        if (upVol >= downVol && vahLevel < numBins - 1) {
            vahLevel++;
            currentVolume += upVol;
        } else if (valLevel > 0) {
            valLevel--;
            currentVolume += downVol;
        } else {
            break;
        }
    }

    return {
        poc: priceLow + (pocLevel + 0.5) * priceStep,
        vah: priceLow + (vahLevel + 1) * priceStep,
        val: priceLow + valLevel * priceStep,
        pocLevel,
        vahLevel,
        valLevel,
        priceHigh,
        priceLow,
        totalVolume,
        volumeBins,
    };
}

/**
 * Calculate volume moving average for context.
 */
function calculateVolumeSMA(volumes: number[], period: number): (number | null)[] {
    const result: (number | null)[] = new Array(volumes.length).fill(null);
    let sum = 0;

    for (let i = 0; i < volumes.length; i++) {
        sum += volumes[i];
        if (i >= period) {
            sum -= volumes[i - period];
        }
        if (i >= period - 1) {
            result[i] = sum / period;
        }
    }

    return result;
}

// ============================================================================
// STRATEGY
// ============================================================================

export const volume_pivot_anchored: Strategy = {
    name: 'Volume Pivot Anchored',
    description: 'Volume Profile anchored to pivot points. Generates signals based on price interaction with POC, VAH, and VAL levels. Includes volume confirmation for enhanced signal quality.',
    defaultParams: {
        pivotLength: 20,         // Bars left/right to confirm pivot
        profileBins: 25,         // Number of price bins for volume profile
        volMaPeriod: 89,         // Volume MA period for relative volume
        volThresholdHigh: 1.618, // Threshold for high volume confirmation
        volThresholdLow: 0.618,  // Threshold for low volume (weak signals)
        enableVolumeFilter: 1,   // 0/1 toggle for volume filtering
        enablePocSignals: 1,     // 0/1 toggle for POC-based signals
        enableVaSignals: 1,      // 0/1 toggle for VA boundary signals
    },
    paramLabels: {
        pivotLength: 'Pivot Detection Length',
        profileBins: 'Profile Bins',
        volMaPeriod: 'Volume MA Period',
        volThresholdHigh: 'High Volume Threshold',
        volThresholdLow: 'Low Volume Threshold',
        enableVolumeFilter: 'Enable Volume Filter (0/1)',
        enablePocSignals: 'Enable POC Signals (0/1)',
        enableVaSignals: 'Enable VA Signals (0/1)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length < params.pivotLength * 3) return [];

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);
        const close = cleanData.map(d => d.close);
        const volume = cleanData.map(d => d.volume);

        // Detect pivots
        const pivots = detectPivotPoints(high, low, params.pivotLength, params.pivotLength);
        if (pivots.length < 2) return [];

        // Calculate volume MA for confirmation
        const volumeMA = calculateVolumeSMA(volume, params.volMaPeriod);

        const signals: Signal[] = [];

        // For each pair of consecutive pivots, calculate volume profile
        // and check for signals AFTER the second pivot is confirmed
        for (let p = 1; p < pivots.length; p++) {
            const startPivot = pivots[p - 1];
            const endPivot = pivots[p];

            // Calculate profile between pivots
            const profile = calculatePivotAnchoredVolumeProfile(
                cleanData,
                startPivot.index,
                endPivot.index,
                params.profileBins
            );

            if (!profile) continue;

            // Signal generation window: from confirmation of endPivot to next pivot (or end)
            const confirmIndex = endPivot.index + params.pivotLength;
            const nextPivotIndex = p + 1 < pivots.length ? pivots[p + 1].index : cleanData.length;
            const signalEnd = Math.min(nextPivotIndex, cleanData.length);

            // Track triggered levels to avoid duplicate signals
            const triggeredPoc = new Set<string>();
            const triggeredVa = new Set<string>();

            for (let i = Math.max(confirmIndex, 1); i < signalEnd; i++) {
                if (i >= cleanData.length) break;

                const barClose = close[i];
                const prevClose = close[i - 1];
                const barVolume = volume[i];
                const volMA = volumeMA[i];

                // Volume context
                const isHighVolume = params.enableVolumeFilter === 0 ||
                    (volMA !== null && barVolume > volMA * params.volThresholdHigh);
                const isLowVolume = volMA !== null && barVolume < volMA * params.volThresholdLow;

                // Skip low volume signals if filter is enabled
                if (params.enableVolumeFilter === 1 && isLowVolume) continue;

                // POC Signals: Mean reversion near POC
                if (params.enablePocSignals === 1) {
                    const pocTolerance = (profile.priceHigh - profile.priceLow) * 0.02;

                    // Price crosses above POC - bullish
                    if (!triggeredPoc.has('bullish') &&
                        prevClose < profile.poc && barClose > profile.poc) {
                        const reason = isHighVolume
                            ? 'POC Breakout (High Volume)'
                            : 'POC Cross Up';
                        signals.push(createBuySignal(cleanData, i, reason));
                        triggeredPoc.add('bullish');
                    }

                    // Price crosses below POC - bearish
                    if (!triggeredPoc.has('bearish') &&
                        prevClose > profile.poc && barClose < profile.poc) {
                        const reason = isHighVolume
                            ? 'POC Breakdown (High Volume)'
                            : 'POC Cross Down';
                        signals.push(createSellSignal(cleanData, i, reason));
                        triggeredPoc.add('bearish');
                    }

                    // Bounce at POC (support/resistance)
                    if (!triggeredPoc.has('bounce')) {
                        const nearPocPrev = Math.abs(prevClose - profile.poc) < pocTolerance;

                        if (nearPocPrev && barClose > profile.poc + pocTolerance) {
                            signals.push(createBuySignal(cleanData, i, 'POC Support Bounce'));
                            triggeredPoc.add('bounce');
                        } else if (nearPocPrev && barClose < profile.poc - pocTolerance) {
                            signals.push(createSellSignal(cleanData, i, 'POC Resistance Rejection'));
                            triggeredPoc.add('bounce');
                        }
                    }
                }

                // Value Area Signals
                if (params.enableVaSignals === 1) {
                    // VAL (Value Area Low) - Support zone
                    if (!triggeredVa.has('val_buy')) {
                        // Price dips below VAL and returns inside (mean reversion)
                        if (prevClose < profile.val && barClose > profile.val) {
                            const reason = isHighVolume
                                ? 'VAL Re-entry (High Volume)'
                                : 'VAL Re-entry';
                            signals.push(createBuySignal(cleanData, i, reason));
                            triggeredVa.add('val_buy');
                        }
                    }

                    // VAH (Value Area High) - Resistance zone
                    if (!triggeredVa.has('vah_sell')) {
                        // Price peaks above VAH and returns inside (mean reversion)
                        if (prevClose > profile.vah && barClose < profile.vah) {
                            const reason = isHighVolume
                                ? 'VAH Re-entry (High Volume)'
                                : 'VAH Re-entry';
                            signals.push(createSellSignal(cleanData, i, reason));
                            triggeredVa.add('vah_sell');
                        }
                    }

                    // Breakout signals (for trending markets)
                    if (!triggeredVa.has('vah_breakout') && isHighVolume) {
                        if (prevClose <= profile.vah && barClose > profile.vah) {
                            signals.push(createBuySignal(cleanData, i, 'VAH Breakout (Volume Confirmed)'));
                            triggeredVa.add('vah_breakout');
                        }
                    }

                    if (!triggeredVa.has('val_breakdown') && isHighVolume) {
                        if (prevClose >= profile.val && barClose < profile.val) {
                            signals.push(createSellSignal(cleanData, i, 'VAL Breakdown (Volume Confirmed)'));
                            triggeredVa.add('val_breakdown');
                        }
                    }
                }
            }
        }

        return signals;
    },

    indicators: (data: OHLCVData[], params: StrategyParams): StrategyIndicator[] => {
        const cleanData = ensureCleanData(data);
        const indicators: StrategyIndicator[] = [];

        if (cleanData.length < params.pivotLength * 2) return [];

        const high = cleanData.map(d => d.high);
        const low = cleanData.map(d => d.low);

        // Detect pivots
        const pivots = detectPivotPoints(high, low, params.pivotLength, params.pivotLength);

        if (pivots.length < 2) return [];

        // Draw ZigZag connecting pivots
        const zigzagLine: (number | null)[] = new Array(cleanData.length).fill(null);
        for (let i = 0; i < pivots.length - 1; i++) {
            const p1 = pivots[i];
            const p2 = pivots[i + 1];
            const steps = p2.index - p1.index;
            if (steps <= 0) continue;
            const valStep = (p2.price - p1.price) / steps;

            for (let k = 0; k <= steps; k++) {
                if (p1.index + k < cleanData.length) {
                    zigzagLine[p1.index + k] = p1.price + valStep * k;
                }
            }
        }
        indicators.push({ name: 'Pivot ZigZag', type: 'line', values: zigzagLine, color: PROFILE_COLORS.zigzag });

        // Calculate and draw volume profile for the LAST completed swing
        if (pivots.length >= 2) {
            const startPivot = pivots[pivots.length - 2];
            const endPivot = pivots[pivots.length - 1];

            const profile = calculatePivotAnchoredVolumeProfile(
                cleanData,
                startPivot.index,
                endPivot.index,
                params.profileBins
            );

            if (profile) {
                // Draw POC line extending from endPivot
                const pocLine: (number | null)[] = new Array(cleanData.length).fill(null);
                for (let k = endPivot.index; k < cleanData.length; k++) {
                    pocLine[k] = profile.poc;
                }
                indicators.push({ name: 'POC', type: 'line', values: pocLine, color: PROFILE_COLORS.poc });

                // Draw VAH line
                const vahLine: (number | null)[] = new Array(cleanData.length).fill(null);
                for (let k = endPivot.index; k < cleanData.length; k++) {
                    vahLine[k] = profile.vah;
                }
                indicators.push({ name: 'VAH', type: 'line', values: vahLine, color: PROFILE_COLORS.vah });

                // Draw VAL line
                const valLine: (number | null)[] = new Array(cleanData.length).fill(null);
                for (let k = endPivot.index; k < cleanData.length; k++) {
                    valLine[k] = profile.val;
                }
                indicators.push({ name: 'VAL', type: 'line', values: valLine, color: PROFILE_COLORS.val });
            }
        }

        return indicators;
    }
};
