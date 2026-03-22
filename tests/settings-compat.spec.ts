import { expect } from 'chai';
import { describe, it } from 'node:test';
import { normalizeBacktestSettings } from './lib/strategies/backtest/backtest-utils';
import { EFFECTIVE_BACKTEST_DEFAULTS, resolveBacktestSettingsFromRaw } from './lib/backtest-settings-resolver';
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
import {
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredStrategyConfig,
} from './lib/settings-manager';
import { DEFAULT_BACKTEST_SETTINGS } from './lib/settings-model';
import { readBoolean, readNumber, toBooleanLike, toFiniteNumber } from './lib/settings-parse-utils';
import { SNAPSHOT_CONFIGS } from './lib/backtest-settings-resolver';
import { strategyManifest } from './lib/strategies/manifest';
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from './lib/strategy-defaults';

describe('Backtest settings compatibility', () => {
    it('uses tradeFilterMode when provided', () => {
        const normalized = normalizeBacktestSettings({
            tradeFilterMode: 'rsi',
        });
        expect(normalized.tradeFilterMode).to.equal('rsi');
    });

    it('reads legacy entryConfirmation but does not retain it in normalized stored settings', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            tradeFilterSettingsToggle: true,
            entryConfirmation: 'trend',
        } as unknown as BacktestSettings);
        const normalized = normalizeStoredBacktestSettings({
            tradeFilterSettingsToggle: true,
            entryConfirmation: 'trend',
        });

        expect(resolved.tradeFilterMode).to.equal('trend');
        expect(normalized.tradeFilterMode).to.equal('trend');
        expect('entryConfirmation' in (normalized as Record<string, unknown>)).to.equal(false);
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

    it('preserves configurable trend filter settings for new trend modes', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            tradeFilterSettingsToggle: true,
            tradeFilterMode: 'trend_persistence',
            executionTrendEmaPeriod: 34,
            trendPersistenceWindow: 7,
            trendPersistenceMinBars: 5,
            trendSlopeLookback: 6,
            trendSlopeMinPercent: 0.35,
        } as unknown as BacktestSettings);

        expect(resolved.tradeFilterMode).to.equal('trend_persistence');
        expect(resolved.executionTrendEmaPeriod).to.equal(34);
        expect(resolved.trendPersistenceWindow).to.equal(7);
        expect(resolved.trendPersistenceMinBars).to.equal(5);
        expect(resolved.trendSlopeLookback).to.equal(6);
        expect(resolved.trendSlopeMinPercent).to.equal(0.35);
        expect(requiresTypescriptEngine(resolved)).to.equal(true);
    });

    it('preserves guarded resolver semantics across schema-driven numeric and boolean fields', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            stopLossToggle: true,
            takeProfitToggle: 1,
            takeProfitVelocityFastBars: 0.4,
            riskWinStreakStopLossToggle: true,
            riskWinStreakStopLossAfterWins: 0.2,
            riskWinStreakStopLossPercent: -5,
            tradeFilterSettingsToggle: true,
            confirmRsiPeriod: 23,
            confirmRsiBullish: 61,
            confirmRsiBearish: 39,
            warmUpEntryToggle: 'true',
            maxOpenTrades: 7,
        } as unknown as BacktestSettings);

        expect(resolved.stopLossEnabled).to.equal(true);
        expect(resolved.takeProfitEnabled).to.equal(true);
        expect(resolved.takeProfitVelocityFastBars).to.equal(1);
        expect(resolved.riskWinStreakStopLossEnabled).to.equal(true);
        expect(resolved.riskWinStreakStopLossAfterWins).to.equal(1);
        expect(resolved.riskWinStreakStopLossPercent).to.equal(0);
        expect(resolved.rsiPeriod).to.equal(23);
        expect(resolved.rsiBullish).to.equal(61);
        expect(resolved.rsiBearish).to.equal(39);
        expect(resolved.warmUpEntryEnabled).to.equal(true);
        expect(resolved.maxOpenTrades).to.equal(2);

        const disabled = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: false,
            stopLossAtr: 9,
            tradeFilterSettingsToggle: false,
            htfBiasEmaPeriod: 10,
        } as unknown as BacktestSettings);

        expect(disabled.stopLossAtr).to.equal(0);
        expect(disabled.htfBiasEmaPeriod).to.equal(EFFECTIVE_BACKTEST_DEFAULTS.htfBiasEmaPeriod);
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
            sizingMode: 'smart_fixed_velocity_memory',
            fixedTradeToggle: true,
            fixedTradeAmount: 1200,
            executionModel: 'next_close',
        } as unknown as BacktestSettings);

        expect((resolved as Record<string, unknown>).initialCapital).to.equal(25000);
        expect((resolved as Record<string, unknown>).positionSize).to.equal(50);
        expect((resolved as Record<string, unknown>).commission).to.equal(0.2);
        expect((resolved as Record<string, unknown>).sizingMode).to.equal('smart_fixed_velocity_memory');
        expect((resolved as Record<string, unknown>).fixedTradeToggle).to.equal(true);
        expect((resolved as Record<string, unknown>).fixedTradeAmount).to.equal(1200);
        expect(resolved.executionModel).to.equal('next_close');
    });

    it('preserves velocity take-profit mode and parameters for subscription execution settings', () => {
        const resolved = resolveSubscriptionExecutionBacktestSettings({
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 8,
            takeProfitMode: 'velocity',
            takeProfitVelocityFastBars: 3,
            takeProfitVelocitySlowBars: 18,
            takeProfitVelocityProgressPercent: 55,
            takeProfitVelocityExpandMultiplier: 1.8,
            takeProfitVelocityShrinkMultiplier: 0.7,
        } as unknown as BacktestSettings);

        expect(resolved.takeProfitMode).to.equal('velocity');
        expect(resolved.takeProfitVelocityFastBars).to.equal(3);
        expect(resolved.takeProfitVelocitySlowBars).to.equal(18);
        expect(resolved.takeProfitVelocityProgressPercent).to.equal(55);
        expect(resolved.takeProfitVelocityExpandMultiplier).to.equal(1.8);
        expect(resolved.takeProfitVelocityShrinkMultiplier).to.equal(0.7);
    });

    it('normalizes deleted percentage TP modes back to fixed mode', () => {
        const rawResolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitToggle: true,
            takeProfitPercent: 8,
            takeProfitMode: 'climax_exit',
        } as unknown as BacktestSettings);
        const subscriptionResolved = resolveSubscriptionExecutionBacktestSettings({
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 8,
            takeProfitMode: 'equity_feedback',
        } as unknown as BacktestSettings);

        expect(rawResolved.takeProfitMode).to.equal('fixed');
        expect(subscriptionResolved.takeProfitMode).to.equal('fixed');
    });

    it('keeps legacy fixed toggle compatibility while upgrading legacy smart sizing mode', () => {
        const legacy = normalizeStoredBacktestSettings({
            fixedTradeToggle: true,
            fixedTradeAmount: 1000,
        });
        const explicit = normalizeStoredBacktestSettings({
            sizingMode: 'smart_fixed',
            fixedTradeToggle: true,
            fixedTradeAmount: 1000,
        });

        expect(legacy.sizingMode).to.equal('fixed');
        expect(explicit.sizingMode).to.equal('smart_fixed_velocity_memory');
    });

    it('preserves the surviving smart sizing mode when normalizing stored settings', () => {
        const explicit = normalizeStoredBacktestSettings({
            sizingMode: 'smart_fixed_velocity_memory',
            fixedTradeToggle: true,
            fixedTradeAmount: 1000,
        });

        expect(explicit.sizingMode).to.equal('smart_fixed_velocity_memory');
    });

    it('upgrades deleted smart fixed variants to quality x velocity when normalizing stored settings', () => {
        const explicit = normalizeStoredBacktestSettings({
            sizingMode: 'smart_fixed_tp_distance_fit',
            fixedTradeToggle: true,
            fixedTradeAmount: 1000,
        });

        expect(explicit.sizingMode).to.equal('smart_fixed_quality_x_velocity');
    });

    it('preserves quality x velocity when normalizing stored settings', () => {
        const explicit = normalizeStoredBacktestSettings({
            sizingMode: 'smart_fixed_quality_x_velocity',
            fixedTradeToggle: true,
            fixedTradeAmount: 1000,
        });

        expect(explicit.sizingMode).to.equal('smart_fixed_quality_x_velocity');
    });

    it('infers snapshot toggles from stored values while honoring explicit disabled toggles', () => {
        const inferred = normalizeStoredBacktestSettings({
            snapshotAtrPercentMin: '1.1',
            snapshotAtrPercentMax: '2.2',
        });
        const explicitOff = normalizeStoredBacktestSettings({
            snapshotAtrFilterToggle: false,
            snapshotAtrPercentMin: 1.1,
            snapshotAtrPercentMax: 2.2,
        });

        expect(inferred.snapshotAtrFilterToggle).to.equal(true);
        expect(inferred.snapshotAtrPercentMin).to.equal(1.1);
        expect(inferred.snapshotAtrPercentMax).to.equal(2.2);
        expect(explicitOff.snapshotAtrFilterToggle).to.equal(false);
        expect(explicitOff.snapshotAtrPercentMin).to.equal(0);
        expect(explicitOff.snapshotAtrPercentMax).to.equal(0);
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

    it('keeps shared boolean and numeric coercion semantics aligned across storage paths', () => {
        expect(toBooleanLike('yes')).to.equal(true);
        expect(toBooleanLike('off')).to.equal(false);
        expect(readBoolean('invalid', true)).to.equal(true);

        expect(toFiniteNumber('12.5')).to.equal(12.5);
        expect(toFiniteNumber('0,78')).to.equal(null);
        expect(readNumber('0,78', 99, { parseString: parseInputNumber })).to.equal(0.78);
    });

    it('keeps snapshot defaults aligned with the shared snapshot config list', () => {
        for (const snapshot of SNAPSHOT_CONFIGS) {
            const minKey = 'minKey' in snapshot ? snapshot.minKey : undefined;
            expect((DEFAULT_BACKTEST_SETTINGS as Record<string, unknown>)[snapshot.toggleKey]).to.equal(false);
            if (minKey) {
                expect((DEFAULT_BACKTEST_SETTINGS as Record<string, unknown>)[minKey]).to.equal(0);
            }
            expect((DEFAULT_BACKTEST_SETTINGS as Record<string, unknown>)[snapshot.maxKey]).to.equal(0);
        }
    });

    it('keeps shared UI defaults aligned with engine defaults except for explicit UI overrides', () => {
        for (const [key, value] of Object.entries(EFFECTIVE_BACKTEST_DEFAULTS)) {
            if (key === 'rsiPeriod') {
                expect(DEFAULT_BACKTEST_SETTINGS.confirmRsiPeriod).to.equal(value);
                continue;
            }
            if (key === 'rsiBullish') {
                expect(DEFAULT_BACKTEST_SETTINGS.confirmRsiBullish).to.equal(value);
                continue;
            }
            if (key === 'rsiBearish') {
                expect(DEFAULT_BACKTEST_SETTINGS.confirmRsiBearish).to.equal(value);
                continue;
            }
            if (key === 'stopLossEnabled') {
                expect(DEFAULT_BACKTEST_SETTINGS.stopLossEnabled).to.equal(false);
                continue;
            }
            if (key === 'takeProfitEnabled') {
                expect(DEFAULT_BACKTEST_SETTINGS.takeProfitEnabled).to.equal(false);
                continue;
            }

            expect((DEFAULT_BACKTEST_SETTINGS as Record<string, unknown>)[key]).to.equal(value);
        }
    });

    it('normalizes malformed stored app settings instead of crashing on partial payloads', () => {
        const normalized = normalizeStoredAppSettings({
            currentSymbol: 'BTCUSDT',
            currentInterval: '4h',
            isDarkTheme: 'false',
            currentStrategyKey: '',
            chartMode: 'invalid',
            backtestSettings: 'broken',
        });

        expect(normalized).to.not.equal(null);
        expect(normalized?.currentSymbol).to.equal('BTCUSDT');
        expect(normalized?.currentInterval).to.equal('4h');
        expect(normalized?.isDarkTheme).to.equal(false);
        expect(normalized?.currentStrategyKey).to.equal(DEFAULT_BUILT_IN_STRATEGY_KEY);
        expect(normalized?.chartMode).to.equal('candlestick');
        expect(normalized?.backtestSettings.initialCapital).to.equal(10000);
    });

    it('normalizes malformed saved strategy configs and filters unusable entries', () => {
        const normalized = normalizeStoredStrategyConfig({
            name: 'My Config',
            strategyKey: '',
            strategyParams: {
                foo: '42',
                bad: 'NaN',
            },
            backtestSettings: {
                initialCapital: '25000',
                tradeFilterMode: 'rsi',
                tradeFilterSettingsToggle: true,
            },
        });

        expect(normalized).to.not.equal(null);
        expect(normalized?.strategyKey).to.equal(DEFAULT_BUILT_IN_STRATEGY_KEY);
        expect(normalized?.strategyParams).to.deep.equal({ foo: 42 });
        expect(normalized?.backtestSettings.initialCapital).to.equal(25000);
        expect(normalized?.backtestSettings.tradeFilterMode).to.equal('rsi');
        expect(normalized?.backtestSettings.tradeFilterSettingsToggle).to.equal(true);
        expect(normalizeStoredStrategyConfig({ strategyKey: 'missing-name' })).to.equal(null);
    });

    it('keeps the shared default strategy key aligned with the built-in manifest', () => {
        expect(strategyManifest.some((entry) => entry.key === DEFAULT_BUILT_IN_STRATEGY_KEY)).to.equal(true);
    });
});
