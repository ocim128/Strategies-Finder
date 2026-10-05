import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Signal, Time } from '../lib/strategies/index';
import { MAX_OPEN_TRADES_UNLIMITED, runBacktest, runBacktestCompact } from '../lib/strategies/index';
import { buildSelectionResult } from '../lib/finder/endpoint';

describe('Finder endpoint selection across daily entry-filter paths', () => {
    for (const executionModel of ['signal_close', 'next_open', 'next_close'] as const) {
        for (const tradeDirection of ['long', 'short', 'both'] as const) {
            it(`excludes terminal gains without trade history for ${tradeDirection}/${executionModel}`, () => {
                const data = makeData(12).map((bar, index) => ({ ...bar, time: (1700000000 + index * 86400) as Time }));
                const signals: Signal[] = [0, 3, 6].map((index, order) => ({
                    time: data[index].time,
                    type: (order === 1) === (tradeDirection !== 'short') ? 'sell' : 'buy',
                    price: data[index].close,
                }));
                const lastDataTime = data[data.length - 1].time;
                const settings = { executionModel, tradeDirection, entryTimeFilter: 'day_close' as const };
                const full = runBacktest(data, signals, 10000, 100, 0, settings);
                const expected = buildSelectionResult(full, lastDataTime, 10000);
                expect(expected.removedTrades).to.be.greaterThan(0);
                for (const entryTimeFilterEnabled of [false, true]) {
                    const result = runBacktestCompact(data, signals, 10000, 100, 0,
                        { ...settings, entryTimeFilterEnabled }, undefined, undefined, {
                            omitEquityCurve: true, includeSharpeRatio: false, requireTradeHistory: false,
                            endpointSelectionLastDataTime: lastDataTime, endpointSelectionInitialCapital: 10000,
                        });
                    expect(result.trades).to.deep.equal([]);
                    expect(result.endpointSelection?.removedTrades).to.equal(expected.removedTrades);
                    for (const key of ['netProfit', 'totalTrades', 'winningTrades', 'losingTrades', 'avgWin', 'avgLoss', 'expectancy', 'sharpeRatio'] as const) {
                        expect(result.endpointSelection!.result[key], key).to.be.closeTo(expected.result[key], 1e-9);
                    }
                }
            });
        }
    }
});

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

// ---------------------------------------------------------------------------
// Fallback characterization (pre-extraction baseline).
//
// The single-position Finder fast path only engages when the caller opts out
// of the returned equity curve (options.omitEquityCurve — scalar Sharpe
// stays supported) and passes every per-feature blocker; every other
// configuration takes the per-wrapper FALLBACK simulation. These tests are
// the semantic oracle for the shared fallback between runBacktest and
// runBacktestCompact: each case asserts diagnostics.fastPath.used === false,
// locks deterministic expected trades/scalars, and records the CURRENT
// wrapper differences (they characterize behavior; they do not endorse it):
//
//  - full always retains Trade objects; compact retains them only under
//    options.requireTradeHistory, and under retention the trade arrays are
//    deep-equal (ids, order, exit reasons, EOD liquidation included).
//  - full's fallback IGNORES options.skipDrawdown (the loop always tracks
//    peak/drawdown); compact zeroes the drawdown metrics under skipDrawdown.
//  - full builds an object equityCurve where fast-forwarded bars are absent;
//    compact fills its Float64Array equity across skipped ranges.
//  - compact's fallback supports endpoint exclusion via
//    options.endpointSelectionLastDataTime; full post-processes with
//    buildSelectionResult instead.
//  - compact skips ensureCleanData (caller contract); full drops null bars.
// ---------------------------------------------------------------------------

const FALLBACK_OPTIONS = { collectDiagnostics: true } as const;

/** Finder-style compact options that keep diagnostics and history control. */
const FINDER_FALLBACK_OPTIONS = {
    omitEquityCurve: true,
    includeSharpeRatio: false,
    requireTradeHistory: true,
    collectDiagnostics: true,
} as const;

function assertFallbackUsed(result: { diagnostics?: { fastPath?: { used: boolean } } }): void {
    expect(result.diagnostics?.fastPath?.used, 'expected the fallback simulation, not the fast path')
        .to.equal(false);
}

