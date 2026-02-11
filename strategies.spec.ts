import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateSMA, calculateRSI, calculateStochastic, calculateVWAP, calculateVolumeProfile, calculateDonchianChannels, calculateSupertrend, calculateMomentum, calculateADX, runBacktest, runBacktestCompact, OHLCVData, Signal, Time, Trade } from './lib/strategies/index';
import { buildPivotFlags, detectPivots, detectPivotsWithDeviation } from './lib/strategies/strategy-helpers';
import { simple_regression_line } from './lib/strategies/lib/simple-regression-line';
import { analyzeTradePatterns } from './lib/strategies/backtest/trade-analyzer';
import { getOpenPositionForScanner } from './lib/strategies/backtest/signal-preparation';
import { resolveScannerBacktestSettings } from './lib/scanner/scanner-engine';


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

    it('scanner settings resolver should mirror backtest toggle behavior', () => {
        const rawScannerSettings = {
            riskSettingsToggle: false,
            riskMode: 'simple',
            atrPeriod: 14,
            stopLossAtr: 1.5,
            takeProfitAtr: 3,
            trailingAtr: 2,
            stopLossPercent: 5,
            takeProfitPercent: 10,
            stopLossEnabled: true,
            takeProfitEnabled: true,
            tradeFilterSettingsToggle: false,
            tradeFilterMode: 'rsi',
            confirmLookback: 4,
            volumeSmaPeriod: 25,
            volumeMultiplier: 2,
            confirmRsiPeriod: 7,
            confirmRsiBullish: 60,
            confirmRsiBearish: 40,
            confirmationStrategiesToggle: false,
            confirmationStrategies: ['test-filter'],
            confirmationStrategyParams: { 'test-filter': { length: 20 } },
            tradeDirection: 'short',
            executionModel: 'next_open',
            allowSameBarExit: false,
            slippageBps: 5,
            snapshotAtrFilterToggle: false,
            snapshotAtrPercentMin: 1.2,
            snapshotAtrPercentMax: 2.1,
        };

        const resolved = resolveScannerBacktestSettings(rawScannerSettings as any);

        expect(resolved.stopLossAtr).to.equal(0);
        expect(resolved.takeProfitAtr).to.equal(0);
        expect(resolved.trailingAtr).to.equal(0);
        expect(resolved.stopLossEnabled).to.equal(false);
        expect(resolved.takeProfitEnabled).to.equal(false);
        expect(resolved.tradeFilterMode).to.equal('none');
        expect(resolved.confirmationStrategies).to.deep.equal([]);
        expect(resolved.confirmationStrategyParams).to.deep.equal({});
        expect(resolved.snapshotAtrPercentMin).to.equal(0);
        expect(resolved.snapshotAtrPercentMax).to.equal(0);
    });

    it('scanner settings resolver should accept combined trade direction', () => {
        const resolved = resolveScannerBacktestSettings({
            tradeDirection: 'combined',
            riskSettingsToggle: false,
            tradeFilterSettingsToggle: false
        } as any);
        expect(resolved.tradeDirection).to.equal('combined');
    });

    it('scanner settings resolver should coerce string toggles and numeric inputs', () => {
        const resolved = resolveScannerBacktestSettings({
            riskSettingsToggle: 'true',
            riskMode: 'percentage',
            stopLossPercent: '2.5',
            takeProfitPercent: '7.5',
            stopLossEnabled: 'true',
            takeProfitEnabled: 'false',
            tradeFilterSettingsToggle: 'true',
            tradeFilterMode: 'rsi',
            confirmLookback: '3',
            volumeSmaPeriod: '21',
            volumeMultiplier: '1.8',
            confirmRsiPeriod: '11',
            confirmRsiBullish: '60',
            confirmRsiBearish: '40',
            confirmationStrategiesToggle: 'true',
            confirmationStrategies: ['sma_crossover'],
            confirmationStrategyParams: {
                sma_crossover: {
                    fastPeriod: '9',
                    slowPeriod: '21',
                }
            },
            allowSameBarExit: 'true',
            slippageBps: '12',
            tradeDirection: 'combined',
            snapshotAtrFilterToggle: 'true',
            snapshotAtrPercentMin: '1.1',
            snapshotAtrPercentMax: '2.2',
        } as any);

        expect(resolved.stopLossPercent).to.equal(2.5);
        expect(resolved.takeProfitPercent).to.equal(7.5);
        expect(resolved.stopLossEnabled).to.equal(true);
        expect(resolved.takeProfitEnabled).to.equal(false);
        expect(resolved.tradeFilterMode).to.equal('rsi');
        expect(resolved.confirmLookback).to.equal(3);
        expect(resolved.volumeSmaPeriod).to.equal(21);
        expect(resolved.volumeMultiplier).to.equal(1.8);
        expect(resolved.rsiPeriod).to.equal(11);
        expect(resolved.rsiBullish).to.equal(60);
        expect(resolved.rsiBearish).to.equal(40);
        expect(resolved.confirmationStrategies).to.deep.equal(['sma_crossover']);
        expect(resolved.confirmationStrategyParams).to.deep.equal({
            sma_crossover: {
                fastPeriod: 9,
                slowPeriod: 21,
            }
        });
        expect(resolved.allowSameBarExit).to.equal(true);
        expect(resolved.slippageBps).to.equal(12);
        expect(resolved.tradeDirection).to.equal('combined');
        expect(resolved.snapshotAtrPercentMin).to.equal(1.1);
        expect(resolved.snapshotAtrPercentMax).to.equal(2.2);
    });

    it('scanner settings resolver should coerce numeric/boolean strings when toggle keys are absent', () => {
        const resolved = resolveScannerBacktestSettings({
            executionModel: 'next_close',
            allowSameBarExit: 'false',
            slippageBps: '9',
            takeProfitAtr: '2.75',
            confirmationStrategyParams: {
                dynamic_vix_regime: {
                    lookback: '34'
                }
            }
        } as any);

        expect(resolved.executionModel).to.equal('next_close');
        expect(resolved.allowSameBarExit).to.equal(false);
        expect(resolved.slippageBps).to.equal(9);
        expect(resolved.takeProfitAtr).to.equal(2.75);
        expect((resolved.confirmationStrategyParams as any)?.dynamic_vix_regime?.lookback).to.equal(34);
    });

    it('scanner open position should reuse TP/SL from backtest open trade state', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 104, high: 106, low: 102, close: 105, volume: 1000 },
            { time: '2023-01-03' as Time, open: 106, high: 110, low: 104, close: 108, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 105 },
        ];

        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            atrPeriod: 1,
            stopLossAtr: 1,
            takeProfitAtr: 2,
            trailingAtr: 0,
        };

        const result = runBacktest(data, signals, 10000, 100, 0, settings);
        const lastTrade = result.trades[result.trades.length - 1];
        const openPosition = getOpenPositionForScanner(data, signals, settings);

        expect(lastTrade.exitReason).to.equal('end_of_data');
        expect(lastTrade.takeProfitPrice).to.not.equal(undefined);
        expect(lastTrade.stopLossPrice).to.not.equal(undefined);
        expect(openPosition).to.not.equal(null);
        expect(openPosition?.takeProfitPrice).to.equal(lastTrade.takeProfitPrice ?? null);
        expect(openPosition?.stopLossPrice).to.equal(lastTrade.stopLossPrice ?? null);
    });

    it('should flip position on opposite signals when trade direction is both', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 95, close: 100, volume: 1000 }, // Short entry
            { time: '2023-01-03' as Time, open: 90, high: 91, low: 88, close: 90, volume: 1000 },   // Flip to long
            { time: '2023-01-04' as Time, open: 95, high: 96, low: 94, close: 95, volume: 1000 },   // Final close
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-03' as Time, type: 'buy', price: 90 },
        ];

        const settings = { tradeDirection: 'both' as const };
        const full = runBacktest(data, signals, 1000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

        expect(full.totalTrades).to.equal(2);
        expect(full.trades[0].type).to.equal('short');
        expect(full.trades[1].type).to.equal('long');
        expect(full.netProfit).to.be.closeTo(161.1111, 1e-4);
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-8);
    });

    it('should support combined direction with same-bar opposite-entry conflicts ignored', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // Conflict bar
            { time: '2023-01-03' as Time, open: 110, high: 112, low: 108, close: 110, volume: 1000 },
            { time: '2023-01-04' as Time, open: 120, high: 121, low: 118, close: 120, volume: 1000 },
            { time: '2023-01-05' as Time, open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-02' as Time, type: 'sell', price: 100 }, // Conflict pair should be ignored as entries
            { time: '2023-01-03' as Time, type: 'buy', price: 110 },  // Long entry
            { time: '2023-01-04' as Time, type: 'sell', price: 120 }, // Long exit + short entry
            { time: '2023-01-05' as Time, type: 'buy', price: 100 },  // Short exit + long entry
        ];

        const settings = { tradeDirection: 'combined' as const };
        const full = runBacktest(data, signals, 1000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

        expect(full.trades.some(trade => trade.entryTime === ('2023-01-02' as Time))).to.equal(false);
        expect(full.totalTrades).to.equal(3);
        expect(full.netProfit).to.be.closeTo(128.787878, 1e-6);
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-8);
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

    it('compact and full backtests should stay in sync for summary metrics', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 102, low: 98, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 108, low: 99, close: 106, volume: 1000 },
            { time: '2023-01-03' as Time, open: 106, high: 109, low: 101, close: 103, volume: 1000 },
            { time: '2023-01-04' as Time, open: 103, high: 112, low: 102, close: 110, volume: 1000 },
            { time: '2023-01-05' as Time, open: 110, high: 111, low: 104, close: 105, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 106 },
            { time: '2023-01-03' as Time, type: 'sell', price: 103 },
            { time: '2023-01-04' as Time, type: 'buy', price: 110 },
            { time: '2023-01-05' as Time, type: 'sell', price: 105 },
        ];

        const full = runBacktest(data, signals, 10000, 100, 0.1);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0.1);

        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.winningTrades).to.equal(full.winningTrades);
        expect(compact.losingTrades).to.equal(full.losingTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-8);
        expect(compact.avgTrade).to.be.closeTo(full.avgTrade, 1e-8);
        expect(compact.expectancy).to.be.closeTo(full.expectancy, 1e-8);
        expect(compact.profitFactor).to.be.closeTo(full.profitFactor, 1e-8);
        expect(compact.maxDrawdownPercent).to.be.closeTo(full.maxDrawdownPercent, 1e-8);
    });

    it('should skip invalid entries with non-positive fill prices', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 98, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 103, low: 97, close: 100, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 0 },
            { time: '2023-01-03' as Time, type: 'sell', price: 100 },
        ];

        const full = runBacktest(data, signals, 1000, 100, 0);
        const compact = runBacktestCompact(data, signals, 1000, 100, 0);

        expect(full.totalTrades).to.equal(0);
        expect(compact.totalTrades).to.equal(0);
        expect(Number.isFinite(full.netProfit)).to.equal(true);
        expect(Number.isFinite(compact.netProfit)).to.equal(true);
    });

    it('should filter low-efficiency entries when trend efficiency filter is enabled', () => {
        const data: OHLCVData[] = [];
        const closes = [
            100, 101, 100, 101, 100, 101, 100, 101, 100, 101, 100, 101,
            102, 103, 104, 105, 106, 107, 108, 109, 110, 111, 112, 113
        ];
        for (let i = 0; i < closes.length; i++) {
            const close = closes[i];
            data.push({
                time: (`2023-02-${String(i + 1).padStart(2, '0')}`) as Time,
                open: close - 0.4,
                high: close + 1,
                low: close - 1,
                close,
                volume: 1000
            });
        }

        const signals: Signal[] = [
            { time: '2023-02-12' as Time, type: 'buy', price: 101 },
            { time: '2023-02-14' as Time, type: 'sell', price: 103 },
            { time: '2023-02-21' as Time, type: 'buy', price: 110 },
            { time: '2023-02-23' as Time, type: 'sell', price: 112 },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotTrendEfficiencyMin: 0.6
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
    });

    it('should filter low-conviction candles with body percent filter', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 18; i++) {
            const base = 100 + i;
            data.push({
                time: (`2023-03-${String(i + 1).padStart(2, '0')}`) as Time,
                open: base,
                high: base + 1,
                low: base - 1,
                close: base + 0.2,
                volume: 1200
            });
        }

        // Entry 1: doji-like candle (~5% body of range)
        data[12] = {
            time: '2023-03-13' as Time,
            open: 112,
            high: 114,
            low: 110,
            close: 112.2,
            volume: 1300
        };

        // Entry 2: strong body candle (~80% body of range)
        data[15] = {
            time: '2023-03-16' as Time,
            open: 115,
            high: 117,
            low: 114,
            close: 116.6,
            volume: 1300
        };

        const signals: Signal[] = [
            { time: '2023-03-13' as Time, type: 'buy', price: 112.2 },
            { time: '2023-03-14' as Time, type: 'sell', price: 113 },
            { time: '2023-03-16' as Time, type: 'buy', price: 116.6 },
            { time: '2023-03-18' as Time, type: 'sell', price: 117.5 },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotBodyPercentMin: 50
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
    });

    it('should filter entries with weak break quality', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 22; i++) {
            const base = 100 + i * 0.4;
            data.push({
                time: (`2023-04-${String(i + 1).padStart(2, '0')}`) as Time,
                open: base,
                high: base + 1.5,
                low: base - 1.5,
                close: base + 0.6,
                volume: 1200
            });
        }

        // Entry 1: closes below trigger -> poor break quality
        data[12] = {
            time: '2023-04-13' as Time,
            open: 100,
            high: 103,
            low: 99,
            close: 101,
            volume: 1400
        };

        // Entry 2: closes strongly above trigger -> high break quality
        data[16] = {
            time: '2023-04-17' as Time,
            open: 104,
            high: 107,
            low: 103,
            close: 106,
            volume: 1500
        };

        const signals: Signal[] = [
            { time: '2023-04-13' as Time, type: 'buy', price: 102 },
            { time: '2023-04-14' as Time, type: 'sell', price: 101.5 },
            { time: '2023-04-17' as Time, type: 'buy', price: 104 },
            { time: '2023-04-19' as Time, type: 'sell', price: 106.5 },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotBreakQualityMin: 55
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
    });

    it('should filter weak entries by composite entry quality score', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 24; i++) {
            const base = 98 + i * 0.5;
            data.push({
                time: (`2023-05-${String(i + 1).padStart(2, '0')}`) as Time,
                open: base - 0.2,
                high: base + 1.2,
                low: base - 1.2,
                close: base + 0.3,
                volume: 1250 + (i % 4) * 60
            });
        }

        // Weak candle profile (small body, weak close, larger opposite wick)
        data[12] = {
            time: '2023-05-13' as Time,
            open: 104.5,
            high: 107,
            low: 103,
            close: 104.8,
            volume: 1300
        };

        // Strong candle profile (large body, strong close, cleaner wick)
        data[18] = {
            time: '2023-05-19' as Time,
            open: 108,
            high: 111,
            low: 107.5,
            close: 110.6,
            volume: 1700
        };

        const signals: Signal[] = [
            { time: '2023-05-13' as Time, type: 'buy', price: 105.8 },
            { time: '2023-05-15' as Time, type: 'sell', price: 105.2 },
            { time: '2023-05-19' as Time, type: 'buy', price: 108.8 },
            { time: '2023-05-22' as Time, type: 'sell', price: 111.2 },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotEntryQualityScoreMin: 65
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
    });
});

