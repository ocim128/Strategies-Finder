import { expect } from 'chai';
import { describe, it } from 'node:test';
import { OHLCVData, Strategy, Time } from '../lib/strategies/index';
import { evaluateLatestEntrySignal } from '../lib/signal-entry-evaluator';
import { strategies } from '../lib/strategies/library';
describe('Alert Entry Evaluator', () => {
    function buildCandles(count: number, startSec = 1_700_000_000): OHLCVData[] {
        const out: OHLCVData[] = [];
        for (let i = 0; i < count; i++) {
            const open = 100 + i;
            out.push({
                time: (startSec + i * 60) as Time,
                open,
                high: open + 1,
                low: open - 1,
                close: open + 0.5,
                volume: 1000 + i
            });
        }
        return out;
    }

    it('should select latest executed entry instead of latest prepared entry signal', () => {
        const strategyKey = '__test_eval_executed_entry__';
        const registry = strategies as Record<string, Strategy>;
        const previous = registry[strategyKey];

        const testStrategy: Strategy = {
            name: 'Evaluator Executed Entry Test',
            description: 'Ensures evaluator follows executed trades.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 5) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: 'buy', price: data[2].close, barIndex: 2 },
                    { time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 },
                ];
            }
        };

        registry[strategyKey] = testStrategy;
        try {
            const candles = buildCandles(6);
            const result = evaluateLatestEntrySignal({
                strategyKey,
                candles,
                backtestSettings: {
                    tradeDirection: 'long',
                    executionModel: 'signal_close'
                },
                freshnessBars: 20
            });

            expect(result.ok).to.equal(true);
            expect(result.latestEntry).to.not.equal(null);
            expect(result.rawSignalCount).to.equal(3);
            expect(result.latestEntry?.signalTimeSec).to.equal(Number(candles[1].time));
            expect(result.latestEntry?.signal.price).to.equal(candles[1].close);
            expect(result.latestEntry?.direction).to.equal('long');
        } finally {
            if (previous) {
                registry[strategyKey] = previous;
            } else {
                delete registry[strategyKey];
            }
        }
    });

    it('should apply confirmation strategies before selecting latest entry', () => {
        const mainKey = '__test_eval_main_with_confirm__';
        const confKey = '__test_eval_confirm_state__';
        const registry = strategies as Record<string, Strategy>;
        const prevMain = registry[mainKey];
        const prevConf = registry[confKey];

        const mainStrategy: Strategy = {
            name: 'Main Confirm Test',
            description: 'Main strategy emits two long entries.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 5) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 },
                ];
            }
        };

        const confirmationStrategy: Strategy = {
            name: 'Confirmation State Test',
            description: 'Turns bearish before the second main entry.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 5) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: 'sell', price: data[2].close, barIndex: 2 },
                ];
            }
        };

        registry[mainKey] = mainStrategy;
        registry[confKey] = confirmationStrategy;

        try {
            const candles = buildCandles(6);
            const result = evaluateLatestEntrySignal({
                strategyKey: mainKey,
                candles,
                backtestSettings: {
                    tradeDirection: 'long',
                    executionModel: 'signal_close',
                    confirmationStrategies: [confKey]
                },
                freshnessBars: 20
            });

            expect(result.ok).to.equal(true);
            expect(result.latestEntry).to.not.equal(null);
            expect(result.rawSignalCount).to.equal(2);
            expect(result.preparedSignalCount).to.equal(1);
            expect(result.latestEntry?.signalTimeSec).to.equal(Number(candles[1].time));
        } finally {
            if (prevMain) {
                registry[mainKey] = prevMain;
            } else {
                delete registry[mainKey];
            }
            if (prevConf) {
                registry[confKey] = prevConf;
            } else {
                delete registry[confKey];
            }
        }
    });

    it('should ignore overlapping signals once the position is already occupied', () => {
        const strategyKey = '__test_eval_pending_next_open_disabled__';
        const registry = strategies as Record<string, Strategy>;
        const previous = registry[strategyKey];

        const testStrategy: Strategy = {
            name: 'Evaluator Overlap Ignore Test',
            description: 'Extra same-direction signals should not expose a pending entry after warm-up removal.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 6) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                    { time: data[2].time, type: 'buy', price: data[2].close, barIndex: 2 },
                    { time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 },
                ];
            }
        };

        registry[strategyKey] = testStrategy;
        try {
            const candles = buildCandles(6);
            const result = evaluateLatestEntrySignal({
                strategyKey,
                candles,
                backtestSettings: {
                    tradeDirection: 'long',
                    executionModel: 'next_open',
                    maxOpenTrades: 1,
                },
                freshnessBars: 20
            });

            expect(result.ok).to.equal(true);
            expect(result.latestEntry).to.not.equal(null);
            expect(result.latestTrade?.isOpen).to.equal(true);
            expect('pendingEntry' in result).to.equal(false);
        } finally {
            if (previous) {
                registry[strategyKey] = previous;
            } else {
                delete registry[strategyKey];
            }
        }
    });

    it('should expose evaluated trade targets for worker and telegram payloads', () => {
        const strategyKey = '__test_eval_trade_targets__';
        const registry = strategies as Record<string, Strategy>;
        const previous = registry[strategyKey];

        const testStrategy: Strategy = {
            name: 'Evaluator Trade Targets Test',
            description: 'Exposes the actual backtest trade targets to worker consumers.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 4) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                ];
            }
        };

        registry[strategyKey] = testStrategy;
        try {
            const candles = buildCandles(5);
            const result = evaluateLatestEntrySignal({
                strategyKey,
                candles,
                backtestSettings: {
                    tradeDirection: 'long',
                    executionModel: 'signal_close',
                    riskMode: 'percentage',
                    stopLossEnabled: true,
                    stopLossPercent: 5,
                    takeProfitEnabled: true,
                    takeProfitMode: 'fixed',
                    takeProfitPercent: 10,
                },
                freshnessBars: 20
            });

            expect(result.ok).to.equal(true);
            expect(result.latestTrade).to.not.equal(null);
            expect(result.latestTrade?.entryPrice).to.equal(candles[1].close);
            expect(result.latestTrade?.takeProfitPrice).to.be.closeTo(candles[1].close * 1.1, 1e-9);
            expect(result.latestTrade?.takeProfitPercent).to.be.closeTo(10, 1e-9);
            expect(result.latestTrade?.stopLossPrice).to.be.closeTo(candles[1].close * 0.95, 1e-9);
            expect(result.latestTrade?.stopLossPercent).to.be.closeTo(5, 1e-9);
        } finally {
            if (previous) {
                registry[strategyKey] = previous;
            } else {
                delete registry[strategyKey];
            }
        }
    });

    it('should keep source signal price and executed fill price separate when slippage is enabled', () => {
        const strategyKey = '__test_eval_entry_fill_price__';
        const registry = strategies as Record<string, Strategy>;
        const previous = registry[strategyKey];

        const testStrategy: Strategy = {
            name: 'Evaluator Entry Fill Price Test',
            description: 'Separates execution price from slippage-adjusted fill price.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => {
                if (data.length < 4) return [];
                return [
                    { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                ];
            }
        };

        registry[strategyKey] = testStrategy;
        try {
            const candles = buildCandles(5);
            const result = evaluateLatestEntrySignal({
                strategyKey,
                candles,
                backtestSettings: {
                    tradeDirection: 'long',
                    executionModel: 'next_open',
                    slippageBps: 100,
                },
                freshnessBars: 20
            });

            expect(result.ok).to.equal(true);
            expect(result.latestEntry).to.not.equal(null);
            expect(result.latestTrade).to.not.equal(null);
            expect(result.latestEntry?.signal.price).to.equal(candles[1].close);
            expect(result.latestEntry?.entryTimeSec).to.equal(Number(candles[2].time));
            expect(result.latestEntry?.entryPrice).to.be.closeTo(candles[2].open * 1.01, 1e-9);
            expect(result.latestTrade?.entryPrice).to.be.closeTo(candles[2].open * 1.01, 1e-9);
        } finally {
            if (previous) {
                registry[strategyKey] = previous;
            } else {
                delete registry[strategyKey];
            }
        }
    });

