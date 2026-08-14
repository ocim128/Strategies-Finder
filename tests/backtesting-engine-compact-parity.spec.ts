import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Signal, Time } from '../lib/strategies/index';
import { runBacktest, runBacktestCompact } from '../lib/strategies/index';

// Compact vs full parity tests. The two engine paths deliberately diverge on
// what they materialize (compact tracks aggregate metrics; full builds Trade[]
// and {time,value}[] equity). The arithmetic that drives entries/exits must
// agree, otherwise the same strategy reports different metrics depending on
// which entrypoint the caller picked. These tests encode the WHY: protect the
// invariants that the recent openedBarIndex refactor touches (same-bar entry
// detection, next_open exit gating, signal-exit re-entry) across execution
// models and direction modes.

function makeData(count: number, start = 100, drift = 0.5): OHLCVData[] {
    const data: OHLCVData[] = [];
    let price = start;
    for (let i = 0; i < count; i++) {
        // Alternating up/down candles with a slight upward drift so longs and
        // shorts both have winning and losing trades in the same dataset.
        const up = i % 2 === 0;
        const open = price;
        const close = price + (up ? 2 : -1.5) + drift * 0.1;
        const high = Math.max(open, close) + 0.5;
        const low = Math.min(open, close) - 0.5;
        data.push({
            time: (1000 + i * 60) as Time,
            open,
            high,
            low,
            close,
            volume: 1000 + (i % 5) * 100,
        });
        price = close;
    }
    return data;
}

function buyEveryNSignal(data: OHLCVData[], everyN: number): Signal[] {
    const signals: Signal[] = [];
    for (let i = 0; i < data.length; i += everyN) {
        signals.push({ time: data[i].time, type: 'buy', price: data[i].close });
    }
    return signals;
}

function alternatingSignals(data: OHLCVData[], everyN: number): Signal[] {
    const signals: Signal[] = [];
    let buyNext = true;
    for (let i = 0; i < data.length; i += everyN) {
        signals.push({
            time: data[i].time,
            type: buyNext ? 'buy' : 'sell',
            price: data[i].close,
        });
        buyNext = !buyNext;
    }
    return signals;
}

const METRIC_KEYS = [
    'totalTrades',
    'winningTrades',
    'losingTrades',
    'netProfit',
    'winRate',
    'avgWin',
    'avgLoss',
    'profitFactor',
    'maxDrawdown',
    'maxDrawdownPercent',
    'sharpeRatio',
] as const;

type MetricKey = (typeof METRIC_KEYS)[number];

function assertMetricsParity(
    fullResult: ReturnType<typeof runBacktest>,
    compactResult: ReturnType<typeof runBacktestCompact>,
    tolerances: Partial<Record<MetricKey, number>> = {},
) {
    for (const key of METRIC_KEYS) {
        const fullValue = fullResult[key] as number;
        const compactValue = compactResult[key] as number;
        const tolerance = tolerances[key] ?? 1e-9;
        // to.be.closeTo requires finite values; Infinity-safe compare first.
        if (!Number.isFinite(fullValue) || !Number.isFinite(compactValue)) {
            expect(Number.isFinite(fullValue)).to.equal(
                Number.isFinite(compactValue),
                `${key}: finite-ness mismatch (full=${fullValue}, compact=${compactValue})`,
            );
            continue;
        }
        expect(compactValue, `compact vs full parity on ${key}`).to.be.closeTo(fullValue, tolerance);
    }
}

