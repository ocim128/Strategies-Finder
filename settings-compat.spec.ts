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

describe('Backtest settings compatibility', () => {
    it('prefers tradeFilterMode over legacy entryConfirmation', () => {
        const normalized = normalizeBacktestSettings({
            tradeFilterMode: 'rsi',
            entryConfirmation: 'adx',
        });
        expect(normalized.tradeFilterMode).to.equal('rsi');
    });

    it('falls back to legacy entryConfirmation when tradeFilterMode is missing', () => {
        const normalized = normalizeBacktestSettings({
            entryConfirmation: 'trend',
        });
        expect(normalized.tradeFilterMode).to.equal('trend');
    });

    it('sanitizes Rust payloads without dropping compatibility fields', () => {
        const settings: BacktestSettings = {
            atrPeriod: 14,
            tradeFilterMode: 'volume',
            entryConfirmation: 'volume',
            executionModel: 'next_open',
            flipAfterConsecutiveLosses: 3,
            flipCooldownTrades: 2,
            minTradesBeforeFirstFlip: 10,
            confirmationStrategies: ['rsi_reversal'],
            confirmationStrategyParams: { rsi_reversal: { period: 14 } },
            twoHourCloseParity: 'even',
            snapshotRsiMin: 40,
        };

        const sanitized = sanitizeBacktestSettingsForRust(settings);

        expect(sanitized.atrPeriod).to.equal(14);
        expect(sanitized.tradeFilterMode).to.equal('volume');
        expect(sanitized.entryConfirmation).to.equal('volume');
        expect('executionModel' in sanitized).to.equal(false);
        expect('flipAfterConsecutiveLosses' in sanitized).to.equal(false);
        expect('flipCooldownTrades' in sanitized).to.equal(false);
        expect('minTradesBeforeFirstFlip' in sanitized).to.equal(false);
        expect('confirmationStrategies' in sanitized).to.equal(false);
        expect('confirmationStrategyParams' in sanitized).to.equal(false);
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
});
