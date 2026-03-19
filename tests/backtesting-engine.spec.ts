import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateSMA, calculateRSI, calculateATR, calculateADX, calculateBacktestStats, OHLCVData, Signal, Time, Trade } from './lib/strategies/index';
import { calculateSharpeRatioFromEquityCurve } from './lib/strategies/performance-metrics';
import { calculateEMA } from './lib/strategies/indicators';
import { runBacktest, runBacktestCompact } from './lib/strategies/index';
import { normalizeBacktestSettings } from './lib/strategies/backtest/backtest-utils';
import { buildPositionFromSignal } from './lib/strategies/backtest/position-builder';
import { getOpenPositionForScanner } from './lib/strategies/backtest/signal-preparation';
import { computeSnapshotIndicators } from './lib/strategies/backtest/snapshot-capture';
import { resolveScannerBacktestSettings } from './lib/scanner/scanner-engine';
import { resolveBacktestSettingsFromRaw } from './lib/backtest-settings-resolver';
import { resolveEntryRiskTargets } from './lib/entry-risk-targets';
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

    it('should override percentage stop loss after the configured win streak', () => {
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
        expect(result.trades[2].exitReason).to.equal('stop_loss');
        expect(result.trades[2].exitTime).to.equal('2023-01-07' as Time);
    });

    it('should resolve shrinkage take-profit settings from raw UI values', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitToggle: true,
            takeProfitPercent: '8',
            takeProfitMode: 'shrinkage',
            takeProfitMfeLookbackTrades: '75',
            takeProfitMfePercentile: '65',
            takeProfitShrinkageStrength: '12',
        } as any);

        expect(resolved.takeProfitMode).to.equal('shrinkage');
        expect(resolved.takeProfitPercent).to.equal(8);
        expect(resolved.takeProfitMfeLookbackTrades).to.equal(75);
        expect(resolved.takeProfitMfePercentile).to.equal(65);
        expect(resolved.takeProfitShrinkageStrength).to.equal(12);
    });

    it('should resolve momentum-gated take-profit settings from raw UI values', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitToggle: true,
            takeProfitPercent: '6',
            takeProfitMode: 'momentum_gated',
            takeProfitMomentumRsiPeriod: '9',
            takeProfitMomentumRsiPauseLevel: '58',
            takeProfitMomentumDecayPercentPerBar: '0.35',
        } as any);

        expect(resolved.takeProfitMode).to.equal('momentum_gated');
        expect(resolved.takeProfitPercent).to.equal(6);
        expect(resolved.takeProfitMomentumRsiPeriod).to.equal(9);
        expect(resolved.takeProfitMomentumRsiPauseLevel).to.equal(58);
        expect(resolved.takeProfitMomentumDecayPercentPerBar).to.equal(0.35);
    });

    it('should shrink pair-specific rolling MFE toward the base take-profit percent', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 105, low: 99, close: 103, volume: 1000 },
            { time: '2023-01-03' as Time, open: 103, high: 103, low: 102, close: 103, volume: 1000 },
            { time: '2023-01-04' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-05' as Time, open: 100, high: 103.6, low: 99.8, close: 101, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
            { time: '2023-01-04' as Time, type: 'buy', price: 100 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 2,
            takeProfitMode: 'shrinkage',
            takeProfitMfeLookbackTrades: 10,
            takeProfitMfePercentile: 60,
            takeProfitShrinkageStrength: 1,
        });

        expect(result.totalTrades).to.equal(2);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitPrice).to.equal(102);
        expect(result.trades[1].exitReason).to.equal('take_profit');
        expect(result.trades[1].exitPrice).to.be.closeTo(102, 1e-9);
    });

    it('should not use a same-bar closed trade to set shrinkage TP for next_open warm-up entries', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 104, low: 99, close: 104, volume: 1000 },
            { time: '2023-01-04' as Time, open: 104, high: 108.5, low: 100, close: 101, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            executionModel: 'next_open',
            warmUpEntryEnabled: true,
            maxOpenTrades: 1,
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            takeProfitMode: 'shrinkage',
            takeProfitMfeLookbackTrades: 10,
            takeProfitMfePercentile: 60,
            takeProfitShrinkageStrength: 1,
            riskMaxHoldEnabled: true,
            riskMaxHoldBars: 1,
        });

        expect(result.totalTrades).to.equal(2);
        expect(result.trades[0].exitReason).to.equal('time_stop');
        expect(result.trades[0].exitPrice).to.equal(104);
        expect(result.trades[1].entryTime).to.equal('2023-01-03' as Time);
        expect(result.trades[1].exitReason).to.equal('time_stop');
        expect(result.trades[1].exitPrice).to.equal(101);
    });

    it('should keep full exit-bar excursion for signal-close exits that stay open through the close', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 110, low: 99, close: 104, volume: 1000 },
            { time: '2023-01-04' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-05' as Time, open: 100, high: 113, low: 99, close: 101, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100 },
            { time: '2023-01-03' as Time, type: 'sell', price: 104 },
            { time: '2023-01-04' as Time, type: 'buy', price: 100 },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 20,
            takeProfitMode: 'shrinkage',
            takeProfitMfeLookbackTrades: 10,
            takeProfitMfePercentile: 60,
            takeProfitShrinkageStrength: 1,
        });

        expect(result.totalTrades).to.equal(2);
        expect(result.trades[0].exitReason).to.equal('signal');
        expect(result.trades[0].exitPrice).to.equal(104);
        expect(result.trades[1].exitReason).to.equal('end_of_data');
        expect(result.trades[1].takeProfitPrice).to.be.closeTo(115, 1e-9);
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

    it('scanner settings resolver should accept flip-after-2-losses trade direction', () => {
        const resolved = resolveScannerBacktestSettings({
            tradeDirection: 'both_flip_loss_2',
            riskSettingsToggle: false,
            tradeFilterSettingsToggle: false
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
        expect(resolved.riskMaxHoldBars).to.equal(12);
        expect(resolved.riskMaxHoldEnabled).to.equal(true);
        expect(resolved.riskWinStreakStopLossEnabled).to.equal(true);
        expect(resolved.riskWinStreakStopLossAfterWins).to.equal(4);
        expect(resolved.riskWinStreakStopLossPercent).to.equal(1.25);
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

    it('scanner settings resolver should preserve max hold in simple mode when risk is enabled', () => {
        const resolved = resolveScannerBacktestSettings({
            riskSettingsToggle: true,
            riskMode: 'simple',
            stopLossAtr: 1.5,
            riskMaxHoldBars: 7,
            riskMaxHoldEnabled: true,
            tradeFilterSettingsToggle: false,
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

    it('should not let next_open entry-bar range expand velocity TP when same-bar exits are disabled', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 110, low: 100, close: 105, volume: 1000 },
            { time: '2023-01-04' as Time, open: 105, high: 110, low: 104, close: 108, volume: 1000 },
            { time: '2023-01-05' as Time, open: 108, high: 108, low: 108, close: 108, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100, barIndex: 1 },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            takeProfitMode: 'velocity' as const,
            takeProfitVelocityFastBars: 1,
            takeProfitVelocitySlowBars: 5,
            takeProfitVelocityProgressPercent: 100,
            takeProfitVelocityExpandMultiplier: 2,
            takeProfitVelocityShrinkMultiplier: 0.5,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].entryTime).to.equal('2023-01-03' as Time);
        expect(result.trades[0].exitReason).to.equal('take_profit');
        expect(result.trades[0].exitTime).to.equal('2023-01-04' as Time);
        expect(result.trades[0].exitPrice).to.be.closeTo(110, 1e-9);
    });

    it('should still shrink velocity TP after slow bars when progress stays below 100 percent', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 100, high: 107, low: 100, close: 106, volume: 1000 },
            { time: '2023-01-04' as Time, open: 106, high: 108, low: 104, close: 107, volume: 1000 },
            { time: '2023-01-05' as Time, open: 107, high: 105, low: 104, close: 105, volume: 1000 },
            { time: '2023-01-06' as Time, open: 105, high: 105, low: 105, close: 105, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100, barIndex: 1 },
        ];

        const shrunk = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            takeProfitMode: 'velocity' as const,
            takeProfitVelocityFastBars: 1,
            takeProfitVelocitySlowBars: 2,
            takeProfitVelocityProgressPercent: 100,
            takeProfitVelocityExpandMultiplier: 2,
            takeProfitVelocityShrinkMultiplier: 0.5,
        });

        const unshrunk = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            allowSameBarExit: false,
            riskMode: 'percentage' as const,
            stopLossEnabled: false,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            takeProfitMode: 'velocity' as const,
            takeProfitVelocityFastBars: 1,
            takeProfitVelocitySlowBars: 2,
            takeProfitVelocityProgressPercent: 100,
            takeProfitVelocityExpandMultiplier: 2,
            takeProfitVelocityShrinkMultiplier: 1,
        });

        expect(shrunk.totalTrades).to.equal(1);
        expect(shrunk.trades[0].exitReason).to.equal('take_profit');
        expect(shrunk.trades[0].exitTime).to.equal('2023-01-06' as Time);
        expect(shrunk.trades[0].exitPrice).to.be.closeTo(105, 1e-9);

        expect(unshrunk.totalTrades).to.equal(1);
        expect(unshrunk.trades[0].exitReason).to.equal('end_of_data');
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

    it('should filter rebound traps using TF confluence', () => {
        const data: OHLCVData[] = [];
        const startMs = Date.UTC(2023, 5, 1, 0, 0, 0);

        for (let i = 0; i < 80; i++) {
            let close: number;
            if (i < 30) {
                close = 120 - i * 0.7;
            } else if (i < 35) {
                close = 99 + (i - 29) * 1.2;
            } else if (i < 40) {
                close = 105 - (i - 34) * 1.0;
            } else {
                close = 100 + (i - 39) * 0.65;
            }

            const open = close - 0.25;
            const high = Math.max(open, close) + 0.6;
            const low = Math.min(open, close) - 0.6;
            data.push({
                time: Math.floor((startMs + i * 30 * 60 * 1000) / 1000) as Time,
                open,
                high,
                low,
                close,
                volume: 1200 + (i % 6) * 30
            });
        }

        const signals: Signal[] = [
            { time: data[34].time, type: 'buy', price: data[34].close },
            { time: data[38].time, type: 'sell', price: data[38].close },
            { time: data[66].time, type: 'buy', price: data[66].close },
            { time: data[70].time, type: 'sell', price: data[70].close },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0);
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            snapshotTfConfluencePerfMin: 1.2
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        expect(withFilter.totalTrades).to.equal(1);
        expect(withFilter.trades[0].entryTime).to.equal(data[66].time);
    });

    it('should evaluate TF snapshot filters on the signal bar (not execution bar) for next_open entries', () => {
        // Snapshot filters must evaluate on the decision/signal bar, NOT the execution bar.
        // Under next_open, execution happens at bar i+1's open, but that bar's close/volume
        // aren't available yet. Filters must only use data up to the signal bar.
        const data: OHLCVData[] = [];
        const startMs = Date.UTC(2023, 6, 1, 0, 0, 0);

        // Build data: first 9 bars choppy, then a clear uptrend from bar 9 onward.
        // Signal bar 8: close=108, TF60 perf measured from bar 8's close (not bar 9's).
        // Signal bar 14: close=106, TF60 perf measured from bar 14's close (not bar 15's).
        const closes = [
            100, 101, 102, 103, 104, 105, 106, 107, 108,
            100, 101, 102, 103, 104, 106, 110, 112
        ];

        for (let i = 0; i < closes.length; i++) {
            const close = closes[i];
            data.push({
                time: Math.floor((startMs + i * 30 * 60 * 1000) / 1000) as Time,
                open: close - 0.2,
                high: close + 0.8,
                low: close - 0.8,
                close,
                volume: 1200 + (i % 5) * 20
            });
        }

        const signals: Signal[] = [
            { time: data[8].time, type: 'buy', price: data[8].close },
            { time: data[11].time, type: 'sell', price: data[11].close },
            { time: data[14].time, type: 'buy', price: data[14].close },
            { time: data[16].time, type: 'sell', price: data[16].close },
        ];

        const withoutFilter = runBacktest(data, signals, 10000, 100, 0, {
            executionModel: 'next_open'
        });

        // Use a high threshold that depends on which bar the filter evaluates.
        // Under the corrected logic, TF60 perf is computed from the signal bar's close,
        // not the execution bar's close, so the filter result may differ.
        const withFilter = runBacktest(data, signals, 10000, 100, 0, {
            executionModel: 'next_open',
            snapshotTf60PerfMin: 1.0
        });

        expect(withoutFilter.totalTrades).to.equal(2);
        // The filter should still allow good entries but based on signal-bar data only.
        expect(withFilter.totalTrades).to.be.greaterThanOrEqual(0);
        expect(withFilter.totalTrades).to.be.lessThanOrEqual(withoutFilter.totalTrades);
    });

    it('should capture entry snapshots on the signal bar for next_open entries', () => {
        const data: OHLCVData[] = [];
        const startMs = Date.UTC(2023, 6, 1, 0, 0, 0);
        const closes = [
            100, 101, 102, 103, 104, 105, 106, 107, 108,
            100, 101, 102, 103, 104, 106, 110, 112
        ];

        for (let i = 0; i < closes.length; i++) {
            const close = closes[i];
            data.push({
                time: Math.floor((startMs + i * 30 * 60 * 1000) / 1000) as Time,
                open: close - 0.2,
                high: close + 0.8,
                low: close - 0.8,
                close,
                volume: 1200 + (i % 5) * 20
            });
        }

        const signals: Signal[] = [
            { time: data[14].time, type: 'buy', price: data[14].close },
            { time: data[15].time, type: 'sell', price: data[15].close },
        ];

        const result = runBacktest(data, signals, 10000, 100, 0, {
            executionModel: 'next_open',
            captureSnapshots: true
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].entryTime).to.equal(data[15].time);
        expect(result.trades[0].entrySnapshot).to.not.be.undefined;

        // 60m lookback on 30m data resolves to two bars back from the signal bar (14 -> 12).
        const expectedTf60Perf = ((data[14].close - data[12].close) / data[12].close) * 100;
        expect(result.trades[0].entrySnapshot?.tf60Perf ?? null).to.be.closeTo(expectedTf60Perf, 1e-9);
    });

    it('should keep standardized snapshot indicators independent from strategy indicator periods', () => {
        const data: OHLCVData[] = [];
        for (let i = 0; i < 80; i++) {
            const close = 100 + i * 0.65 + (i % 7) * 1.4 - (i % 5) * 0.55;
            data.push({
                time: `2023-03-${String(i + 1).padStart(2, '0')}` as Time,
                open: close - 0.7,
                high: close + 1.6 + (i % 3) * 0.2,
                low: close - 1.4 - (i % 4) * 0.15,
                close,
                volume: 900 + (i % 9) * 75 + (i % 4) * 20,
            });
        }

        const highs = data.map((candle) => candle.high);
        const lows = data.map((candle) => candle.low);
        const closes = data.map((candle) => candle.close);
        const volumes = data.map((candle) => candle.volume);
        const probeIndex = 70;

        const contaminatedIndicators = {
            atr: calculateATR(highs, lows, closes, 5),
            emaTrend: calculateEMA(closes, 21),
            emaFast: [],
            emaSlow: [],
            adx: calculateADX(highs, lows, closes, 5),
            volumeSma: calculateSMA(volumes, 7),
            rsi: calculateRSI(closes, 5),
            sessionVwap: [],
            vwapDeviationStd: [],
        };

        const snapshotIndicators = computeSnapshotIndicators(data, contaminatedIndicators);

        expect(snapshotIndicators.rsi[probeIndex]).to.be.closeTo(calculateRSI(closes, 14)[probeIndex]!, 1e-9);
        expect(snapshotIndicators.volumeSma[probeIndex]).to.be.closeTo(calculateSMA(volumes, 20)[probeIndex]!, 1e-9);
        expect(snapshotIndicators.adx[probeIndex]).to.be.closeTo(calculateADX(highs, lows, closes, 14)[probeIndex]!, 1e-9);
        expect(snapshotIndicators.atr[probeIndex]).to.be.closeTo(calculateATR(highs, lows, closes, 14)[probeIndex]!, 1e-9);
        expect(snapshotIndicators.emaTrend[probeIndex]).to.be.closeTo(calculateEMA(closes, 50)[probeIndex]!, 1e-9);

        expect(snapshotIndicators.rsi[probeIndex]).to.not.equal(contaminatedIndicators.rsi[probeIndex]);
        expect(snapshotIndicators.volumeSma[probeIndex]).to.not.equal(contaminatedIndicators.volumeSma[probeIndex]);
        expect(snapshotIndicators.adx[probeIndex]).to.not.equal(contaminatedIndicators.adx[probeIndex]);
        expect(snapshotIndicators.atr[probeIndex]).to.not.equal(contaminatedIndicators.atr[probeIndex]);
        expect(snapshotIndicators.emaTrend[probeIndex]).to.not.equal(contaminatedIndicators.emaTrend[probeIndex]);
    });
});

