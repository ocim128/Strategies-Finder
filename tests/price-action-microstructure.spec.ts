import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Time } from '../lib/strategies/index';
import {
    buildCloseAcceptanceSeries,
    buildInitiativePressureSeries,
    buildTrailingHighLow,
} from '../lib/strategies/lib/price-action-frequency-core';
import { buildEfficiencyRatio, buildPercentileRank, buildRollingEntropy } from '../lib/strategies/lib/price-action-statistics-core';

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

    it('should rank percentile windows with duplicates and non-finite samples', () => {
        const values = [1, 2, 2, 4, Number.NaN, 3];
        const rank = buildPercentileRank(values, 3);
        const cachedRank = buildPercentileRank(values, 3);

        expect(cachedRank).to.equal(rank);
        expect(rank[0]).to.equal(null);
        expect(rank[1]).to.equal(null);
        expect(rank[2]).to.equal(0.5);
        expect(rank[3]).to.equal(1);
        expect(rank[4]).to.equal(null);
        expect(rank[5]).to.equal(0);
    });

    it('should calculate cached rolling efficiency ratio from trailing absolute changes', () => {
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 10, high: 10, low: 10, close: 10, volume: 100 },
            { time: '2' as Time, open: 10, high: 12, low: 10, close: 12, volume: 100 },
            { time: '3' as Time, open: 12, high: 13, low: 12, close: 13, volume: 100 },
            { time: '4' as Time, open: 13, high: 13, low: 11, close: 11, volume: 100 },
            { time: '5' as Time, open: 11, high: 14, low: 11, close: 14, volume: 100 },
        ];

        const er = buildEfficiencyRatio(data, 3);
        const cachedEr = buildEfficiencyRatio(data, 3);

        expect(cachedEr).to.equal(er);
        expect(er[0]).to.equal(null);
        expect(er[1]).to.equal(null);
        expect(er[2]).to.equal(null);
        expect(er[3]).to.be.closeTo(1 / 5, 1e-9);
        expect(er[4]).to.be.closeTo(2 / 6, 1e-9);
    });

    it('should calculate rolling entropy with dynamic window bins', () => {
        const values = [0, 0, 1, 1, 0];
        const entropy = buildRollingEntropy(values, 3, 2);
        const cachedEntropy = buildRollingEntropy(values, 3, 2);

        expect(cachedEntropy).to.equal(entropy);
        expect(entropy[0]).to.equal(null);
        expect(entropy[1]).to.equal(null);
        expect(entropy[2]).to.be.closeTo(0.918295834, 1e-9);
        expect(entropy[3]).to.be.closeTo(0.918295834, 1e-9);
        expect(entropy[4]).to.be.closeTo(0.918295834, 1e-9);
    });

    it('should build trailing high and low windows without leaking the current bar by default', () => {
        const data: OHLCVData[] = [
            { time: '1' as Time, open: 7, high: 10, low: 5, close: 8, volume: 100 },
            { time: '2' as Time, open: 8, high: 12, low: 6, close: 9, volume: 100 },
            { time: '3' as Time, open: 9, high: 11, low: 4, close: 7, volume: 100 },
            { time: '4' as Time, open: 7, high: 14, low: 7, close: 13, volume: 100 },
        ];

        const trailing = buildTrailingHighLow(data, 2);
        const inclusive = buildTrailingHighLow(data, 2, true);

        expect(trailing.highest).to.deep.equal([null, null, 12, 12]);
        expect(trailing.lowest).to.deep.equal([null, null, 5, 4]);
        expect(inclusive.highest).to.deep.equal([null, 12, 12, 14]);
        expect(inclusive.lowest).to.deep.equal([null, 5, 4, 4]);
    });

});