describe('Simple Regression Line Strategy', () => {
    it('should produce stable signals and expose walk-forward metadata', () => {
        const data: OHLCVData[] = [];

        for (let i = 0; i < 320; i++) {
            const trend = i < 160 ? (100 + (i * 0.28)) : (145 - ((i - 160) * 0.24));
            const cycle = Math.sin(i / 6) * 2.2;
            const shock =
                i % 37 === 0 ? -4.5 :
                    i % 41 === 0 ? 4.2 :
                        i % 23 === 0 ? -2.8 :
                            0;
            const close = trend + cycle + shock;

            data.push({
                time: (i + 1) as unknown as Time,
                open: close - 0.4,
                high: close + 0.9,
                low: close - 0.9,
                close,
                volume: 1000 + (i % 15) * 25
            });
        }

        const params = {
            lookback: 50,
            slopeThresholdPct: 0.015,
            zEntry: 1.05,
            zExit: 0.3,
            maxHoldBars: 45,
            cooldownBars: 3,
            useShorts: 1
        };

        const signals = simple_regression_line.execute(data, params);
        expect(signals.length).to.be.greaterThan(4);
        expect(signals.some(s => s.type === 'buy')).to.equal(true);
        expect(signals.some(s => s.type === 'sell')).to.equal(true);
        expect(signals.every(s => Number.isFinite(s.price))).to.equal(true);

        const indicators = simple_regression_line.indicators?.(data, params) ?? [];
        expect(indicators.length).to.equal(3);
        expect((indicators[0].values as (number | null)[]).length).to.equal(data.length);

        expect(simple_regression_line.metadata?.walkForwardParams).to.include('lookback');
        expect(simple_regression_line.metadata?.walkForwardParams).to.include('zEntry');
        expect(simple_regression_line.metadata?.walkForwardParams).to.include('zExit');
    });
});

