import { Strategy, OHLCVData, StrategyParams, Signal } from '../types';
import { detectPivotsWithDeviation } from '../strategy-helpers';

// Fibonacci Sequence for Time Zones
const FIB_SEQUENCE = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89];

export const fib_time_zones: Strategy = {
    name: 'Fibonacci Time Zones',
    description: 'Generates signals based on Fibonacci Time Zones projected from recent pivot points. Time Zones often mark potential trend reversals.',
    defaultParams: {
        deviation: 3,       // Standard deviation % for ZigZag
        depth: 10,          // Lookback depth for pivots
        zoneWindow: 1,      // Tolerance window (bars) for time zone hit (0 = exact bar)
        trendFilter: 1,     // 1 = Follow "Pivot Reversal" logic (Buy after High pivot), 0 = Any hit
    },
    paramLabels: {
        deviation: 'Deviation (%)',
        depth: 'Pivot Depth',
        zoneWindow: 'Signal Window (+/- bars)',
        trendFilter: 'Uses Trend Reversal Logic (0/1)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const signals: Signal[] = [];

        const deviation = params.deviation || 3;
        const depth = Math.floor(params.depth) || 10;
        // const window = Math.floor(params.zoneWindow) || 1;
        const useTrendLogic = (params.trendFilter !== 0);

        // 1. Detect Pivots
        const pivots = detectPivotsWithDeviation(data, deviation, depth);
        // console.log('Strategy Pivots:', JSON.stringify(pivots, null, 2));

        if (pivots.length < 2) return [];

        for (let i = 1; i < pivots.length; i++) {
            const pLast = pivots[i];
            const pPrev = pivots[i - 1];

            // Time Base
            const baseBars = pLast.index - pPrev.index;
            if (baseBars <= 0) continue;

            // Project Zones
            for (const fib of FIB_SEQUENCE) {
                const zoneIndex = pLast.index + (baseBars * fib);

                if (zoneIndex >= data.length) break;

                // Signal Logic
                const isBullishSetup = pLast.isHigh;
                // If Last was High, we are trending down. Time Zone marks reversal bottom => BUY.

                const isBearishSetup = !pLast.isHigh;
                // If Last was Low, we are trending up. Time Zone marks top => SELL.

                let type: 'buy' | 'sell' | undefined;
                if (useTrendLogic) {
                    if (isBullishSetup) type = 'buy';
                    else if (isBearishSetup) type = 'sell';
                } else {
                    if (isBullishSetup) type = 'buy';
                    else type = 'sell';
                }

                if (type && zoneIndex >= 0) {
                    // console.log(`Signal generated at index ${zoneIndex} (${type})`);
                    signals.push({
                        time: data[zoneIndex].time,
                        type: type,
                        price: data[zoneIndex].close,
                        reason: `Fib Time Zone (${fib}) from pivots`
                    });
                }
            }
        }

        // Sort signals by time
        signals.sort((a, b) => {
            // Safe sort assuming generic time comparison
            if (a.time < b.time) return -1;
            if (a.time > b.time) return 1;
            return 0;
        });

        return signals;
    }
};
