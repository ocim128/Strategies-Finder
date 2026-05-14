import { expect } from 'chai';
import { describe, it } from 'node:test';
import { normalizeBacktestSettings } from '../lib/strategies/backtest/backtest-utils';
import { BACKTEST_DOM_SETTING_IDS, EFFECTIVE_BACKTEST_DEFAULTS, resolveBacktestSettingsFromRaw } from '../lib/backtest-settings-resolver';
import {
    sanitizeBacktestSettingsForRust,
    requiresTypescriptEngine,
} from '../lib/rust-settings-sanitizer';
import type { BacktestSettings } from '../lib/types/strategies';
import {
    isWorkerSupportedStrategyKey,
    resolveSubscriptionExecutionBacktestSettings,
} from '../lib/alert-subscription-utils';
import { parseInputNumber } from '../lib/dom-input-readers';
import {
    normalizeStoredEnsembleSignalRecipe,
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredStrategyConfig,
    sortEnsembleSignalRecipesNewestFirst,
    sortStrategyConfigsNewestFirst,
} from '../lib/settings-manager';
import { DEFAULT_BACKTEST_SETTINGS, type EnsembleSignalRecipe } from '../lib/settings-model';
import { readBoolean, readNumber, toBooleanLike, toFiniteNumber } from '../lib/settings-parse-utils';
import {
    BACKTEST_SETTINGS_DOM_CONTRACTS,
    coerceBacktestDomSettingValue,
    getBacktestDomSettingContract,
} from '../lib/backtest-settings-dom-contract';
import { strategyManifest } from '../lib/strategies/manifest';
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from '../lib/strategy-defaults';
import { resolvePolymarketEntrySelectionModeForDisplay } from '../lib/polymarket-entry-selection-mode';

