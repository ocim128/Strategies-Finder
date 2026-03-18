/**
 * Settings Manager - Handles auto-save, load, and reset of all application settings
 * 
 * Features:
 * - Auto-save settings to localStorage on changes
 * - Auto-load settings on browser open
 * - Reset to default functionality
 * - Save/Load named strategy configurations
 */

import { state } from "./state";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import {
    readSettingsCheckbox,
    readSettingsNumber,
    readSettingsSelect,
    triggerSettingsChangeEvents,
    writeSettingsCheckbox,
    writeSettingsNumber,
    writeSettingsSelect,
} from "./settings-dom";
import {
    DEFAULT_APP_SETTINGS,
    DEFAULT_BACKTEST_SETTINGS,
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredStrategyConfig,
    resolveExecutionModelValue,
    resolveMarketMode,
    resolveRiskModeValue,
    resolveTakeProfitModeValue,
    resolveTradeDirection,
    resolveTradeFilterMode,
    resolveTradeFilterModeValue,
    resolveTradeFilterToggle,
    resolveTwoHourCloseParity,
    type AppSettings,
    type BacktestSettingsData,
    type StrategyConfig,
} from "./settings-model";

export {
    DEFAULT_APP_SETTINGS,
    DEFAULT_BACKTEST_SETTINGS,
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredStrategyConfig,
};
export type { AppSettings, BacktestSettingsData, StrategyConfig } from "./settings-model";

import type { BacktestSettings, ExecutionModel, MarketMode, TradeDirection, TradeFilterMode } from './types/strategies';

// ============================================================================
// Storage Keys
// ============================================================================

const STORAGE_KEYS = {
    APP_SETTINGS: 'playground_app_settings',
    STRATEGY_CONFIGS: 'playground_strategy_configs',
};

// ============================================================================
// Settings Manager
// ============================================================================

class SettingsManager {
    private autoSaveEnabled: boolean = true;
    private saveDebounceTimeout: number | null = null;

    // ========================================================================
    // Auto-Save Settings
    // ========================================================================

    public getCurrentSettings(): AppSettings {
        return {
            currentSymbol: state.currentSymbol,
            currentInterval: state.currentInterval,
            isDarkTheme: state.isDarkTheme,
            currentStrategyKey: state.currentStrategyKey,
            chartMode: state.chartMode,
            backtestSettings: this.getBacktestSettings(),
        };
    }