describe('Backtesting Engine - compact vs full parity', () => {
    it('matches across next_open execution model with stop loss', () => {
        const data = makeData(60);
        const signals = buyEveryNSignal(data, 5);
        const settings = {
            executionModel: 'next_open' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 2,
            takeProfitEnabled: true,
            takeProfitPercent: 4,
            maxOpenTrades: 1,
        };

        const full = runBacktest(data, signals, 10000, 100, 0.1, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0.1, settings);
        assertMetricsParity(full, compact, { netProfit: 1e-6 });
    });

    it('matches with signal exits and re-entry cooldown in next_open', () => {
        const data = makeData(40);
        const signals = alternatingSignals(data, 4);
        const settings = {
            executionModel: 'next_open' as const,
            maxOpenTrades: 1,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings);
        assertMetricsParity(full, compact, { netProfit: 1e-6 });
    });

    it('matches with both direction and opposite-signal exits', () => {
        const data = makeData(40);
        const signals = alternatingSignals(data, 3);
        const settings = { tradeDirection: 'both' as const };

        const full = runBacktest(data, signals, 10000, 100, 0.1, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0.1, settings);
        assertMetricsParity(full, compact, { netProfit: 1e-6 });
    });

    it('matches with signal_close and sparse signals (no bars-with-position gap behavior)', () => {
        const data = makeData(80);
        // Sparse signals to exercise the omitEquityCurve fast-forward path.
        const signals = buyEveryNSignal(data, 20);
        const settings = {
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: true,
            takeProfitPercent: 10,
            maxOpenTrades: 1,
        };

        const full = runBacktest(data, signals, 10000, 100, 0.05, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0.05, settings);
        assertMetricsParity(full, compact, { netProfit: 1e-6 });
    });

    it('matches with unlimited overlap and ATR exits', () => {
        const data = makeData(50);
        const signals = buyEveryNSignal(data, 3);
        const settings = {
            executionModel: 'signal_close' as const,
            atrPeriod: 5,
            stopLossAtr: 1.5,
            takeProfitAtr: 3,
            maxOpenTrades: 2,
        };

        const full = runBacktest(data, signals, 10000, 50, 0.05, settings);
        const compact = runBacktestCompact(data, signals, 10000, 50, 0.05, settings);
        assertMetricsParity(full, compact, { netProfit: 1e-6 });
    });

    it('matches with omitEquityCurve and skipDrawdown (finder-style run)', () => {
        const data = makeData(40);
        const signals = buyEveryNSignal(data, 5);
        const settings = {
            executionModel: 'signal_close' as const,
            maxOpenTrades: 1,
        };
        const options = { omitEquityCurve: true, skipDrawdown: true, includeSharpeRatio: false };

        const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, options);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined, options);
        // With drawdown skipped both engines report 0 for drawdown metrics.
        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-6);
        expect(compact.winningTrades).to.equal(full.winningTrades);
    });

    it('preserves scalar Sharpe while using the Finder fast path without returning an equity curve', () => {
        const data = makeData(72);
        for (let index = 0; index < data.length; index += 1) {
            data[index].time = (1700000000 + index * 4 * 60 * 60) as Time;
        }
        const signals = alternatingSignals(data, 6);
        for (let index = 0; index < signals.length; index += 1) {
            signals[index].barIndex = index * 6;
        }
        const settings = {
            executionModel: 'next_open' as const,
            tradeDirection: 'both' as const,
            maxOpenTrades: 1,
        };

        const full = runBacktest(data, signals, 10000, 100, 0.1, settings);
        const compact = runBacktestCompact(
            data,
            signals,
            10000,
            100,
            0.1,
            settings,
            undefined,
            undefined,
            {
                includeAdvancedAnalytics: false,
                includeSharpeRatio: true,
                omitEquityCurve: true,
                skipDrawdown: true,
                collectDiagnostics: true,
            }
        );

        expect(compact.totalTrades).to.equal(full.totalTrades);
        expect(compact.netProfit).to.be.closeTo(full.netProfit, 1e-6);
        expect(compact.sharpeRatio).to.be.closeTo(full.sharpeRatio, 1e-9);
        expect(compact.equityCurve).to.deep.equal([]);
        expect(compact.trades).to.deep.equal([]);
        expect(compact.maxDrawdownPercent).to.equal(0);
        expect(compact.diagnostics?.fastPath?.used).to.equal(true);
        expect(compact.diagnostics?.fastPath?.signalPreparation).to.equal("indexed");
        expect(compact.diagnostics?.counts.fastPathRuns).to.equal(1);
    });

    it('matches with flip-loss direction (same-bar entry detection across re-entries)', () => {
        const data = makeData(40);
        const signals = alternatingSignals(data, 3);
        const settings = {
            tradeDirection: 'both_flip_loss_2' as const,
            flipAfterConsecutiveLosses: 2,
            flipCooldownTrades: 1,
            maxOpenTrades: 1,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings);
        assertMetricsParity(full, compact, { netProfit: 1e-6 });
    });

    it('matches with path-dependent exits (MFE Giveback and Profit Compression)', () => {
        const data = makeData(100);
        const signals = buyEveryNSignal(data, 10);
        const settings = {
            pathExitEnabled: true,
            pathExitMode: 'mfe_giveback' as const,
            pathExitMinBars: 2,
            pathExitMinMfePercent: 1.0,
            pathExitGivebackPercent: 20,
            maxOpenTrades: 1,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings);
        assertMetricsParity(full, compact, { netProfit: 1e-6 });
    });

    it('matches when conditional hazard learning exits a later trade', () => {
        const data: OHLCVData[] = Array.from({ length: 19 }, (_, idx) => {
            const time = (idx + 1) as Time;
            const close = idx === 10 ? 90 : idx === 18 ? 80 : 100;
            return { time, open: close, high: close, low: close, close, volume: 1000 };
        });
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 11 as Time, type: 'sell', price: 90 },
            { time: 12 as Time, type: 'buy', price: 100 },
        ];
        const settings = {
            executionModel: 'signal_close' as const,
            pathExitEnabled: true,
            pathExitMode: 'conditional_hazard' as const,
            pathExitMinBars: 1,
            pathExitMinSamples: 5,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings);

        expect(full.trades[1]?.exitReason).to.equal('path_exit');
        assertMetricsParity(full, compact, { netProfit: 1e-6 });
    });
});
