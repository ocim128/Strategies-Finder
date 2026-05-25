import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateSMA, calculateATR, calculateADX, calculateKeltnerChannels, calculateCMF, calculateIchimoku, OHLCVData, Time } from './lib/strategies/index';
import { precomputeIndicators, resolveIndicators } from './lib/strategies/backtest';
import { buildRollingSkewness } from './lib/strategies/lib/price-action-statistics-core';

function buildRollingSkewnessWindowed(values: number[], lookbackInput: number): (number | null)[] {
    const lookback = Math.max(3, Math.round(lookbackInput));
    const result: (number | null)[] = new Array(values.length).fill(null);

    for (let i = lookback - 1; i < values.length; i++) {
        let sum = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
            sum += values[j];
        }
        const mean = sum / lookback;

        let m2 = 0;
        let m3 = 0;
        for (let j = i - lookback + 1; j <= i; j++) {
            const diff = values[j] - mean;
            m2 += diff * diff;
            m3 += diff * diff * diff;
        }
        m2 /= lookback;
        m3 /= lookback;

        const stddev = Math.sqrt(m2);
        if (stddev <= 0) continue;

        result[i] = m3 / (stddev * stddev * stddev);
    }

    return result;
}

describe('Strategy Calculations', () => {
    it('should calculate SMA correctly', () => {
        const data = [10, 20, 30, 40, 50];
        const sma = calculateSMA(data, 3);
        // Period 3:
        // [null, null, (10+20+30)/3=20, (20+30+40)/3=30, (30+40+50)/3=40]
        expect(sma).to.deep.equal([null, null, 20, 30, 40]);
    });

    it('should calculate SMA with nulls for initial period', () => {
        const data = [1, 2, 3, 4, 5];
        const sma = calculateSMA(data, 5);
        expect(sma).to.deep.equal([null, null, null, null, 3]);
    });

    it('should calculate ADX within expected bounds', () => {
        const high = [10, 11, 12, 13, 14, 15, 16, 17];
        const low = [9, 9.5, 10, 10.5, 11, 12, 13, 14];
        const close = [9.5, 10.5, 11.5, 12.5, 13.5, 14.5, 15.5, 16.5];

        const adx = calculateADX(high, low, close, 3);
        expect(adx.length).to.equal(high.length);
        const last = adx[adx.length - 1];
        expect(last).to.be.a('number');
        expect(last).to.be.at.least(0);
        expect(last).to.be.at.most(100);
    });

    it('should calculate Keltner Channels around the EMA', () => {
        const high = [11, 12, 13, 14, 15, 16];
        const low = [9, 10, 11, 12, 13, 14];
        const close = [10, 11, 12, 13, 14, 15];

        const kc = calculateKeltnerChannels(high, low, close, 3, 3, 1.5);
        expect(kc.middle[5]).to.be.a('number');
        expect(kc.upper[5]!).to.be.greaterThan(kc.middle[5]!);
        expect(kc.lower[5]!).to.be.lessThan(kc.middle[5]!);
    });

    it('should calculate CMF around the zero line', () => {
        const high = [10, 11, 12, 13, 14, 15];
        const low = [8, 9, 10, 11, 12, 13];
        const close = [9.8, 10.8, 11.7, 12.2, 12.5, 14.6];
        const volume = [100, 110, 120, 130, 140, 150];

        const cmf = calculateCMF(high, low, close, volume, 3);
        expect(cmf[5]).to.be.a('number');
        expect(cmf[5]!).to.be.at.least(-1);
        expect(cmf[5]!).to.be.at.most(1);
    });

    it('should calculate rolling skewness like the windowed formula and cache repeated work', () => {
        const values = Array.from({ length: 120 }, (_, i) =>
            100000 + Math.sin(i / 5) * 0.02 + ((i % 7) - 3) * 0.003 + (i % 17 === 0 ? 0.06 : 0)
        );

        const actual = buildRollingSkewness(values, 12);
        const expected = buildRollingSkewnessWindowed(values, 12);

        expect(buildRollingSkewness(values, 12)).to.equal(actual);
        for (let i = 0; i < values.length; i++) {
            if (expected[i] === null) {
                expect(actual[i], `index ${i}`).to.equal(null);
            } else {
                expect(actual[i]!, `index ${i}`).to.be.closeTo(expected[i]!, 1e-8);
            }
        }
    });

    it('should calculate Ichimoku components without future leakage in current spans', () => {
        const high = [10, 11, 12, 13, 14, 15, 16, 17, 18, 19];
        const low = [8, 9, 10, 11, 12, 13, 14, 15, 16, 17];
        const close = [9, 10, 11, 12, 13, 14, 15, 16, 17, 18];

        const ichimoku = calculateIchimoku(high, low, close, 3, 5, 7, 2);
        expect(ichimoku.conversion[4]).to.be.a('number');
        expect(ichimoku.base[6]).to.be.a('number');
        expect(ichimoku.spanA[6]).to.be.a('number');
        expect(ichimoku.spanB[8]).to.be.a('number');
        expect(ichimoku.lagging[0]).to.equal(close[2]);
    });

    it('should key ATR/ADX caches by OHLC inputs, not close only', () => {
        const close = [10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10, 10];
        const highTrend = [11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22];
        const lowTrend = [9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9, 9];
        const highChop = [11, 10, 11, 10, 11, 10, 11, 10, 11, 10, 11, 10];
        const lowChop = [9, 10, 9, 10, 9, 10, 9, 10, 9, 10, 9, 10];

        const atrTrend = calculateATR(highTrend, lowTrend, close, 3);
        const atrChop = calculateATR(highChop, lowChop, close, 3);
        const atrChopFreshClose = calculateATR(highChop, lowChop, [...close], 3);
        expect(atrChop).to.deep.equal(atrChopFreshClose);
        expect(atrTrend).to.not.deep.equal(atrChop);

        const adxTrend = calculateADX(highTrend, lowTrend, close, 3);
        const adxChop = calculateADX(highChop, lowChop, close, 3);
        const adxChopFreshClose = calculateADX(highChop, lowChop, [...close], 3);
        expect(adxChop).to.deep.equal(adxChopFreshClose);
        expect(adxTrend).to.not.deep.equal(adxChop);
    });

    it('should reuse indicator precompute cache when ATR exit settings change without changing indicator inputs', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 80; i++) {
            const close = 100 + i * 0.4 + Math.sin(i / 5) * 3;
            data.push({
                time: new Date(Date.UTC(2023, 0, 1, i, 0, 0)).toISOString() as Time,
                open: close - 0.5,
                high: close + 1.2,
                low: close - 1.1,
                close,
                volume: 100 + (i % 10) * 15,
            });
        }

        const baseSettings = {
            riskMode: 'percentage' as const,
            takeProfitEnabled: true,
            takeProfitMode: 'fixed' as const,
            trendEmaPeriod: 50,
            adxPeriod: 14,
            adxMin: 20,
        };

        const first = resolveIndicators(data, {
            ...baseSettings,
            stopLossAtr: 1,
            takeProfitAtr: 2,
            trailingAtr: 0,
        });

        const second = resolveIndicators(data, {
            ...baseSettings,
            stopLossAtr: 3,
            takeProfitAtr: 5,
            trailingAtr: 2,
        });

        expect(first.atr).to.equal(second.atr);
        expect(first.emaTrend).to.equal(second.emaTrend);
        expect(first.adx).to.equal(second.adx);
    });

    it('should ignore stale precomputed indicators when atrPeriod changes', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 120, low: 100, close: 110, volume: 1000 },
            { time: '2023-01-02' as Time, open: 110, high: 112, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 103, low: 97, close: 100, volume: 1000 },
            { time: '2023-01-04' as Time, open: 100, high: 104, low: 99, close: 101, volume: 1000 },
            { time: '2023-01-05' as Time, open: 101, high: 101, low: 100, close: 100, volume: 1000 },
        ];

        const stalePrecomputed = precomputeIndicators(data, {
            riskMode: 'simple',
            atrPeriod: 1,
            stopLossAtr: 0,
            takeProfitAtr: 0.5,
            trailingAtr: 0,
        });

        const resolved = resolveIndicators(data, {
            riskMode: 'simple',
            atrPeriod: 2,
            stopLossAtr: 0,
            takeProfitAtr: 0.5,
            trailingAtr: 0,
        }, stalePrecomputed);

        const expected = resolveIndicators(data, {
            riskMode: 'simple',
            atrPeriod: 2,
            stopLossAtr: 0,
            takeProfitAtr: 0.5,
            trailingAtr: 0,
        });

        expect(resolved.atr).to.not.equal(stalePrecomputed.atr);
        expect(resolved.atr).to.deep.equal(expected.atr);
    });
});
