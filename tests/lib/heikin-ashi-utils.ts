/**
 * Heikin Ashi Transformation Utility
 * 
 * Heikin Ashi is a candlestick charting technique that smooths price data
 * to make trend identification easier.
 * 
 * Formula:
 * - HA Close = (Open + High + Low + Close) / 4
 * - HA Open = (Previous HA Open + Previous HA Close) / 2
 * - HA High = Max(High, HA Open, HA Close)
 * - HA Low = Min(Low, HA Open, HA Close)
 */

import { OHLCVData } from "./strategies/index";

/**
 * Transforms standard OHLCV data to Heikin Ashi format.
 * 
 * Note: This is a purely visual transformation. Strategies should always
 * use the original OHLCV data for accurate backtesting, as Heikin Ashi
 * values are synthetic and can lead to unrealistic entry/exit prices.
 * 
 * @param data - Array of OHLCV candlestick data
 * @returns Array of Heikin Ashi transformed OHLCV data
 */
export function toHeikinAshi(data: OHLCVData[]): OHLCVData[] {
    if (data.length === 0) return [];

    const result: OHLCVData[] = [];

    for (let i = 0; i < data.length; i++) {
        const current = data[i];

        // HA Close = average of OHLC
        const haClose = (current.open + current.high + current.low + current.close) / 4;

        // HA Open = midpoint of previous HA candle body
        let haOpen: number;
        if (i === 0) {
            // For first bar, use average of open and close
            haOpen = (current.open + current.close) / 2;
        } else {
            const prev = result[i - 1];
            haOpen = (prev.open + prev.close) / 2;
        }

        // HA High = maximum of high, HA open, HA close
        const haHigh = Math.max(current.high, haOpen, haClose);

        // HA Low = minimum of low, HA open, HA close
        const haLow = Math.min(current.low, haOpen, haClose);

        result.push({
            time: current.time,
            open: haOpen,
            high: haHigh,
            low: haLow,
            close: haClose,
            volume: current.volume,
        });
    }

    return result;
}
