import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Time } from './lib/strategies/index';
import { buildPivotFlags, detectPivots, detectPivotsWithDeviation } from './lib/strategies/strategy-helpers';
describe('Pivot Detection', () => {
    it('should detect zig-zag pivots correctly', () => {
        // Construct a clear zig-zag pattern
        // 0: 100
        // 1: 110 (High candidate)
        // 2: 105
        // 3: 115 (Higher High - should replace previous high) - PIVOT HIGH
        // 4: 100 
        // 5: 90 (Low candidate) - PIVOT LOW
        // 6: 100
        // 7: 120 (High candidate) - PIVOT HIGH
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '2' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
            { time: '3' as Time, open: 105, high: 105, low: 105, close: 105, volume: 100 },
            { time: '4' as Time, open: 115, high: 115, low: 115, close: 115, volume: 100 }, // High 115
            { time: '5' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '6' as Time, open: 90, high: 90, low: 90, close: 90, volume: 100 }, // Low 90
            { time: '7' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '8' as Time, open: 120, high: 120, low: 120, close: 120, volume: 100 }, // High 120
            { time: '9' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
        ];

        // Depth 2 (halfDepth = 1, look 1 bar left/right)
        // Deviation 5%
        const pivots = detectPivotsWithDeviation(data, 5, 2);

        expect(pivots.length).to.be.greaterThan(0);

        // Should find the lowest low at 90
        const lowPivot = pivots.find(p => !p.isHigh && p.price === 90);
        expect(lowPivot).to.not.be.undefined;
        expect(lowPivot?.index).to.equal(5);

        // Should find the highest high at 120
        const highPivot = pivots.find(p => p.isHigh && p.price === 120);
        expect(highPivot).to.not.be.undefined;
        expect(highPivot?.index).to.equal(7);
    });

    it('should support dynamic deviation thresholds', () => {
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '2' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
            { time: '3' as Time, open: 105, high: 105, low: 105, close: 105, volume: 100 },
            { time: '4' as Time, open: 115, high: 115, low: 115, close: 115, volume: 100 },
            { time: '5' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '6' as Time, open: 90, high: 90, low: 90, close: 90, volume: 100 },
            { time: '7' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '8' as Time, open: 120, high: 120, low: 120, close: 120, volume: 100 },
            { time: '9' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
        ];

        const staticThresholds = new Array(data.length).fill(30);
        const dynamicThresholds = new Array(data.length).fill(30);
        dynamicThresholds[5] = 5;
        dynamicThresholds[7] = 5;

        const staticPivots = detectPivots(data, {
            depth: 2,
            deviationThreshold: staticThresholds,
            extremaMode: 'strict',
            includeConfirmationIndex: true,
            deviationInclusive: false,
        });
        const dynamicPivots = detectPivots(data, {
            depth: 2,
            deviationThreshold: dynamicThresholds,
            extremaMode: 'strict',
            includeConfirmationIndex: true,
            deviationInclusive: false,
        });

        expect(staticPivots.length).to.equal(1);
        expect(dynamicPivots.length).to.be.greaterThan(staticPivots.length);
    });

    it('should expose confirmation indices when requested', () => {
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '2' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
            { time: '3' as Time, open: 105, high: 105, low: 105, close: 105, volume: 100 },
            { time: '4' as Time, open: 115, high: 115, low: 115, close: 115, volume: 100 },
            { time: '5' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '6' as Time, open: 90, high: 90, low: 90, close: 90, volume: 100 },
            { time: '7' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 },
            { time: '8' as Time, open: 120, high: 120, low: 120, close: 120, volume: 100 },
            { time: '9' as Time, open: 110, high: 110, low: 110, close: 110, volume: 100 },
        ];

        const pivots = detectPivots(data, {
            depth: 2,
            deviationThreshold: 5,
            extremaMode: 'strict',
            includeConfirmationIndex: true,
        });

        expect(pivots.length).to.be.greaterThan(0);
        pivots.forEach((pivot) => {
            expect(pivot.confirmationIndex).to.equal(pivot.index + 1);
        });
    });

    it('strict pivot flags should match expected extrema behavior', () => {
        const highs = [100, 110, 105, 115, 100, 90, 100, 120, 110];
        const lows = [100, 110, 105, 115, 100, 90, 100, 120, 110];
        const flags = buildPivotFlags(highs, lows, 1, 'strict');

        expect(flags.pivotHighs[3]).to.equal(true);
        expect(flags.pivotLows[5]).to.equal(true);
        expect(flags.pivotHighs[7]).to.equal(true);
    });
});





