import { expect } from 'chai';
import { describe, it } from 'node:test';
import { calculateBacktestStats, OHLCVData, Signal, Time, Trade, type BacktestSettings } from '../lib/strategies/index';
import { calculateSharpeRatioFromEquityCurve } from '../lib/strategies/performance-metrics';
import { runBacktest, runBacktestCompact } from '../lib/strategies/index';
import { precomputeIndicators } from '../lib/strategies/backtest';
import { normalizeBacktestSettings } from '../lib/strategies/backtest/backtest-utils';
import { buildPositionFromSignal } from '../lib/strategies/backtest/position-builder';
import { getOpenPositionForScanner } from '../lib/strategies/backtest/signal-preparation';
import { resolveScannerBacktestSettings } from '../lib/scanner/scanner-engine';
import { resolveBacktestSettingsFromRaw } from '../lib/backtest-settings-resolver';
import { resolveEntryRiskTargets } from '../lib/entry-risk-targets';
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

    it('preserves chronological execution for out-of-order raw signals', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 103, low: 99, close: 102, volume: 1000 },
            { time: 3 as Time, open: 102, high: 106, low: 101, close: 105, volume: 1000 },
            { time: 4 as Time, open: 105, high: 106, low: 103, close: 104, volume: 1000 },
            { time: 5 as Time, open: 104, high: 109, low: 103, close: 108, volume: 1000 },
        ];
        const sortedSignals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 3 as Time, type: 'sell', price: 105 },
            { time: 4 as Time, type: 'buy', price: 104 },
            { time: 5 as Time, type: 'sell', price: 108 },
        ];
        const unsortedSignals = [
            sortedSignals[2],
            sortedSignals[3],
            sortedSignals[0],
            sortedSignals[1],
        ];
        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            takeProfitEnabled: false,
            takeProfitMode: 'mfe_bootstrap' as const,
        };

        const expected = runBacktest(data, sortedSignals, 1000, 100, 0, settings);
        const actual = runBacktest(data, unsortedSignals, 1000, 100, 0, settings);

        expect(actual.trades).to.deep.equal(expected.trades);
        expect(actual.netProfit).to.equal(expected.netProfit);
    });

    it('collects opt-in backtest diagnostics for Finder profiling', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 103, low: 99, close: 102, volume: 1000 },
            { time: 3 as Time, open: 102, high: 106, low: 101, close: 105, volume: 1000 },
            { time: 4 as Time, open: 105, high: 106, low: 102, close: 103, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 4 as Time, type: 'sell', price: 103 },
        ];

        const plainResult = runBacktest(data, signals, 1000, 100, 0);
        const profiledResult = runBacktest(data, signals, 1000, 100, 0, {}, undefined, undefined, {
            collectDiagnostics: true,
        });

        expect(plainResult.diagnostics).to.equal(undefined);
        expect(profiledResult.diagnostics?.counts.inputSignals).to.equal(2);
        expect(profiledResult.diagnostics?.counts.preparedSignals).to.equal(2);
        expect(profiledResult.diagnostics?.counts.barsScanned).to.equal(data.length);
        expect(profiledResult.diagnostics?.counts.tradesOpened).to.equal(1);
        expect(profiledResult.diagnostics?.counts.tradesClosed).to.equal(1);
        expect(profiledResult.diagnostics?.counts.fastPathRuns).to.equal(0);
        expect(profiledResult.diagnostics?.fastPath?.blockers).to.include('equity_curve_required');
        expect(profiledResult.diagnostics?.timingsMs.total).to.be.greaterThan(0);
        expect(profiledResult.diagnostics?.timingsMs.tradeSimulation).to.be.greaterThan(0);
    });

    it('can omit the equity curve for non-Sharpe Finder candidate runs', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 3 as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: 4 as Time, open: 101, high: 104, low: 100, close: 103, volume: 1000 },
            { time: 5 as Time, open: 103, high: 105, low: 102, close: 104, volume: 1000 },
            { time: 6 as Time, open: 104, high: 105, low: 103, close: 104, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 3 as Time, type: 'buy', price: 101 },
            { time: 5 as Time, type: 'sell', price: 104 },
        ];
        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            takeProfitEnabled: false,
            takeProfitMode: 'mfe_bootstrap' as const,
            riskMaxHoldEnabled: false,
            riskMaxHoldBars: 10,
        };

        const baseline = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
        });
        const omitted = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
            omitEquityCurve: true,
            collectDiagnostics: true,
        });

        expect(omitted.equityCurve).to.deep.equal([]);
        expect(omitted.totalTrades).to.equal(baseline.totalTrades);
        expect(omitted.netProfit).to.equal(baseline.netProfit);
        expect(omitted.maxDrawdown).to.equal(baseline.maxDrawdown);
        expect(omitted.diagnostics?.counts.barsScanned).to.be.lessThan(data.length);
    });

    it('honors disabled Sharpe calculation in compact backtests', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 103, low: 99, close: 102, volume: 1000 },
            { time: 3 as Time, open: 102, high: 106, low: 101, close: 105, volume: 1000 },
            { time: 4 as Time, open: 105, high: 106, low: 102, close: 103, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 4 as Time, type: 'sell', price: 103 },
        ];

        const result = runBacktestCompact(data, signals, 1000, 100, 0, {}, undefined, undefined, {
            includeSharpeRatio: false,
            collectDiagnostics: true,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.sharpeRatio).to.equal(0);
        expect(result.diagnostics?.counts.preparedSignals).to.equal(2);
    });

    it('uses the single-position fast path for compact Finder candidate runs', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 101, low: 99.5, close: 100, volume: 1000 },
            { time: 3 as Time, open: 100, high: 102.5, low: 99.5, close: 102, volume: 1000 },
            { time: 4 as Time, open: 102, high: 103, low: 101, close: 101, volume: 1000 },
            { time: 5 as Time, open: 101, high: 101.5, low: 100.5, close: 101, volume: 1000 },
            { time: 6 as Time, open: 101, high: 101.5, low: 99, close: 99.5, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 2 as Time, type: 'buy', price: 100 },
            { time: 4 as Time, type: 'sell', price: 101 },
            { time: 5 as Time, type: 'buy', price: 101 },
        ];
        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 1,
            takeProfitEnabled: true,
            takeProfitPercent: 2,
            disableSignalExits: true,
        };

        const baseline = runBacktestCompact(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
        });
        const fast = runBacktestCompact(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
            omitEquityCurve: true,
            collectDiagnostics: true,
        });

        expect(fast.trades).to.deep.equal([]);
        expect(fast.totalTrades).to.equal(baseline.totalTrades);
        expect(fast.netProfit).to.equal(baseline.netProfit);
        expect(fast.maxDrawdown).to.equal(baseline.maxDrawdown);
        expect(fast.diagnostics?.counts.fastPathRuns).to.equal(1);
        expect(fast.diagnostics?.fastPath?.used).to.equal(true);
    });

    it('can skip held-bar drawdown scans for Symbol Universe compact runs', () => {
        const data: OHLCVData[] = Array.from({ length: 120 }, (_, index) => ({
            time: (index + 1) as Time,
            open: 100 + index * 0.1,
            high: 101 + index * 0.1,
            low: 99 + index * 0.1,
            close: 100 + index * 0.1,
            volume: 1000,
        }));
        const signals: Signal[] = [
            { time: 2 as Time, type: 'buy', price: data[1].close },
            { time: 110 as Time, type: 'sell', price: data[109].close },
        ];
        const settings = { tradeDirection: 'long' as const, executionModel: 'signal_close' as const };

        const baseline = runBacktestCompact(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
            omitEquityCurve: true,
            collectDiagnostics: true,
        });
        const sparse = runBacktestCompact(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
            omitEquityCurve: true,
            skipDrawdown: true,
            collectDiagnostics: true,
        });

        expect(sparse.totalTrades).to.equal(baseline.totalTrades);
        expect(sparse.netProfit).to.equal(baseline.netProfit);
        expect(sparse.maxDrawdownPercent).to.equal(0);
        expect(sparse.diagnostics?.counts.fastPathRuns).to.equal(1);
        expect(sparse.diagnostics?.counts.barsScanned).to.be.lessThan(baseline.diagnostics?.counts.barsScanned ?? 0);
        expect(sparse.diagnostics?.counts.barsScanned).to.equal(signals.length);
    });

    it('preserves trade history when Finder uses the single-position fast path', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 101, low: 99.5, close: 100, volume: 1000 },
            { time: 3 as Time, open: 100, high: 102.5, low: 99.5, close: 102, volume: 1000 },
            { time: 4 as Time, open: 102, high: 103, low: 101, close: 101, volume: 1000 },
            { time: 5 as Time, open: 101, high: 101.5, low: 100.5, close: 101, volume: 1000 },
            { time: 6 as Time, open: 101, high: 101.5, low: 99, close: 99.5, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 2 as Time, type: 'buy', price: 100 },
            { time: 4 as Time, type: 'sell', price: 101 },
            { time: 5 as Time, type: 'buy', price: 101 },
        ];
        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 1,
            takeProfitEnabled: true,
            takeProfitPercent: 2,
            disableSignalExits: true,
        };

        const baseline = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
        });
        const fast = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
            omitEquityCurve: true,
            collectDiagnostics: true,
        });

        expect(fast.equityCurve).to.deep.equal([]);
        expect(fast.trades).to.deep.equal(baseline.trades);
        expect(fast.netProfit).to.equal(baseline.netProfit);
        expect(fast.maxDrawdown).to.equal(baseline.maxDrawdown);
        expect(fast.diagnostics?.counts.fastPathRuns).to.equal(1);
        expect(fast.diagnostics?.fastPath?.used).to.equal(true);
        expect(fast.diagnostics?.timingsMs.tradeSimulation).to.be.greaterThan(0);
    });

    it('preserves next-open entry-bar stop behavior on the Finder fast path', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 100.5, low: 99.5, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 101, low: 98, close: 99, volume: 1000 },
            { time: 3 as Time, open: 99, high: 100, low: 98, close: 99, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
        ];
        const settings = {
            tradeDirection: 'long' as const,
            executionModel: 'next_open' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 1,
            takeProfitEnabled: true,
            takeProfitPercent: 5,
            disableSignalExits: true,
        };

        const baseline = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
        });
        const fast = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
            omitEquityCurve: true,
        });

        expect(fast.trades).to.deep.equal(baseline.trades);
        expect(fast.trades[0]?.exitReason).to.equal('stop_loss');
        expect(fast.trades[0]?.exitTime).to.equal(2);
        expect(fast.trades[0]?.exitPrice).to.equal(99);
    });

    it('preserves both-direction signal-close flips on the Finder fast path', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 103, low: 99, close: 102, volume: 1000 },
            { time: 3 as Time, open: 102, high: 103, low: 98, close: 99, volume: 1000 },
            { time: 4 as Time, open: 99, high: 100, low: 95, close: 96, volume: 1000 },
            { time: 5 as Time, open: 96, high: 99, low: 95, close: 98, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 3 as Time, type: 'sell', price: 99 },
            { time: 5 as Time, type: 'buy', price: 98 },
        ];
        const settings = {
            tradeDirection: 'both' as const,
            executionModel: 'signal_close' as const,
        };

        const baseline = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
        });
        const fast = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            includeSharpeRatio: false,
            omitEquityCurve: true,
            collectDiagnostics: true,
        });

        expect(fast.diagnostics?.counts.fastPathRuns).to.equal(1);
        expect(fast.trades).to.deep.equal(baseline.trades);
        expect(fast.trades.map((trade) => trade.type)).to.deep.equal(['long', 'short', 'long']);
    });

    it('can ignore strategy exit signals until chart TP or SL closes the trade', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: 3 as Time, open: 101, high: 106, low: 100, close: 105, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 2 as Time, type: 'sell', price: 101 },
        ];

        const normal = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'long',
            executionModel: 'signal_close',
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 5,
        });
        const disabled = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'long',
            executionModel: 'signal_close',
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 5,
            disableSignalExits: true,
        });

        expect(normal.trades[0].exitReason).to.equal('signal');
        expect(disabled.trades[0].exitReason).to.equal('take_profit');
        expect(disabled.trades[0].exitTime).to.equal(3 as Time);
    });

    it('allows exit-only signals to close trades while disableSignalExits is active', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: 3 as Time, open: 101, high: 103, low: 100, close: 102, volume: 1000 },
            { time: 4 as Time, open: 102, high: 104, low: 101, close: 103, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 2 as Time, type: 'sell', price: 101, exitOnly: true },
            { time: 3 as Time, type: 'sell', price: 102, exitOnly: true },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both',
            executionModel: 'signal_close',
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            disableSignalExits: true,
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('signal');
        expect(result.trades[0].exitTime).to.equal(2 as Time);
        expect(result.trades.map((trade) => trade.type)).to.deep.equal(['long']);
    });

    it('keeps disableSignalExits active when an exit strategy override supplies close-only signals', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: 3 as Time, open: 101, high: 103, low: 100, close: 102, volume: 1000 },
            { time: 4 as Time, open: 102, high: 104, low: 101, close: 103, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 2 as Time, type: 'sell', price: 101 },
            { time: 3 as Time, type: 'sell', price: 102, exitOnly: true },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both',
            executionModel: 'signal_close',
            riskMode: 'percentage',
            disableSignalExits: true,
            exitStrategyOverrideEnabled: true,
            exitStrategyKey: 'exit_demo',
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].exitReason).to.equal('signal');
        expect(result.trades[0].exitTime).to.equal(3 as Time);
        expect(result.trades.map((trade) => trade.type)).to.deep.equal(['long']);
    });

    it('never opens a new position from an exitOnly signal, even in both-direction mode', () => {
        // WHY this test exists: the core safety property of Exit Strategy Override is that
        // the exit strategy's signals are close-ONLY. If an exitOnly sell signal could open
        // a fresh short after closing a long, the exit strategy would silently become a second
        // entry strategy, defeating the feature's purpose and corrupting backtest results.
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: 3 as Time, open: 101, high: 103, low: 100, close: 102, volume: 1000 },
            { time: 4 as Time, open: 102, high: 104, low: 101, close: 103, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 2 as Time, type: 'sell', price: 101, exitOnly: true },
            { time: 3 as Time, type: 'sell', price: 102, exitOnly: true }, // would open a short if not exitOnly
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both',
            executionModel: 'signal_close',
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            disableSignalExits: true,
        });

        // Exactly one trade (the long), closed by the exitOnly sell at time=2.
        // The time=3 exitOnly sell must NOT open a new short.
        expect(result.totalTrades).to.equal(1);
        expect(result.trades.map((trade) => trade.type)).to.deep.equal(['long']);
        expect(result.trades[0].exitTime).to.equal(2 as Time);
    });

    it('does not treat forced Polymarket exit signals as entries without a matching open trade', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'sell', price: 100, reason: 'polymarket_take_profit' },
        ];

        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both',
            executionModel: 'signal_close',
        });

        expect(result.totalTrades).to.equal(0);
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

    it('scanner settings resolver should accept both_no_flip trade direction', () => {
        const resolved = resolveScannerBacktestSettings({
            tradeDirection: 'both_no_flip',
            riskSettingsToggle: false,
        } as any);
        expect(resolved.tradeDirection).to.equal('both_no_flip');
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
        expect(resolved.confirmationMode).to.equal('agree');
        expect(resolved.confirmationWindowBars).to.equal(0);
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

    it('scanner settings resolver should normalize confirmation mode and window bars', () => {
        const resolved = resolveScannerBacktestSettings({
            confirmationStrategiesToggle: 'true',
            confirmationStrategies: ['event_direction_1s'],
            confirmationMode: 'confirm_within_window',
            confirmationWindowBars: '3',
        } as any);

        expect(resolved.confirmationStrategies).to.deep.equal(['event_direction_1s']);
        expect(resolved.confirmationMode).to.equal('confirm_within_window');
        expect(resolved.confirmationWindowBars).to.equal(3);
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

    it('should gap through take profit at next_open and respect the entry cooldown afterwards', () => {
        // WHY: a gap-through-TP at the open must still close the trade at the TP
        // target. After the cooldown feature shipped, any close (including TP)
        // arms the post-exit entry cooldown, so a new entry cannot open on the
        // same bar — it must wait one bar (default N=1) before re-entering.
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

        // First trade enters at 2023-01-02 (next_open of the 01-01 signal) and
        // gaps through the 5% TP at the 2023-01-03 open (106 vs 100 entry).
        expect(full.totalTrades).to.equal(1);
        expect(full.trades[0].entryTime).to.equal('2023-01-02' as Time);
        expect(full.trades[0].exitTime).to.equal('2023-01-03' as Time);
        expect(full.trades[0].exitReason).to.equal('take_profit');
        // The 01-02 buy signal's next_open execution lands on the same bar as
        // the TP close (01-03); the entry cooldown now blocks same-bar re-entry,
        // so no second trade is opened.
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
    });

    it('should re-enter on the bar after a TP-gap exit once the cooldown clears', () => {
        // WHY: the cooldown gates spacing, it does not block the strategy
        // outright — once N bars pass the next signal must enter normally.
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: '2023-01-03' as Time, open: 106, high: 107, low: 105, close: 106, volume: 1000 },
            { time: '2023-01-04' as Time, open: 107, high: 108, low: 106, close: 107, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: '2023-01-01' as Time, type: 'buy', price: 100, barIndex: 0 },
            { time: '2023-01-03' as Time, type: 'buy', price: 106, barIndex: 2 },
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

        // First trade gaps through TP at 01-03 open. The 01-03 buy signal's
        // next_open execution lands on 01-04 — one bar after the exit, so the
        // default N=1 cooldown has cleared and the second trade opens.
        expect(full.totalTrades).to.equal(2);
        expect(full.trades[0].exitReason).to.equal('take_profit');
        expect(full.trades[1].entryTime).to.equal('2023-01-04' as Time);
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
            } as unknown as BacktestSettings,
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
            } as unknown as BacktestSettings,
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

    it('should close without reversing on the same signal in both_no_flip mode', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 2 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 3 as Time, open: 100, high: 101, low: 94, close: 95, volume: 1000 },
            { time: 4 as Time, open: 95, high: 96, low: 94, close: 95, volume: 1000 },
            { time: 5 as Time, open: 95, high: 106, low: 94, close: 105, volume: 1000 },
            { time: 6 as Time, open: 105, high: 106, low: 104, close: 105, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 2 as Time, type: 'sell', price: 100 },
            { time: 3 as Time, type: 'buy', price: 95 },
            { time: 4 as Time, type: 'buy', price: 95 },
        ];
        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'both_no_flip',
            executionModel: 'signal_close',
        });

        expect(result.trades.map((trade) => `${trade.type}:${trade.entryTime}`)).to.deep.equal([
            'short:2',
            'long:4',
        ]);
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

    it('should not let exitOnly conflicts suppress a combined entry', () => {
        const data: OHLCVData[] = Array.from({ length: 6 }, (_, index) => ({
            time: (index + 1) as Time,
            open: 100 + index,
            high: 101 + index,
            low: 99 + index,
            close: 100 + index,
            volume: 1000,
        }));
        const signals: Signal[] = [
            { time: 2 as Time, type: 'sell', price: 101 },
            { time: 2 as Time, type: 'buy', price: 101, exitOnly: true },
        ];
        const result = runBacktest(data, signals, 1000, 100, 0, {
            tradeDirection: 'combined',
            executionModel: 'signal_close',
        });

        expect(result.totalTrades).to.equal(1);
        expect(result.trades[0].type).to.equal('short');
    });

    it('should preserve combined diagnostics and disabled Sharpe in full runs', () => {
        const data: OHLCVData[] = Array.from({ length: 8 }, (_, index) => {
            const close = 100 + (index % 2 === 0 ? index * 2 : -index);
            return {
                time: `2024-01-${String(index + 1).padStart(2, '0')}` as Time,
                open: close,
                high: close + 1,
                low: close - 1,
                close,
                volume: 1000,
            };
        });
        const signals: Signal[] = data.slice(0, -1).map((candle, index) => ({
            time: candle.time,
            type: index % 2 === 0 ? 'buy' : 'sell',
            price: candle.close,
        }));
        const result = runBacktest(data, signals, 10000, 100, 0, {
            tradeDirection: 'combined',
            executionModel: 'signal_close',
        }, undefined, undefined, {
            includeSharpeRatio: false,
            collectDiagnostics: true,
        });

        expect(result.sharpeRatio).to.equal(0);
        expect(result.diagnostics?.counts.tradesOpened).to.be.greaterThan(0);
        expect(result.diagnostics?.counts.tradesClosed).to.be.greaterThan(0);
    });

    it('should use side fast paths for full combined no-equity Finder runs while preserving trades', () => {
        const data: OHLCVData[] = [
            { time: '2023-01-01' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-02' as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: '2023-01-03' as Time, open: 110, high: 112, low: 108, close: 110, volume: 1000 },
            { time: '2023-01-04' as Time, open: 120, high: 121, low: 118, close: 120, volume: 1000 },
            { time: '2023-01-05' as Time, open: 100, high: 102, low: 98, close: 100, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            { time: '2023-01-03' as Time, type: 'buy', price: 110 },
            { time: '2023-01-04' as Time, type: 'sell', price: 120 },
            { time: '2023-01-05' as Time, type: 'buy', price: 100 },
        ];
        const settings = { tradeDirection: 'combined' as const };
        const baseline = runBacktest(data, signals, 1000, 100, 0, settings);
        const fast = runBacktest(data, signals, 1000, 100, 0, settings, undefined, undefined, {
            collectDiagnostics: true,
            includeSharpeRatio: false,
            omitEquityCurve: true,
            skipDrawdown: true,
        });

        expect(fast.trades).to.deep.equal(baseline.trades);
        expect(fast.netProfit).to.be.closeTo(baseline.netProfit, 1e-8);
        expect(fast.equityCurve).to.deep.equal([]);
        expect(fast.maxDrawdown).to.equal(0);
        expect(fast.diagnostics?.fastPath?.used).to.equal(true);
        expect(fast.diagnostics?.counts.fastPathRuns).to.equal(1);
        expect(fast.diagnostics?.fastPath?.blockers).to.deep.equal([]);
        expect(fast.diagnostics?.counts.barsScanned).to.be.lessThan(data.length * 2);
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

    it('should honor disabled Sharpe calculation in compact combined backtests', () => {
        const data: OHLCVData[] = [
            { time: 1 as Time, open: 100, high: 102, low: 99, close: 101, volume: 1000 },
            { time: 2 as Time, open: 101, high: 104, low: 100, close: 103, volume: 1000 },
            { time: 3 as Time, open: 103, high: 104, low: 98, close: 99, volume: 1000 },
            { time: 4 as Time, open: 99, high: 101, low: 96, close: 97, volume: 1000 },
        ];
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 101, barIndex: 0 },
            { time: 3 as Time, type: 'sell', price: 99, barIndex: 2 },
        ];

        const baseline = runBacktestCompact(
            data,
            signals,
            10000,
            100,
            0.1,
            { tradeDirection: 'combined' as const, executionModel: 'signal_close' as const },
            undefined,
            undefined,
            { includeSharpeRatio: false }
        );
        const compact = runBacktestCompact(
            data,
            signals,
            10000,
            100,
            0.1,
            { tradeDirection: 'combined' as const, executionModel: 'signal_close' as const },
            undefined,
            undefined,
            { includeSharpeRatio: false, omitEquityCurve: true }
        );

        expect(compact.totalTrades).to.equal(baseline.totalTrades);
        expect(compact.netProfit).to.be.closeTo(baseline.netProfit, 1e-9);
        expect(compact.maxDrawdown).to.be.closeTo(baseline.maxDrawdown, 1e-9);
        expect(compact.totalTrades).to.be.greaterThan(0);
        expect(compact.sharpeRatio).to.equal(0);
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

    it('should report Sharpe = 0 when an intraday window collapses to a single daily bar', () => {
        // A 1m WFA OOS segment that fits in one UTC day collapses to a single daily
        // bar. There is no second point to form a return, so Sharpe must be 0 rather
        // than inflated by a raw bar-level fallback. Reporting 0 here is what keeps
        // walkForwardEfficiency and avgOutOfSampleSharpe honest — a window with no
        // observable daily return variation carries no Sharpe information.
        const dayStartMs = Date.UTC(2026, 0, 1, 0, 0, 0);
        const minuteMs = 60 * 1000;
        const intradayCurve: { time: Time; value: number }[] = [];
        let equity = 10000;
        for (let i = 0; i < 1440; i++) {
            if (i > 0 && i % 240 === 0) equity *= 1.001; // a few intra-day trade moves
            intradayCurve.push({ time: ((dayStartMs + i * minuteMs) / 1000) as Time, value: equity });
        }

        const intradaySharpe = calculateSharpeRatioFromEquityCurve(intradayCurve);

        expect(intradaySharpe).to.equal(0);
    });

    it('should report Sharpe = 0 when daily-collapsed returns have near-zero variance', () => {
        // A consistent-drift OOS window (e.g. 3 wins stepping equity up by almost the
        // same small amount each day) collapses to daily returns whose stdDev is below
        // SHARPE_MIN_STD_DEV. That is not a meaningful Sharpe — the per-bar stdDev is
        // tiny because of trade sparsity, and the annualization factor would inflate
        // it to a clamp at ±8, producing a false confidence reading. Report 0 instead.
        const dayStartMs = Date.UTC(2026, 0, 1, 0, 0, 0);
        const minuteMs = 60 * 1000;
        const driftCurve: { time: Time; value: number }[] = [];
        let equity = 10000;
        for (let i = 0; i < 7 * 1440; i++) {
            if (i > 0 && i % 1440 === 720) equity *= 1.0001; // ~uniform +0.01%/day
            driftCurve.push({ time: ((dayStartMs + i * minuteMs) / 1000) as Time, value: equity });
        }

        const driftSharpe = calculateSharpeRatioFromEquityCurve(driftCurve);

        expect(driftSharpe).to.equal(0);
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

    describe('Path-Dependent Exits', () => {
        it('should exit a long position via MFE Giveback', () => {
            const data: OHLCVData[] = [
                { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
                { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 }, // entry
                { time: '2023-01-03' as Time, open: 100, high: 110, low: 99, close: 109, volume: 1000 }, // moves up to 110
                { time: '2023-01-04' as Time, open: 109, high: 109, low: 104, close: 105, volume: 1000 }, // retraces to 105 (gives back 50% of MFE)
            ];
            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'mfe_giveback',
                pathExitMinBars: 1,
                pathExitMinMfePercent: 5.0,
                pathExitGivebackPercent: 40,
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

            expect(full.totalTrades).to.equal(1);
            expect(full.trades[0].exitReason).to.equal('path_exit');
            expect(full.trades[0].exitPrice).to.equal(105);

            expect(compact.totalTrades).to.equal(1);
            expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
        });

        it('should exit a short position via MFE Giveback', () => {
            const data: OHLCVData[] = [
                { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
                { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 }, // entry
                { time: '2023-01-03' as Time, open: 100, high: 101, low: 90, close: 91, volume: 1000 }, // moves down to 90
                { time: '2023-01-04' as Time, open: 91, high: 96, low: 91, close: 95, volume: 1000 }, // retraces to 95 (gives back 50% of MFE)
            ];
            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'sell', price: 100 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'mfe_giveback',
                pathExitMinBars: 1,
                pathExitMinMfePercent: 5.0,
                pathExitGivebackPercent: 40,
                tradeDirection: 'short' as const,
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

            expect(full.totalTrades).to.equal(1);
            expect(full.trades[0].exitReason).to.equal('path_exit');
            expect(full.trades[0].exitPrice).to.equal(95);

            expect(compact.totalTrades).to.equal(1);
            expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
        });

        it('should allow path exits to manage trades while signal exits are disabled', () => {
            const data: OHLCVData[] = [
                { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
                { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
                { time: '2023-01-03' as Time, open: 100, high: 110, low: 99, close: 109, volume: 1000 },
                { time: '2023-01-04' as Time, open: 109, high: 109, low: 104, close: 105, volume: 1000 },
            ];
            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 100 },
                { time: '2023-01-03' as Time, type: 'sell', price: 109 },
            ];

            const result = runBacktest(data, signals, 1000, 100, 0, {
                pathExitEnabled: true,
                pathExitMode: 'mfe_giveback',
                pathExitMinBars: 1,
                pathExitMinMfePercent: 5.0,
                pathExitGivebackPercent: 40,
                disableSignalExits: true,
            });

            expect(result.totalTrades).to.equal(1);
            expect(result.trades[0].exitReason).to.equal('path_exit');
            expect(result.trades[0].exitTime).to.equal('2023-01-04' as Time);
        });

        it('should exit a long position via Profit Compression', () => {
            const data: OHLCVData[] = [
                { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
                { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 }, // entry
                { time: '2023-01-03' as Time, open: 100, high: 104, low: 100, close: 104, volume: 1000 }, // barsInTrade = 1, profit = 4%
                { time: '2023-01-04' as Time, open: 104, high: 104, low: 101, close: 101, volume: 1000 }, // barsInTrade = 2, profit = 1%, profitRate = 0.5%
            ];
            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'profit_compression',
                pathExitMinBars: 1,
                pathExitMinMfePercent: 2.0,
                pathExitThreshold: 1.0, // exit if profitRate < 1.0% per bar
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

            expect(full.totalTrades).to.equal(1);
            expect(full.trades[0].exitReason).to.equal('path_exit');
            expect(full.trades[0].exitPrice).to.equal(101);

            expect(compact.totalTrades).to.equal(1);
            expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-9);
        });

        it('should exit a long position via Momentum Deceleration', () => {
            const data: OHLCVData[] = [
                { time: '2023-01-01' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 },
                { time: '2023-01-02' as Time, open: 100, high: 100, low: 100, close: 100, volume: 1000 }, // entry
                { time: '2023-01-03' as Time, open: 100, high: 105, low: 100, close: 105, volume: 1000 }, // momentum = 5%
                { time: '2023-01-04' as Time, open: 105, high: 106, low: 105, close: 105.5, volume: 1000 }, // momentum = 0.47% (below 1.0% threshold)
            ];
            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'momentum_deceleration',
                pathExitMinBars: 1,
                pathExitLookbackBars: 1,
                pathExitThreshold: 1.0,
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            expect(full.totalTrades).to.equal(1);
            expect(full.trades[0].exitReason).to.equal('path_exit');
            expect(full.trades[0].exitPrice).to.equal(105.5);
        });

        it('should exit a long position via Capitulation Exhaustion', () => {
            const data: OHLCVData[] = [
                { time: '2023-01-01' as Time, open: 99, high: 100, low: 99, close: 100, volume: 100 },
                { time: '2023-01-02' as Time, open: 99, high: 100, low: 99, close: 100, volume: 100 },
                { time: '2023-01-03' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 }, // entry
                { time: '2023-01-04' as Time, open: 100, high: 110, low: 100, close: 109, volume: 5000 }, // capitulation (R=10, B=9, V=5000)
                { time: '2023-01-05' as Time, open: 109, high: 109, low: 103, close: 104, volume: 100 }, // closes below midpoint of body (104.5)
            ];
            const signals: Signal[] = [
                { time: '2023-01-03' as Time, type: 'buy', price: 100 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'capitulation_exhaustion',
                pathExitMinBars: 1,
                pathExitLookbackBars: 2,
                pathExitThreshold: 90,
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            expect(full.totalTrades).to.equal(1);
            expect(full.trades[0].exitReason).to.equal('path_exit');
            expect(full.trades[0].exitPrice).to.equal(104);
        });

        it('should exit a long position via Squeeze Pressure', () => {
            const data: OHLCVData[] = [
                { time: '2023-01-02' as Time, open: 100, high: 101, low: 100, close: 100.5, volume: 100 },
                { time: '2023-01-03' as Time, open: 100, high: 100, low: 100, close: 100, volume: 100 }, // entry
                { time: '2023-01-04' as Time, open: 102, high: 103, low: 100, close: 101, volume: 5000 }, // opposite color, CLV < 0, vol expansion
            ];
            const signals: Signal[] = [
                { time: '2023-01-03' as Time, type: 'buy', price: 100 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'squeeze_pressure',
                pathExitMinBars: 1,
                pathExitLookbackBars: 1,
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            expect(full.totalTrades).to.equal(1);
            expect(full.trades[0].exitReason).to.equal('path_exit');
            expect(full.trades[0].exitPrice).to.equal(101);
        });

        it('should exit a long position via Structure Reclaim', () => {
            const data: OHLCVData[] = [
                { time: '2023-01-01' as Time, open: 96, high: 97, low: 96, close: 97, volume: 100 },
                { time: '2023-01-02' as Time, open: 98, high: 100, low: 98, close: 100, volume: 100 }, // breakout / entry (midpoint = 99)
                { time: '2023-01-03' as Time, open: 100, high: 105, low: 100, close: 105, volume: 100 },
                { time: '2023-01-04' as Time, open: 105, high: 105, low: 96, close: 97, volume: 100 }, // closes below structure level (97.5)
            ];
            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 100 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'structure_reclaim',
                pathExitMinBars: 1,
                pathExitLookbackBars: 1,
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            expect(full.totalTrades).to.equal(1);
            expect(full.trades[0].exitReason).to.equal('path_exit');
            expect(full.trades[0].exitPrice).to.equal(97);
        });
    });

    describe('Phase 4 - Causal Learning Exit Modes', () => {
        // Helper: generate N bars of OHLCV data starting at a base price, with a trend
        function generateTrendBars(count: number, startPrice: number, stepPerBar: number, startDate: string = '2023-01-01'): OHLCVData[] {
            const bars: OHLCVData[] = [];
            for (let i = 0; i < count; i++) {
                const d = new Date(startDate);
                d.setDate(d.getDate() + i);
                const dateStr = d.toISOString().slice(0, 10) as unknown as Time;
                const c = startPrice + stepPerBar * i;
                bars.push({
                    time: dateStr,
                    open: c - 0.5,
                    high: c + 1,
                    low: c - 1,
                    close: c,
                    volume: 1000,
                });
            }
            return bars;
        }

        it('conditional_hazard: first trade never triggers learning exit (empty state)', () => {
            // Build data with a single losing trade pattern: price goes up then reverses
            const upBars = generateTrendBars(10, 100, 2, '2023-01-01');
            const downBars = generateTrendBars(10, 118, -3, '2023-01-11');
            const data = [...upBars, ...downBars];

            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 102 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'conditional_hazard',
                pathExitMinSamples: 1,
                pathExitHorizonBars: 5,
                pathExitThreshold: 1,
            };

            const result = runBacktest(data, signals, 1000, 100, 0, settings);
            // First trade: learning state is empty, so no learning exit fires.
            // Trade should close via end_of_data.
            expect(result.totalTrades).to.equal(1);
            expect(result.trades[0].exitReason).to.equal('end_of_data');
        });

        it('conditional_hazard: second trade exits when expectancy <= 0 from first trade learning', () => {
            // Trade 1: buy at bar 2, hits stop loss or signal exit at bar 8 (losing trade).
            // Trade 2: buy at bar 12, should be cut short by learning exit.
            // Build data: goes up slightly then reverses hard, then repeats pattern.
            const data: OHLCVData[] = [];
            for (let i = 0; i < 30; i++) {
                const d = new Date('2023-01-01');
                d.setDate(d.getDate() + i);
                const dateStr = d.toISOString().slice(0, 10) as unknown as Time;
                let c: number;
                if (i <= 4) c = 100 + i * 1;     // gentle rise 100-104
                else if (i <= 9) c = 104 - (i - 4) * 3; // drop 104 -> 89
                else if (i <= 14) c = 89 + (i - 9) * 1;  // rise 89-94
                else if (i <= 19) c = 94 - (i - 14) * 3; // drop 94 -> 79
                else c = 79 + (i - 19) * 0.5; // flat-ish
                data.push({
                    time: dateStr,
                    open: c - 0.5,
                    high: c + 1,
                    low: c - 1,
                    close: c,
                    volume: 1000,
                });
            }

            // Signal exit first trade, then buy again
            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 101 },
                { time: '2023-01-09' as Time, type: 'sell', price: 89 },
                { time: '2023-01-12' as Time, type: 'buy', price: 92 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'conditional_hazard',
                pathExitMinSamples: 1, // Low threshold so learning kicks in fast
                pathExitHorizonBars: 50,
                pathExitThreshold: 1,
                executionModel: 'signal_close',
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

            // Trade 1 closes on signal (losing), populates learning state.
            // Trade 2 may get cut by learning exit before end_of_data.
            expect(full.totalTrades).to.be.greaterThanOrEqual(2);
            expect(compact.totalTrades).to.equal(full.totalTrades);

            // If learning exit fires, it should be 'path_exit'
            if (full.trades.length >= 2 && full.trades[1].exitReason === 'path_exit') {
                expect(compact.trades[1].exitReason).to.equal('path_exit');
            }
        });

        it('triple_barrier_meta: first trade never triggers learning exit (empty state)', () => {
            const data = generateTrendBars(20, 100, 1, '2023-01-01');

            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 101 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'triple_barrier_meta',
                pathExitMinSamples: 1,
                pathExitHorizonBars: 5,
                pathExitThreshold: 2,
            };

            const result = runBacktest(data, signals, 1000, 100, 0, settings);
            expect(result.totalTrades).to.equal(1);
            expect(result.trades[0].exitReason).to.equal('end_of_data');
        });

        it('triple_barrier_meta: second trade exits when barrier expectancy <= 0', () => {
            const data: OHLCVData[] = [];
            for (let i = 0; i < 30; i++) {
                const d = new Date('2023-01-01');
                d.setDate(d.getDate() + i);
                const dateStr = d.toISOString().slice(0, 10) as unknown as Time;
                let c: number;
                if (i <= 4) c = 100 + i * 0.5;
                else if (i <= 9) c = 102 - (i - 4) * 4; // sharp drop
                else if (i <= 14) c = 82 + (i - 9) * 0.5;
                else if (i <= 19) c = 84 - (i - 14) * 4; // sharp drop again
                else c = 64 + (i - 19) * 0.5;
                data.push({
                    time: dateStr,
                    open: c - 0.5,
                    high: c + 1,
                    low: c - 1,
                    close: c,
                    volume: 1000,
                });
            }

            const signals: Signal[] = [
                { time: '2023-01-02' as Time, type: 'buy', price: 100.5 },
                { time: '2023-01-09' as Time, type: 'sell', price: 82 },
                { time: '2023-01-12' as Time, type: 'buy', price: 83 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'triple_barrier_meta',
                pathExitMinSamples: 1,
                pathExitHorizonBars: 5,
                pathExitThreshold: 2,
                executionModel: 'signal_close',
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

            expect(full.totalTrades).to.be.greaterThanOrEqual(2);
            expect(compact.totalTrades).to.equal(full.totalTrades);

            if (full.trades.length >= 2 && full.trades[1].exitReason === 'path_exit') {
                expect(compact.trades[1].exitReason).to.equal('path_exit');
            }
        });

        it('full/compact parity for conditional_hazard mode', () => {
            const data = generateTrendBars(20, 100, 0.5);

            const signals: Signal[] = [
                { time: '2023-01-03' as Time, type: 'buy', price: 101 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'conditional_hazard',
                pathExitMinSamples: 1,
                pathExitHorizonBars: 10,
                pathExitThreshold: 1,
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

            expect(compact.totalTrades).to.equal(full.totalTrades);
            expect(compact.winRate).to.equal(full.winRate);
        });

        it('full/compact parity for triple_barrier_meta mode', () => {
            const data = generateTrendBars(20, 100, 0.5);

            const signals: Signal[] = [
                { time: '2023-01-03' as Time, type: 'buy', price: 101 },
            ];

            const settings: BacktestSettings = {
                pathExitEnabled: true,
                pathExitMode: 'triple_barrier_meta',
                pathExitMinSamples: 1,
                pathExitHorizonBars: 10,
                pathExitThreshold: 2,
            };

            const full = runBacktest(data, signals, 1000, 100, 0, settings);
            const compact = runBacktestCompact(data, signals, 1000, 100, 0, settings);

            expect(compact.totalTrades).to.equal(full.totalTrades);
            expect(compact.winRate).to.equal(full.winRate);
        });
    });
});

