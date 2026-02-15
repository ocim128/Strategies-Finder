import { Strategy, OHLCVData, StrategyParams, Signal } from '../../types/strategies';
import { createBuySignal, createSellSignal, ensureCleanData, getCloses, getHighs, getLows } from '../strategy-helpers';
import { calculateATR } from '../indicators';
import { parseTimeToUnixSeconds } from '../../time-normalization';

interface QuietRangeInfo {
    inRange: boolean;
    windowId: string | null;
}

function clampHour(value: number | undefined, fallback: number): number {
    const raw = Number.isFinite(value) ? value as number : fallback;
    return Math.max(0, Math.min(23, Math.round(raw)));
}

function toUtcDateKey(unixSeconds: number): string {
    const date = new Date(unixSeconds * 1000);
    const year = date.getUTCFullYear();
    const month = String(date.getUTCMonth() + 1).padStart(2, '0');
    const day = String(date.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
}

function getQuietRangeInfo(unixSeconds: number, startHour: number, endHour: number): QuietRangeInfo {
    if (startHour === endHour) {
        return { inRange: false, windowId: null };
    }

    const date = new Date(unixSeconds * 1000);
    const hour = date.getUTCHours();

    if (startHour < endHour) {
        const inRange = hour >= startHour && hour < endHour;
        return {
            inRange,
            windowId: inRange ? toUtcDateKey(unixSeconds) : null
        };
    }

    if (hour >= startHour) {
        return { inRange: true, windowId: toUtcDateKey(unixSeconds) };
    }

    if (hour < endHour) {
        return {
            inRange: true,
            windowId: toUtcDateKey(unixSeconds - 86400)
        };
    }

    return { inRange: false, windowId: null };
}

export const asian_session_breakout: Strategy = {
    name: 'UTC Quiet Range Breakout (Crypto)',
    description: 'Builds a UTC quiet-range and trades post-range volatility expansion with ATR protection, tuned for 24/7 crypto markets.',
    defaultParams: {
        rangeStartHour: 0,
        rangeEndHour: 8,
        stopATR: 1.5
    },
    paramLabels: {
        rangeStartHour: 'Range Start Hour (UTC)',
        rangeEndHour: 'Range End Hour (UTC)',
        stopATR: 'Stop Loss (ATR)'
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const cleanData = ensureCleanData(data);
        if (cleanData.length === 0) return [];

        const rangeStartHour = clampHour(params.rangeStartHour, 0);
        const rangeEndHour = clampHour(params.rangeEndHour, 8);
        const stopATR = Math.max(0.1, params.stopATR ?? 1.5);
        if (rangeStartHour === rangeEndHour) return [];

        const highs = getHighs(cleanData);
        const lows = getLows(cleanData);
        const closes = getCloses(cleanData);
        const atr = calculateATR(highs, lows, closes, 14);

        const signals: Signal[] = [];

        let position: 'flat' | 'long' | 'short' = 'flat';
        let stopPrice = 0;
        let entryIndex = -1;

        let prevInRange = false;
        let buildingWindowId: string | null = null;
        let buildingHigh: number | null = null;
        let buildingLow: number | null = null;
        let readyRange: { windowId: string; high: number; low: number } | null = null;
        let tradedWindowId: string | null = null;

        for (let i = 0; i < cleanData.length; i++) {
            const unixSeconds = parseTimeToUnixSeconds(cleanData[i].time);
            if (unixSeconds === null) continue;

            const rangeInfo = getQuietRangeInfo(unixSeconds, rangeStartHour, rangeEndHour);

            if (rangeInfo.inRange) {
                const isNewRange = !prevInRange || rangeInfo.windowId !== buildingWindowId;
                if (isNewRange) {
                    buildingWindowId = rangeInfo.windowId;
                    buildingHigh = highs[i];
                    buildingLow = lows[i];
                    readyRange = null;

                    if (position === 'long') {
                        signals.push(createSellSignal(cleanData, i, 'Quiet Range session reset'));
                        position = 'flat';
                        stopPrice = 0;
                        entryIndex = -1;
                    } else if (position === 'short') {
                        signals.push(createBuySignal(cleanData, i, 'Quiet Range session reset'));
                        position = 'flat';
                        stopPrice = 0;
                        entryIndex = -1;
                    }
                } else {
                    buildingHigh = Math.max(buildingHigh ?? highs[i], highs[i]);
                    buildingLow = Math.min(buildingLow ?? lows[i], lows[i]);
                }

                prevInRange = true;
                continue;
            }

            if (prevInRange && buildingWindowId !== null && buildingHigh !== null && buildingLow !== null) {
                readyRange = {
                    windowId: buildingWindowId,
                    high: buildingHigh,
                    low: buildingLow
                };
            }
            prevInRange = false;

            if (position === 'long') {
                const stopHit = i > entryIndex && lows[i] <= stopPrice;
                if (stopHit) {
                    signals.push(createSellSignal(cleanData, i, 'Quiet Range long stop'));
                    position = 'flat';
                    stopPrice = 0;
                    entryIndex = -1;
                }
                continue;
            }

            if (position === 'short') {
                const stopHit = i > entryIndex && highs[i] >= stopPrice;
                if (stopHit) {
                    signals.push(createBuySignal(cleanData, i, 'Quiet Range short stop'));
                    position = 'flat';
                    stopPrice = 0;
                    entryIndex = -1;
                }
                continue;
            }

            if (!readyRange || readyRange.windowId === tradedWindowId) continue;

            const atrNow = atr[i];
            if (atrNow === null || atrNow <= 0) continue;

            const close = closes[i];
            if (close > readyRange.high) {
                signals.push(createBuySignal(cleanData, i, 'Quiet Range upside breakout'));
                position = 'long';
                stopPrice = close - (stopATR * atrNow);
                entryIndex = i;
                tradedWindowId = readyRange.windowId;
            } else if (close < readyRange.low) {
                signals.push(createSellSignal(cleanData, i, 'Quiet Range downside breakout'));
                position = 'short';
                stopPrice = close + (stopATR * atrNow);
                entryIndex = i;
                tradedWindowId = readyRange.windowId;
            }
        }

        if (position === 'long' && cleanData.length > 0) {
            signals.push(createSellSignal(cleanData, cleanData.length - 1, 'Quiet Range final close'));
        } else if (position === 'short' && cleanData.length > 0) {
            signals.push(createBuySignal(cleanData, cleanData.length - 1, 'Quiet Range final close'));
        }

        return signals;
    },
    metadata: {
        role: 'entry',
        direction: 'both',
        walkForwardParams: ['rangeStartHour', 'rangeEndHour', 'stopATR']
    }
};
