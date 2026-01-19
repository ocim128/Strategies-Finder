import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateSMA, calculateRSI, calculateStochastic, calculateVWAP, calculateVolumeProfile, calculateDonchianChannels, calculateSupertrend, calculateMomentum, calculateADX, runBacktest, OHLCVData, Signal, Time } from './lib/strategies/index';


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
});

describe('Backtesting Engine', () => {
    it('should execute trades and calculate profit correctly', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 110, low: 90, close: 110, volume: 1000 }, // Buy here
            { time: '2023-01-03' as Time, open: 110, high: 125, low: 105, close: 120, volume: 1000 },
            { time: '2023-01-04' as Time, open: 120, high: 130, low: 110, close: 125, volume: 1000 }, // Sell here
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-04' as Time, type: 'sell', price: 125 },
        ];

        // Capital 1000, 100% size, 0% commission
        const result = runBacktest(data, signals, 1000, 100, 0);

        expect(result.totalTrades).to.equal(1);
        expect(result.winningTrades).to.equal(1);
        // Bought 10 shares @ 100 = 1000 cost.
        // Sold 10 shares @ 125 = 1250 value.
        // Profit = 250.
        expect(result.netProfit).to.equal(250);
        expect(result.profitFactor).to.equal(Infinity); // No losses
    });

    it('should execute short trades when trade direction is short', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 95, close: 100, volume: 1000 }, // Sell here
            { time: '2023-01-03' as Time, open: 100, high: 101, low: 85, close: 90, volume: 1000 },
            { time: '2023-01-04' as Time, open: 90, high: 95, low: 75, close: 80, volume: 1000 }, // Buy here
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-04' as Time, type: 'buy', price: 80 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, { tradeDirection: 'short' });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].type).to.equal('short');
        expect(result.netProfit).to.equal(200);
    });

    it('should handle commission correctly', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 110, low: 90, close: 110, volume: 1000 },
            { time: '2023-01-04' as Time, open: 120, high: 130, low: 110, close: 125, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-04' as Time, type: 'sell', price: 125 },
        ];

        // Capital 1000, 100% size, 1% commission
        // Entry: 
        // Trade Value = 1000 / 1.01 = 990.099...
        // Entry Comm = 9.901
        // Shares = 9.90099...
        //
        // Exit:
        // Value = 9.90099 * 125 = 1237.62...
        // Exit Comm = 12.376...
        // Net Value = 1225.24...
        // Net Profit = 225.24...

        const result = runBacktest(data, signals, 1000, 100, 1);

        expect(result.netProfit).to.be.closeTo(225.24, 0.1);
    });

    it('should calculate profit factor and drawdown correctly', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 110, low: 90, close: 110, volume: 1000 },
            { time: '2023-01-03' as Time, open: 110, high: 105, low: 95, close: 100, volume: 1000 },
            { time: '2023-01-04' as Time, open: 100, high: 120, low: 100, close: 120, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
            { time: '2023-01-02' as Time, type: 'sell', price: 90 }, // Lose 100
            { time: '2023-01-03' as Time, type: 'buy', price: 100 },
            { time: '2023-01-04' as Time, type: 'sell', price: 120 }, // Win 200
        ];

        const result = runBacktest(data, signals, 1000, 100, 0);

        expect(result.totalTrades).to.equal(2);
        expect(result.winningTrades).to.equal(1);
        expect(result.losingTrades).to.equal(1);
        expect(result.netProfit).to.equal(80); // -100 + 180
        expect(result.profitFactor).to.equal(1.8); // 180 / 100
        expect(result.maxDrawdownPercent).to.be.greaterThan(0);
    });
});
