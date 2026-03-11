import { expect } from 'chai';
import { describe, it } from 'node:test';
import { normalizeBacktestSettings } from './lib/strategies/backtest/backtest-utils';
import { resolveBacktestSettingsFromRaw } from './lib/backtest-settings-resolver';
import {
    hasNonZeroSnapshotFilter,
    sanitizeBacktestSettingsForRust,
    requiresTypescriptEngine,
} from './lib/rust-settings-sanitizer';
import type { BacktestSettings } from './lib/types/strategies';
import {
    isWorkerSupportedStrategyKey,
    resolveSubscriptionExecutionBacktestSettings,
} from './lib/alert-subscription-utils';
import { parseInputNumber } from './lib/dom-input-readers';

describe('Backtest settings compatibility', () => {
    it('uses tradeFilterMode when provided', () => {
        const normalized = normalizeBacktestSettings({
            tradeFilterMode: 'rsi',
        });
        expect(normalized.tradeFilterMode).to.equal('rsi');
    });

    it('sanitizes Rust payloads without dropping compatibility fields', () => {
        const settings: BacktestSettings = {
            atrPeriod: 14,
            tradeFilterMode: 'volume',
            executionModel: 'next_open',
            flipAfterConsecutiveLosses: 3,
            flipCooldownTrades: 2,
            minTradesBeforeFirstFlip: 10,
            twoHourCloseParity: 'even',
            snapshotRsiMin: 40,
        };

        const sanitized = sanitizeBacktestSettingsForRust(settings);

        expect(sanitized.atrPeriod).to.equal(14);
        expect(sanitized.tradeFilterMode).to.equal('volume');
        expect('executionModel' in sanitized).to.equal(false);
        expect('flipAfterConsecutiveLosses' in sanitized).to.equal(false);
        expect('flipCooldownTrades' in sanitized).to.equal(false);
        expect('minTradesBeforeFirstFlip' in sanitized).to.equal(false);
        expect('twoHourCloseParity' in sanitized).to.equal(false);
        expect('snapshotRsiMin' in sanitized).to.equal(false);
    });

    it('detects non-zero snapshot filters consistently', () => {
        expect(hasNonZeroSnapshotFilter({ snapshotRsiMin: 0 })).to.equal(false);
        expect(hasNonZeroSnapshotFilter({ snapshotRsiMin: 42 })).to.equal(true);
        expect(hasNonZeroSnapshotFilter({ snapshotWickSkewMin: -5 })).to.equal(true);
    });

    it('requires TS engine when marketMode is not "all"', () => {
        // Default marketMode is 'all', should not require TS
        expect(requiresTypescriptEngine({})).to.equal(false);
        expect(requiresTypescriptEngine({ marketMode: 'all' })).to.equal(false);

        // Any non-'all' marketMode should require TS
        expect(requiresTypescriptEngine({ marketMode: 'uptrend' })).to.equal(true);
        expect(requiresTypescriptEngine({ marketMode: 'downtrend' })).to.equal(true);
        expect(requiresTypescriptEngine({ marketMode: 'sideway' })).to.equal(true);
    });

    it('enforces sanitizer contract for twoHourCloseParity', () => {
        const settings: BacktestSettings = {
            atrPeriod: 14,
            twoHourCloseParity: 'even',
        };

        const sanitized = sanitizeBacktestSettingsForRust(settings);

        // twoHourCloseParity must be removed by sanitizer
        expect('twoHourCloseParity' in sanitized).to.equal(false);
    });

    it('requires TS engine for realism constraints', () => {
        // signal_close (default) with no slippage and allowSameBarExit should not require TS
        expect(requiresTypescriptEngine({})).to.equal(false);
        expect(requiresTypescriptEngine({ executionModel: 'signal_close', slippageBps: 0, allowSameBarExit: true })).to.equal(false);

        // Non-signal_close execution model requires TS
        expect(requiresTypescriptEngine({ executionModel: 'next_open' })).to.equal(true);
        expect(requiresTypescriptEngine({ executionModel: 'next_close' })).to.equal(true);

        // Slippage requires TS
        expect(requiresTypescriptEngine({ slippageBps: 5 })).to.equal(true);

        // Disabled same-bar exit requires TS
        expect(requiresTypescriptEngine({ allowSameBarExit: false })).to.equal(true);
    });

    it('requires TS engine for combined trade directions', () => {
        expect(requiresTypescriptEngine({ tradeDirection: 'long' })).to.equal(false);
        expect(requiresTypescriptEngine({ tradeDirection: 'short' })).to.equal(false);
        expect(requiresTypescriptEngine({ tradeDirection: 'both' })).to.equal(true);
        expect(requiresTypescriptEngine({ tradeDirection: 'both_flip_loss_2' })).to.equal(true);
        expect(requiresTypescriptEngine({ tradeDirection: 'combined' })).to.equal(true);
    });

    it('preserves new trend filter modes and keeps them on TS engine', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            tradeFilterSettingsToggle: true,
            tradeFilterMode: 'trend_mtf_stack',
        } as unknown as BacktestSettings);

        expect(resolved.tradeFilterMode).to.equal('trend_mtf_stack');
        expect(requiresTypescriptEngine(resolved)).to.equal(true);
    });

    it('hydrates subscription execution defaults to the UI-compatible semantics', () => {
        const resolved = resolveSubscriptionExecutionBacktestSettings({});

        expect(resolved.tradeDirection).to.equal('short');
        expect(resolved.executionModel).to.equal('next_open');
        expect(resolved.allowSameBarExit).to.equal(false);
        expect(resolved.slippageBps).to.equal(5);
    });

    it('preserves subscription capital fields while normalizing execution settings', () => {
        const resolved = resolveSubscriptionExecutionBacktestSettings({
            initialCapital: 25000,
            positionSize: 50,
            commission: 0.2,
            fixedTradeToggle: true,
            fixedTradeAmount: 1200,
            executionModel: 'next_close',
        } as unknown as BacktestSettings);

        expect((resolved as Record<string, unknown>).initialCapital).to.equal(25000);
        expect((resolved as Record<string, unknown>).positionSize).to.equal(50);
        expect((resolved as Record<string, unknown>).commission).to.equal(0.2);
        expect((resolved as Record<string, unknown>).fixedTradeToggle).to.equal(true);
        expect((resolved as Record<string, unknown>).fixedTradeAmount).to.equal(1200);
        expect(resolved.executionModel).to.equal('next_close');
    });

    it('exposes worker strategy compatibility checks for alert subscriptions', () => {
        expect(isWorkerSupportedStrategyKey('volatility_compression_break')).to.equal(true);
        expect(isWorkerSupportedStrategyKey('definitely_not_a_worker_strategy')).to.equal(false);
    });

    it('parses comma-decimal user inputs consistently', () => {
        expect(parseInputNumber('0,78')).to.equal(0.78);
        expect(parseInputNumber('1.234,56')).to.equal(1234.56);
        expect(parseInputNumber('1,234.56')).to.equal(1234.56);
    });
});
