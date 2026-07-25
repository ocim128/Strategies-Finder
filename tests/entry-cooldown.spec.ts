import { expect } from 'chai';
import { describe, it } from 'node:test';
import type { BacktestSettings, OHLCVData, Signal, Time } from '../lib/types/strategies';
import { runBacktest } from '../lib/strategies/index';

/**
 * Intent: a configurable post-exit entry cooldown (riskCooldownBars) gates new
 * entries for N bars after ANY trade closes — replacing the prior hardcoded
 * 1-bar signal-exit-only re-entry guard with a general, user-tunable one.
 *
 * These tests encode WHY the cooldown matters:
 *  - it must space entries out after exits regardless of the exit reason
 *    (signal, stop loss, etc.);
 *  - the default (N=1) must preserve prior behavior so existing users don't
 *    see a regression;
 *  - turning it off (riskCooldownEnabled=false) must allow immediate re-entry.
 */

describe('Entry cooldown (riskCooldownBars)', () => {
    it('blocks a new entry within the cooldown window after a stop-loss exit', () => {
        // WHY: after a protective stop fires, immediately re-entering on the next
        // bar is the exact pattern the cooldown exists to prevent.
        const data: OHLCVData[] = [
            { time: 0 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // buy @ 100
            { time: 2 as Time, open: 100, high: 101, low: 94, close: 95, volume: 1000 }, // SL hit @ 95 (−5%)
            { time: 3 as Time, open: 95, high: 96, low: 94, close: 95, volume: 1000 }, // would-be re-entry, blocked by cooldown=2
            { time: 4 as Time, open: 95, high: 96, low: 94, close: 95, volume: 1000 }, // allowed — 2 bars after exit (bar 2 + N=2 → bar 4)
            { time: 5 as Time, open: 95, high: 96, low: 94, close: 95, volume: 1000 },
        ];

        // Re-entry buy signals on every bar from 3 onward so the only thing
        // gating the second entry is the cooldown.
        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 3 as Time, type: 'buy', price: 95 },
            { time: 4 as Time, type: 'buy', price: 95 },
            { time: 5 as Time, type: 'buy', price: 95 },
        ];

        const settings: BacktestSettings = {
            riskMode: 'percentage',
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: false,
            riskCooldownEnabled: true,
            riskCooldownBars: 2,
            executionModel: 'signal_close',
        };

        const result = runBacktest(data, signals, 1000, 100, 0, settings);
        // First entry exits via SL on bar 2. Cooldown N=2 blocks bars 2 and 3.
        // Next entry is allowed at bar 4 (exit bar + N) → total 2 trades.
        expect(result.totalTrades).to.equal(2);
        expect(result.trades[0]!.exitReason).to.equal('stop_loss');
        expect(result.trades[1]!.entryTime).to.equal(4 as Time);
    });

    it('default cooldown N=1 preserves prior behavior (one-bar re-entry guard)', () => {
        // WHY: existing users running with default settings must not see their
        // trade counts change for the worse. With N=1, the cooldown blocks only
        // the exit bar itself; the next bar is open for re-entry — matching the
        // pre-feature hardcoded SIGNAL_EXIT_REENTRY_COOLDOWN_BARS=1 semantics.
        const data: OHLCVData[] = [
            { time: 0 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // buy @ 100
            { time: 2 as Time, open: 100, high: 101, low: 94, close: 95, volume: 1000 }, // SL @ 95
            { time: 3 as Time, open: 95, high: 96, low: 94, close: 95, volume: 1000 }, // allowed — 1 bar after exit
        ];

        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 3 as Time, type: 'buy', price: 95 },
        ];

        const settings: BacktestSettings = {
            riskMode: 'percentage',
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: false,
            // Default cooldown — leave riskCooldown* unset to exercise the
            // normalizeBacktestSettings defaults (enabled=true, bars=1).
            executionModel: 'signal_close',
        };

        const result = runBacktest(data, signals, 1000, 100, 0, settings);
        // N=1 blocks only bar 2 (exit bar). Bar 3 is open for re-entry.
        expect(result.totalTrades).to.equal(2);
        expect(result.trades[1]!.entryTime).to.equal(3 as Time);
    });

    it('disabled cooldown allows same-bar-sequence re-entry (no gate)', () => {
        // WHY: turning the feature off must restore the unguarded behavior so
        // power users can opt out entirely.
        const data: OHLCVData[] = [
            { time: 0 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // buy @ 100
            { time: 2 as Time, open: 100, high: 101, low: 94, close: 95, volume: 1000 }, // SL @ 95
            { time: 3 as Time, open: 95, high: 96, low: 94, close: 95, volume: 1000 }, // re-entry allowed immediately
        ];

        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 3 as Time, type: 'buy', price: 95 },
        ];

        const settings: BacktestSettings = {
            riskMode: 'percentage',
            stopLossEnabled: true,
            stopLossPercent: 5,
            takeProfitEnabled: false,
            riskCooldownEnabled: false,
            riskCooldownBars: 0,
            executionModel: 'signal_close',
        };

        const result = runBacktest(data, signals, 1000, 100, 0, settings);
        expect(result.totalTrades).to.equal(2);
        expect(result.trades[1]!.entryTime).to.equal(3 as Time);
    });

    it('fires after a signal exit (not only after protective stops)', () => {
        // WHY: the feature replaces a signal-exit-only guard; it must still
        // cover the signal-exit path, or we've regressed the original case.
        const data: OHLCVData[] = [
            { time: 0 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
            { time: 1 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // buy
            { time: 2 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // sell signal → exit
            { time: 3 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // buy blocked (cooldown N=2)
            { time: 4 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 }, // buy allowed — exit bar 2 + N=2
            { time: 5 as Time, open: 100, high: 101, low: 99, close: 100, volume: 1000 },
        ];

        const signals: Signal[] = [
            { time: 1 as Time, type: 'buy', price: 100 },
            { time: 2 as Time, type: 'sell', price: 100 },
            { time: 3 as Time, type: 'buy', price: 100 },
            { time: 4 as Time, type: 'buy', price: 100 },
            { time: 5 as Time, type: 'buy', price: 100 },
        ];

        const settings: BacktestSettings = {
            riskMode: 'percentage',
            stopLossEnabled: false,
            takeProfitEnabled: false,
            riskCooldownEnabled: true,
            riskCooldownBars: 2,
            executionModel: 'signal_close',
        };

        const result = runBacktest(data, signals, 1000, 100, 0, settings);
        expect(result.totalTrades).to.equal(2);
        expect(result.trades[0]!.exitReason).to.equal('signal');
        expect(result.trades[1]!.entryTime).to.equal(4 as Time);
    });
});