    public getBacktestSettings(): BacktestSettingsData {
        return {
            // Capital settings
            initialCapital: this.readNumber('initialCapital', DEFAULT_BACKTEST_SETTINGS.initialCapital),
            positionSize: this.readNumber('positionSize', DEFAULT_BACKTEST_SETTINGS.positionSize),
            commission: this.readNumber('commission', DEFAULT_BACKTEST_SETTINGS.commission),
            fixedTradeToggle: this.readCheckbox('fixedTradeToggle', DEFAULT_BACKTEST_SETTINGS.fixedTradeToggle),
            fixedTradeAmount: this.readNumber('fixedTradeAmount', DEFAULT_BACKTEST_SETTINGS.fixedTradeAmount),
            useRustEngine: this.readCheckbox('useRustEngineToggle', DEFAULT_BACKTEST_SETTINGS.useRustEngine),

            // Risk management
            riskSettingsToggle: this.readCheckbox('riskSettingsToggle', DEFAULT_BACKTEST_SETTINGS.riskSettingsToggle),
            riskMode: this.resolveRiskModeValue(this.readSelect('riskMode', DEFAULT_BACKTEST_SETTINGS.riskMode)),
            atrPeriod: this.readNumber('atrPeriod', DEFAULT_BACKTEST_SETTINGS.atrPeriod),
            stopLossAtr: this.readNumber('stopLossAtr', DEFAULT_BACKTEST_SETTINGS.stopLossAtr),
            takeProfitAtr: this.readNumber('takeProfitAtr', DEFAULT_BACKTEST_SETTINGS.takeProfitAtr),
            trailingAtr: this.readNumber('trailingAtr', DEFAULT_BACKTEST_SETTINGS.trailingAtr),
            partialTakeProfitAtR: this.readNumber('partialTakeProfitAtR', DEFAULT_BACKTEST_SETTINGS.partialTakeProfitAtR),
            partialTakeProfitPercent: this.readNumber('partialTakeProfitPercent', DEFAULT_BACKTEST_SETTINGS.partialTakeProfitPercent),
            breakEvenAtR: this.readNumber('breakEvenAtR', DEFAULT_BACKTEST_SETTINGS.breakEvenAtR),
            breakEvenPercent: this.readNumber('breakEvenPercent', DEFAULT_BACKTEST_SETTINGS.breakEvenPercent),
            timeStopBars: this.readNumber('timeStopBars', DEFAULT_BACKTEST_SETTINGS.timeStopBars),
            stopLossPercent: this.readNumber('stopLossPercent', DEFAULT_BACKTEST_SETTINGS.stopLossPercent),
            takeProfitPercent: this.readNumber('takeProfitPercent', DEFAULT_BACKTEST_SETTINGS.takeProfitPercent),
            takeProfitMode: this.resolveTakeProfitModeValue(this.readSelect('takeProfitMode', DEFAULT_BACKTEST_SETTINGS.takeProfitMode)),
            takeProfitMfeLookbackTrades: this.readNumber('takeProfitMfeLookbackTrades', DEFAULT_BACKTEST_SETTINGS.takeProfitMfeLookbackTrades),
            takeProfitMfePercentile: this.readNumber('takeProfitMfePercentile', DEFAULT_BACKTEST_SETTINGS.takeProfitMfePercentile),
            takeProfitShrinkageStrength: this.readNumber('takeProfitShrinkageStrength', DEFAULT_BACKTEST_SETTINGS.takeProfitShrinkageStrength),
            takeProfitMomentumRsiPeriod: this.readNumber('takeProfitMomentumRsiPeriod', DEFAULT_BACKTEST_SETTINGS.takeProfitMomentumRsiPeriod),
            takeProfitMomentumRsiPauseLevel: this.readNumber('takeProfitMomentumRsiPauseLevel', DEFAULT_BACKTEST_SETTINGS.takeProfitMomentumRsiPauseLevel),
            takeProfitMomentumDecayPercentPerBar: this.readNumber('takeProfitMomentumDecayPercentPerBar', DEFAULT_BACKTEST_SETTINGS.takeProfitMomentumDecayPercentPerBar),
            takeProfitVelocityFastBars: this.readNumber('takeProfitVelocityFastBars', DEFAULT_BACKTEST_SETTINGS.takeProfitVelocityFastBars),
            takeProfitVelocitySlowBars: this.readNumber('takeProfitVelocitySlowBars', DEFAULT_BACKTEST_SETTINGS.takeProfitVelocitySlowBars),
            takeProfitVelocityProgressPercent: this.readNumber('takeProfitVelocityProgressPercent', DEFAULT_BACKTEST_SETTINGS.takeProfitVelocityProgressPercent),
            takeProfitVelocityExpandMultiplier: this.readNumber('takeProfitVelocityExpandMultiplier', DEFAULT_BACKTEST_SETTINGS.takeProfitVelocityExpandMultiplier),
            takeProfitVelocityShrinkMultiplier: this.readNumber('takeProfitVelocityShrinkMultiplier', DEFAULT_BACKTEST_SETTINGS.takeProfitVelocityShrinkMultiplier),
            takeProfitClimaxStdDevPeriod: this.readNumber('takeProfitClimaxStdDevPeriod', DEFAULT_BACKTEST_SETTINGS.takeProfitClimaxStdDevPeriod),
            takeProfitClimaxStdDevMultiple: this.readNumber('takeProfitClimaxStdDevMultiple', DEFAULT_BACKTEST_SETTINGS.takeProfitClimaxStdDevMultiple),
            takeProfitClimaxVolumePeriod: this.readNumber('takeProfitClimaxVolumePeriod', DEFAULT_BACKTEST_SETTINGS.takeProfitClimaxVolumePeriod),
            takeProfitClimaxVolumeMultiple: this.readNumber('takeProfitClimaxVolumeMultiple', DEFAULT_BACKTEST_SETTINGS.takeProfitClimaxVolumeMultiple),
            takeProfitEquityLossStreak: this.readNumber('takeProfitEquityLossStreak', DEFAULT_BACKTEST_SETTINGS.takeProfitEquityLossStreak),
            takeProfitEquityDrawdownPercent: this.readNumber('takeProfitEquityDrawdownPercent', DEFAULT_BACKTEST_SETTINGS.takeProfitEquityDrawdownPercent),
            takeProfitEquityDefensiveMultiplier: this.readNumber('takeProfitEquityDefensiveMultiplier', DEFAULT_BACKTEST_SETTINGS.takeProfitEquityDefensiveMultiplier),
            stopLossEnabled: this.readCheckbox('stopLossToggle', DEFAULT_BACKTEST_SETTINGS.stopLossEnabled),
            takeProfitEnabled: this.readCheckbox('takeProfitToggle', DEFAULT_BACKTEST_SETTINGS.takeProfitEnabled),
            riskMaxHoldBars: this.readNumber('riskMaxHoldBars', DEFAULT_BACKTEST_SETTINGS.riskMaxHoldBars),
            riskMaxHoldEnabled: this.readCheckbox('riskMaxHoldToggle', DEFAULT_BACKTEST_SETTINGS.riskMaxHoldEnabled),
            riskWinStreakStopLossEnabled: this.readCheckbox('riskWinStreakStopLossToggle', DEFAULT_BACKTEST_SETTINGS.riskWinStreakStopLossEnabled),
            riskWinStreakStopLossAfterWins: this.readNumber('riskWinStreakStopLossAfterWins', DEFAULT_BACKTEST_SETTINGS.riskWinStreakStopLossAfterWins),
            riskWinStreakStopLossPercent: this.readNumber('riskWinStreakStopLossPercent', DEFAULT_BACKTEST_SETTINGS.riskWinStreakStopLossPercent),
            marketMode: this.readSelect('marketMode', DEFAULT_BACKTEST_SETTINGS.marketMode) as MarketMode,

            // Trade direction
            tradeDirection: this.readSelect('tradeDirection', DEFAULT_BACKTEST_SETTINGS.tradeDirection) as TradeDirection,
            invertSignals: this.readCheckbox('invertSignalsToggle', DEFAULT_BACKTEST_SETTINGS.invertSignals),
            flipAfterConsecutiveLosses: this.readNumber('flipAfterConsecutiveLosses', DEFAULT_BACKTEST_SETTINGS.flipAfterConsecutiveLosses),
            flipCooldownTrades: this.readNumber('flipCooldownTrades', DEFAULT_BACKTEST_SETTINGS.flipCooldownTrades),
            minTradesBeforeFirstFlip: this.readNumber('minTradesBeforeFirstFlip', DEFAULT_BACKTEST_SETTINGS.minTradesBeforeFirstFlip),

            // Trade filter
            tradeFilterSettingsToggle: this.readCheckbox('tradeFilterSettingsToggle', DEFAULT_BACKTEST_SETTINGS.tradeFilterSettingsToggle),
            tradeFilterMode: this.resolveTradeFilterModeValue(this.readSelect('tradeFilterMode', DEFAULT_BACKTEST_SETTINGS.tradeFilterMode)),
            htfBiasEmaPeriod: this.readNumber('htfBiasEmaPeriod', DEFAULT_BACKTEST_SETTINGS.htfBiasEmaPeriod),
            executionTrendEmaPeriod: this.readNumber('executionTrendEmaPeriod', DEFAULT_BACKTEST_SETTINGS.executionTrendEmaPeriod),
            confirmLookback: this.readNumber('confirmLookback', DEFAULT_BACKTEST_SETTINGS.confirmLookback),
            trendPersistenceWindow: this.readNumber('trendPersistenceWindow', DEFAULT_BACKTEST_SETTINGS.trendPersistenceWindow),
            trendPersistenceMinBars: this.readNumber('trendPersistenceMinBars', DEFAULT_BACKTEST_SETTINGS.trendPersistenceMinBars),
            trendSlopeLookback: this.readNumber('trendSlopeLookback', DEFAULT_BACKTEST_SETTINGS.trendSlopeLookback),
            trendSlopeMinPercent: this.readNumber('trendSlopeMinPercent', DEFAULT_BACKTEST_SETTINGS.trendSlopeMinPercent),
            volumeSmaPeriod: this.readNumber('volumeSmaPeriod', DEFAULT_BACKTEST_SETTINGS.volumeSmaPeriod),
            volumeMultiplier: this.readNumber('volumeMultiplier', DEFAULT_BACKTEST_SETTINGS.volumeMultiplier),
            confirmRsiPeriod: this.readNumber('confirmRsiPeriod', DEFAULT_BACKTEST_SETTINGS.confirmRsiPeriod),
            confirmRsiBullish: this.readNumber('confirmRsiBullish', DEFAULT_BACKTEST_SETTINGS.confirmRsiBullish),
            confirmRsiBearish: this.readNumber('confirmRsiBearish', DEFAULT_BACKTEST_SETTINGS.confirmRsiBearish),
            snapshotAtrFilterToggle: this.readCheckbox('snapshotAtrFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotAtrFilterToggle),
            snapshotAtrPercentMin: this.readNumber('snapshotAtrPercentMin', DEFAULT_BACKTEST_SETTINGS.snapshotAtrPercentMin),
            snapshotAtrPercentMax: this.readNumber('snapshotAtrPercentMax', DEFAULT_BACKTEST_SETTINGS.snapshotAtrPercentMax),
            snapshotVolumeFilterToggle: this.readCheckbox('snapshotVolumeFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeFilterToggle),
            snapshotVolumeRatioMin: this.readNumber('snapshotVolumeRatioMin', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeRatioMin),
            snapshotVolumeRatioMax: this.readNumber('snapshotVolumeRatioMax', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeRatioMax),
            snapshotAdxFilterToggle: this.readCheckbox('snapshotAdxFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotAdxFilterToggle),
            snapshotAdxMin: this.readNumber('snapshotAdxMin', DEFAULT_BACKTEST_SETTINGS.snapshotAdxMin),
            snapshotAdxMax: this.readNumber('snapshotAdxMax', DEFAULT_BACKTEST_SETTINGS.snapshotAdxMax),
            snapshotEmaFilterToggle: this.readCheckbox('snapshotEmaFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotEmaFilterToggle),
            snapshotEmaDistanceMin: this.readNumber('snapshotEmaDistanceMin', DEFAULT_BACKTEST_SETTINGS.snapshotEmaDistanceMin),
            snapshotEmaDistanceMax: this.readNumber('snapshotEmaDistanceMax', DEFAULT_BACKTEST_SETTINGS.snapshotEmaDistanceMax),
            snapshotRsiFilterToggle: this.readCheckbox('snapshotRsiFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotRsiFilterToggle),
            snapshotRsiMin: this.readNumber('snapshotRsiMin', DEFAULT_BACKTEST_SETTINGS.snapshotRsiMin),
            snapshotRsiMax: this.readNumber('snapshotRsiMax', DEFAULT_BACKTEST_SETTINGS.snapshotRsiMax),
            snapshotPriceRangePosFilterToggle: this.readCheckbox('snapshotPriceRangePosFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotPriceRangePosFilterToggle),
            snapshotPriceRangePosMin: this.readNumber('snapshotPriceRangePosMin', DEFAULT_BACKTEST_SETTINGS.snapshotPriceRangePosMin),
            snapshotPriceRangePosMax: this.readNumber('snapshotPriceRangePosMax', DEFAULT_BACKTEST_SETTINGS.snapshotPriceRangePosMax),
            snapshotBarsFromHighFilterToggle: this.readCheckbox('snapshotBarsFromHighFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotBarsFromHighFilterToggle),
            snapshotBarsFromHighMax: this.readNumber('snapshotBarsFromHighMax', DEFAULT_BACKTEST_SETTINGS.snapshotBarsFromHighMax),
            snapshotBarsFromLowFilterToggle: this.readCheckbox('snapshotBarsFromLowFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotBarsFromLowFilterToggle),
            snapshotBarsFromLowMax: this.readNumber('snapshotBarsFromLowMax', DEFAULT_BACKTEST_SETTINGS.snapshotBarsFromLowMax),
            snapshotTrendEfficiencyFilterToggle: this.readCheckbox('snapshotTrendEfficiencyFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotTrendEfficiencyFilterToggle),
            snapshotTrendEfficiencyMin: this.readNumber('snapshotTrendEfficiencyMin', DEFAULT_BACKTEST_SETTINGS.snapshotTrendEfficiencyMin),
            snapshotTrendEfficiencyMax: this.readNumber('snapshotTrendEfficiencyMax', DEFAULT_BACKTEST_SETTINGS.snapshotTrendEfficiencyMax),
            snapshotAtrRegimeFilterToggle: this.readCheckbox('snapshotAtrRegimeFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotAtrRegimeFilterToggle),
            snapshotAtrRegimeRatioMin: this.readNumber('snapshotAtrRegimeRatioMin', DEFAULT_BACKTEST_SETTINGS.snapshotAtrRegimeRatioMin),
            snapshotAtrRegimeRatioMax: this.readNumber('snapshotAtrRegimeRatioMax', DEFAULT_BACKTEST_SETTINGS.snapshotAtrRegimeRatioMax),
            snapshotBodyPercentFilterToggle: this.readCheckbox('snapshotBodyPercentFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotBodyPercentFilterToggle),
            snapshotBodyPercentMin: this.readNumber('snapshotBodyPercentMin', DEFAULT_BACKTEST_SETTINGS.snapshotBodyPercentMin),
            snapshotBodyPercentMax: this.readNumber('snapshotBodyPercentMax', DEFAULT_BACKTEST_SETTINGS.snapshotBodyPercentMax),
            snapshotWickSkewFilterToggle: this.readCheckbox('snapshotWickSkewFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotWickSkewFilterToggle),
            snapshotWickSkewMin: this.readNumber('snapshotWickSkewMin', DEFAULT_BACKTEST_SETTINGS.snapshotWickSkewMin),
            snapshotWickSkewMax: this.readNumber('snapshotWickSkewMax', DEFAULT_BACKTEST_SETTINGS.snapshotWickSkewMax),
            snapshotVolumeTrendFilterToggle: this.readCheckbox('snapshotVolumeTrendFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeTrendFilterToggle),
            snapshotVolumeTrendMin: this.readNumber('snapshotVolumeTrendMin', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeTrendMin),
            snapshotVolumeTrendMax: this.readNumber('snapshotVolumeTrendMax', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeTrendMax),
            snapshotVolumeBurstFilterToggle: this.readCheckbox('snapshotVolumeBurstFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeBurstFilterToggle),
            snapshotVolumeBurstMin: this.readNumber('snapshotVolumeBurstMin', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeBurstMin),
            snapshotVolumeBurstMax: this.readNumber('snapshotVolumeBurstMax', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeBurstMax),
            snapshotVolumePriceDivergenceFilterToggle: this.readCheckbox('snapshotVolumePriceDivergenceFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotVolumePriceDivergenceFilterToggle),
            snapshotVolumePriceDivergenceMin: this.readNumber('snapshotVolumePriceDivergenceMin', DEFAULT_BACKTEST_SETTINGS.snapshotVolumePriceDivergenceMin),
            snapshotVolumePriceDivergenceMax: this.readNumber('snapshotVolumePriceDivergenceMax', DEFAULT_BACKTEST_SETTINGS.snapshotVolumePriceDivergenceMax),
            snapshotVolumeConsistencyFilterToggle: this.readCheckbox('snapshotVolumeConsistencyFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeConsistencyFilterToggle),
            snapshotVolumeConsistencyMin: this.readNumber('snapshotVolumeConsistencyMin', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeConsistencyMin),
            snapshotVolumeConsistencyMax: this.readNumber('snapshotVolumeConsistencyMax', DEFAULT_BACKTEST_SETTINGS.snapshotVolumeConsistencyMax),
            snapshotCloseLocationFilterToggle: this.readCheckbox('snapshotCloseLocationFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotCloseLocationFilterToggle),
            snapshotCloseLocationMin: this.readNumber('snapshotCloseLocationMin', DEFAULT_BACKTEST_SETTINGS.snapshotCloseLocationMin),
            snapshotCloseLocationMax: this.readNumber('snapshotCloseLocationMax', DEFAULT_BACKTEST_SETTINGS.snapshotCloseLocationMax),
            snapshotOppositeWickFilterToggle: this.readCheckbox('snapshotOppositeWickFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotOppositeWickFilterToggle),
            snapshotOppositeWickMin: this.readNumber('snapshotOppositeWickMin', DEFAULT_BACKTEST_SETTINGS.snapshotOppositeWickMin),
            snapshotOppositeWickMax: this.readNumber('snapshotOppositeWickMax', DEFAULT_BACKTEST_SETTINGS.snapshotOppositeWickMax),
            snapshotRangeAtrFilterToggle: this.readCheckbox('snapshotRangeAtrFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotRangeAtrFilterToggle),
            snapshotRangeAtrMultipleMin: this.readNumber('snapshotRangeAtrMultipleMin', DEFAULT_BACKTEST_SETTINGS.snapshotRangeAtrMultipleMin),
            snapshotRangeAtrMultipleMax: this.readNumber('snapshotRangeAtrMultipleMax', DEFAULT_BACKTEST_SETTINGS.snapshotRangeAtrMultipleMax),
            snapshotMomentumFilterToggle: this.readCheckbox('snapshotMomentumFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotMomentumFilterToggle),
            snapshotMomentumConsistencyMin: this.readNumber('snapshotMomentumConsistencyMin', DEFAULT_BACKTEST_SETTINGS.snapshotMomentumConsistencyMin),
            snapshotMomentumConsistencyMax: this.readNumber('snapshotMomentumConsistencyMax', DEFAULT_BACKTEST_SETTINGS.snapshotMomentumConsistencyMax),
            snapshotBreakQualityFilterToggle: this.readCheckbox('snapshotBreakQualityFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotBreakQualityFilterToggle),
            snapshotBreakQualityMin: this.readNumber('snapshotBreakQualityMin', DEFAULT_BACKTEST_SETTINGS.snapshotBreakQualityMin),
            snapshotBreakQualityMax: this.readNumber('snapshotBreakQualityMax', DEFAULT_BACKTEST_SETTINGS.snapshotBreakQualityMax),
            snapshotTf60PerfFilterToggle: this.readCheckbox('snapshotTf60PerfFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotTf60PerfFilterToggle),
            snapshotTf60PerfMin: this.readNumber('snapshotTf60PerfMin', DEFAULT_BACKTEST_SETTINGS.snapshotTf60PerfMin),
            snapshotTf60PerfMax: this.readNumber('snapshotTf60PerfMax', DEFAULT_BACKTEST_SETTINGS.snapshotTf60PerfMax),
            snapshotTf90PerfFilterToggle: this.readCheckbox('snapshotTf90PerfFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotTf90PerfFilterToggle),
            snapshotTf90PerfMin: this.readNumber('snapshotTf90PerfMin', DEFAULT_BACKTEST_SETTINGS.snapshotTf90PerfMin),
            snapshotTf90PerfMax: this.readNumber('snapshotTf90PerfMax', DEFAULT_BACKTEST_SETTINGS.snapshotTf90PerfMax),
            snapshotTf120PerfFilterToggle: this.readCheckbox('snapshotTf120PerfFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotTf120PerfFilterToggle),
            snapshotTf120PerfMin: this.readNumber('snapshotTf120PerfMin', DEFAULT_BACKTEST_SETTINGS.snapshotTf120PerfMin),
            snapshotTf120PerfMax: this.readNumber('snapshotTf120PerfMax', DEFAULT_BACKTEST_SETTINGS.snapshotTf120PerfMax),
            snapshotTf480PerfFilterToggle: this.readCheckbox('snapshotTf480PerfFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotTf480PerfFilterToggle),
            snapshotTf480PerfMin: this.readNumber('snapshotTf480PerfMin', DEFAULT_BACKTEST_SETTINGS.snapshotTf480PerfMin),
            snapshotTf480PerfMax: this.readNumber('snapshotTf480PerfMax', DEFAULT_BACKTEST_SETTINGS.snapshotTf480PerfMax),
            snapshotTfConfluencePerfFilterToggle: this.readCheckbox('snapshotTfConfluencePerfFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotTfConfluencePerfFilterToggle),
            snapshotTfConfluencePerfMin: this.readNumber('snapshotTfConfluencePerfMin', DEFAULT_BACKTEST_SETTINGS.snapshotTfConfluencePerfMin),
            snapshotTfConfluencePerfMax: this.readNumber('snapshotTfConfluencePerfMax', DEFAULT_BACKTEST_SETTINGS.snapshotTfConfluencePerfMax),
            snapshotEntryQualityScoreFilterToggle: this.readCheckbox('snapshotEntryQualityScoreFilterToggle', DEFAULT_BACKTEST_SETTINGS.snapshotEntryQualityScoreFilterToggle),
            snapshotEntryQualityScoreMin: this.readNumber('snapshotEntryQualityScoreMin', DEFAULT_BACKTEST_SETTINGS.snapshotEntryQualityScoreMin),
            snapshotEntryQualityScoreMax: this.readNumber('snapshotEntryQualityScoreMax', DEFAULT_BACKTEST_SETTINGS.snapshotEntryQualityScoreMax),

            // Execution realism
            executionModel: this.resolveExecutionModelValue(this.readSelect('executionModel', DEFAULT_BACKTEST_SETTINGS.executionModel)),
            allowSameBarExit: this.readCheckbox('allowSameBarExitToggle', DEFAULT_BACKTEST_SETTINGS.allowSameBarExit),
            slippageBps: this.readNumber('slippageBps', DEFAULT_BACKTEST_SETTINGS.slippageBps),
            maxOpenTrades: Number(this.readSelect('maxOpenTrades', String(DEFAULT_BACKTEST_SETTINGS.maxOpenTrades))),
            warmUpEntryEnabled: this.readCheckbox('warmUpEntryToggle', DEFAULT_BACKTEST_SETTINGS.warmUpEntryEnabled),
            strategyTimeframeEnabled: this.readCheckbox('strategyTimeframeToggle', DEFAULT_BACKTEST_SETTINGS.strategyTimeframeEnabled),
            strategyTimeframeMinutes: this.readNumber('strategyTimeframeMinutes', DEFAULT_BACKTEST_SETTINGS.strategyTimeframeMinutes),
            twoHourCloseParity: this.resolveTwoHourCloseParity(
                this.readSelect('twoHourCloseParity', DEFAULT_BACKTEST_SETTINGS.twoHourCloseParity)
            ),
        };
    }



    public saveSettings(): void {
        if (!this.autoSaveEnabled) return;

        const settings = this.getCurrentSettings();
        try {
            localStorage.setItem(STORAGE_KEYS.APP_SETTINGS, JSON.stringify(settings));
            debugLogger.event('settings.saved', { strategy: settings.currentStrategyKey });
        } catch (e) {
            debugLogger.error('settings.save_failed', { error: e instanceof Error ? e.message : String(e) });
        }
    }

    public saveSettingsDebounced(): void {
        if (this.saveDebounceTimeout !== null) {
            clearTimeout(this.saveDebounceTimeout);
        }
        this.saveDebounceTimeout = window.setTimeout(() => {
            this.saveSettings();
            this.saveDebounceTimeout = null;
        }, 500);
    }

    public loadSettings(): AppSettings | null {
        try {
            const data = localStorage.getItem(STORAGE_KEYS.APP_SETTINGS);
            if (data) {
                const settings = normalizeStoredAppSettings(JSON.parse(data));
                if (!settings) return null;

                debugLogger.event('settings.loaded', { strategy: settings.currentStrategyKey });
                return settings;
            }
        } catch (e) {
            debugLogger.error('settings.load_failed', { error: e instanceof Error ? e.message : String(e) });
        }
        return null;
    }

    public applySettings(settings: AppSettings): void {
        this.autoSaveEnabled = false;
        try {
            // Apply backtest settings to UI
            this.applyBacktestSettings(settings.backtestSettings);



            // Set state values (these trigger reactive updates)
            if (settings.isDarkTheme !== state.isDarkTheme) {
                state.set('isDarkTheme', settings.isDarkTheme);
            }

            // Apply chart mode
            if (settings.chartMode && settings.chartMode !== state.chartMode) {
                state.set('chartMode', settings.chartMode);
            }

            debugLogger.event('settings.applied', { strategy: settings.currentStrategyKey });
        } finally {
            this.autoSaveEnabled = true;
        }
    }

    public applyBacktestSettings(settings: BacktestSettingsData): void {
        // Capital settings
        this.writeNumber('initialCapital', settings.initialCapital);
        this.writeNumber('positionSize', settings.positionSize);
        this.writeNumber('commission', settings.commission);
        this.writeCheckbox('fixedTradeToggle', settings.fixedTradeToggle);
        this.writeNumber('fixedTradeAmount', settings.fixedTradeAmount);
        this.writeCheckbox('useRustEngineToggle', settings.useRustEngine ?? DEFAULT_BACKTEST_SETTINGS.useRustEngine);

        // Risk management
        this.writeCheckbox('riskSettingsToggle', settings.riskSettingsToggle);
        this.writeSelect('riskMode', settings.riskMode);
        this.writeNumber('atrPeriod', settings.atrPeriod);
        this.writeNumber('stopLossAtr', settings.stopLossAtr);
        this.writeNumber('takeProfitAtr', settings.takeProfitAtr);
        this.writeNumber('trailingAtr', settings.trailingAtr);
        this.writeNumber('partialTakeProfitAtR', settings.partialTakeProfitAtR);
        this.writeNumber('partialTakeProfitPercent', settings.partialTakeProfitPercent);
        this.writeNumber('breakEvenAtR', settings.breakEvenAtR);
        this.writeNumber('breakEvenPercent', settings.breakEvenPercent ?? 0);
        this.writeNumber('timeStopBars', settings.timeStopBars);
        this.writeNumber('stopLossPercent', settings.stopLossPercent);
        this.writeNumber('takeProfitPercent', settings.takeProfitPercent);
        this.writeSelect('takeProfitMode', settings.takeProfitMode ?? DEFAULT_BACKTEST_SETTINGS.takeProfitMode);
        this.writeNumber('takeProfitMfeLookbackTrades', settings.takeProfitMfeLookbackTrades ?? DEFAULT_BACKTEST_SETTINGS.takeProfitMfeLookbackTrades);
        this.writeNumber('takeProfitMfePercentile', settings.takeProfitMfePercentile ?? DEFAULT_BACKTEST_SETTINGS.takeProfitMfePercentile);
        this.writeNumber('takeProfitShrinkageStrength', settings.takeProfitShrinkageStrength ?? DEFAULT_BACKTEST_SETTINGS.takeProfitShrinkageStrength);
        this.writeNumber('takeProfitMomentumRsiPeriod', settings.takeProfitMomentumRsiPeriod ?? DEFAULT_BACKTEST_SETTINGS.takeProfitMomentumRsiPeriod);
        this.writeNumber('takeProfitMomentumRsiPauseLevel', settings.takeProfitMomentumRsiPauseLevel ?? DEFAULT_BACKTEST_SETTINGS.takeProfitMomentumRsiPauseLevel);
        this.writeNumber('takeProfitMomentumDecayPercentPerBar', settings.takeProfitMomentumDecayPercentPerBar ?? DEFAULT_BACKTEST_SETTINGS.takeProfitMomentumDecayPercentPerBar);
        this.writeNumber('takeProfitVelocityFastBars', settings.takeProfitVelocityFastBars ?? DEFAULT_BACKTEST_SETTINGS.takeProfitVelocityFastBars);
        this.writeNumber('takeProfitVelocitySlowBars', settings.takeProfitVelocitySlowBars ?? DEFAULT_BACKTEST_SETTINGS.takeProfitVelocitySlowBars);
        this.writeNumber('takeProfitVelocityProgressPercent', settings.takeProfitVelocityProgressPercent ?? DEFAULT_BACKTEST_SETTINGS.takeProfitVelocityProgressPercent);
        this.writeNumber('takeProfitVelocityExpandMultiplier', settings.takeProfitVelocityExpandMultiplier ?? DEFAULT_BACKTEST_SETTINGS.takeProfitVelocityExpandMultiplier);
        this.writeNumber('takeProfitVelocityShrinkMultiplier', settings.takeProfitVelocityShrinkMultiplier ?? DEFAULT_BACKTEST_SETTINGS.takeProfitVelocityShrinkMultiplier);
        this.writeNumber('takeProfitClimaxStdDevPeriod', settings.takeProfitClimaxStdDevPeriod ?? DEFAULT_BACKTEST_SETTINGS.takeProfitClimaxStdDevPeriod);
        this.writeNumber('takeProfitClimaxStdDevMultiple', settings.takeProfitClimaxStdDevMultiple ?? DEFAULT_BACKTEST_SETTINGS.takeProfitClimaxStdDevMultiple);
        this.writeNumber('takeProfitClimaxVolumePeriod', settings.takeProfitClimaxVolumePeriod ?? DEFAULT_BACKTEST_SETTINGS.takeProfitClimaxVolumePeriod);
        this.writeNumber('takeProfitClimaxVolumeMultiple', settings.takeProfitClimaxVolumeMultiple ?? DEFAULT_BACKTEST_SETTINGS.takeProfitClimaxVolumeMultiple);
        this.writeNumber('takeProfitEquityLossStreak', settings.takeProfitEquityLossStreak ?? DEFAULT_BACKTEST_SETTINGS.takeProfitEquityLossStreak);
        this.writeNumber('takeProfitEquityDrawdownPercent', settings.takeProfitEquityDrawdownPercent ?? DEFAULT_BACKTEST_SETTINGS.takeProfitEquityDrawdownPercent);
        this.writeNumber('takeProfitEquityDefensiveMultiplier', settings.takeProfitEquityDefensiveMultiplier ?? DEFAULT_BACKTEST_SETTINGS.takeProfitEquityDefensiveMultiplier);
        this.writeCheckbox('stopLossToggle', settings.stopLossEnabled);
        this.writeCheckbox('takeProfitToggle', settings.takeProfitEnabled);
        this.writeNumber('riskMaxHoldBars', settings.riskMaxHoldBars ?? DEFAULT_BACKTEST_SETTINGS.riskMaxHoldBars);
        this.writeCheckbox('riskMaxHoldToggle', settings.riskMaxHoldEnabled ?? DEFAULT_BACKTEST_SETTINGS.riskMaxHoldEnabled);
        this.writeCheckbox('riskWinStreakStopLossToggle', settings.riskWinStreakStopLossEnabled ?? DEFAULT_BACKTEST_SETTINGS.riskWinStreakStopLossEnabled);
        this.writeNumber('riskWinStreakStopLossAfterWins', settings.riskWinStreakStopLossAfterWins ?? DEFAULT_BACKTEST_SETTINGS.riskWinStreakStopLossAfterWins);
        this.writeNumber('riskWinStreakStopLossPercent', settings.riskWinStreakStopLossPercent ?? DEFAULT_BACKTEST_SETTINGS.riskWinStreakStopLossPercent);
        this.writeSelect('marketMode', this.resolveMarketMode(settings));

        // Trade direction
        this.writeSelect('tradeDirection', this.resolveTradeDirection(settings));
        this.writeCheckbox('invertSignalsToggle', settings.invertSignals ?? DEFAULT_BACKTEST_SETTINGS.invertSignals);
        this.writeNumber('flipAfterConsecutiveLosses', settings.flipAfterConsecutiveLosses ?? DEFAULT_BACKTEST_SETTINGS.flipAfterConsecutiveLosses);
        this.writeNumber('flipCooldownTrades', settings.flipCooldownTrades ?? DEFAULT_BACKTEST_SETTINGS.flipCooldownTrades);
        this.writeNumber('minTradesBeforeFirstFlip', settings.minTradesBeforeFirstFlip ?? DEFAULT_BACKTEST_SETTINGS.minTradesBeforeFirstFlip);

        // Trade filter
        this.writeCheckbox('tradeFilterSettingsToggle', this.resolveTradeFilterToggle(settings));
        this.writeSelect('tradeFilterMode', this.resolveTradeFilterMode(settings));
        this.writeNumber('htfBiasEmaPeriod', settings.htfBiasEmaPeriod ?? DEFAULT_BACKTEST_SETTINGS.htfBiasEmaPeriod);
        this.writeNumber('executionTrendEmaPeriod', settings.executionTrendEmaPeriod ?? DEFAULT_BACKTEST_SETTINGS.executionTrendEmaPeriod);
        this.writeNumber('confirmLookback', settings.confirmLookback ?? DEFAULT_BACKTEST_SETTINGS.confirmLookback);
        this.writeNumber('trendPersistenceWindow', settings.trendPersistenceWindow ?? DEFAULT_BACKTEST_SETTINGS.trendPersistenceWindow);
        this.writeNumber('trendPersistenceMinBars', settings.trendPersistenceMinBars ?? DEFAULT_BACKTEST_SETTINGS.trendPersistenceMinBars);
        this.writeNumber('trendSlopeLookback', settings.trendSlopeLookback ?? DEFAULT_BACKTEST_SETTINGS.trendSlopeLookback);
        this.writeNumber('trendSlopeMinPercent', settings.trendSlopeMinPercent ?? DEFAULT_BACKTEST_SETTINGS.trendSlopeMinPercent);
        this.writeNumber('volumeSmaPeriod', settings.volumeSmaPeriod ?? DEFAULT_BACKTEST_SETTINGS.volumeSmaPeriod);
        this.writeNumber('volumeMultiplier', settings.volumeMultiplier ?? DEFAULT_BACKTEST_SETTINGS.volumeMultiplier);
        this.writeNumber('confirmRsiPeriod', settings.confirmRsiPeriod ?? DEFAULT_BACKTEST_SETTINGS.confirmRsiPeriod);
        this.writeNumber('confirmRsiBullish', settings.confirmRsiBullish ?? DEFAULT_BACKTEST_SETTINGS.confirmRsiBullish);
        this.writeNumber('confirmRsiBearish', settings.confirmRsiBearish ?? DEFAULT_BACKTEST_SETTINGS.confirmRsiBearish);
        this.writeCheckbox('snapshotAtrFilterToggle', settings.snapshotAtrFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotAtrFilterToggle);
        this.writeNumber('snapshotAtrPercentMin', settings.snapshotAtrPercentMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotAtrPercentMin);
        this.writeNumber('snapshotAtrPercentMax', settings.snapshotAtrPercentMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotAtrPercentMax);
        this.writeCheckbox('snapshotVolumeFilterToggle', settings.snapshotVolumeFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeFilterToggle);
        this.writeNumber('snapshotVolumeRatioMin', settings.snapshotVolumeRatioMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeRatioMin);
        this.writeNumber('snapshotVolumeRatioMax', settings.snapshotVolumeRatioMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeRatioMax);
        this.writeCheckbox('snapshotAdxFilterToggle', settings.snapshotAdxFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotAdxFilterToggle);
        this.writeNumber('snapshotAdxMin', settings.snapshotAdxMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotAdxMin);
        this.writeNumber('snapshotAdxMax', settings.snapshotAdxMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotAdxMax);
        this.writeCheckbox('snapshotEmaFilterToggle', settings.snapshotEmaFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotEmaFilterToggle);
        this.writeNumber('snapshotEmaDistanceMin', settings.snapshotEmaDistanceMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotEmaDistanceMin);
        this.writeNumber('snapshotEmaDistanceMax', settings.snapshotEmaDistanceMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotEmaDistanceMax);
        this.writeCheckbox('snapshotRsiFilterToggle', settings.snapshotRsiFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotRsiFilterToggle);
        this.writeNumber('snapshotRsiMin', settings.snapshotRsiMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotRsiMin);
        this.writeNumber('snapshotRsiMax', settings.snapshotRsiMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotRsiMax);
        this.writeCheckbox('snapshotPriceRangePosFilterToggle', settings.snapshotPriceRangePosFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotPriceRangePosFilterToggle);
        this.writeNumber('snapshotPriceRangePosMin', settings.snapshotPriceRangePosMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotPriceRangePosMin);
        this.writeNumber('snapshotPriceRangePosMax', settings.snapshotPriceRangePosMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotPriceRangePosMax);
        this.writeCheckbox('snapshotBarsFromHighFilterToggle', settings.snapshotBarsFromHighFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotBarsFromHighFilterToggle);
        this.writeNumber('snapshotBarsFromHighMax', settings.snapshotBarsFromHighMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotBarsFromHighMax);
        this.writeCheckbox('snapshotBarsFromLowFilterToggle', settings.snapshotBarsFromLowFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotBarsFromLowFilterToggle);
        this.writeNumber('snapshotBarsFromLowMax', settings.snapshotBarsFromLowMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotBarsFromLowMax);
        this.writeCheckbox('snapshotTrendEfficiencyFilterToggle', settings.snapshotTrendEfficiencyFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotTrendEfficiencyFilterToggle);
        this.writeNumber('snapshotTrendEfficiencyMin', settings.snapshotTrendEfficiencyMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotTrendEfficiencyMin);
        this.writeNumber('snapshotTrendEfficiencyMax', settings.snapshotTrendEfficiencyMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotTrendEfficiencyMax);
        this.writeCheckbox('snapshotAtrRegimeFilterToggle', settings.snapshotAtrRegimeFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotAtrRegimeFilterToggle);
        this.writeNumber('snapshotAtrRegimeRatioMin', settings.snapshotAtrRegimeRatioMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotAtrRegimeRatioMin);
        this.writeNumber('snapshotAtrRegimeRatioMax', settings.snapshotAtrRegimeRatioMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotAtrRegimeRatioMax);
        this.writeCheckbox('snapshotBodyPercentFilterToggle', settings.snapshotBodyPercentFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotBodyPercentFilterToggle);
        this.writeNumber('snapshotBodyPercentMin', settings.snapshotBodyPercentMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotBodyPercentMin);
        this.writeNumber('snapshotBodyPercentMax', settings.snapshotBodyPercentMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotBodyPercentMax);
        this.writeCheckbox('snapshotWickSkewFilterToggle', settings.snapshotWickSkewFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotWickSkewFilterToggle);
        this.writeNumber('snapshotWickSkewMin', settings.snapshotWickSkewMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotWickSkewMin);
        this.writeNumber('snapshotWickSkewMax', settings.snapshotWickSkewMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotWickSkewMax);
        this.writeCheckbox('snapshotVolumeTrendFilterToggle', settings.snapshotVolumeTrendFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeTrendFilterToggle);
        this.writeNumber('snapshotVolumeTrendMin', settings.snapshotVolumeTrendMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeTrendMin);
        this.writeNumber('snapshotVolumeTrendMax', settings.snapshotVolumeTrendMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeTrendMax);
        this.writeCheckbox('snapshotVolumeBurstFilterToggle', settings.snapshotVolumeBurstFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeBurstFilterToggle);
        this.writeNumber('snapshotVolumeBurstMin', settings.snapshotVolumeBurstMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeBurstMin);
        this.writeNumber('snapshotVolumeBurstMax', settings.snapshotVolumeBurstMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeBurstMax);
        this.writeCheckbox('snapshotVolumePriceDivergenceFilterToggle', settings.snapshotVolumePriceDivergenceFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumePriceDivergenceFilterToggle);
        this.writeNumber('snapshotVolumePriceDivergenceMin', settings.snapshotVolumePriceDivergenceMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumePriceDivergenceMin);
        this.writeNumber('snapshotVolumePriceDivergenceMax', settings.snapshotVolumePriceDivergenceMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumePriceDivergenceMax);
        this.writeCheckbox('snapshotVolumeConsistencyFilterToggle', settings.snapshotVolumeConsistencyFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeConsistencyFilterToggle);
        this.writeNumber('snapshotVolumeConsistencyMin', settings.snapshotVolumeConsistencyMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeConsistencyMin);
        this.writeNumber('snapshotVolumeConsistencyMax', settings.snapshotVolumeConsistencyMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotVolumeConsistencyMax);
        this.writeCheckbox('snapshotCloseLocationFilterToggle', settings.snapshotCloseLocationFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotCloseLocationFilterToggle);
        this.writeNumber('snapshotCloseLocationMin', settings.snapshotCloseLocationMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotCloseLocationMin);
        this.writeNumber('snapshotCloseLocationMax', settings.snapshotCloseLocationMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotCloseLocationMax);
        this.writeCheckbox('snapshotOppositeWickFilterToggle', settings.snapshotOppositeWickFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotOppositeWickFilterToggle);
        this.writeNumber('snapshotOppositeWickMin', settings.snapshotOppositeWickMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotOppositeWickMin);
        this.writeNumber('snapshotOppositeWickMax', settings.snapshotOppositeWickMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotOppositeWickMax);
        this.writeCheckbox('snapshotRangeAtrFilterToggle', settings.snapshotRangeAtrFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotRangeAtrFilterToggle);
        this.writeNumber('snapshotRangeAtrMultipleMin', settings.snapshotRangeAtrMultipleMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotRangeAtrMultipleMin);
        this.writeNumber('snapshotRangeAtrMultipleMax', settings.snapshotRangeAtrMultipleMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotRangeAtrMultipleMax);
        this.writeCheckbox('snapshotMomentumFilterToggle', settings.snapshotMomentumFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotMomentumFilterToggle);
        this.writeNumber('snapshotMomentumConsistencyMin', settings.snapshotMomentumConsistencyMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotMomentumConsistencyMin);
        this.writeNumber('snapshotMomentumConsistencyMax', settings.snapshotMomentumConsistencyMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotMomentumConsistencyMax);
        this.writeCheckbox('snapshotBreakQualityFilterToggle', settings.snapshotBreakQualityFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotBreakQualityFilterToggle);
        this.writeNumber('snapshotBreakQualityMin', settings.snapshotBreakQualityMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotBreakQualityMin);
        this.writeNumber('snapshotBreakQualityMax', settings.snapshotBreakQualityMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotBreakQualityMax);
        this.writeCheckbox('snapshotTf60PerfFilterToggle', settings.snapshotTf60PerfFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf60PerfFilterToggle);
        this.writeNumber('snapshotTf60PerfMin', settings.snapshotTf60PerfMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf60PerfMin);
        this.writeNumber('snapshotTf60PerfMax', settings.snapshotTf60PerfMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf60PerfMax);
        this.writeCheckbox('snapshotTf90PerfFilterToggle', settings.snapshotTf90PerfFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf90PerfFilterToggle);
        this.writeNumber('snapshotTf90PerfMin', settings.snapshotTf90PerfMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf90PerfMin);
        this.writeNumber('snapshotTf90PerfMax', settings.snapshotTf90PerfMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf90PerfMax);
        this.writeCheckbox('snapshotTf120PerfFilterToggle', settings.snapshotTf120PerfFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf120PerfFilterToggle);
        this.writeNumber('snapshotTf120PerfMin', settings.snapshotTf120PerfMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf120PerfMin);
        this.writeNumber('snapshotTf120PerfMax', settings.snapshotTf120PerfMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf120PerfMax);
        this.writeCheckbox('snapshotTf480PerfFilterToggle', settings.snapshotTf480PerfFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf480PerfFilterToggle);
        this.writeNumber('snapshotTf480PerfMin', settings.snapshotTf480PerfMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf480PerfMin);
        this.writeNumber('snapshotTf480PerfMax', settings.snapshotTf480PerfMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotTf480PerfMax);
        this.writeCheckbox('snapshotTfConfluencePerfFilterToggle', settings.snapshotTfConfluencePerfFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotTfConfluencePerfFilterToggle);
        this.writeNumber('snapshotTfConfluencePerfMin', settings.snapshotTfConfluencePerfMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotTfConfluencePerfMin);
        this.writeNumber('snapshotTfConfluencePerfMax', settings.snapshotTfConfluencePerfMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotTfConfluencePerfMax);
        this.writeCheckbox('snapshotEntryQualityScoreFilterToggle', settings.snapshotEntryQualityScoreFilterToggle ?? DEFAULT_BACKTEST_SETTINGS.snapshotEntryQualityScoreFilterToggle);
        this.writeNumber('snapshotEntryQualityScoreMin', settings.snapshotEntryQualityScoreMin ?? DEFAULT_BACKTEST_SETTINGS.snapshotEntryQualityScoreMin);
        this.writeNumber('snapshotEntryQualityScoreMax', settings.snapshotEntryQualityScoreMax ?? DEFAULT_BACKTEST_SETTINGS.snapshotEntryQualityScoreMax);

        // Execution realism
        this.writeSelect('executionModel', settings.executionModel ?? DEFAULT_BACKTEST_SETTINGS.executionModel);
        this.writeCheckbox('allowSameBarExitToggle', settings.allowSameBarExit ?? DEFAULT_BACKTEST_SETTINGS.allowSameBarExit);
        this.writeNumber('slippageBps', settings.slippageBps ?? DEFAULT_BACKTEST_SETTINGS.slippageBps);
        this.writeSelect('maxOpenTrades', String(settings.maxOpenTrades ?? DEFAULT_BACKTEST_SETTINGS.maxOpenTrades));
        this.writeCheckbox('warmUpEntryToggle', settings.warmUpEntryEnabled ?? DEFAULT_BACKTEST_SETTINGS.warmUpEntryEnabled);
        this.writeCheckbox('strategyTimeframeToggle', settings.strategyTimeframeEnabled ?? DEFAULT_BACKTEST_SETTINGS.strategyTimeframeEnabled);
        this.writeNumber('strategyTimeframeMinutes', settings.strategyTimeframeMinutes ?? DEFAULT_BACKTEST_SETTINGS.strategyTimeframeMinutes);
        this.writeSelect('twoHourCloseParity', this.resolveTwoHourCloseParity(settings.twoHourCloseParity));

        // Trigger change events so UI updates reflect changes
        this.triggerChangeEvents();
    }

    // ========================================================================
    // Reset to Default
    // ========================================================================

    public resetToDefault(): void {
        debugLogger.event('settings.reset');
        this.applyBacktestSettings(DEFAULT_BACKTEST_SETTINGS);

        // Reset strategy params to defaults
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        if (strategy) {
            paramManager.setValues(strategy, strategy.defaultParams);
        }

        this.saveSettings();
    }

    public getDefaultBacktestSettings(): BacktestSettingsData {
        return { ...DEFAULT_BACKTEST_SETTINGS };
    }

    public getDefaultAppSettings(): AppSettings {
        return { ...DEFAULT_APP_SETTINGS, backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS } };
    }

    // ========================================================================
    // Strategy Configurations
    // ========================================================================

    public saveStrategyConfig(name: string): StrategyConfig {
        const strategy = strategyRegistry.get(state.currentStrategyKey);
        const strategyParams = strategy ? paramManager.getValues(strategy) : {};

        const config: StrategyConfig = {
            name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            strategyKey: state.currentStrategyKey,
            strategyParams,
            backtestSettings: this.getBacktestSettings(),
        };

        const persisted = this.upsertStrategyConfig(config);
        debugLogger.event('settings.config.saved', { name, strategy: state.currentStrategyKey });
        return persisted;
    }

    public upsertStrategyConfig(config: StrategyConfig): StrategyConfig {
        const configs = this.loadAllStrategyConfigs();
        const existingIndex = configs.findIndex(c => c.name === config.name);
        const nowIso = new Date().toISOString();
        const normalized: StrategyConfig = {
            ...config,
            createdAt: config.createdAt || nowIso,
            updatedAt: config.updatedAt || nowIso,
        };

        if (existingIndex >= 0) {
            normalized.createdAt = configs[existingIndex].createdAt || normalized.createdAt;
            normalized.updatedAt = nowIso;
            configs[existingIndex] = normalized;
        } else {
            configs.push(normalized);
        }

        try {
            localStorage.setItem(STORAGE_KEYS.STRATEGY_CONFIGS, JSON.stringify(configs));
        } catch (e) {
            debugLogger.error('settings.config_save_failed', { error: e instanceof Error ? e.message : String(e), name: config.name });
        }

        return normalized;
    }

    public loadStrategyConfig(name: string): StrategyConfig | null {
        const configs = this.loadAllStrategyConfigs();
        return configs.find(c => c.name === name) || null;
    }

    public async applyStrategyConfig(config: StrategyConfig): Promise<void> {
        this.autoSaveEnabled = false;
        try {
            // Apply backtest settings
            this.applyBacktestSettings(config.backtestSettings);

            // Switch to the strategy if different
            if (config.strategyKey !== state.currentStrategyKey && strategyRegistry.has(config.strategyKey)) {
                state.set('currentStrategyKey', config.strategyKey);
                const strategySelect = document.getElementById('strategySelect') as HTMLSelectElement | null;
                if (strategySelect) {
                    strategySelect.value = config.strategyKey;
                }
            }

            // Apply strategy params with a slight delay to ensure params are rendered
            await new Promise<void>((resolve) => {
                setTimeout(() => {
                    const strategy = strategyRegistry.get(config.strategyKey);
                    if (strategy) {
                        paramManager.setValues(strategy, config.strategyParams);
                    }
                    resolve();
                }, 50);
            });

            debugLogger.event('settings.config.applied', { name: config.name, strategy: config.strategyKey });
        } finally {
            this.autoSaveEnabled = true;
        }
    }

    public loadAllStrategyConfigs(): StrategyConfig[] {
        try {
            const data = localStorage.getItem(STORAGE_KEYS.STRATEGY_CONFIGS);
            if (data) {
                const parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    return parsed
                        .map((config) => normalizeStoredStrategyConfig(config))
                        .filter((config): config is StrategyConfig => config !== null);
                }
                debugLogger.warn('settings.config_invalid_format');
                return [];
            }
        } catch (e) {
            debugLogger.error('settings.config_load_failed', { error: e instanceof Error ? e.message : String(e) });
        }
        return [];
    }

    public deleteStrategyConfig(name: string): boolean {
        const configs = this.loadAllStrategyConfigs();
        const index = configs.findIndex(c => c.name === name);

        if (index >= 0) {
            configs.splice(index, 1);
            try {
                localStorage.setItem(STORAGE_KEYS.STRATEGY_CONFIGS, JSON.stringify(configs));
                debugLogger.event('settings.config.deleted', { name });
                return true;
            } catch (e) {
                debugLogger.error('settings.config_delete_failed', { error: e instanceof Error ? e.message : String(e), name });
            }
        }
        return false;
    }

    /**
     * Resolve capital/sizing settings directly from a StrategyConfig
     * without touching the DOM. Used by combined-strategy flow.
     */
    public resolveCapitalFromConfig(config: StrategyConfig): {
        initialCapital: number;
        positionSize: number;
        commission: number;
        sizingMode: 'percent' | 'fixed';
        fixedTradeAmount: number;
    } {
        const s = config.backtestSettings;
        return {
            initialCapital: Math.max(0, s.initialCapital ?? 10000),
            positionSize: Math.max(0, s.positionSize ?? 100),
            commission: Math.max(0, s.commission ?? 0.1),
            sizingMode: s.fixedTradeToggle ? 'fixed' : 'percent',
            fixedTradeAmount: Math.max(0, s.fixedTradeAmount ?? 1000),
        };
    }

    // ========================================================================
    // Auto-Save Event Listeners
    // ========================================================================

    public setupAutoSave(): void {
        // Listen for input changes on settings panel
        const settingsPanel = document.getElementById('settingsTab');
        if (settingsPanel) {
            settingsPanel.addEventListener('change', () => this.saveSettingsDebounced());
            settingsPanel.addEventListener('input', () => this.saveSettingsDebounced());
        }

        // Listen for state changes
        state.subscribe('currentStrategyKey', () => this.saveSettingsDebounced());
        state.subscribe('isDarkTheme', () => this.saveSettingsDebounced());
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

    private readNumber(id: string, fallback: number): number {
        return readSettingsNumber(id, fallback);
    }

    private readCheckbox(id: string, fallback: boolean): boolean {
        return readSettingsCheckbox(id, fallback);
    }

    private readSelect(id: string, fallback: string): string {
        return readSettingsSelect(id, fallback);
    }

    private writeNumber(id: string, value: number): void {
        writeSettingsNumber(id, value);
    }

    private writeCheckbox(id: string, value: boolean): void {
        writeSettingsCheckbox(id, value);
    }

    private writeSelect(id: string, value: string): void {
        writeSettingsSelect(id, value);
    }

    private resolveTradeDirection(settings: Partial<BacktestSettingsData>): TradeDirection {
        return resolveTradeDirection(settings, DEFAULT_BACKTEST_SETTINGS);
    }

    private resolveMarketMode(settings: Partial<BacktestSettingsData>): MarketMode {
        return resolveMarketMode(settings, DEFAULT_BACKTEST_SETTINGS);
    }

    private resolveRiskModeValue(value: unknown): NonNullable<BacktestSettings['riskMode']> {
        return resolveRiskModeValue(value, DEFAULT_BACKTEST_SETTINGS);
    }

    private resolveTakeProfitModeValue(value: unknown) {
        return resolveTakeProfitModeValue(value, DEFAULT_BACKTEST_SETTINGS);
    }

    private resolveTradeFilterModeValue(value: unknown): TradeFilterMode {
        return resolveTradeFilterModeValue(value, DEFAULT_BACKTEST_SETTINGS);
    }

    private resolveExecutionModelValue(value: unknown): ExecutionModel {
        return resolveExecutionModelValue(value, DEFAULT_BACKTEST_SETTINGS);
    }

    private resolveTradeFilterMode(settings: Partial<BacktestSettingsData>): TradeFilterMode {
        return resolveTradeFilterMode(settings, DEFAULT_BACKTEST_SETTINGS);
    }

    private resolveTwoHourCloseParity(value: unknown): 'odd' | 'even' | 'both' {
        return resolveTwoHourCloseParity(value, DEFAULT_BACKTEST_SETTINGS);
    }

    private resolveTradeFilterToggle(settings: Partial<BacktestSettingsData>): boolean {
        return resolveTradeFilterToggle(settings, DEFAULT_BACKTEST_SETTINGS);
    }

    private triggerChangeEvents(): void {
        const toggleIds = [
            'fixedTradeToggle',
            'riskSettingsToggle',
            'tradeFilterSettingsToggle',
            'invertSignalsToggle',
            'useRustEngineToggle',
            'snapshotAtrFilterToggle',
            'snapshotVolumeFilterToggle',
            'snapshotAdxFilterToggle',
            'snapshotEmaFilterToggle',
            'snapshotRsiFilterToggle',
            'snapshotPriceRangePosFilterToggle',
            'snapshotBarsFromHighFilterToggle',
            'snapshotBarsFromLowFilterToggle',
            'snapshotTrendEfficiencyFilterToggle',
            'snapshotAtrRegimeFilterToggle',
            'snapshotBodyPercentFilterToggle',
            'snapshotWickSkewFilterToggle',
            'snapshotVolumeTrendFilterToggle',
            'snapshotVolumeBurstFilterToggle',
            'snapshotVolumePriceDivergenceFilterToggle',
            'snapshotVolumeConsistencyFilterToggle',
            'snapshotCloseLocationFilterToggle',
            'snapshotOppositeWickFilterToggle',
            'snapshotRangeAtrFilterToggle',
            'snapshotMomentumFilterToggle',
            'snapshotBreakQualityFilterToggle',
            'snapshotTf60PerfFilterToggle',
            'snapshotTf90PerfFilterToggle',
            'snapshotTf120PerfFilterToggle',
            'snapshotTf480PerfFilterToggle',
            'snapshotTfConfluencePerfFilterToggle',
            'snapshotEntryQualityScoreFilterToggle',

            'stopLossToggle',
            'takeProfitToggle',
            'riskMaxHoldToggle',
            'riskWinStreakStopLossToggle'
        ];

        triggerSettingsChangeEvents(toggleIds);

        // Trigger riskMode change
        const riskMode = document.getElementById('riskMode');
        if (riskMode) {
            riskMode.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const takeProfitMode = document.getElementById('takeProfitMode');
        if (takeProfitMode) {
            takeProfitMode.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const tradeFilterMode = document.getElementById('tradeFilterMode');
        if (tradeFilterMode) {
            tradeFilterMode.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const tradeDirection = document.getElementById('tradeDirection');
        if (tradeDirection) {
            tradeDirection.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const twoHourCloseParity = document.getElementById('twoHourCloseParity');
        if (twoHourCloseParity) {
            twoHourCloseParity.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
}

export const settingsManager = new SettingsManager();

// Export for debugging
if (typeof window !== 'undefined') {
    (window as any).__settingsManager = settingsManager;
}



