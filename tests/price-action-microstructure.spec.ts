import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Time } from './lib/strategies/index';
import {
    buildCloseAcceptanceSeries,
    buildInitiativePressureSeries,
} from './lib/strategies/lib/price-action-frequency-core';

describe('Price Action Microstructure Helpers', () => {
    it('should score close acceptance by settlement quality', () => {
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 10, high: 12, low: 10, close: 12, volume: 100 },
            { time: '2' as Time, open: 11.8, high: 12, low: 10, close: 11.9, volume: 100 },
            { time: '3' as Time, open: 12, high: 12, low: 10, close: 10, volume: 100 },
        ];

        const acceptance = buildCloseAcceptanceSeries(data);

        expect(acceptance[0]).to.be.closeTo(1, 1e-9);
        expect(acceptance[1]).to.be.greaterThan(0);
        expect(acceptance[1]).to.be.lessThan(acceptance[0]);
        expect(acceptance[2]).to.be.closeTo(-1, 1e-9);
    });

    it('should scale initiative pressure with relative volume and settlement direction', () => {
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 10, high: 11, low: 9, close: 10, volume: 100 },
            { time: '2' as Time, open: 10, high: 11, low: 9, close: 10.1, volume: 100 },
            { time: '3' as Time, open: 10.1, high: 13, low: 10, close: 12.9, volume: 300 },
            { time: '4' as Time, open: 12.9, high: 13, low: 10, close: 10.1, volume: 320 },
        ];

        const pressure = buildInitiativePressureSeries(data, 2);

        expect(pressure[0]).to.equal(null);
        expect(pressure[1]).to.be.a('number');
        expect(pressure[2]).to.be.greaterThan(1);
        expect(pressure[3]).to.be.lessThan(-0.8);
    });

});