describe('Executed exit summaries from the entry evaluation', () => {
    function buildCandles(count: number, startSec = 1_700_000_000): OHLCVData[] {
        const out: OHLCVData[] = [];
        for (let i = 0; i < count; i++) {
            const open = 100 + i;
            out.push({
                time: (startSec + i * 60) as Time,
                open,
                high: open + 1,
                low: open - 1,
                close: open + 0.5,
                volume: 1000 + i
            });
        }
        return out;
    }

    function withStrategy(key: string, strategy: Strategy, fn: () => void): void {
        const registry = strategies as Record<string, Strategy>;
        const previous = registry[key];
        registry[key] = strategy;
        try {
            fn();
        } finally {
            if (previous) {
                registry[key] = previous;
            } else {
                delete registry[key];
            }
        }
    }

    it('summarizes the actual executed close of the latest position', () => {
        const key = '__test_exit_signal_close__';
        withStrategy(key, {
            name: 'Exit Signal Close',
            description: 'Buys at bar 1, sells at bar 3.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [
                { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                { time: data[3].time, type: 'sell', price: data[3].close, barIndex: 3 },
            ],
        }, () => {
            const candles = buildCandles(8);
            const result = evaluateLatestEntrySignal({
                strategyKey: key,
                candles,
                backtestSettings: { tradeDirection: 'long', executionModel: 'signal_close' },
                freshnessBars: 20,
            });

            expect(result.ok).to.equal(true);
            expect(result.executedExit).to.not.equal(null);
            expect(result.executedExit!.direction).to.equal('long');
            expect(result.executedExit!.entryTimeSec).to.equal(Number(candles[1].time));
            expect(result.executedExit!.entryPrice).to.equal(candles[1].close);
            expect(result.executedExit!.exitTimeSec).to.equal(Number(candles[3].time));
            expect(result.executedExit!.exitPrice).to.equal(candles[3].close);
            expect(result.executedExit!.exitReason).to.equal('signal');
            expect(result.executedExit!.fullyClosed).to.equal(true);
        });
    });

    it('summarizes stop-loss closures with their actual exit price', () => {
        const key = '__test_exit_stop_loss__';
        withStrategy(key, {
            name: 'Exit Stop Loss',
            description: 'Buys at bar 1 into a falling market.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [{ time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 }],
        }, () => {
            const candles = buildCandles(8).map((candle, index) => ({
                ...candle,
                open: 120 - index,
                high: 121 - index,
                low: 119 - index,
                close: 120.5 - index,
            }));
            const result = evaluateLatestEntrySignal({
                strategyKey: key,
                candles,
                backtestSettings: {
                    tradeDirection: 'long',
                    executionModel: 'signal_close',
                    riskMode: 'percentage',
                    stopLossEnabled: true,
                    stopLossPercent: 2,
                },
                freshnessBars: 20,
            });

            expect(result.ok).to.equal(true);
            expect(result.executedExit).to.not.equal(null);
            expect(result.executedExit!.exitReason).to.equal('stop_loss');
            expect(result.executedExit!.fullyClosed).to.equal(true);
            expect(result.executedExit!.exitPrice).to.be.lessThan(result.executedExit!.entryPrice);
        });
    });

    it('returns no exit summary while the position is open at end of data', () => {
        const key = '__test_exit_open__';
        withStrategy(key, {
            name: 'Exit Open',
            description: 'Buys at bar 1 and never exits.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [{ time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 }],
        }, () => {
            const candles = buildCandles(8);
            const result = evaluateLatestEntrySignal({
                strategyKey: key,
                candles,
                backtestSettings: { tradeDirection: 'long', executionModel: 'signal_close' },
                freshnessBars: 20,
            });

            expect(result.ok).to.equal(true);
            expect(result.executedExit).to.equal(null);
            expect(result.latestTrade?.isOpen).to.equal(true);
        });
    });

    it('returns no exit summary when only a partial exit fired before the data ended', () => {
        const key = '__test_exit_partial__';
        withStrategy(key, {
            name: 'Exit Partial',
            description: 'Buys at bar 1, half-exits at bar 3.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [
                { time: data[1].time, type: 'buy', price: data[1].close, barIndex: 1 },
                { time: data[3].time, type: 'sell', price: data[3].close, barIndex: 3, sizeFraction: 0.5 },
            ],
        }, () => {
            const candles = buildCandles(8);
            const result = evaluateLatestEntrySignal({
                strategyKey: key,
                candles,
                backtestSettings: { tradeDirection: 'long', executionModel: 'signal_close' },
                freshnessBars: 20,
            });

            expect(result.ok).to.equal(true);
            // The partial exit closed only half the position; the remainder
            // was liquidated as end_of_data, so no full-close summary exists.
            expect(result.executedExit).to.equal(null);
        });
    });

    it('summarizes executed short closes', () => {
        const key = '__test_exit_short__';
        withStrategy(key, {
            name: 'Exit Short',
            description: 'Sells at bar 1, buys back at bar 3.',
            defaultParams: {},
            paramLabels: {},
            execute: (data) => [
                { time: data[1].time, type: 'sell', price: data[1].close, barIndex: 1 },
                { time: data[3].time, type: 'buy', price: data[3].close, barIndex: 3 },
            ],
        }, () => {
            const candles = buildCandles(8);
            const result = evaluateLatestEntrySignal({
                strategyKey: key,
                candles,
                backtestSettings: { tradeDirection: 'short', executionModel: 'signal_close' },
                freshnessBars: 20,
            });

            expect(result.ok).to.equal(true);
            expect(result.executedExit).to.not.equal(null);
            expect(result.executedExit!.direction).to.equal('short');
            expect(result.executedExit!.exitTimeSec).to.equal(Number(candles[3].time));
        });
    });
});
});