describe('Backtest settings compatibility', () => {
    it('ignores removed tradeFilterMode when provided', () => {
        const normalized = normalizeBacktestSettings({
            tradeFilterMode: 'rsi',
        });
        expect('tradeFilterMode' in (normalized as Record<string, unknown>)).to.equal(false);
    });

    it('ignores legacy entryConfirmation and trade filter toggles in stored settings', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            tradeFilterSettingsToggle: true,
            entryConfirmation: 'trend',
        } as unknown as BacktestSettings);
        const normalized = normalizeStoredBacktestSettings({
            tradeFilterSettingsToggle: true,
            entryConfirmation: 'trend',
        });

        expect('tradeFilterMode' in (resolved as Record<string, unknown>)).to.equal(false);
        expect('tradeFilterMode' in (normalized as Record<string, unknown>)).to.equal(false);
        expect('tradeFilterSettingsToggle' in (normalized as Record<string, unknown>)).to.equal(false);
        expect('entryConfirmation' in (normalized as Record<string, unknown>)).to.equal(false);
    });

    it('keeps polymarketExitMode in canonical lowercase form when read from DOM contracts', () => {
        const contract = getBacktestDomSettingContract('polymarketExitMode');
        expect(contract).to.not.equal(undefined);
        expect(coerceBacktestDomSettingValue(contract!, 'signal_exit_same_event')).to.equal('signal_exit_same_event');
        expect(coerceBacktestDomSettingValue(contract!, 'SIGNAL_EXIT_SAME_EVENT')).to.equal('signal_exit_same_event');
        expect(coerceBacktestDomSettingValue(contract!, 'resolve_hold')).to.equal('resolve_hold');
    });

    it('keeps polymarketEntrySelectionMode in canonical lowercase form when read from DOM contracts', () => {
        const contract = getBacktestDomSettingContract('polymarketEntrySelectionMode');
        expect(contract).to.not.equal(undefined);
        expect(coerceBacktestDomSettingValue(contract!, 'actual_entry_minute')).to.equal('actual_entry_minute');
        expect(coerceBacktestDomSettingValue(contract!, 'ACTUAL_ENTRY_MINUTE')).to.equal('actual_entry_minute');
        expect(coerceBacktestDomSettingValue(contract!, 'fixed_offset')).to.equal('fixed_offset');
        expect(coerceBacktestDomSettingValue(contract!, 'anything-else')).to.equal('fixed_offset');
    });

    it('keeps polymarketOutcomeInterval in canonical lowercase form when read from DOM contracts', () => {
        const contract = getBacktestDomSettingContract('polymarketOutcomeInterval');
        expect(contract).to.not.equal(undefined);
        expect(coerceBacktestDomSettingValue(contract!, '15m')).to.equal('15m');
        expect(coerceBacktestDomSettingValue(contract!, '1H')).to.equal('1h');
        expect(coerceBacktestDomSettingValue(contract!, 'anything-else')).to.equal('5m');
    });

    it('includes polymarketEntrySelectionMode in the shared DOM setting ids used by manual backtests', () => {
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketEntrySelectionMode')).to.equal(true);
    });

    it('normalizes the Polymarket entry price filter as a symmetric cents boundary', () => {
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketEntryPriceFilterCents).to.equal(0);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketEntryPriceFilterCents')).to.equal(true);

        const contract = getBacktestDomSettingContract('polymarketEntryPriceFilterCents');
        expect(contract).to.not.equal(undefined);
        expect(coerceBacktestDomSettingValue(contract!, 20)).to.equal(20);
        expect(coerceBacktestDomSettingValue(contract!, 80)).to.equal(49);
        expect(coerceBacktestDomSettingValue(contract!, -5)).to.equal(0);
        expect(coerceBacktestDomSettingValue(contract!, 'bad')).to.equal(0);

        const resolved = resolveBacktestSettingsFromRaw({
            polymarketEntryPriceFilterCents: 80,
        } as unknown as BacktestSettings);
        expect(resolved.polymarketEntryPriceFilterCents).to.equal(49);
        expect('polymarketEntryPriceFilterCents' in sanitizeBacktestSettingsForRust(resolved)).to.equal(false);
    });

    it('includes polymarketOutcomeInterval in shared defaults and manual-backtest DOM ids', () => {
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketOutcomeInterval).to.equal('5m');
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketOutcomeInterval')).to.equal(true);
    });

    it('includes historical-level controls in manual-backtest DOM ids', () => {
        expect(BACKTEST_DOM_SETTING_IDS.includes('historicalLevelTakeProfitToggle')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('historicalLevelStopLossToggle')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('historicalLevelLookbackBars')).to.equal(true);
    });

    it('normalizes selected confirmation strategies from the settings UI payload', () => {
        expect(BACKTEST_DOM_SETTING_IDS.includes('confirmationStrategiesToggle')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('confirmationStrategies')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('confirmationStrategyParams')).to.equal(true);

        const contract = getBacktestDomSettingContract('confirmationStrategies');
        const paramsContract = getBacktestDomSettingContract('confirmationStrategyParams');
        expect(contract).to.not.equal(undefined);
        expect(paramsContract).to.not.equal(undefined);
        expect(coerceBacktestDomSettingValue(
            contract!,
            'entropy_ratio_regime_alignment,close_location_median_alignment,kurtosis_distribution_alignment'
        )).to.deep.equal([
            'entropy_ratio_regime_alignment',
            'close_location_median_alignment',
            'kurtosis_distribution_alignment',
        ]);
        expect(coerceBacktestDomSettingValue(
            paramsContract!,
            JSON.stringify({
                entropy_ratio_regime_alignment: { slowWindow: '21' },
                close_location_median_alignment: { lookback: '34' },
            })
        )).to.deep.equal({
            entropy_ratio_regime_alignment: { slowWindow: 21 },
            close_location_median_alignment: { lookback: 34 },
        });

        const resolved = resolveBacktestSettingsFromRaw({
            confirmationStrategiesToggle: true,
            confirmationStrategies: 'entropy_ratio_regime_alignment,close_location_median_alignment',
            confirmationStrategyParams: JSON.stringify({
                entropy_ratio_regime_alignment: { slowWindow: '21' },
                close_location_median_alignment: { lookback: '34' },
                kurtosis_distribution_alignment: { lookback: '55' },
            }),
        } as unknown as BacktestSettings);
        expect(resolved.confirmationStrategies).to.deep.equal([
            'entropy_ratio_regime_alignment',
            'close_location_median_alignment',
        ]);
        expect(resolved.confirmationStrategyParams).to.deep.equal({
            entropy_ratio_regime_alignment: { slowWindow: 21 },
            close_location_median_alignment: { lookback: 34 },
        });
        expect('confirmationStrategies' in sanitizeBacktestSettingsForRust(resolved)).to.equal(false);
        expect('confirmationStrategyParams' in sanitizeBacktestSettingsForRust(resolved)).to.equal(false);
    });

    it('normalizes post-signal Polymarket limit-entry settings', () => {
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketPostSignalLimitEntryEnabled).to.equal(false);
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketPostSignalLimitEntryMode).to.equal('fixed_price');
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketPostSignalLimitEntryPriceCents).to.equal(50);
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketPostSignalLimitEntryOffsetCents).to.equal(20);
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketPostSignalLimitExitEnabled).to.equal(false);
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketPostSignalLimitExitMode).to.equal('entry_offset');
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketPostSignalLimitExitPriceCents).to.equal(80);
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketPostSignalLimitExitOffsetCents).to.equal(20);
        expect(EFFECTIVE_BACKTEST_DEFAULTS.polymarketSignalExitAllowMultipleTradesPerEvent).to.equal(false);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketSignalExitAllowMultipleTradesPerEvent')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketPostSignalLimitEntryEnabled')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketPostSignalLimitEntryMode')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketPostSignalLimitEntryPriceCents')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketPostSignalLimitEntryOffsetCents')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketPostSignalLimitExitEnabled')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketPostSignalLimitExitMode')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketPostSignalLimitExitPriceCents')).to.equal(true);
        expect(BACKTEST_DOM_SETTING_IDS.includes('polymarketPostSignalLimitExitOffsetCents')).to.equal(true);

        const priceContract = getBacktestDomSettingContract('polymarketPostSignalLimitEntryPriceCents');
        const exitPriceContract = getBacktestDomSettingContract('polymarketPostSignalLimitExitPriceCents');
        expect(priceContract).to.not.equal(undefined);
        expect(exitPriceContract).to.not.equal(undefined);
        expect(coerceBacktestDomSettingValue(priceContract!, 0)).to.equal(1);
        expect(coerceBacktestDomSettingValue(priceContract!, 120)).to.equal(99);
        expect(coerceBacktestDomSettingValue(exitPriceContract!, 'bad')).to.equal(80);
        const entryModeContract = getBacktestDomSettingContract('polymarketPostSignalLimitEntryMode');
        const exitModeContract = getBacktestDomSettingContract('polymarketPostSignalLimitExitMode');
        const offsetContract = getBacktestDomSettingContract('polymarketPostSignalLimitEntryOffsetCents');
        expect(coerceBacktestDomSettingValue(entryModeContract!, 'signal_offset')).to.equal('signal_offset');
        expect(coerceBacktestDomSettingValue(entryModeContract!, 'bad')).to.equal('fixed_price');
        expect(coerceBacktestDomSettingValue(exitModeContract!, 'fixed_price')).to.equal('fixed_price');
        expect(coerceBacktestDomSettingValue(exitModeContract!, 'bad')).to.equal('entry_offset');
        expect(coerceBacktestDomSettingValue(offsetContract!, 120)).to.equal(99);

        const resolved = resolveBacktestSettingsFromRaw({
            polymarketPostSignalLimitEntryEnabled: true,
            polymarketSignalExitAllowMultipleTradesPerEvent: true,
            polymarketPostSignalLimitEntryMode: 'signal_offset',
            polymarketPostSignalLimitEntryPriceCents: 120,
            polymarketPostSignalLimitEntryOffsetCents: -2,
            polymarketPostSignalLimitExitEnabled: true,
            polymarketPostSignalLimitExitMode: 'fixed_price',
            polymarketPostSignalLimitExitPriceCents: 0,
            polymarketPostSignalLimitExitOffsetCents: 120,
        } as BacktestSettings);
        expect(resolved.polymarketPostSignalLimitEntryEnabled).to.equal(true);
        expect(resolved.polymarketSignalExitAllowMultipleTradesPerEvent).to.equal(true);
        expect(resolved.polymarketPostSignalLimitEntryMode).to.equal('signal_offset');
        expect(resolved.polymarketPostSignalLimitEntryPriceCents).to.equal(99);
        expect(resolved.polymarketPostSignalLimitEntryOffsetCents).to.equal(0);
        expect(resolved.polymarketPostSignalLimitExitEnabled).to.equal(true);
        expect(resolved.polymarketPostSignalLimitExitMode).to.equal('fixed_price');
        expect(resolved.polymarketPostSignalLimitExitPriceCents).to.equal(1);
        expect(resolved.polymarketPostSignalLimitExitOffsetCents).to.equal(99);

        const invalidExitPrice = resolveBacktestSettingsFromRaw({
            polymarketPostSignalLimitExitPriceCents: 'bad',
        } as unknown as BacktestSettings);
        expect(invalidExitPrice.polymarketPostSignalLimitExitPriceCents).to.equal(80);
    });

    it('prefers actual entry minute for display when fixed-offset annotations are stale and rows are filtered', () => {
        const resolved = resolvePolymarketEntrySelectionModeForDisplay(
            'fixed_offset',
            'actual_entry_minute',
            [{ polymarketOutcome: { marketExitSource: 'filtered' } } as any]
        );

        expect(resolved).to.equal('actual_entry_minute');
    });

    it('sanitizes Rust payloads and strips removed trade-filter fields', () => {
        const settings = {
            atrPeriod: 14,
            tradeFilterMode: 'volume',
            executionModel: 'next_open',
            polymarketOutcomeInterval: '15m',
            polymarketSignalExitAllowMultipleTradesPerEvent: true,
            polymarketPostSignalLimitEntryEnabled: true,
            polymarketPostSignalLimitEntryMode: 'signal_offset',
            polymarketPostSignalLimitEntryPriceCents: 45,
            polymarketPostSignalLimitEntryOffsetCents: 20,
            polymarketPostSignalLimitExitEnabled: true,
            polymarketPostSignalLimitExitMode: 'entry_offset',
            polymarketPostSignalLimitExitPriceCents: 80,
            polymarketPostSignalLimitExitOffsetCents: 20,
            flipAfterConsecutiveLosses: 3,
            flipCooldownTrades: 2,
            minTradesBeforeFirstFlip: 10,
        } as unknown as BacktestSettings;

        const sanitized = sanitizeBacktestSettingsForRust(settings);

        expect(sanitized.atrPeriod).to.equal(14);
        expect('tradeFilterMode' in sanitized).to.equal(false);
        expect('executionModel' in sanitized).to.equal(false);
        expect('polymarketOutcomeInterval' in sanitized).to.equal(false);
        expect('polymarketSignalExitAllowMultipleTradesPerEvent' in sanitized).to.equal(false);
        expect('polymarketPostSignalLimitEntryEnabled' in sanitized).to.equal(false);
        expect('polymarketPostSignalLimitEntryMode' in sanitized).to.equal(false);
        expect('polymarketPostSignalLimitEntryPriceCents' in sanitized).to.equal(false);
        expect('polymarketPostSignalLimitEntryOffsetCents' in sanitized).to.equal(false);
        expect('polymarketPostSignalLimitExitEnabled' in sanitized).to.equal(false);
        expect('polymarketPostSignalLimitExitMode' in sanitized).to.equal(false);
        expect('polymarketPostSignalLimitExitPriceCents' in sanitized).to.equal(false);
        expect('polymarketPostSignalLimitExitOffsetCents' in sanitized).to.equal(false);
        expect('flipAfterConsecutiveLosses' in sanitized).to.equal(false);
        expect('flipCooldownTrades' in sanitized).to.equal(false);
        expect('minTradesBeforeFirstFlip' in sanitized).to.equal(false);
    });

    it('ignores removed marketMode settings', () => {
        // Market Mode is no longer configurable; every path resolves to all markets.
        expect(resolveBacktestSettingsFromRaw({ marketMode: 'uptrend' } as BacktestSettings).marketMode).to.equal('all');
        expect(normalizeBacktestSettings({ marketMode: 'downtrend' }).marketMode).to.equal('all');
        expect(normalizeStoredBacktestSettings({ marketMode: 'sideway' }).marketMode).to.equal('all');
    });

    it('requires TS engine for realism constraints', () => {
        // Same-bar exits are no longer configurable, so the TS engine is required.
        expect(requiresTypescriptEngine({})).to.equal(true);
        expect(requiresTypescriptEngine({ executionModel: 'signal_close', slippageBps: 0, allowSameBarExit: true })).to.equal(true);

        // Non-signal_close execution model requires TS
        expect(requiresTypescriptEngine({ executionModel: 'next_open' })).to.equal(true);
        expect(requiresTypescriptEngine({ executionModel: 'next_close' })).to.equal(true);

        // Slippage requires TS
        expect(requiresTypescriptEngine({ slippageBps: 5 })).to.equal(true);

        expect(requiresTypescriptEngine({ allowSameBarExit: false })).to.equal(true);
    });

    it('keeps combined trade directions on the TS engine path', () => {
        expect(requiresTypescriptEngine({ tradeDirection: 'long' })).to.equal(true);
        expect(requiresTypescriptEngine({ tradeDirection: 'short' })).to.equal(true);
        expect(requiresTypescriptEngine({ tradeDirection: 'both' })).to.equal(true);
        expect(requiresTypescriptEngine({ tradeDirection: 'both_flip_loss_2' })).to.equal(true);
        expect(requiresTypescriptEngine({ tradeDirection: 'combined' })).to.equal(true);
    });

    it('ignores removed trade filter modes from raw and stored settings', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            tradeFilterSettingsToggle: true,
            tradeFilterMode: 'trend_mtf_stack',
        } as unknown as BacktestSettings);
        const normalized = normalizeStoredBacktestSettings({
            tradeFilterSettingsToggle: true,
            tradeFilterMode: 'trend_persistence',
        });

        expect('tradeFilterMode' in (resolved as Record<string, unknown>)).to.equal(false);
        expect('tradeFilterMode' in (normalized as Record<string, unknown>)).to.equal(false);
    });

    it('preserves guarded resolver semantics across schema-driven numeric and boolean fields', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            stopLossToggle: true,
            takeProfitToggle: 1,
            takeProfitMfeBootstrapPercentile: 120,
            riskWinStreakStopLossToggle: true,
            riskWinStreakStopLossAfterWins: 0.2,
            riskWinStreakStopLossPercent: -5,
            maxOpenTrades: 7,
        } as unknown as BacktestSettings);

        expect(resolved.stopLossEnabled).to.equal(true);
        expect(resolved.takeProfitEnabled).to.equal(true);
        expect(resolved.takeProfitMfeBootstrapPercentile).to.equal(99);
        expect(resolved.riskWinStreakStopLossEnabled).to.equal(false);
        expect(resolved.riskWinStreakStopLossAfterWins).to.equal(3);
        expect(resolved.riskWinStreakStopLossPercent).to.equal(0);
        expect(resolved.maxOpenTrades).to.equal(2);

        const disabled = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: false,
            stopLossAtr: 9,
        } as unknown as BacktestSettings);

        expect(disabled.stopLossAtr).to.equal(0);
        expect('htfBiasEmaPeriod' in (disabled as Record<string, unknown>)).to.equal(false);
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

    it('preserves MFE bootstrap take-profit settings for subscription execution settings', () => {
        const resolved = resolveSubscriptionExecutionBacktestSettings({
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 8,
            takeProfitMode: 'mfe_bootstrap',
            takeProfitMfeBootstrapPercentile: 73,
        } as unknown as BacktestSettings);

        expect(resolved.takeProfitMode).to.equal('mfe_bootstrap');
        expect(resolved.takeProfitMfeBootstrapPercentile).to.equal(73);
    });

    it('preserves new adaptive TP modes and clamps their shared settings', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitToggle: true,
            takeProfitPercent: 8,
            takeProfitMode: 'information_coefficient',
            takeProfitAdaptiveLookbackTrades: 2,
            takeProfitAdaptiveRecentWindow: 1,
            takeProfitAdaptiveMinMultiplier: 0.01,
            takeProfitAdaptiveMaxMultiplier: 7,
            takeProfitAdaptiveGridSteps: 1,
            takeProfitAdaptiveRegimeBlend: 2,
            takeProfitAdaptiveIcScale: -1,
        } as unknown as BacktestSettings);

        expect(resolved.takeProfitMode).to.equal('information_coefficient');
        expect(resolved.takeProfitAdaptiveLookbackTrades).to.equal(5);
        expect(resolved.takeProfitAdaptiveRecentWindow).to.equal(3);
        expect(resolved.takeProfitAdaptiveMinMultiplier).to.equal(0.1);
        expect(resolved.takeProfitAdaptiveMaxMultiplier).to.equal(7);
        expect(resolved.takeProfitAdaptiveGridSteps).to.equal(3);
        expect(resolved.takeProfitAdaptiveRegimeBlend).to.equal(1);
        expect(resolved.takeProfitAdaptiveIcScale).to.equal(0);
    });

    it('requires TS engine for new adaptive take-profit modes', () => {
        expect(requiresTypescriptEngine({
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'edge_weighted',
        })).to.equal(true);

        expect(requiresTypescriptEngine({
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitMode: 'minimum_surprisal',
        })).to.equal(true);
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

    it('strips deleted percentage TP fields when normalizing stored settings', () => {
        const normalized = normalizeStoredBacktestSettings({
            riskSettingsToggle: true,
            riskMode: 'percentage',
            takeProfitEnabled: true,
            takeProfitPercent: 8,
            takeProfitMode: 'velocity',
            takeProfitVelocityFastBars: 3,
            takeProfitVelocitySlowBars: 18,
            takeProfitVelocityProgressPercent: 55,
            takeProfitVelocityExpandMultiplier: 1.8,
            takeProfitVelocityShrinkMultiplier: 0.7,
            takeProfitMfeBootstrapPercentile: 73,
        });

        expect(normalized.takeProfitMode).to.equal('fixed');
        expect(normalized.takeProfitMfeBootstrapPercentile).to.equal(73);
        expect('takeProfitVelocityFastBars' in (normalized as Record<string, unknown>)).to.equal(false);
        expect('takeProfitVelocitySlowBars' in (normalized as Record<string, unknown>)).to.equal(false);
        expect('takeProfitVelocityProgressPercent' in (normalized as Record<string, unknown>)).to.equal(false);
        expect('takeProfitVelocityExpandMultiplier' in (normalized as Record<string, unknown>)).to.equal(false);
        expect('takeProfitVelocityShrinkMultiplier' in (normalized as Record<string, unknown>)).to.equal(false);
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

    it('ignores removed snapshot filter fields in stored settings', () => {
        const normalized = normalizeStoredBacktestSettings({
            snapshotAtrFilterToggle: true,
            snapshotAtrPercentMin: 1.1,
            snapshotAtrPercentMax: 2.2,
        });

        expect('snapshotAtrFilterToggle' in (normalized as Record<string, unknown>)).to.equal(false);
        expect('snapshotAtrPercentMin' in (normalized as Record<string, unknown>)).to.equal(false);
        expect('snapshotAtrPercentMax' in (normalized as Record<string, unknown>)).to.equal(false);
    });

    it('exposes worker strategy compatibility checks for alert subscriptions', () => {
        expect(isWorkerSupportedStrategyKey(DEFAULT_BUILT_IN_STRATEGY_KEY)).to.equal(true);
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

    it('forces removed backtest settings to inert values', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMode: 'advanced',
            partialTakeProfitAtR: 2,
            partialTakeProfitPercent: 50,
            breakEvenAtR: 1,
            breakEvenPercent: 4,
            timeStopBars: 6,
            riskWinStreakStopLossToggle: true,
            riskWinStreakStopLossAfterWins: 2,
            riskWinStreakStopLossPercent: 1,
            marketMode: 'uptrend',
            allowSameBarExit: true,
        } as unknown as BacktestSettings);
        const normalized = normalizeBacktestSettings({
            riskMode: 'advanced',
            partialTakeProfitAtR: 2,
            partialTakeProfitPercent: 50,
            breakEvenAtR: 1,
            breakEvenPercent: 4,
            timeStopBars: 6,
            riskWinStreakStopLossEnabled: true,
            riskWinStreakStopLossAfterWins: 2,
            riskWinStreakStopLossPercent: 1,
            marketMode: 'uptrend',
            allowSameBarExit: true,
        } as BacktestSettings);

        expect(resolved.riskMode).to.equal('simple');
        expect(resolved.partialTakeProfitAtR).to.equal(0);
        expect(resolved.partialTakeProfitPercent).to.equal(0);
        expect(resolved.breakEvenAtR).to.equal(0);
        expect(resolved.breakEvenPercent).to.equal(0);
        expect(resolved.timeStopBars).to.equal(0);
        expect(resolved.riskWinStreakStopLossEnabled).to.equal(false);
        expect(resolved.riskWinStreakStopLossPercent).to.equal(0);
        expect(resolved.marketMode).to.equal('all');
        expect(resolved.allowSameBarExit).to.equal(false);

        expect(normalized.riskMode).to.equal('simple');
        expect(normalized.partialTakeProfitAtR).to.equal(0);
        expect(normalized.partialTakeProfitPercent).to.equal(0);
        expect(normalized.breakEvenAtR).to.equal(0);
        expect(normalized.breakEvenPercent).to.equal(0);
        expect(normalized.timeStopBars).to.equal(0);
        expect(normalized.riskWinStreakStopLossEnabled).to.equal(false);
        expect(normalized.riskWinStreakStopLossPercent).to.equal(0);
        expect(normalized.marketMode).to.equal('all');
        expect(normalized.allowSameBarExit).to.equal(false);
    });

    it('resolves historical-level risk settings behind the risk section toggle', () => {
        const enabled = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            historicalLevelTakeProfitToggle: true,
            historicalLevelStopLossToggle: 'true',
            historicalLevelLookbackBars: '96',
        } as unknown as BacktestSettings);
        const disabled = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: false,
            historicalLevelTakeProfitToggle: true,
            historicalLevelStopLossToggle: true,
            historicalLevelLookbackBars: 96,
        } as unknown as BacktestSettings);

        expect(enabled.historicalLevelTakeProfitEnabled).to.equal(true);
        expect(enabled.historicalLevelStopLossEnabled).to.equal(true);
        expect(enabled.historicalLevelLookbackBars).to.equal(96);
        expect(disabled.historicalLevelTakeProfitEnabled).to.equal(false);
        expect(disabled.historicalLevelStopLossEnabled).to.equal(false);
        expect(disabled.historicalLevelLookbackBars).to.equal(0);
    });

    it('keeps historical-level exits on the TypeScript-only path', () => {
        const settings: BacktestSettings = {
            historicalLevelTakeProfitEnabled: true,
            historicalLevelLookbackBars: 120,
        };
        const sanitized = sanitizeBacktestSettingsForRust(settings);

        expect(requiresTypescriptEngine(settings)).to.equal(true);
        expect('historicalLevelTakeProfitEnabled' in sanitized).to.equal(false);
        expect('historicalLevelLookbackBars' in sanitized).to.equal(false);
    });

    it('keeps minimum hold on the TypeScript-only path when enabled', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            riskSettingsToggle: true,
            riskMinHoldToggle: true,
            riskMinHoldBars: '10',
        } as unknown as BacktestSettings);
        const sanitized = sanitizeBacktestSettingsForRust(resolved);

        expect(resolved.riskMinHoldEnabled).to.equal(true);
        expect(resolved.riskMinHoldBars).to.equal(10);
        expect(requiresTypescriptEngine(resolved)).to.equal(true);
        expect('riskMinHoldEnabled' in sanitized).to.equal(false);
        expect('riskMinHoldBars' in sanitized).to.equal(false);
    });

    it('does not expose removed snapshot filter defaults', () => {
        expect('snapshotAtrFilterToggle' in (DEFAULT_BACKTEST_SETTINGS as Record<string, unknown>)).to.equal(false);
        expect('snapshotAtrPercentMin' in (DEFAULT_BACKTEST_SETTINGS as Record<string, unknown>)).to.equal(false);
        expect('snapshotAtrPercentMax' in (DEFAULT_BACKTEST_SETTINGS as Record<string, unknown>)).to.equal(false);
    });

    it('keeps shared UI defaults aligned with engine defaults except for explicit UI overrides', () => {
        for (const [key, value] of Object.entries(EFFECTIVE_BACKTEST_DEFAULTS)) {
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

    it('keeps the shared settings DOM contract unique and aligned with legacy aliases', () => {
        expect(new Set(BACKTEST_SETTINGS_DOM_CONTRACTS.map((contract) => contract.domId)).size)
            .to.equal(BACKTEST_SETTINGS_DOM_CONTRACTS.length);

        expect(getBacktestDomSettingContract('polymarketAnnotationEnabled')).to.not.equal(undefined);
        expect(getBacktestDomSettingContract('polymarketOutcomeSymbol')).to.not.equal(undefined);
        expect(getBacktestDomSettingContract('polymarketEntrySelectionMode')).to.not.equal(undefined);
        expect(getBacktestDomSettingContract('polymarketEntryOffset')).to.not.equal(undefined);
        expect(getBacktestDomSettingContract('polymarketEntryPriceFilterCents')).to.not.equal(undefined);
        expect(getBacktestDomSettingContract('historicalLevelTakeProfitToggle')?.settingKey).to.equal('historicalLevelTakeProfitEnabled');
        expect(getBacktestDomSettingContract('historicalLevelStopLossToggle')?.settingKey).to.equal('historicalLevelStopLossEnabled');
        expect(getBacktestDomSettingContract('historicalLevelLookbackBars')?.rustSupport).to.equal('unsupported');
        expect(getBacktestDomSettingContract('riskMinHoldToggle')?.settingKey).to.equal('riskMinHoldEnabled');
        expect(getBacktestDomSettingContract('riskMinHoldBars')?.rustSupport).to.equal('unsupported');
        expect(getBacktestDomSettingContract('allowSameBarExitToggle')).to.equal(undefined);
        expect(getBacktestDomSettingContract('marketMode')).to.equal(undefined);
        expect(getBacktestDomSettingContract('tradeFilterMode')).to.equal(undefined);
        expect(getBacktestDomSettingContract('tradeFilterSettingsToggle')).to.equal(undefined);
        expect(getBacktestDomSettingContract('confirmRsiPeriod')).to.equal(undefined);
        expect(getBacktestDomSettingContract('breakEvenPercent')).to.equal(undefined);
        expect(getBacktestDomSettingContract('riskWinStreakStopLossToggle')).to.equal(undefined);
        expect(getBacktestDomSettingContract('snapshotAtrFilterToggle')).to.equal(undefined);
        expect(getBacktestDomSettingContract('snapshotAtrPercentMin')).to.equal(undefined);
    });

    it('normalizes malformed stored app settings instead of crashing on partial payloads', () => {
        const normalized = normalizeStoredAppSettings({
            currentSymbol: 'BTCUSDT',
            currentInterval: '4h',
            binanceMarketType: 'futures',
            isDarkTheme: 'false',
            currentStrategyKey: '',
            chartMode: 'invalid',
            backtestSettings: 'broken',
        });

        expect(normalized).to.not.equal(null);
        expect(normalized?.currentSymbol).to.equal('BTCUSDT');
        expect(normalized?.currentInterval).to.equal('4h');
        expect(normalized?.binanceMarketType).to.equal('futures');
        expect(normalized?.isDarkTheme).to.equal(false);
        expect(normalized?.currentStrategyKey).to.equal(DEFAULT_BUILT_IN_STRATEGY_KEY);
        expect(normalized?.chartMode).to.equal('candlestick');
        expect(normalized?.backtestSettings.initialCapital).to.equal(10000);
    });

    it('falls back to spot when stored Binance market type is invalid', () => {
        const normalized = normalizeStoredAppSettings({
            currentSymbol: 'BTCUSDT',
            currentInterval: '1h',
            binanceMarketType: 'delivery',
        });

        expect(normalized?.binanceMarketType).to.equal('spot');
    });

    it('normalizes malformed saved strategy configs and filters unusable entries', () => {
        const normalized = normalizeStoredStrategyConfig({
            name: 'My Config',
            symbol: 'btcusdt',
            interval: '1h',
            strategyKey: '',
            strategyParams: {
                foo: '42',
                bad: 'NaN',
            },
            backtestSettings: {
                initialCapital: '25000',
                tradeFilterMode: 'rsi',
                tradeFilterSettingsToggle: true,
                polymarketOutcomeSymbol: 'ethusdt',
            },
        });

        expect(normalized).to.not.equal(null);
        expect(normalized?.symbol).to.equal('BTCUSDT');
        expect(normalized?.interval).to.equal('1h');
        expect(normalized?.strategyKey).to.equal(DEFAULT_BUILT_IN_STRATEGY_KEY);
        expect(normalized?.strategyParams).to.deep.equal({ foo: 42 });
        expect(normalized?.backtestSettings.initialCapital).to.equal(25000);
        expect('tradeFilterMode' in (normalized?.backtestSettings as Record<string, unknown>)).to.equal(false);
        expect('tradeFilterSettingsToggle' in (normalized?.backtestSettings as Record<string, unknown>)).to.equal(false);
        expect(normalized?.backtestSettings.polymarketOutcomeSymbol).to.equal('ETHUSDT');
        expect(normalizeStoredStrategyConfig({ strategyKey: 'missing-name' })).to.equal(null);
    });

    it('sorts saved strategy configs by createdAt newest first', () => {
        const sorted = sortStrategyConfigsNewestFirst([
            {
                name: 'Oldest',
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-03-01T00:00:00.000Z',
                strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
                strategyParams: {},
                backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
            },
            {
                name: 'Newest',
                createdAt: '2026-03-01T00:00:00.000Z',
                updatedAt: '2026-03-02T00:00:00.000Z',
                strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
                strategyParams: {},
                backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
            },
            {
                name: 'Middle',
                createdAt: '2026-02-01T00:00:00.000Z',
                updatedAt: '2026-03-03T00:00:00.000Z',
                strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
                strategyParams: {},
                backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
            },
        ]);

        expect(sorted.map((config) => config.name)).to.deep.equal(['Newest', 'Middle', 'Oldest']);
    });

    it('normalizes stored ensemble signal recipes and filters unusable payloads', () => {
        const normalized = normalizeStoredEnsembleSignalRecipe({
            name: 'Saved Conflict Recipe',
            symbol: 'XRPUSDT',
            interval: '5m',
            mode: 'target_conflict_filter',
            directionSlice: 'long_only',
            anchorConfigName: 'Target Config',
            anchorConfig: {
                name: 'Target Config',
                strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
                strategyParams: { threshold: '12' },
                backtestSettings: {
                    initialCapital: '15000',
                    tradeFilterMode: 'rsi',
                    tradeFilterSettingsToggle: true,
                },
            },
            componentConfigs: [
                {
                    name: 'Target Config',
                    strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
                    strategyParams: { threshold: '12' },
                    backtestSettings: {
                        initialCapital: '15000',
                        tradeFilterMode: 'rsi',
                        tradeFilterSettingsToggle: true,
                    },
                },
                {
                    name: 'Context Config',
                    strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
                    strategyParams: { threshold: '7' },
                    backtestSettings: {
                        initialCapital: '12000',
                    },
                },
            ],
            notes: 'target anchored',
            metrics: {
                keptTrades: '42',
                wins: '28',
                losses: '14',
                winRate: '0.6667',
                coverage: '0.51',
                overlapRate: '0.58',
            },
        });

        expect(normalized).to.not.equal(null);
        expect(normalized?.source).to.equal('ensemble_polymarket');
        expect(normalized?.directionSlice).to.equal('long_only');
        expect(normalized?.anchorConfig.strategyParams).to.deep.equal({ threshold: 12 });
        expect(normalized?.componentConfigs).to.have.length(2);
        expect(normalized?.metrics.keptTrades).to.equal(42);
        expect(normalized?.metrics.wins).to.equal(28);
        expect(normalized?.metrics.losses).to.equal(14);
        expect(normalized?.metrics.winRate).to.equal(0.6667);
        expect(normalized?.metrics.coverage).to.equal(0.51);
        expect(normalizeStoredEnsembleSignalRecipe({
            name: 'Broken Recipe',
            anchorConfig: null,
            componentConfigs: [],
        })).to.equal(null);
    });

    it('sorts saved ensemble signal recipes by createdAt newest first', () => {
        const makeRecipe = (name: string, createdAt: string): EnsembleSignalRecipe => ({
            name,
            createdAt,
            updatedAt: createdAt,
            source: 'ensemble_polymarket',
            symbol: 'XRPUSDT',
            interval: '5m',
            mode: 'target_conflict_filter',
            directionSlice: 'all',
            anchorConfigName: 'Anchor',
            anchorConfig: {
                name: 'Anchor',
                createdAt,
                updatedAt: createdAt,
                strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
                strategyParams: {},
                backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
            },
            componentConfigs: [
                {
                    name: 'Anchor',
                    createdAt,
                    updatedAt: createdAt,
                    strategyKey: DEFAULT_BUILT_IN_STRATEGY_KEY,
                    strategyParams: {},
                    backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
                },
            ],
            notes: '',
            metrics: {
                keptTrades: 0,
                wins: 0,
                losses: 0,
                winRate: 0,
                retentionRate: null,
                coverage: null,
                overlapRate: null,
                winRateLift: null,
                wilsonLift: null,
            },
        });

        const sorted = sortEnsembleSignalRecipesNewestFirst([
            makeRecipe('Oldest Recipe', '2026-01-01T00:00:00.000Z'),
            makeRecipe('Newest Recipe', '2026-03-01T00:00:00.000Z'),
            makeRecipe('Middle Recipe', '2026-02-01T00:00:00.000Z'),
        ]);

        expect(sorted.map((recipe) => recipe.name)).to.deep.equal([
            'Newest Recipe',
            'Middle Recipe',
            'Oldest Recipe',
        ]);
    });

    it('keeps the shared default strategy key aligned with the built-in manifest', () => {
        expect(strategyManifest.some((entry) => entry.key === DEFAULT_BUILT_IN_STRATEGY_KEY)).to.equal(true);
    });

    it('persists and normalizes crossSymbolSecondary through stored settings', () => {
        const normalized = normalizeStoredBacktestSettings({
            crossSymbolSecondary: '  ethusdt  ',
        });
        expect(normalized.crossSymbolSecondary).to.equal('ETHUSDT');

        const empty = normalizeStoredBacktestSettings({});
        expect(empty.crossSymbolSecondary).to.equal('');

        const whitespace = normalizeStoredBacktestSettings({
            crossSymbolSecondary: '   ',
        });
        expect(whitespace.crossSymbolSecondary).to.equal('');

        const nonString = normalizeStoredBacktestSettings({
            crossSymbolSecondary: 42,
        });
        expect(nonString.crossSymbolSecondary).to.equal('');
    });

    it('strips crossSymbolSecondary from Rust payloads', () => {
        const settings: BacktestSettings = {
            crossSymbolSecondary: 'ETHUSDT',
        } as BacktestSettings;
        const sanitized = sanitizeBacktestSettingsForRust(settings);
        expect('crossSymbolSecondary' in (sanitized as Record<string, unknown>)).to.equal(false);
    });

    it('resolves crossSymbolSecondary from raw backtest settings', () => {
        const resolved = resolveBacktestSettingsFromRaw({
            crossSymbolSecondary: 'solusdt',
        } as unknown as BacktestSettings);
        expect(resolved.crossSymbolSecondary).to.equal('solusdt');
    });

    it('includes crossSymbolSecondary in DOM contracts as Rust-unsupported', () => {
        const contract = getBacktestDomSettingContract('crossSymbolSecondary');
        expect(contract).to.not.equal(undefined);
        expect(contract?.rustSupport).to.equal('unsupported');
    });
});
