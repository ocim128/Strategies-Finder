import { Strategy, OHLCVData, StrategyParams, Signal } from '../types';
import { detectPivotsWithDeviation } from '../strategy-helpers';

// Fibonacci Ratios for Trend-Based Time Extensions
// Standard extensions: 1.0 (Equal Time), 0.618 (Golden Ratio), 1.618, etc.
const FIB_RATIOS = [0.382, 0.618, 1.0, 1.382, 1.618, 2.0, 2.618];

export const trend_fib_time: Strategy = {
    name: 'Trend-Based Fib Time',
    description: 'Projects time zones using Fibonacci ratios of a trend (A-B) extended from a retracement point (C). Requires 3 pivots.',
    defaultParams: {
        deviation: 3,       // Standard deviation % for ZigZag
        depth: 10,          // Lookback depth for pivots
        zoneWindow: 1,      // Tolerance window (bars) for time zone hit
        trendFilter: 1,     // 1 = Follow Trend Direction
    },
    paramLabels: {
        deviation: 'Deviation (%)',
        depth: 'Pivot Depth',
        zoneWindow: 'Signal Window (+/- bars)',
        trendFilter: 'Uses Trend Logic (0/1)',
    },
    execute: (data: OHLCVData[], params: StrategyParams): Signal[] => {
        const signals: Signal[] = [];

        const deviation = params.deviation || 3;
        const depth = Math.floor(params.depth) || 10;
        const useTrendLogic = (params.trendFilter !== 0);

        // 1. Detect Pivots
        const pivots = detectPivotsWithDeviation(data, deviation, depth);

        // Need at least 3 pivots for A-B-C projection
        if (pivots.length < 3) return [];

        // Iterate through pivots to form A-B-C sets
        // We typically need alternating pivots High-Low-High or Low-High-Low

        for (let i = 2; i < pivots.length; i++) {
            const pC = pivots[i];     // Latest pivot (Start of projection)
            const pB = pivots[i - 1]; // Middle pivot
            const pA = pivots[i - 2]; // Start pivot

            // Logic Check: Should be alternating
            // But detectPivots guarantees alternating High/Low usually.

            // Time Distance A -> B
            const distAB = pB.index - pA.index;
            if (distAB <= 0) continue;

            // Trend Definition:
            // If Trend was A(Low) -> B(High) -> C(Low), we are projecting start of Next Up Trend?
            // "Trend-Based Fib Time" usually measures the impulse (A-B) and projects it from C.
            // 
            // Case 1: A=Low, B=High, C=Low (Bullish Correction finished?)
            // We anticipate the next High based on time ratios of A-B.
            // Target events are HIGH points/Reversals. So we SELL at zones?
            // OR checks for continuation?
            //
            // Standard interpretation:
            // A-B is the Trend. C is the retracement.
            // Zones mark expected completion of the next impulse (C-D).
            // Since next impulse is UP, the time zone marks the Top. -> SELL signal.

            // Case 2: A=High, B=Low, C=High (Bearish Correction finished?)
            // Next impulse is DOWN. Time zone marks Bottom. -> BUY signal.

            let signalType: 'buy' | 'sell' | undefined;

            // If A is Low, B is High, C is Low -> Bullish setup. Next move is UP. Zone is Top. -> SELL.
            if (!pA.isHigh && pB.isHigh && !pC.isHigh) {
                signalType = 'sell';
            }
            // If A is High, B is Low, C is High -> Bearish setup. Next move is DOWN. Zone is Bottom. -> BUY.
            else if (pA.isHigh && !pB.isHigh && pC.isHigh) {
                signalType = 'buy';
            }

            if (useTrendLogic && !signalType) continue;

            // If not strict trend logic, standard might be to just alternate based on C?
            // If C is Low, we buy? No, existing logic implies C is start of new wave.
            // Let's stick to the mapping above.

            // Project Zones from C
            for (const ratio of FIB_RATIOS) {
                // Projection = C.index + (Distance(A,B) * Ratio)
                const projectedIndex = Math.round(pC.index + (distAB * ratio));

                if (projectedIndex >= data.length) continue;
                if (projectedIndex < 0) continue;

                // Simple collision check: Is 'projectedIndex' valid?
                // Just create signal.

                // Note: If multiple pivots equate to same time?
                // We'll push, user can handle.

                if (signalType) {
                    signals.push({
                        time: data[projectedIndex].time,
                        type: signalType,
                        price: data[projectedIndex].close,
                        reason: `Trend Fib Time (${ratio}) based on A(${pA.index})-B(${pB.index})`
                    });
                }
            }
        }

        // Sort signals (safe for time string/number mixed types if implemented correctly in tests)
        signals.sort((a, b) => {
            if (a.time < b.time) return -1;
            if (a.time > b.time) return 1;
            return 0;
        });

        return signals;
    }
};