describe('Backtesting Engine - fallback characterization (full vs compact)', () => {
    it('runs the fallback for capped overlap and matches retained trades exactly', () => {
        const data = makeData(60);
        const signals = buyEveryNSignal(data, 4);
        const settings = {
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 3,
            takeProfitEnabled: true,
            takeProfitPercent: 6,
            maxOpenTrades: 2,
        };

        const full = runBacktest(data, signals, 10000, 100, 0.1, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
        const compact = runBacktestCompact(data, signals, 10000, 100, 0.1, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

        assertFallbackUsed(full);
        assertFallbackUsed(compact);
        expect(full.totalTrades, 'overlap must actually open overlapping positions').to.be.greaterThan(0);
        assertMetricsParity(full, compact, { netProfit: 1e-6, sharpeRatio: 1e-9 });
        expect(compact.trades).to.deep.equal(full.trades);
    });

    it(`runs the fallback for unlimited overlap (${MAX_OPEN_TRADES_UNLIMITED}+) and matches retained trades exactly`, () => {
        const data = makeData(50);
        const signals = buyEveryNSignal(data, 3);
        const settings = {
            executionModel: 'signal_close' as const,
            atrPeriod: 5,
            stopLossAtr: 1.5,
            takeProfitAtr: 3,
            maxOpenTrades: MAX_OPEN_TRADES_UNLIMITED,
        };

        const full = runBacktest(data, signals, 10000, 50, 0.05, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
        const compact = runBacktestCompact(data, signals, 10000, 50, 0.05, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

        assertFallbackUsed(full);
        assertFallbackUsed(compact);
        expect(full.totalTrades).to.be.greaterThan(0);
        assertMetricsParity(full, compact, { netProfit: 1e-6, sharpeRatio: 1e-9 });
        expect(compact.trades).to.deep.equal(full.trades);
    });

    it('runs the fallback for trailing ATR exits and matches retained trades exactly', () => {
        // Rally then reversal: the trail follows the extreme up, then the
        // pullback crosses it, producing trailing_stop exits.
        const data: OHLCVData[] = [];
        let price = 100;
        for (let i = 0; i < 60; i += 1) {
            const close = price + (i < 40 ? 2 : -3);
            data.push({
                time: (1000 + i * 60) as Time,
                open: price,
                high: Math.max(price, close) + 0.5,
                low: Math.min(price, close) - 0.5,
                close,
                volume: 1000,
            });
            price = close;
        }
        const signals = buyEveryNSignal(data, 8);
        const settings = {
            executionModel: 'signal_close' as const,
            atrPeriod: 5,
            trailingAtr: 1,
            maxOpenTrades: 1,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

        assertFallbackUsed(full);
        assertFallbackUsed(compact);
        // The ATR trailing mechanism moves stopLossPrice; the exit itself is
        // reported with the stop_loss reason (documented current behavior).
        expect(full.trades.some((trade) => trade.exitReason === 'stop_loss'), 'trailing stop exits must occur')
            .to.equal(true);
        expect(full.trades.every((trade) => trade.stopLossPrice !== null), 'trail sets a stop price').to.equal(true);
        assertMetricsParity(full, compact, { netProfit: 1e-6, sharpeRatio: 1e-9 });
        expect(compact.trades).to.deep.equal(full.trades);
    });

    it('runs the fallback for adaptive take-profit and matches retained trades exactly', () => {
        const data = makeData(60);
        const signals = buyEveryNSignal(data, 5);
        const settings = {
            executionModel: 'signal_close' as const,
            riskMode: 'percentage' as const,
            takeProfitEnabled: true,
            takeProfitPercent: 5,
            takeProfitMode: 'mfe_bootstrap' as const,
            maxOpenTrades: 1,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

        assertFallbackUsed(full);
        assertFallbackUsed(compact);
        expect(full.totalTrades).to.be.greaterThan(0);
        assertMetricsParity(full, compact, { netProfit: 1e-6, sharpeRatio: 1e-9 });
        expect(compact.trades).to.deep.equal(full.trades);
    });

    it('matches the full entry-time filter through the compact fast path', () => {
        const data = makeData(60).map((bar, index) => ({ ...bar, time: (1700000000 + index * 3600) as Time }));
        const signals = buyEveryNSignal(data, 5);
        const settings = {
            executionModel: 'signal_close' as const,
            maxOpenTrades: 1,
            entryTimeFilterEnabled: true,
            entryTimeFilter: 'day_close' as const,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

        assertFallbackUsed(full);
        expect(compact.diagnostics?.fastPath?.used).to.equal(true);
        expect(full.totalTrades).to.be.greaterThan(0);
        assertMetricsParity(full, compact, { netProfit: 1e-6, sharpeRatio: 1e-9 });
        expect(compact.trades).to.deep.equal(full.trades);
    });

    it('runs the fallback for partial signal exits (sizeFraction) and matches retained trades exactly', () => {
        const data = makeData(60);
        const signals: Signal[] = [];
        for (let i = 0; i < data.length - 6; i += 6) {
            signals.push({ time: data[i]!.time, type: 'buy', price: data[i]!.close });
            // Partial exit: half the position on the next signal bar.
            signals.push({ time: data[i + 3]!.time, type: 'sell', price: data[i + 3]!.close, sizeFraction: 0.5 });
        }
        const settings = {
            executionModel: 'signal_close' as const,
            tradeDirection: 'both' as const,
            maxOpenTrades: 2,
        };

        const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

        assertFallbackUsed(full);
        assertFallbackUsed(compact);
        expect(full.trades.some((trade) => trade.size < full.trades[0]!.size), 'partial exits must occur')
            .to.equal(true);
        assertMetricsParity(full, compact, { netProfit: 1e-6, sharpeRatio: 1e-9 });
        expect(compact.trades).to.deep.equal(full.trades);
    });

    for (const tradeDirection of ['long', 'short', 'both'] as const) {
        for (const executionModel of ['signal_close', 'next_open', 'next_close'] as const) {
            it(`runs the fallback across ${tradeDirection}/${executionModel} with flips and EOD liquidation`, () => {
                const data = makeData(48);
                const signals = alternatingSignals(data, 4);
                const settings = {
                    executionModel,
                    tradeDirection,
                    maxOpenTrades: 2,
                    riskMode: 'percentage' as const,
                    stopLossEnabled: true,
                    stopLossPercent: 4,
                };

                const full = runBacktest(data, signals, 10000, 100, 0.05, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
                const compact = runBacktestCompact(data, signals, 10000, 100, 0.05, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

                assertFallbackUsed(full);
                assertFallbackUsed(compact);
                expect(full.totalTrades).to.be.greaterThan(0);
                assertMetricsParity(full, compact, { netProfit: 1e-6, sharpeRatio: 1e-9 });
                expect(compact.trades).to.deep.equal(full.trades);
            });

            // A single never-closed entry must liquidate at the final close in
            // every execution model and direction.
            const entryType: Signal['type'] = tradeDirection === 'short' ? 'sell' : 'buy';
            const entryIndex = 5;
            it(`liquidates an open ${tradeDirection} position at the final close under ${executionModel}`, () => {
                const data = makeData(30);
                const signals: Signal[] = [
                    { time: data[entryIndex]!.time, type: entryType, price: data[entryIndex]!.close },
                ];
                const settings = { executionModel, tradeDirection, maxOpenTrades: 2 };

                const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
                const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

                assertFallbackUsed(full);
                assertFallbackUsed(compact);
                expect(full.trades).to.have.length(1);
                expect(full.trades[0]!.exitReason).to.equal('end_of_data');
                expect(full.trades[0]!.exitTime).to.equal(data[data.length - 1]!.time);
                expect(compact.trades).to.deep.equal(full.trades);
            });
        }
    }

    it('matches combined books in the fallback for capped and unlimited overlap', () => {
        const data = makeData(60);
        const signals = alternatingSignals(data, 4);
        for (const maxOpenTrades of [2, MAX_OPEN_TRADES_UNLIMITED]) {
            const settings = {
                executionModel: 'signal_close' as const,
                tradeDirection: 'combined' as const,
                maxOpenTrades,
            };

            const full = runBacktest(data, signals, 10000, 100, 0.05, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
            const compact = runBacktestCompact(data, signals, 10000, 100, 0.05, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

            // Combined delegates per side; with a blocked fast path the sides
            // run their fallbacks and the merged fastPath flag stays false.
            assertFallbackUsed(full);
            assertFallbackUsed(compact);
            expect(full.totalTrades).to.be.greaterThan(0);
            assertMetricsParity(full, compact, { netProfit: 1e-6, sharpeRatio: 1e-9 });
            expect(compact.trades).to.deep.equal(full.trades);
        }
    });

    it('liquidates an open position at the final close in both fallbacks', () => {
        const data = makeData(30);
        const signals: Signal[] = [{ time: data[5]!.time, type: 'buy', price: data[5]!.close }];
        const settings = { executionModel: 'signal_close' as const, maxOpenTrades: 2 };

        const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FINDER_FALLBACK_OPTIONS });

        assertFallbackUsed(full);
        assertFallbackUsed(compact);
        expect(full.trades).to.have.length(1);
        expect(full.trades[0]!.exitReason).to.equal('end_of_data');
        expect(full.trades[0]!.exitTime).to.equal(data[data.length - 1]!.time);
        expect(full.trades[0]!.exitPrice).to.equal(data[data.length - 1]!.close);
        expect(compact.trades).to.deep.equal(full.trades);
        // The forced close feeds the final capital into the reported metrics.
        expect(full.netProfit).to.be.closeTo(compact.netProfit, 1e-9);
        expect(full.diagnostics?.counts.forcedEndOfDataExits).to.equal(1);
        expect(compact.diagnostics?.counts.forcedEndOfDataExits).to.equal(1);
    });

    it('handles empty signal inputs identically in both entrypoints', () => {
        const data = makeData(20);
        const settings = { maxOpenTrades: 2 };

        const full = runBacktest(data, [], 10000, 100, 0, settings);
        const compact = runBacktestCompact(data, [], 10000, 100, 0, settings);

        expect(full.totalTrades).to.equal(0);
        expect(full.netProfit).to.equal(0);
        expect(full.trades).to.deep.equal([]);
        expect(full.equityCurve).to.deep.equal([]);
        expect(compact.totalTrades).to.equal(0);
        expect(compact.netProfit).to.equal(0);
        expect(compact.trades).to.deep.equal([]);
    });

    it('fills the caller Float64Array equity across fast-forwarded bars in the compact fallback', () => {
        const data = makeData(80);
        // Sparse signals force the omitEquityCurve bar-skip fast-forward.
        const signals = buyEveryNSignal(data, 25);
        const settings = { executionModel: 'signal_close' as const, maxOpenTrades: 2 };
        const equityOut = new Float64Array(data.length);

        const compact = runBacktestCompact(
            data, signals, 10000, 100, 0, settings, undefined, undefined,
            equityOut,
            { omitEquityCurve: true, includeSharpeRatio: false, requireTradeHistory: false, collectDiagnostics: true },
        );

        assertFallbackUsed(compact);
        let filled = 0;
        for (let i = 0; i < equityOut.length; i += 1) {
            if (equityOut[i] !== 0 || i === 0) filled += 1;
        }
        expect(filled, 'every bar must carry an equity value').to.equal(data.length);
        expect(equityOut[data.length - 1]).to.be.closeTo(10000 + compact.netProfit, 1e-9);

        // The full fallback's object equity curve records only scanned bars,
        // so sparse entries leave fast-forwarded bars absent (documented
        // wrapper difference).
        const full = runBacktest(
            data, signals, 10000, 100, 0, settings, undefined, undefined,
            { omitEquityCurve: true, includeSharpeRatio: false, collectDiagnostics: true },
        );
        assertFallbackUsed(full);
        expect(full.equityCurve.length).to.be.lessThan(data.length);
        expect(full.netProfit).to.be.closeTo(compact.netProfit, 1e-6);
    });

    it('excludes endpoint trades in the compact fallback via the endpoint accumulator', () => {
        const data = makeData(30);
        const signals: Signal[] = [{ time: data[5]!.time, type: 'buy', price: data[5]!.close }];
        const lastDataTime = data[data.length - 1]!.time;
        const settings = { executionModel: 'signal_close' as const, maxOpenTrades: 2 };

        const compact = runBacktestCompact(
            data, signals, 10000, 100, 0, settings, undefined, undefined,
            {
                omitEquityCurve: true,
                includeSharpeRatio: false,
                requireTradeHistory: false,
                collectDiagnostics: true,
                endpointSelectionLastDataTime: lastDataTime,
                endpointSelectionInitialCapital: 10000,
            },
        );

        assertFallbackUsed(compact);
        // The only trade is the EOD liquidation at the boundary: excluded.
        expect(compact.endpointSelection?.adjusted).to.equal(true);
        expect(compact.endpointSelection?.removedTrades).to.equal(1);
        expect(compact.endpointSelection?.result.totalTrades).to.equal(0);
        expect(compact.endpointSelection?.result.netProfit).to.equal(0);
        expect(compact.trades).to.deep.equal([]);
    });

    it('diverges on skipDrawdown: compact zeroes drawdown while full still tracks it', () => {
        const data = makeData(60);
        const signals = buyEveryNSignal(data, 5);
        const settings = {
            executionModel: 'signal_close' as const,
            maxOpenTrades: 2,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 5,
        };
        const options = { omitEquityCurve: true, includeSharpeRatio: false, skipDrawdown: true, collectDiagnostics: true };

        const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...options });
        const compact = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...options });

        assertFallbackUsed(full);
        assertFallbackUsed(compact);
        expect(full.maxDrawdownPercent, 'full fallback ignores skipDrawdown (current behavior)')
            .to.be.greaterThan(0);
        expect(compact.maxDrawdownPercent, 'compact fallback honors skipDrawdown').to.equal(0);
        expect(compact.maxDrawdown).to.equal(0);
        expect(full.netProfit).to.be.closeTo(compact.netProfit, 1e-6);
    });

    it('drops null bars through ensureCleanData only in the full entrypoint', () => {
        const clean = makeData(30);
        const dirty = [...clean];
        (dirty as unknown[])[7] = null; // one corrupt bar the full path must drop
        const signals = buyEveryNSignal(clean, 5);
        const settings = { maxOpenTrades: 2 };

        const fromClean = runBacktest(clean, signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });
        const fromDirty = runBacktest(dirty as OHLCVData[], signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });

        assertFallbackUsed(fromClean);
        assertFallbackUsed(fromDirty);
        expect(fromDirty.totalTrades).to.equal(fromClean.totalTrades);
        expect(fromDirty.netProfit).to.be.closeTo(fromClean.netProfit, 1e-9);
        expect(fromDirty.trades).to.deep.equal(fromClean.trades);
    });

    it('throws the cancellation error from both fallback loops', () => {
        const data = makeData(60);
        const signals = buyEveryNSignal(data, 4);
        const settings = { maxOpenTrades: 2 };
        let calls = 0;
        const isCancelled = (): boolean => {
            calls += 1;
            return calls > 2;
        };

        expect(() => runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined,
            { ...FALLBACK_OPTIONS, isCancelled })).to.throw(/cancelled during TypeScript simulation/);

        calls = 0;
        expect(() => runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined,
            { ...FINDER_FALLBACK_OPTIONS, requireTradeHistory: false, isCancelled })).to.throw(/cancelled during TypeScript simulation/);
    });

    it('computes compact fallback Sharpe from typed equity when requested and skips it when not', () => {
        // Daily-collapsed Sharpe sampling needs multi-day coverage: 4h bars.
        const data = makeData(96).map((bar, index) => ({ ...bar, time: (1700000000 + index * 4 * 3600) as Time }));
        const signals = buyEveryNSignal(data, 6);
        const settings = {
            executionModel: 'signal_close' as const,
            maxOpenTrades: 2,
            riskMode: 'percentage' as const,
            stopLossEnabled: true,
            stopLossPercent: 4,
            takeProfitEnabled: true,
            takeProfitPercent: 8,
        };

        const withSharpe = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined,
            { collectDiagnostics: true });
        const withoutSharpe = runBacktestCompact(data, signals, 10000, 100, 0, settings, undefined, undefined,
            { omitEquityCurve: true, includeSharpeRatio: false, requireTradeHistory: false, collectDiagnostics: true });
        const full = runBacktest(data, signals, 10000, 100, 0, settings, undefined, undefined, { ...FALLBACK_OPTIONS });

        assertFallbackUsed(withSharpe);
        assertFallbackUsed(withoutSharpe);
        assertFallbackUsed(full);
        expect(withSharpe.sharpeRatio).to.not.equal(0);
        expect(withoutSharpe.sharpeRatio).to.equal(0);
        // Sample-based (typed) and curve-based (object) Sharpe agree closely.
        expect(withSharpe.sharpeRatio).to.be.closeTo(full.sharpeRatio, 1e-6);
        assertMetricsParity(full, withSharpe, { netProfit: 1e-6, sharpeRatio: 1e-6 });
    });
});