describe('Trade Analyzer', () => {
    it('relax-aware mode should honor max removal cap', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 100; i++) {
            const isLowQualityBucket = i < 10;
            const bodyPercent = isLowQualityBucket ? 15 : 60 + (i % 5);
            const pnl = isLowQualityBucket
                ? -12
                : (i % 3 === 0 ? -6 : 9);

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100 + pnl / 10,
                pnl,
                pnlPercent: pnl / 10,
                size: 1,
                entrySnapshot: {
                    rsi: 50 + (i % 7),
                    adx: 20 + (i % 10),
                    atrPercent: 1 + (i % 5) * 0.05,
                    emaDistance: (i % 11) - 5,
                    volumeRatio: 0.8 + (i % 6) * 0.1,
                    priceRangePos: 0.3 + (i % 6) * 0.1,
                    barsFromHigh: i % 12,
                    barsFromLow: i % 12,
                    trendEfficiency: 0.2 + (i % 8) * 0.08,
                    atrRegimeRatio: 0.8 + (i % 6) * 0.1,
                    bodyPercent,
                    wickSkew: (i % 21) - 10,
                    volumeTrend: 0.8 + (i % 5) * 0.1,
                    volumeBurst: (i % 7) - 3,
                    volumePriceDivergence: ((i % 11) - 5) / 5,
                    volumeConsistency: 0.3 + (i % 8) * 0.1
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'relax_aware',
            maxSingleRemoval: 15
        });

        const suggested = analyses.filter(a => a.suggestedFilter !== null);
        expect(suggested.length).to.be.greaterThan(0);
        suggested.forEach(a => {
            expect(a.tradesRemovedPercent).to.be.at.most(15.0001);
        });
    });

    it('should only suggest below direction for bars-from-high/low features', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 30; i++) {
            const isLoss = i < 10;
            const barsValue = isLoss ? 16 + (i % 3) : (i % 4);

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: isLoss ? -10 : 6,
                pnlPercent: isLoss ? -1 : 0.6,
                size: 1,
                entrySnapshot: {
                    rsi: 50,
                    adx: 25,
                    atrPercent: 1.2,
                    emaDistance: 0.5,
                    volumeRatio: 1.1,
                    priceRangePos: 0.45,
                    barsFromHigh: barsValue,
                    barsFromLow: barsValue,
                    trendEfficiency: 0.6,
                    atrRegimeRatio: 1.1,
                    bodyPercent: 55,
                    wickSkew: 2,
                    volumeTrend: 1.0,
                    volumeBurst: 0.5,
                    volumePriceDivergence: 0.1,
                    volumeConsistency: 0.7
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'quality',
            maxSingleRemoval: 35
        });

        const barsFromHigh = analyses.find(a => a.feature === 'barsFromHigh');
        const barsFromLow = analyses.find(a => a.feature === 'barsFromLow');

        expect(barsFromHigh).to.not.be.undefined;
        expect(barsFromLow).to.not.be.undefined;
        expect(barsFromHigh?.suggestedFilter).to.not.be.null;
        expect(barsFromLow?.suggestedFilter).to.not.be.null;
        expect(barsFromHigh?.suggestedFilter?.direction).to.equal('below');
        expect(barsFromLow?.suggestedFilter?.direction).to.equal('below');
    });

    it('should keep tiny non-zero suggested thresholds non-zero', () => {
        const trades: Trade[] = [];

        for (let i = 0; i < 30; i++) {
            const isLoss = i < 10;
            const divergence = isLoss
                ? (-0.000002 + (i * 0.00000002))
                : (0.0000005 + ((i - 10) * 0.00000002));

            trades.push({
                id: i + 1,
                type: 'long',
                entryTime: (i + 1) as unknown as Time,
                entryPrice: 100,
                exitTime: (i + 2) as unknown as Time,
                exitPrice: 100,
                pnl: isLoss ? -8 : 5,
                pnlPercent: isLoss ? -0.8 : 0.5,
                size: 1,
                entrySnapshot: {
                    rsi: 52,
                    adx: 24,
                    atrPercent: 1.15,
                    emaDistance: 0.4,
                    volumeRatio: 1.05,
                    priceRangePos: 0.5,
                    barsFromHigh: 3,
                    barsFromLow: 3,
                    trendEfficiency: 0.62,
                    atrRegimeRatio: 1.05,
                    bodyPercent: 58,
                    wickSkew: 1,
                    volumeTrend: 1.02,
                    volumeBurst: 0.2,
                    volumePriceDivergence: divergence,
                    volumeConsistency: 0.72
                }
            });
        }

        const analyses = analyzeTradePatterns(trades, {
            mode: 'quality',
            maxSingleRemoval: 35
        });
        const divergenceFeature = analyses.find(a => a.feature === 'volumePriceDivergence');

        expect(divergenceFeature).to.not.be.undefined;
        expect(divergenceFeature?.suggestedFilter).to.not.be.null;
        expect(divergenceFeature?.suggestedFilter?.threshold).to.not.equal(0);
    });
});
