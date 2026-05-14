import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateSMA, calculateRSI, calculateStochastic, calculateVWAP, calculateSessionVWAP, calculateVolumeProfile, calculateDonchianChannels, calculateSupertrend, calculateMomentum, calculateATR, calculateADX, calculateKeltnerChannels, calculateMFI, calculateCMF, calculateIchimoku, OHLCVData, Time } from './lib/strategies/index';
import { precomputeIndicators, resolveIndicators } from './lib/strategies/backtest';
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

    it('should calculate RSI correctly (basic check)', () => {
        // Simple uptrend
        const data = [10, 11, 12, 13, 14, 15]; // Gains: 1, 1, 1, 1, 1
        // Period 2 (very short for testing)
        // i=0: null
        // i=1: change=1, gain=1, loss=0. avgGain=1/2=0.5, avgLoss=0. First RSI calculation requires previous averages? 
        // My implementation:
        // Init loop 1..period: gains/losses accumulated.
        // Then first RSI at i=period.
        // Let's verify black box.
        const rsi = calculateRSI(data, 2);
        expect(rsi.length).to.equal(6);
        // First 2 should be null (index 0 and 1)? 
        // Logic: Fill initial nulls for i=0 to period (exclusive). So 0, 1.
        expect(rsi[0]).to.be.null;
        expect(rsi[1]).to.be.null;
        // Index 2: First RSI.
        expect(rsi[2]).to.be.a('number');
        expect(rsi[2]).to.be.greaterThan(50); // It's going up
    });

    it('should calculate VWAP correctly', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 10, high: 20, low: 5, close: 10, volume: 100 },
            { time: '2023-01-02' as Time, open: 10, high: 20, low: 5, close: 20, volume: 100 },
        ];
        // Day 1: Typical Price = (20+5+10)/3 = 11.666. TPV = 1166.6. Vol = 100. VWAP = 11.666
        // Day 2: Typical Price = (20+5+20)/3 = 15. TPV = 1500. Accum TPV = 2666.6. Accum Vol = 200. VWAP = 13.333
        const vwap = calculateVWAP(data);
        expect(vwap[0]).to.be.closeTo(11.666, 0.01);
        expect(vwap[1]).to.be.closeTo(13.333, 0.01);
    });

    it('should reset Session VWAP on a new UTC date', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01T00:00:00Z' as Time, open: 10, high: 20, low: 5, close: 10, volume: 100 },
            { time: '2023-01-01T01:00:00Z' as Time, open: 10, high: 20, low: 5, close: 20, volume: 100 },
            { time: '2023-01-02T00:00:00Z' as Time, open: 20, high: 24, low: 18, close: 22, volume: 200 },
        ];

        const sessionVwap = calculateSessionVWAP(data);
        expect(sessionVwap[0]).to.be.closeTo(11.666, 0.01);
        expect(sessionVwap[1]).to.be.closeTo(13.333, 0.01);
        expect(sessionVwap[2]).to.be.closeTo((24 + 18 + 22) / 3, 0.01);
    });

    it('should calculate Stochastic Oscillator correctly', () => {
        const high = [10, 10, 10, 10, 10];
        const low = [0, 0, 0, 0, 0];
        const close = [5, 5, 5, 5, 5];
        // Range 0-10. Close 5. %K should be 50.
        const stoch = calculateStochastic(high, low, close, 3, 3);
        // Period 3. 
        // i=0: null
        // i=1: null
        // i=2: High(2,1,0)=10, Low=0. Range=10. Close=5. %K=50.
        // i=3: %K=50.
        // %D is SMA(3) of %K.
        expect(stoch.k[2]).to.equal(50);
    });

    it('should calculate Volume Profile POC correctly', () => {
        const data: OHLCVData[] = [
            // Create a range where most volume is at price 100
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            // Some outlier volume
            { time: '2023-01-04' as Time, open: 110, high: 115, low: 105, close: 110, volume: 100 },
        ];

        // Period 3 for profile.
        // i=0,1,2 < period (3) -> nulls.
        // i=3: Slice 0,1,2.
        // Prices 95-105. POC should be near 100.
        const vp = calculateVolumeProfile(data, 3, 10);
        expect(vp.poc[3]).to.be.closeTo(100, 5);
        expect(vp.vah[3]).to.be.greaterThan(vp.poc[3]!);
        expect(vp.val[3]).to.be.lessThan(vp.poc[3]!);
    });
    it('should calculate Donchian Channels correctly', () => {
        const high = [10, 12, 11, 13, 15];
        const low = [8, 9, 8, 10, 12];
        const period = 3;
        // i=0,1: null
        // i=2: window 0,1,2. MaxHigh(10,12,11)=12. MinLow(8,9,8)=8.
        // i=3: window 1,2,3. MaxHigh(12,11,13)=13. MinLow(9,8,10)=8.
        // i=4: window 2,3,4. MaxHigh(11,13,15)=15. MinLow(8,10,12)=8.
        const { upper, lower, middle } = calculateDonchianChannels(high, low, period);

        expect(upper[2]).to.equal(12);
        expect(lower[2]).to.equal(8);
        expect(middle[2]).to.equal(10);

        expect(upper[3]).to.equal(13);
        expect(lower[3]).to.equal(8);
    });

    it('should calculate Momentum correctly', () => {
        const data = [10, 12, 11, 15];
        const period = 2;
        // i=0,1: null
        // i=2: 11 - 10 = 1
        // i=3: 15 - 12 = 3
        const mom = calculateMomentum(data, period);
        expect(mom[2]).to.equal(1);
        expect(mom[3]).to.equal(3);
    });

    it('should calculate Supertrend correctly (basic)', () => {
        // Flat market, then breakout
        const high = [10, 10, 10, 10, 20];
        const low = [9, 9, 9, 9, 19];
        const close = [9.5, 9.5, 9.5, 9.5, 19.5];
        const period = 3;
        const factor = 1;

        // Just verify it doesn't crash and produces numbers
        const { supertrend, direction } = calculateSupertrend(high, low, close, period, factor);
        expect(supertrend.length).to.equal(5);
        // At index 4, price shoots up, should be bullish (1)
        expect(direction[4]).to.equal(1);
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

    it('should calculate MFI within expected bounds', () => {
        const high = [10, 11, 12, 13, 14, 15];
        const low = [9, 10, 11, 12, 13, 14];
        const close = [9.5, 10.8, 11.7, 12.6, 13.4, 14.2];
        const volume = [100, 110, 120, 130, 140, 150];

        const mfi = calculateMFI(high, low, close, volume, 3);
        expect(mfi[5]).to.be.a('number');
        expect(mfi[5]!).to.be.at.least(0);
        expect(mfi[5]!).to.be.at.most(100);
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
