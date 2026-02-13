import { expect } from 'chai';
import { describe, it } from 'node:test';
import { normalizeBacktestSettings } from './lib/strategies/backtest/backtest-utils';
import {
    hasNonZeroSnapshotFilter,
    sanitizeBacktestSettingsForRust,
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
});
