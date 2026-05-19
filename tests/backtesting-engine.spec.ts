import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateBacktestStats, OHLCVData, Signal, Time, Trade } from './lib/strategies/index';
import { calculateSharpeRatioFromEquityCurve } from './lib/strategies/performance-metrics';
import { calculateEMA } from './lib/strategies/indicators';
import { runBacktest, runBacktestCompact } from './lib/strategies/index';
import { precomputeIndicators } from './lib/strategies/backtest';
import { normalizeBacktestSettings } from './lib/strategies/backtest/backtest-utils';
import { buildPositionFromSignal } from './lib/strategies/backtest/position-builder';
import { getOpenPositionForScanner } from './lib/strategies/backtest/signal-preparation';
import { resolveScannerBacktestSettings } from './lib/scanner/scanner-engine';
import { resolveBacktestSettingsFromRaw } from './lib/backtest-settings-resolver';
import { resolveEntryRiskTargets } from './lib/entry-risk-targets';
describe('Backtesting Engine', () => {
    function makeHistoricalLevelCandle(time: number, high: number, low: number, price = (high + low) / 2): OHLCVData {
        return { time: time as Time, open: price, high, low, close: price, volume: 1000 };
    }

    function buildHistoricalLevelData(postEntryCandles: OHLCVData[]): OHLCVData[] {
        return [
            makeHistoricalLevelCandle(0, 101, 99),
            makeHistoricalLevelCandle(1, 103, 101),
            makeHistoricalLevelCandle(2, 110, 108),
            makeHistoricalLevelCandle(3, 104, 102),
            makeHistoricalLevelCandle(4, 103, 101),
            makeHistoricalLevelCandle(5, 97, 95),
            makeHistoricalLevelCandle(6, 102, 100),
            makeHistoricalLevelCandle(7, 103, 101),
            makeHistoricalLevelCandle(8, 104, 102),
            makeHistoricalLevelCandle(9, 103, 101),
            makeHistoricalLevelCandle(10, 109.8, 107.8),
            makeHistoricalLevelCandle(11, 104, 102),
            makeHistoricalLevelCandle(12, 97.2, 95.2),
            makeHistoricalLevelCandle(13, 103, 101),
            makeHistoricalLevelCandle(14, 104, 102),
            makeHistoricalLevelCandle(15, 101, 99, 100),
            ...postEntryCandles,
        ];
    }

    const historicalLevelBaseSettings = {
        executionModel: 'signal_close' as const,
        atrPeriod: 1000,
        historicalLevelLookbackBars: 15,
    };

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

    it('should close by time stop when percentage max hold cap is enabled', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 }, // Buy
            { time: '2023-01-03' as Time, open: 101, high: 103, low: 100, close: 102, volume: 1000 },
            { time: '2023-01-04' as Time, open: 102, high: 103, low: 100, close: 101.5, volume: 1000 }, // Max hold hit
            { time: '2023-01-05' as Time, open: 101.5, high: 102, low: 100, close: 101, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 101 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: false,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 2,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('time_stop');
        expect(result.trades[0].exitTime).to.equal('2023-01-04' as Time);
    });

    it('should close by time stop when simple-mode max hold cap is enabled', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 }, // Buy
            { time: '2023-01-03' as Time, open: 101, high: 103, low: 100, close: 102, volume: 1000 },
            { time: '2023-01-04' as Time, open: 102, high: 103, low: 100, close: 101.5, volume: 1000 }, // Max hold hit
            { time: '2023-01-05' as Time, open: 101.5, high: 102, low: 100, close: 101, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 101 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            riskMode: 'simple',
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 2,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('time_stop');
        expect(result.trades[0].exitTime).to.equal('2023-01-04' as Time);
    });

    it('ignores strategy signal exits before the configured minimum hold', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 101, high: 102, low: 100, close: 101, volume: 1000 },
            { time: '2023-01-03' as Time, open: 102, high: 103, low: 101, close: 102, volume: 1000 },
            { time: '2023-01-04' as Time, open: 103, high: 104, low: 102, close: 103, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
            { time: '2023-01-02' as Time, type: 'sell', price: 101 },
            { time: '2023-01-04' as Time, type: 'sell', price: 103 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            executionModel: 'signal_close',
            tradeDirection: 'long',
            riskMinHoldEnabled: true,
            riskMinHoldBars: 2,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('signal');
        expect(result.trades[0].exitTime).to.equal('2023-01-04' as Time);
        expect(result.trades[0].exitPrice).to.equal(103);
    });

    it('does not let minimum hold block protective stop loss exits', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 94, close: 95, volume: 1000 },
            { time: '2023-01-03' as Time, open: 95, high: 96, low: 93, close: 94, volume: 1000 },
        ];

        const result = runBacktest(data, [{ time: '2023-01-01' as Time, type: 'buy', price: 100 }], 1000, 100, 0, {
            executionModel: 'signal_close',
            tradeDirection: 'long',
            riskMode: 'percentage',
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: false,
            riskMinHoldEnabled: true,
            riskMinHoldBars: 10,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('stop_loss');
        expect(result.trades[0].exitTime).to.equal('2023-01-02' as Time);
    });

    it('does not let max hold close before minimum hold is satisfied', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-04' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-05' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        ];

        const result = runBacktest(data, [{ time: '2023-01-01' as Time, type: 'buy', price: 100 }], 1000, 100, 0, {
            executionModel: 'signal_close',
            tradeDirection: 'long',
            riskMinHoldEnabled: true,
            riskMinHoldBars: 3,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('time_stop');
        expect(result.trades[0].exitTime).to.equal('2023-01-04' as Time);
    });

    it('uses historical resistance as a long take-profit without requiring a stop loss', () => {
        const data = buildHistoricalLevelData([
            makeHistoricalLevelCandle(16, 109.7, 98, 106),
        ]);
        const result = runBacktest(data, [{ time: 15 as Time, type: 'buy', price: 100 }], 1000, 100, 0, {
            ...historicalLevelBaseSettings,
            tradeDirection: 'long',
            historicalLevelTakeProfitEnabled: true,
            historicalLevelStopLossEnabled: false,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitPrice).to.be.closeTo(109.6, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.be.closeTo(109.6, 1e-9);
        expect(result.trades[0].stopLossPrice).to.equal(null);
    });

    it('uses historical support as a long protective exit without requiring a take profit', () => {
        const data = buildHistoricalLevelData([
            makeHistoricalLevelCandle(16, 101, 94.7, 95),
        ]);
        const result = runBacktest(data, [{ time: 15 as Time, type: 'buy', price: 100 }], 1000, 100, 0, {
            ...historicalLevelBaseSettings,
            tradeDirection: 'long',
            historicalLevelTakeProfitEnabled: false,
            historicalLevelStopLossEnabled: true,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('stop_loss');
        expect(result.trades[0].exitPrice).to.be.closeTo(94.8, 1e-9);
        expect(result.trades[0].stopLossPrice).to.be.closeTo(94.8, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.equal(null);
    });

    it('uses historical support as a short take-profit target', () => {
        const data = buildHistoricalLevelData([
            makeHistoricalLevelCandle(16, 101, 95.3, 96),
        ]);
        const result = runBacktest(data, [{ time: 15 as Time, type: 'sell', price: 100 }], 1000, 100, 0, {
            ...historicalLevelBaseSettings,
            tradeDirection: 'short',
            historicalLevelTakeProfitEnabled: true,
            historicalLevelStopLossEnabled: false,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].type).to.equal('short');
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitPrice).to.be.closeTo(95.4, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.be.closeTo(95.4, 1e-9);
    });

    it('keeps a closer base percentage take profit ahead of farther historical resistance', () => {
        const data = buildHistoricalLevelData([
            makeHistoricalLevelCandle(16, 105.2, 99, 104),
        ]);
        const result = runBacktest(data, [{ time: 15 as Time, type: 'buy', price: 100 }], 1000, 100, 0, {
            ...historicalLevelBaseSettings,
            riskMode: 'percentage',
            tradeDirection: 'long',
            takeProfitEnabled: true,
            takeProfitPercent: 5,
            stopLossEnabled: false,
            historicalLevelTakeProfitEnabled: true,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitPrice).to.be.closeTo(105, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.be.closeTo(105, 1e-9);
    });

    it('keeps a closer base percentage stop ahead of farther historical support', () => {
        const data = buildHistoricalLevelData([
            makeHistoricalLevelCandle(16, 101, 96.9, 98),
        ]);
        const result = runBacktest(data, [{ time: 15 as Time, type: 'buy', price: 100 }], 1000, 100, 0, {
            ...historicalLevelBaseSettings,
            riskMode: 'percentage',
            tradeDirection: 'long',
            stopLossEnabled: true,
            stopLossPercent: 3,
            takeProfitEnabled: false,
            historicalLevelStopLossEnabled: true,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('stop_loss');
        expect(result.trades[0].exitPrice).to.be.closeTo(97, 1e-9);
        expect(result.trades[0].stopLossPrice).to.be.closeTo(97, 1e-9);
    });

    it('falls back to max hold when historical targets are not touched', () => {
        const data = buildHistoricalLevelData([
            makeHistoricalLevelCandle(16, 105, 99, 101),
            makeHistoricalLevelCandle(17, 106, 100, 102),
        ]);
        const result = runBacktest(data, [{ time: 15 as Time, type: 'buy', price: 100 }], 1000, 100, 0, {
            ...historicalLevelBaseSettings,
            tradeDirection: 'long',
            historicalLevelTakeProfitEnabled: true,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('time_stop');
        expect(result.trades[0].exitTime).to.equal(16 as Time);
        expect(result.trades[0].exitPrice).to.be.closeTo(101, 1e-9);
    });

    it('should ignore removed win-streak stop loss settings', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 104.5, low: 99.5, close: 104, volume: 1000 },
            { time: '2023-01-03' as Time, open: 104, high: 104.5, low: 103.5, close: 104, volume: 1000 }, // Sell #1 win
            { time: '2023-01-04' as Time, open: 100, high: 104.5, low: 99.5, close: 104, volume: 1000 },
            { time: '2023-01-05' as Time, open: 104, high: 104.5, low: 103.5, close: 104, volume: 1000 }, // Sell #2 win
            { time: '2023-01-06' as Time, open: 100, high: 100.3, low: 99.8, close: 100, volume: 1000 }, // Buy #3
            { time: '2023-01-07' as Time, open: 100, high: 100.2, low: 98.9, close: 99.2, volume: 1000 }, // 1% SL hit
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-03' as Time, type: 'sell', price: 104 },
            { time: '2023-01-04' as Time, type: 'buy', price: 100 },
            { time: '2023-01-05' as Time, type: 'sell', price: 104 },
            { time: '2023-01-06' as Time, type: 'buy', price: 100 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: false,
            stopLossPercent: 2,
            riskWinStreakStopLossEnabled: true,
            riskWinStreakStopLossAfterWins: 2,
            riskWinStreakStopLossPercent: 1,
        });

        expect(result.totalTrades).to.equal(3);
        expect(result.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(result.trades[1].entryTime).to.equal('2023-01-04' as Time);
        expect(result.trades[2].entryTime).to.equal('2023-01-06' as Time);
        expect(result.trades[0].exitReason).to.equal('signal');
        expect(result.trades[1].exitReason).to.equal('signal');
        expect(result.trades[2].exitReason).to.equal('end_of_data');
        expect(result.trades[2].exitTime).to.equal('2023-01-07' as Time);
    });

    it('should resolve MFE bootstrap take-profit settings from raw UI values', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitToggle: true,
            takeProfitPercent: '8',
            takeProfitMode: 'mfe_bootstrap',
            takeProfitMfeBootstrapPercentile: '65',
        } as any);

        expect(resolved.takeProfitMode).to.equal('mfe_bootstrap');
        expect(resolved.takeProfitPercent).to.equal(8);
        expect(resolved.takeProfitMfeBootstrapPercentile).to.equal(65);
    });

    it('should resolve adaptive TP settings from raw UI values', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitToggle: true,
            takeProfitPercent: '8',
            takeProfitMode: 'expectancy_optimal',
            takeProfitAdaptiveLookbackTrades: '30',
            takeProfitAdaptiveGridSteps: '9',
            takeProfitAdaptiveMinMultiplier: '0.6',
            takeProfitAdaptiveMaxMultiplier: '1.8',
        } as any);

        expect(resolved.takeProfitMode).to.equal('expectancy_optimal');
        expect(resolved.takeProfitAdaptiveLookbackTrades).to.equal(30);
        expect(resolved.takeProfitAdaptiveGridSteps).to.equal(9);
        expect(resolved.takeProfitAdaptiveMinMultiplier).to.equal(0.6);
        expect(resolved.takeProfitAdaptiveMaxMultiplier).to.equal(1.8);
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
        };

        const resolved = resolveScannerBacktestSettings(rawScannerSettings as any);

        expect(resolved.stopLossAtr).to.equal(0);
        expect(resolved.takeProfitAtr).to.equal(0);
        expect(resolved.trailingAtr).to.equal(0);
        expect(resolved.stopLossEnabled).to.equal(false);
        expect(resolved.takeProfitEnabled).to.equal(false);
        expect('tradeFilterMode' in (resolved as Record<string, unknown>)).to.equal(false);
        expect(resolved.confirmationStrategies).to.deep.equal([]);
        expect(resolved.confirmationStrategyParams).to.deep.equal({});
    });

    it('scanner settings resolver should accept combined trade direction', () => {
        const resolved = resolveScannerBacktestSettings({
            tradeDirection: 'combined',
            riskSettingsToggle: false,
        } as any);
        expect(resolved.tradeDirection).to.equal('combined');
    });

    it('scanner settings resolver should accept flip-after-2-losses trade direction', () => {
        const resolved = resolveScannerBacktestSettings({
            tradeDirection: 'both_flip_loss_2',
            riskSettingsToggle: false,
        } as any);
        expect(resolved.tradeDirection).to.equal('both_flip_loss_2');
    });

    it('scanner settings resolver should coerce string toggles and numeric inputs', () => {
        const resolved = resolveScannerBacktestSettings({
            riskSettingsToggle: 'true',
            riskMode: 'percentage',
            stopLossPercent: '2.5',
            takeProfitPercent: '7.5',
            stopLossEnabled: 'true',
            takeProfitEnabled: 'false',
            riskMaxHoldBars: '12',
            riskMaxHoldEnabled: 'true',
            riskWinStreakStopLossToggle: 'true',
            riskWinStreakStopLossAfterWins: '4',
            riskWinStreakStopLossPercent: '1.25',
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
        } as any);

        expect(resolved.stopLossPercent).to.equal(2.5);
        expect(resolved.takeProfitPercent).to.equal(7.5);
        expect(resolved.stopLossEnabled).to.equal(true);
        expect(resolved.takeProfitEnabled).to.equal(false);
        expect(resolved.riskMaxHoldBars).to.equal(12);
        expect(resolved.riskMaxHoldEnabled).to.equal(true);
        expect(resolved.riskWinStreakStopLossEnabled).to.equal(false);
        expect(resolved.riskWinStreakStopLossAfterWins).to.equal(3);
        expect(resolved.riskWinStreakStopLossPercent).to.equal(0);
        expect('tradeFilterMode' in (resolved as Record<string, unknown>)).to.equal(false);
        expect('confirmLookback' in (resolved as Record<string, unknown>)).to.equal(false);
        expect('volumeSmaPeriod' in (resolved as Record<string, unknown>)).to.equal(false);
        expect('volumeMultiplier' in (resolved as Record<string, unknown>)).to.equal(false);
        expect('rsiPeriod' in (resolved as Record<string, unknown>)).to.equal(false);
        expect('rsiBullish' in (resolved as Record<string, unknown>)).to.equal(false);
        expect('rsiBearish' in (resolved as Record<string, unknown>)).to.equal(false);
        expect(resolved.confirmationStrategies).to.deep.equal(['sma_crossover']);
        expect(resolved.confirmationStrategyParams).to.deep.equal({
            sma_crossover: {
                fastPeriod: 9,
                slowPeriod: 21,
            }
        });
        expect(resolved.allowSameBarExit).to.equal(false);
        expect(resolved.slippageBps).to.equal(12);
        expect(resolved.tradeDirection).to.equal('combined');
    });

    it('scanner settings resolver should preserve max hold in simple mode when risk is enabled', () => {
        const resolved = resolveScannerBacktestSettings({
            riskSettingsToggle: true,
            riskMode: 'simple',
            stopLossAtr: 1.5,
            riskMaxHoldBars: 7,
            riskMaxHoldEnabled: true,
        } as any);

        expect(resolved.stopLossAtr).to.equal(1.5);
        expect(resolved.riskMaxHoldBars).to.equal(7);
        expect(resolved.riskMaxHoldEnabled).to.equal(true);
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

    it('should seed next_open ATR take profit from the prior closed bar', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 120, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 104, low: 99, close: 103, volume: 1000 },
            { time: '2023-01-04' as Time, open: 103, high: 103, low: 103, close: 103, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100, barIndex: 1 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            atrPeriod: 1,
            stopLossAtr: 0,
            trailingAtr: 0,
            takeProfitAtr: 0.5,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].entryTime).to.equal('2023-01-03' as Time);
        expect(result.trades[0].exitReason).to.equal('end_of_data');
        expect(result.trades[0].takeProfitPrice).to.equal(110);
    });

    it('should block next_open same-bar ATR take profit when same-bar exits are disabled', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 111, low: 100, close: 105, volume: 1000 },
            { time: '2023-01-04' as Time, open: 105, high: 105, low: 105, close: 105, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100, barIndex: 1 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            atrPeriod: 1,
            stopLossAtr: 0,
            trailingAtr: 0,
            takeProfitAtr: 0.5,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].entryTime).to.equal('2023-01-03' as Time);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitTime).to.equal('2023-01-04' as Time);
    });

    it('should still trigger next_open same-bar stop loss when same-bar exits are disabled', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 101, low: 94, close: 99, volume: 1000 },
            { time: '2023-01-04' as Time, open: 99, high: 110, low: 99, close: 108, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100, barIndex: 1 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].entryTime).to.equal('2023-01-03' as Time);
        expect(result.trades[0].exitTime).to.equal('2023-01-03' as Time);
        expect(result.trades[0].exitReason).to.equal('stop_loss');
        expect(result.trades[0].exitPrice).to.be.closeTo(95, 1e-9);
    });

    it('should fill a long percentage stop loss at the bar open when price gaps through the stop', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 80, high: 85, low: 79, close: 82, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100, barIndex: 0 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('stop_loss');
        expect(result.trades[0].exitPrice).to.be.closeTo(80, 1e-9);
        expect(result.trades[0].stopLossPrice).to.be.closeTo(95, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.be.closeTo(110, 1e-9);
    });

    it('should fill a short percentage stop loss at the bar open when price gaps through the stop', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 120, high: 122, low: 118, close: 121, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'sell', price: 100, barIndex: 0 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'short' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: false,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('stop_loss');
        expect(result.trades[0].exitPrice).to.be.closeTo(120, 1e-9);
        expect(result.trades[0].stopLossPrice).to.be.closeTo(105, 1e-9);
    });

    it('should anchor long percentage take profit to the slippage-adjusted fill price', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 110.5, low: 100, close: 110, volume: 1000 },
            { time: '2023-01-03' as Time, open: 110, high: 111.5, low: 109, close: 111, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100, barIndex: 0 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            slippageBps: 100,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].entryPrice).to.be.closeTo(101, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.be.closeTo(111.1, 1e-9);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitTime).to.equal('2023-01-03' as Time);
        expect(result.trades[0].exitPrice).to.be.closeTo(109.989, 1e-9);
    });

    it('should anchor short percentage take profit to the slippage-adjusted fill price', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 100, low: 89.5, close: 90, volume: 1000 },
            { time: '2023-01-03' as Time, open: 90, high: 91, low: 88.5, close: 89, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'sell', price: 100, barIndex: 0 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'short' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            slippageBps: 100,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].entryPrice).to.be.closeTo(99, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.be.closeTo(89.1, 1e-9);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitTime).to.equal('2023-01-03' as Time);
        expect(result.trades[0].exitPrice).to.be.closeTo(89.991, 1e-9);
    });

    it('edge_weighted should assign wider TP to stronger entry candles', () => {
        const data: OHLCVData[] = [
            { time: '2023-02-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-02-02' as Time, open: 100, high: 101, low: 99.8, close: 100.05, volume: 900 },
            { time: '2023-02-03' as Time, open: 100.05, high: 100.4, low: 99.8, close: 100.1, volume: 850 },
            { time: '2023-02-04' as Time, open: 100.1, high: 102.5, low: 100, close: 102.3, volume: 1900 },
            { time: '2023-02-05' as Time, open: 102.3, high: 102.8, low: 101.8, close: 102.6, volume: 1600 },
            { time: '2023-02-06' as Time, open: 102.6, high: 102.8, low: 102.1, close: 102.4, volume: 1200 },
        ];

        const signals: Signal[] = [
            { time: '2023-02-02' as Time, type: 'buy', price: 100.05 },
            { time: '2023-02-03' as Time, type: 'sell', price: 100.1 },
            { time: '2023-02-04' as Time, type: 'buy', price: 102.3 },
            { time: '2023-02-06' as Time, type: 'sell', price: 102.4 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            takeProfitMode: 'edge_weighted',
            stopLossEnabled: false,
            takeProfitAdaptiveMinMultiplier: 0.7,
            takeProfitAdaptiveMaxMultiplier: 1.6,
        });

        expect(result.totalTrades).to.equal(2);
        const firstTargetPct = ((result.trades[0].takeProfitPrice! - result.trades[0].entryPrice) / result.trades[0].entryPrice) * 100;
        const secondTargetPct = ((result.trades[1].takeProfitPrice! - result.trades[1].entryPrice) / result.trades[1].entryPrice) * 100;
        expect(secondTargetPct).to.be.greaterThan(firstTargetPct);
        expect(firstTargetPct).to.be.greaterThan(6.5);
    });

    it('expectancy_optimal should tighten later TP after shallow favorable history', () => {
        const data: OHLCVData[] = [];
        const signals: Signal[] = [];
        let price = 100;

        for (let cycle = 0; cycle < 5; cycle++) {
            const entryDate = `2023-03-${String(cycle * 2 + 1).padStart(2, '0')}` as Time;
            const exitDate = `2023-03-${String(cycle * 2 + 2).padStart(2, '0')}` as Time;

            data.push({
                time: entryDate,
                open: price,
                high: price * 1.01,
                low: price * 0.99,
                close: price,
                volume: 1000 + cycle * 20,
            });
            data.push({
                time: exitDate,
                open: price,
                high: price * 1.05,
                low: price * 0.99,
                close: price * 1.02,
                volume: 1050 + cycle * 20,
            });

            signals.push({ time: entryDate, type: 'buy', price });
            signals.push({ time: exitDate, type: 'sell', price: price * 1.02 });
            price *= 1.01;
        }

        data.push({
            time: '2023-03-11' as Time,
            open: price,
            high: price * 1.01,
            low: price * 0.99,
            close: price,
            volume: 1200,
        });
        data.push({
            time: '2023-03-12' as Time,
            open: price,
            high: price * 1.05,
            low: price * 0.99,
            close: price * 1.02,
            volume: 1220,
        });

        signals.push({ time: '2023-03-11' as Time, type: 'buy', price });
        signals.push({ time: '2023-03-12' as Time, type: 'sell', price: price * 1.02 });

        const result = runBacktest(data, signals, 10000, 100, 0, {
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            takeProfitMode: 'expectancy_optimal',
            stopLossEnabled: false,
            takeProfitAdaptiveLookbackTrades: 10,
            takeProfitAdaptiveGridSteps: 5,
            takeProfitAdaptiveMinMultiplier: 0.4,
            takeProfitAdaptiveMaxMultiplier: 1.2,
        });

        expect(result.totalTrades).to.equal(6);
        const finalTargetPct = ((result.trades[5].takeProfitPrice! - result.trades[5].entryPrice) / result.trades[5].entryPrice) * 100;
        expect(finalTargetPct).to.be.lessThan(10);
        expect(finalTargetPct).to.be.closeTo(4, 0.25);
    });

    it('should cap a long percentage take profit at the target when price gaps beyond it', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 120, high: 121, low: 119, close: 120, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100, barIndex: 0 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitPrice).to.be.closeTo(110, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.be.closeTo(110, 1e-9);
    });

    it('should cap a short percentage take profit at the target when price gaps beyond it', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 80, high: 81, low: 79, close: 80, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'sell', price: 100, barIndex: 0 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'short' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitPrice).to.be.closeTo(90, 1e-9);
        expect(result.trades[0].takeProfitPrice).to.be.closeTo(90, 1e-9);
    });

    it('compact backtest should match next_open same-bar stop loss enforcement', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 106, low: 98, close: 99, volume: 1000 },
            { time: '2023-01-04' as Time, open: 99, high: 99, low: 90, close: 92, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100, barIndex: 1 },
        ];

        const result = runBacktestCompact(data, signals, 10000, 100, 0, {
            tradeDirection: 'short' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.netProfit).to.be.closeTo(-500, 1e-9);
    });

    it('should not retroactively allow a next_open entry after a later same-bar take profit frees capacity', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 106, low: 100, close: 105, volume: 1000 },
            { time: '2023-01-04' as Time, open: 105, high: 105, low: 105, close: 105, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100, barIndex: 0 },
            { time: '2023-01-02' as Time, type: 'buy', price: 101, barIndex: 1 },
        ];

        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 5,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings);

        expect(full.totalTrades).to.equal(1);
        expect(full.trades).to.have.length(1);
        expect(full.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(full.trades[0].exitTime).to.equal('2023-01-03' as Time);
        expect(full.trades[0].exitReason).to.equal('take_profit');
        expect(full.trades.some((trade) => trade.entryTime === ('2023-01-03' as Time))).to.equal(false);
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
    });

    it('should allow a next_open entry when the previous trade already gapped through take profit at the bar open', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: '2023-01-03' as Time, open: 106, high: 107, low: 105, close: 106, volume: 1000 },
            { time: '2023-01-04' as Time, open: 106, high: 106, low: 106, close: 106, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100, barIndex: 0 },
            { time: '2023-01-02' as Time, type: 'buy', price: 101, barIndex: 1 },
        ];

        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 5,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings);

        expect(full.totalTrades).to.equal(2);
        expect(full.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(full.trades[0].exitTime).to.equal('2023-01-03' as Time);
        expect(full.trades[0].exitReason).to.equal('take_profit');
        expect(full.trades[1].entryTime).to.equal('2023-01-03' as Time);
        expect(full.trades[1].exitReason).to.equal('end_of_data');
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
    });

    it('should block same-bar next_open re-entry after a signal exit but allow re-entry on the following bar', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 101, high: 102, low: 100, close: 101, volume: 1000 },
            { time: '2023-01-03' as Time, open: 102, high: 103, low: 101, close: 102, volume: 1000 },
            { time: '2023-01-04' as Time, open: 103, high: 104, low: 102, close: 103, volume: 1000 },
            { time: '2023-01-05' as Time, open: 104, high: 104, low: 104, close: 104, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100, barIndex: 0 },
            { time: '2023-01-02' as Time, type: 'sell', price: 101, barIndex: 1 },
            { time: '2023-01-02' as Time, type: 'buy', price: 101, barIndex: 1 },
            { time: '2023-01-03' as Time, type: 'buy', price: 102, barIndex: 2 },
        ];

        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings);

        expect(full.totalTrades).to.equal(2);
        expect(full.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(full.trades[0].exitTime).to.equal('2023-01-03' as Time);
        expect(full.trades[0].exitReason).to.equal('signal');
        expect(full.trades.some((trade) => trade.entryTime === ('2023-01-03' as Time))).to.equal(false);
        expect(full.trades[1].entryTime).to.equal('2023-01-04' as Time);
        expect(full.trades[1].exitReason).to.equal('end_of_data');
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
    });

    it('should block immediate next_open flips on the signal-exit bar and allow the next bar entry', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 99, high: 100, low: 98, close: 99, volume: 1000 },
            { time: '2023-01-03' as Time, open: 98, high: 99, low: 97, close: 98, volume: 1000 },
            { time: '2023-01-04' as Time, open: 97, high: 98, low: 96, close: 97, volume: 1000 },
            { time: '2023-01-05' as Time, open: 96, high: 96, low: 96, close: 96, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'sell', price: 100, barIndex: 0 },
            { time: '2023-01-02' as Time, type: 'buy', price: 99, barIndex: 1 },
            { time: '2023-01-03' as Time, type: 'buy', price: 98, barIndex: 2 },
        ];

        const settings = {
            tradeDirection: 'both' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings);

        expect(full.totalTrades).to.equal(2);
        expect(full.trades[0].type).to.equal('short');
        expect(full.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(full.trades[0].exitTime).to.equal('2023-01-03' as Time);
        expect(full.trades[0].exitReason).to.equal('signal');
        expect(full.trades.some((trade) => trade.entryTime === ('2023-01-03' as Time) && trade.type === 'long')).to.equal(false);
        expect(full.trades[1].type).to.equal('long');
        expect(full.trades[1].entryTime).to.equal('2023-01-04' as Time);
        expect(full.trades[1].exitReason).to.equal('end_of_data');
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
    });

    it('should resolve next_open ATR targets from the prior closed bar for alert parity', () => {
        const candles: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 120, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 100, low: 100, close: 100, volume: 0 },
        ];

        const targets = resolveEntryRiskTargets({
            candles,
            entryTime: '2023-01-03' as Time,
            entryPrice: 100,
            direction: 'long',
            settings: {
                executionModel: 'next_open',
                atrPeriod: 1,
                stopLossAtr: 1,
                takeProfitAtr: 0.5,
            },
            entryBarIndex: 2,
        });

        expect(targets.stopLossPrice).to.equal(80);
        expect(targets.takeProfitPrice).to.equal(110);
        expect(targets.stopLossPercent).to.equal(20);
        expect(targets.takeProfitPercent).to.equal(10);
    });

    it('should resolve percentage stop loss targets from raw UI settings when the stop toggle is omitted', () => {
        const targets = resolveEntryRiskTargets({
            candles: [],
            entryTime: '2023-01-03' as Time,
            entryPrice: 100,
            direction: 'long',
            settings: {
                riskSettingsToggle: true,
                riskMode: 'percentage',
                stopLossPercent: 5,
            },
        });

        expect(targets.stopLossPrice).to.equal(95);
        expect(targets.stopLossPercent).to.equal(5);
    });

    it('should resolve percentage take profit targets from raw UI settings when the take-profit toggle is omitted', () => {
        const targets = resolveEntryRiskTargets({
            candles: [],
            entryTime: '2023-01-03' as Time,
            entryPrice: 100,
            direction: 'long',
            settings: {
                riskSettingsToggle: true,
                riskMode: 'percentage',
                takeProfitPercent: 5,
            },
        });

        expect(targets.takeProfitPrice).to.equal(105);
        expect(targets.takeProfitPercent).to.equal(5);
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

    it('should flip only after two consecutive losses in both_flip_loss_2 mode', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // short entry
            { time: '2023-01-03' as Time, open: 105, high: 106, low: 104, close: 105, volume: 1000 }, // short loss #1
            { time: '2023-01-04' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // short entry
            { time: '2023-01-05' as Time, open: 108, high: 109, low: 107, close: 108, volume: 1000 }, // short loss #2 -> flip to long
            { time: '2023-01-06' as Time, open: 110, high: 111, low: 109, close: 110, volume: 1000 }, // long profit
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-03' as Time, type: 'buy', price: 105 },
            { time: '2023-01-04' as Time, type: 'sell', price: 104 },
            { time: '2023-01-05' as Time, type: 'buy', price: 108 },
        ];

        const settings = { tradeDirection: 'both_flip_loss_2' as const };
        const full = runBacktest(data, signals, 1000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

        expect(full.totalTrades).to.equal(3);
        expect(full.trades[0].type).to.equal('short');
        expect(full.trades[1].type).to.equal('short');
        expect(full.trades[2].type).to.equal('long');
        expect(full.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(full.trades[1].entryTime).to.equal('2023-01-04' as Time);
        expect(full.trades[2].entryTime).to.equal('2023-01-05' as Time);
        expect(full.trades.some(trade => trade.entryTime === ('2023-01-03' as Time) && trade.type === 'long')).to.equal(false);
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-8);
    });

    it('should respect configurable flipAfterConsecutiveLosses in both_flip_loss_2 mode', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // short entry
            { time: '2023-01-03' as Time, open: 105, high: 106, low: 104, close: 105, volume: 1000 }, // short loss #1
            { time: '2023-01-04' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // short entry
            { time: '2023-01-05' as Time, open: 108, high: 109, low: 107, close: 108, volume: 1000 }, // short loss #2
            { time: '2023-01-06' as Time, open: 107, high: 108, low: 106, close: 107, volume: 1000 }, // short entry
            { time: '2023-01-07' as Time, open: 111, high: 112, low: 110, close: 111, volume: 1000 }, // short loss #3 -> flip
            { time: '2023-01-08' as Time, open: 113, high: 114, low: 112, close: 113, volume: 1000 }, // long profit
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-03' as Time, type: 'buy', price: 105 },
            { time: '2023-01-04' as Time, type: 'sell', price: 104 },
            { time: '2023-01-05' as Time, type: 'buy', price: 108 },
            { time: '2023-01-06' as Time, type: 'sell', price: 107 },
            { time: '2023-01-07' as Time, type: 'buy', price: 111 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both_flip_loss_2',
            flipAfterConsecutiveLosses: 3,
        });

        expect(result.totalTrades).to.equal(4);
        expect(result.trades[0].type).to.equal('short');
        expect(result.trades[1].type).to.equal('short');
        expect(result.trades[2].type).to.equal('short');
        expect(result.trades[3].type).to.equal('long');
        expect(result.trades[3].entryTime).to.equal('2023-01-07' as Time);
    });

    it('should respect minTradesBeforeFirstFlip and flipCooldownTrades in both_flip_loss_2 mode', () => {
        const data: OHLCVData[] = [
            { time: '2023-02-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-02-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // short entry
            { time: '2023-02-03' as Time, open: 102, high: 103, low: 101, close: 102, volume: 1000 }, // short loss #1 (no flip, minTrades gate)
            { time: '2023-02-04' as Time, open: 101, high: 102, low: 100, close: 101, volume: 1000 }, // short entry
            { time: '2023-02-05' as Time, open: 103, high: 104, low: 102, close: 103, volume: 1000 }, // short loss #2 (no flip, minTrades gate)
            { time: '2023-02-06' as Time, open: 102, high: 103, low: 101, close: 102, volume: 1000 }, // short entry
            { time: '2023-02-07' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // short loss #3 -> first flip to long
            { time: '2023-02-08' as Time, open: 106, high: 107, low: 105, close: 106, volume: 1000 }, // long hold
            { time: '2023-02-09' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // long loss #1 (cooldown block #1)
            { time: '2023-02-10' as Time, open: 105, high: 106, low: 104, close: 105, volume: 1000 }, // long entry
            { time: '2023-02-11' as Time, open: 103, high: 104, low: 102, close: 103, volume: 1000 }, // long loss #2 (cooldown block #2)
            { time: '2023-02-12' as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 }, // long entry
            { time: '2023-02-13' as Time, open: 102, high: 103, low: 101, close: 102, volume: 1000 }, // long loss #3 -> cooldown ended, flip to short
            { time: '2023-02-14' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // short profit
        ];

        const signals: Signal[] = [
            { time: '2023-02-02' as Time, type: 'sell', price: 100 },
            { time: '2023-02-03' as Time, type: 'buy', price: 102 },
            { time: '2023-02-04' as Time, type: 'sell', price: 101 },
            { time: '2023-02-05' as Time, type: 'buy', price: 103 },
            { time: '2023-02-06' as Time, type: 'sell', price: 102 },
            { time: '2023-02-07' as Time, type: 'buy', price: 104 },
            { time: '2023-02-10' as Time, type: 'buy', price: 105 },
            { time: '2023-02-09' as Time, type: 'sell', price: 104 },
            { time: '2023-02-12' as Time, type: 'buy', price: 104 },
            { time: '2023-02-11' as Time, type: 'sell', price: 103 },
            { time: '2023-02-13' as Time, type: 'sell', price: 102 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both_flip_loss_2',
            flipAfterConsecutiveLosses: 1,
            flipCooldownTrades: 2,
            minTradesBeforeFirstFlip: 3,
        });

        expect(result.totalTrades).to.equal(7);
        expect(result.trades[0].type).to.equal('short');
        expect(result.trades[1].type).to.equal('short');
        expect(result.trades[2].type).to.equal('short');
        expect(result.trades[3].type).to.equal('long');
        expect(result.trades[4].type).to.equal('long');
        expect(result.trades[5].type).to.equal('long');
        expect(result.trades[6].type).to.equal('short');
        expect(result.trades[3].entryTime).to.equal('2023-02-07' as Time);
        expect(result.trades[4].entryTime).to.equal('2023-02-10' as Time);
        expect(result.trades[5].entryTime).to.equal('2023-02-12' as Time);
        expect(result.trades[6].entryTime).to.equal('2023-02-13' as Time);
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

    it('should keep combined-mode sharpe consistent between full and compact backtests', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 240; i++) {
            const trend = 100 + i * 0.08;
            const cycle = Math.sin(i / 7) * 1.8;
            const close = trend + cycle;
            data.push({
                time: (i + 1) as unknown as Time,
                open: close - 0.4,
                high: close + 0.9,
                low: close - 0.9,
                close,
                volume: 1000 + (i % 9) * 25
            });
        }

        const signals: Signal[] = [];
        for (let i = 20; i < 220; i += 20) {
            const openLong = i % 40 !== 0;
            signals.push({
                time: (i + 1) as unknown as Time,
                type: openLong ? 'buy' : 'sell',
                price: data[i + 1].close
            });
            signals.push({
                time: (i + 8) as unknown as Time,
                type: openLong ? 'sell' : 'buy',
                price: data[i + 8].close
            });
        }

        const settings = { tradeDirection: 'combined' as const, allowSameBarExit: true, slippageBps: 0 };
        const full = runBacktest(data, signals, 10000, 100, 0.1, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0.1, settings);

        expect(full.totalTrades).to.equal(compact.totalTrades);
        expect(full.sharpeRatio).to.be.closeTo(compact.sharpeRatio, 1e-9);
    });

    it('should base sharpe on annualized equity-period returns instead of trade pnlPercent', () => {
        const returns = [0.001, 0, -0.001, 0.001, 0, 0.001];
        let equity = 10000;
        const equityCurve = [{ time: '2023-01-01' as Time, value: equity }];

        for (let i = 0; i < returns.length; i++) {
            equity *= (1 + returns[i]);
            equityCurve.push({
                time: `2023-01-0${i + 2}` as Time,
                value: equity
            });
        }

        const trades: Trade[] = [
            { id: 1, type: 'long', entryTime: 1 as Time, entryPrice: 100, exitTime: 2 as Time, exitPrice: 108, pnl: 5, pnlPercent: 8, size: 1 },
            { id: 2, type: 'long', entryTime: 2 as Time, entryPrice: 100, exitTime: 3 as Time, exitPrice: 91, pnl: -3, pnlPercent: -9, size: 1 },
            { id: 3, type: 'long', entryTime: 3 as Time, entryPrice: 100, exitTime: 4 as Time, exitPrice: 112, pnl: 4, pnlPercent: 12, size: 1 },
            { id: 4, type: 'long', entryTime: 4 as Time, entryPrice: 100, exitTime: 5 as Time, exitPrice: 89, pnl: 2, pnlPercent: -11, size: 1 },
            { id: 5, type: 'long', entryTime: 5 as Time, entryPrice: 100, exitTime: 6 as Time, exitPrice: 110, pnl: 6, pnlPercent: 10, size: 1 },
            { id: 6, type: 'long', entryTime: 6 as Time, entryPrice: 100, exitTime: 7 as Time, exitPrice: 90, pnl: 6, pnlPercent: -10, size: 1 },
        ];

        const result = calculateBacktestStats(
            trades,
            equityCurve,
            10000,
            equityCurve[equityCurve.length - 1].value,
            0,
            0
        );
        const expectedSharpe = calculateSharpeRatioFromEquityCurve(equityCurve);

        expect(result.sharpeRatio).to.be.closeTo(expectedSharpe, 1e-12);
        expect(result.sharpeRatio).to.be.greaterThan(5);
    });

    it('should collapse intraday equity to day-end returns before annualizing sharpe', () => {
        const dailyCurve = [
            { time: '2023-01-01T23:55:00Z' as Time, value: 10000 },
            { time: '2023-01-02T23:55:00Z' as Time, value: 10100 },
            { time: '2023-01-03T23:55:00Z' as Time, value: 10050 },
            { time: '2023-01-04T23:55:00Z' as Time, value: 10200 },
            { time: '2023-01-05T23:55:00Z' as Time, value: 10180 },
            { time: '2023-01-06T23:55:00Z' as Time, value: 10320 },
        ];
        const intradayCurve = [
            { time: '2023-01-01T00:05:00Z' as Time, value: 10000 },
            { time: '2023-01-01T23:55:00Z' as Time, value: 10000 },
            { time: '2023-01-02T00:05:00Z' as Time, value: 10000 },
            { time: '2023-01-02T23:55:00Z' as Time, value: 10100 },
            { time: '2023-01-03T00:05:00Z' as Time, value: 10100 },
            { time: '2023-01-03T23:55:00Z' as Time, value: 10050 },
            { time: '2023-01-04T00:05:00Z' as Time, value: 10050 },
            { time: '2023-01-04T23:55:00Z' as Time, value: 10200 },
            { time: '2023-01-05T00:05:00Z' as Time, value: 10200 },
            { time: '2023-01-05T23:55:00Z' as Time, value: 10180 },
            { time: '2023-01-06T00:05:00Z' as Time, value: 10180 },
            { time: '2023-01-06T23:55:00Z' as Time, value: 10320 },
        ];

        const dailySharpe = calculateSharpeRatioFromEquityCurve(dailyCurve);
        const intradaySharpe = calculateSharpeRatioFromEquityCurve(intradayCurve);

        expect(intradaySharpe).to.be.closeTo(dailySharpe, 1e-12);
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

    it('smart_fixed_velocity_memory should size up after strong recent fast winners', () => {
        const config = normalizeBacktestSettings({ riskMode: 'simple', executionModel: 'signal_close' });
        const signal: Signal = { time: '2023-01-01' as Time, type: 'buy', price: 100 };
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        ];

        const velocity = buildPositionFromSignal({
            signal,
            barIndex: 0,
            capital: 10000,
            initialCapital: 10000,
            positionSizePercent: 100,
            commissionRate: 0,
            slippageRate: 0,
            settings: config,
            data,
            atrArray: [null],
            tradeDirection: 'long',
            sizingMode: 'smart_fixed_velocity_memory',
            fixedTradeAmount: 1000,
            smartSizingState: {
                recentVelocityScores: [1, 0.8, 0.6],
            },
        });

        expect(velocity).to.not.equal(null);
        expect(velocity!.nextPosition.size).to.be.closeTo(11.6, 1e-6);
    });

    it('smart_fixed_velocity_memory should trim size after weak recent trade velocity', () => {
        const config = normalizeBacktestSettings({ riskMode: 'simple', executionModel: 'signal_close' });
        const signal: Signal = { time: '2023-01-01' as Time, type: 'buy', price: 100 };
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        ];

        const fixed = buildPositionFromSignal({
            signal,
            barIndex: 0,
            capital: 10000,
            initialCapital: 10000,
            positionSizePercent: 100,
            commissionRate: 0,
            slippageRate: 0,
            settings: config,
            data,
            atrArray: [null],
            tradeDirection: 'long',
            sizingMode: 'fixed',
            fixedTradeAmount: 1000,
        });
        const velocity = buildPositionFromSignal({
            signal,
            barIndex: 0,
            capital: 10000,
            initialCapital: 10000,
            positionSizePercent: 100,
            commissionRate: 0,
            slippageRate: 0,
            settings: config,
            data,
            atrArray: [null],
            tradeDirection: 'long',
            sizingMode: 'smart_fixed_velocity_memory',
            fixedTradeAmount: 1000,
            smartSizingState: {
                recentVelocityScores: [-0.75, -0.5, -0.25],
            },
        });

        expect(fixed).to.not.equal(null);
        expect(velocity).to.not.equal(null);
        expect(velocity!.nextPosition.size).to.be.lessThan(fixed!.nextPosition.size);
        expect(velocity!.nextPosition.size).to.be.closeTo(9, 1e-6);
    });

    it('smart_fixed_quality_x_velocity should boost strong entry quality on top of good recent velocity', () => {
        const config = normalizeBacktestSettings({ riskMode: 'simple', executionModel: 'signal_close' });
        const signal: Signal = { time: '2023-01-02' as Time, type: 'buy', price: 100 };
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 99, volume: 100 },
            { time: '2023-01-02' as Time, open: 99, high: 103, low: 98, close: 102.8, volume: 300 },
        ];

        const qualityVelocity = buildPositionFromSignal({
            signal,
            barIndex: 1,
            capital: 10000,
            initialCapital: 10000,
            positionSizePercent: 100,
            commissionRate: 0,
            slippageRate: 0,
            settings: config,
            data,
            atrArray: [2, 2],
            tradeDirection: 'long',
            sizingMode: 'smart_fixed_quality_x_velocity',
            fixedTradeAmount: 1000,
            smartSizingState: {
                recentVelocityScores: [1, 0.8, 0.6],
            },
        });

        expect(qualityVelocity).to.not.equal(null);
        expect(qualityVelocity!.nextPosition.size).to.be.closeTo(12.75695, 1e-4);
    });

    it('should keep trade pnlPercent fee-aware', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 100, close: 101, volume: 1000 },
            { time: '2023-01-03' as Time, open: 101, high: 103, low: 101, close: 102, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
            { time: '2023-01-03' as Time, type: 'sell', price: 101 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 1);

        expect(result.totalTrades).to.equal(1);
        expect(result.netProfit).to.be.lessThan(0);
        expect(result.trades[0].pnl).to.be.lessThan(0);
        expect(result.trades[0].pnlPercent).to.be.lessThan(0);
    });

    it('should keep forced end-of-data equity and drawdown in sync', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
        ];

        const full = runBacktest(data, signals, 1000, 100, 1);
        const compact = runBacktestCompact(data, signals, 1000, 100, 1);
        const finalCapital = 1000 + full.netProfit;

        expect(full.totalTrades).to.equal(1);
        expect(full.trades[0].exitReason).to.equal('end_of_data');
        expect(full.equityCurve[full.equityCurve.length - 1].value).to.be.closeTo(finalCapital, 1e-9);
        expect(compact.maxDrawdown).to.be.closeTo(full.maxDrawdown, 1e-9);
        expect(compact.maxDrawdownPercent).to.be.closeTo(full.maxDrawdownPercent, 1e-9);
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

    it('should reject stale ATR precomputes so compact finder-style runs match full backtests', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 120, low: 100, close: 110, volume: 1000 },
            { time: '2023-01-02' as Time, open: 110, high: 112, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 103, low: 97, close: 100, volume: 1000 },
            { time: '2023-01-04' as Time, open: 100, high: 104, low: 99, close: 101, volume: 1000 },
            { time: '2023-01-05' as Time, open: 101, high: 101, low: 100, close: 100, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-03' as Time, type: 'buy', price: 100, barIndex: 2 },
        ];

        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'simple' as const,
            atrPeriod: 2,
            stopLossAtr: 0,
            trailingAtr: 0,
            takeProfitAtr: 0.5,
        };

        const stalePrecomputed = precomputeIndicators(data, { ...settings, atrPeriod: 1 });
        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, stalePrecomputed);

        expect(full.totalTrades).to.equal(1);
        expect(full.trades[0].exitReason).to.equal('end_of_data');
        expect(full.trades[0].takeProfitPrice).to.be.closeTo(105.5, 1e-9);
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
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
});

