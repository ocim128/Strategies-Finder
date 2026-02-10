/**
 * Settings Manager - Handles auto-save, load, and reset of all application settings
 * 
 * Features:
 * - Auto-save settings to localStorage on changes
 * - Auto-load settings on browser open
 * - Reset to default functionality
 * - Save/Load named strategy configurations
 */

import { state, type ChartMode } from "./state";
import { strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { getConfirmationStrategyParams, getConfirmationStrategyValues, renderConfirmationStrategyList, setConfirmationStrategyParams } from "./confirmation-strategies";
import type { MarketMode, StrategyParams, TradeDirection } from './types/strategies';

// ============================================================================
// Types
// ============================================================================

export interface BacktestSettingsData {
    // Capital settings
    initialCapital: number;
    positionSize: number;
    commission: number;
    fixedTradeToggle: boolean;
    fixedTradeAmount: number;

    // Engine preference
    useRustEngine: boolean;

    // Risk management
    riskSettingsToggle: boolean;
    riskMode: string;
    atrPeriod: number;
    stopLossAtr: number;
    takeProfitAtr: number;
    trailingAtr: number;
    partialTakeProfitAtR: number;
    partialTakeProfitPercent: number;
    breakEvenAtR: number;
    timeStopBars: number;
    stopLossPercent: number;
    takeProfitPercent: number;
    stopLossEnabled: boolean;
    takeProfitEnabled: boolean;
    marketMode: MarketMode;

    // Trade direction
    tradeDirection: TradeDirection;

    // Trade filter
    tradeFilterSettingsToggle: boolean;
    tradeFilterMode: string;
    /** @deprecated Legacy key retained for backward compatibility when loading old configs */
    entrySettingsToggle?: boolean;
    /** @deprecated Legacy key retained for backward compatibility when loading old configs */
    entryConfirmation?: string;
    confirmLookback: number;
    volumeSmaPeriod: number;
    volumeMultiplier: number;
    confirmRsiPeriod: number;
    confirmRsiBullish: number;
    confirmRsiBearish: number;
    snapshotAtrFilterToggle: boolean;
    snapshotAtrPercentMin: number;
    snapshotAtrPercentMax: number;
    snapshotVolumeFilterToggle: boolean;
    snapshotVolumeRatioMin: number;
    snapshotVolumeRatioMax: number;
    snapshotAdxFilterToggle: boolean;
    snapshotAdxMin: number;
    snapshotAdxMax: number;
    snapshotEmaFilterToggle: boolean;
    snapshotEmaDistanceMin: number;
    snapshotEmaDistanceMax: number;
    snapshotRsiFilterToggle: boolean;
    snapshotRsiMin: number;
    snapshotRsiMax: number;
    snapshotPriceRangePosFilterToggle: boolean;
    snapshotPriceRangePosMin: number;
    snapshotPriceRangePosMax: number;
    snapshotBarsFromHighFilterToggle: boolean;
    snapshotBarsFromHighMax: number;
    snapshotBarsFromLowFilterToggle: boolean;
    snapshotBarsFromLowMax: number;
    snapshotTrendEfficiencyFilterToggle: boolean;
    snapshotTrendEfficiencyMin: number;
    snapshotTrendEfficiencyMax: number;
    snapshotAtrRegimeFilterToggle: boolean;
    snapshotAtrRegimeRatioMin: number;
    snapshotAtrRegimeRatioMax: number;
    snapshotBodyPercentFilterToggle: boolean;
    snapshotBodyPercentMin: number;
    snapshotBodyPercentMax: number;
    snapshotWickSkewFilterToggle: boolean;
    snapshotWickSkewMin: number;
    snapshotWickSkewMax: number;
    snapshotVolumeTrendFilterToggle: boolean;
    snapshotVolumeTrendMin: number;
    snapshotVolumeTrendMax: number;
    snapshotVolumeBurstFilterToggle: boolean;
    snapshotVolumeBurstMin: number;
    snapshotVolumeBurstMax: number;
    snapshotVolumePriceDivergenceFilterToggle: boolean;
    snapshotVolumePriceDivergenceMin: number;
    snapshotVolumePriceDivergenceMax: number;
    snapshotVolumeConsistencyFilterToggle: boolean;
    snapshotVolumeConsistencyMin: number;
    snapshotVolumeConsistencyMax: number;

    // Confirmation strategies
    confirmationStrategiesToggle: boolean;
    confirmationStrategies: string[];
    confirmationStrategyParams: Record<string, StrategyParams>;

    // Execution realism
    executionModel: string;
    allowSameBarExit: boolean;
    slippageBps: number;
    strategyTimeframeEnabled: boolean;
    strategyTimeframeMinutes: number;
}

export interface StrategyConfig {
    name: string;
    createdAt: string;
    updatedAt: string;
    strategyKey: string;
    strategyParams: Record<string, number>;
    backtestSettings: BacktestSettingsData;
}

export interface AppSettings {
    currentSymbol: string;
    currentInterval: string;
    isDarkTheme: boolean;
    currentStrategyKey: string;
    chartMode: ChartMode;
    backtestSettings: BacktestSettingsData;
}

// ============================================================================
// Default Values
// ============================================================================

const DEFAULT_BACKTEST_SETTINGS: BacktestSettingsData = {
    // Capital settings
    initialCapital: 10000,
    positionSize: 100,
    commission: 0.1,
    fixedTradeToggle: true,
    fixedTradeAmount: 1000,
    useRustEngine: true,

    // Risk management
    riskSettingsToggle: false,
    riskMode: 'simple',
    atrPeriod: 14,
    stopLossAtr: 1.5,
    takeProfitAtr: 3,
    trailingAtr: 2,
    partialTakeProfitAtR: 1,
    partialTakeProfitPercent: 50,
    breakEvenAtR: 1,
    timeStopBars: 0,
    stopLossPercent: 5,
    takeProfitPercent: 10,
    stopLossEnabled: false,
    takeProfitEnabled: false,
    marketMode: 'all',

    // Trade direction
    tradeDirection: 'short',

    // Trade filter
    tradeFilterSettingsToggle: false,
    tradeFilterMode: 'none',
    confirmLookback: 1,
    volumeSmaPeriod: 20,
    volumeMultiplier: 1.5,
    confirmRsiPeriod: 14,
    confirmRsiBullish: 55,
    confirmRsiBearish: 45,
    snapshotAtrFilterToggle: false,
    snapshotAtrPercentMin: 0,
    snapshotAtrPercentMax: 0,
    snapshotVolumeFilterToggle: false,
    snapshotVolumeRatioMin: 0,
    snapshotVolumeRatioMax: 0,
    snapshotAdxFilterToggle: false,
    snapshotAdxMin: 0,
    snapshotAdxMax: 0,
    snapshotEmaFilterToggle: false,
    snapshotEmaDistanceMin: 0,
    snapshotEmaDistanceMax: 0,
    snapshotRsiFilterToggle: false,
    snapshotRsiMin: 0,
    snapshotRsiMax: 0,
    snapshotPriceRangePosFilterToggle: false,
    snapshotPriceRangePosMin: 0,
    snapshotPriceRangePosMax: 0,
    snapshotBarsFromHighFilterToggle: false,
    snapshotBarsFromHighMax: 0,
    snapshotBarsFromLowFilterToggle: false,
    snapshotBarsFromLowMax: 0,
    snapshotTrendEfficiencyFilterToggle: false,
    snapshotTrendEfficiencyMin: 0,
    snapshotTrendEfficiencyMax: 0,
    snapshotAtrRegimeFilterToggle: false,
    snapshotAtrRegimeRatioMin: 0,
    snapshotAtrRegimeRatioMax: 0,
    snapshotBodyPercentFilterToggle: false,
    snapshotBodyPercentMin: 0,
    snapshotBodyPercentMax: 0,
    snapshotWickSkewFilterToggle: false,
    snapshotWickSkewMin: 0,
    snapshotWickSkewMax: 0,
    snapshotVolumeTrendFilterToggle: false,
    snapshotVolumeTrendMin: 0,
    snapshotVolumeTrendMax: 0,
    snapshotVolumeBurstFilterToggle: false,
    snapshotVolumeBurstMin: 0,
    snapshotVolumeBurstMax: 0,
    snapshotVolumePriceDivergenceFilterToggle: false,
    snapshotVolumePriceDivergenceMin: 0,
    snapshotVolumePriceDivergenceMax: 0,
    snapshotVolumeConsistencyFilterToggle: false,
    snapshotVolumeConsistencyMin: 0,
    snapshotVolumeConsistencyMax: 0,

    // Confirmation strategies
    confirmationStrategiesToggle: false,
    confirmationStrategies: [],
    confirmationStrategyParams: {},

    // Execution realism
    executionModel: 'next_open',
    allowSameBarExit: false,
    slippageBps: 5,
    strategyTimeframeEnabled: false,
    strategyTimeframeMinutes: 120,
};

const DEFAULT_APP_SETTINGS: AppSettings = {
    currentSymbol: 'ETHUSDT',
    currentInterval: '1d',
    isDarkTheme: true,
    currentStrategyKey: 'sma_crossover',
    chartMode: 'candlestick',
    backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
};

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
            riskMode: this.readSelect('riskMode', DEFAULT_BACKTEST_SETTINGS.riskMode),
            atrPeriod: this.readNumber('atrPeriod', DEFAULT_BACKTEST_SETTINGS.atrPeriod),
            stopLossAtr: this.readNumber('stopLossAtr', DEFAULT_BACKTEST_SETTINGS.stopLossAtr),
            takeProfitAtr: this.readNumber('takeProfitAtr', DEFAULT_BACKTEST_SETTINGS.takeProfitAtr),
            trailingAtr: this.readNumber('trailingAtr', DEFAULT_BACKTEST_SETTINGS.trailingAtr),
            partialTakeProfitAtR: this.readNumber('partialTakeProfitAtR', DEFAULT_BACKTEST_SETTINGS.partialTakeProfitAtR),
            partialTakeProfitPercent: this.readNumber('partialTakeProfitPercent', DEFAULT_BACKTEST_SETTINGS.partialTakeProfitPercent),
            breakEvenAtR: this.readNumber('breakEvenAtR', DEFAULT_BACKTEST_SETTINGS.breakEvenAtR),
            timeStopBars: this.readNumber('timeStopBars', DEFAULT_BACKTEST_SETTINGS.timeStopBars),
            stopLossPercent: this.readNumber('stopLossPercent', DEFAULT_BACKTEST_SETTINGS.stopLossPercent),
            takeProfitPercent: this.readNumber('takeProfitPercent', DEFAULT_BACKTEST_SETTINGS.takeProfitPercent),
            stopLossEnabled: this.readCheckbox('stopLossToggle', DEFAULT_BACKTEST_SETTINGS.stopLossEnabled),
            takeProfitEnabled: this.readCheckbox('takeProfitToggle', DEFAULT_BACKTEST_SETTINGS.takeProfitEnabled),
            marketMode: this.readSelect('marketMode', DEFAULT_BACKTEST_SETTINGS.marketMode) as MarketMode,

            // Trade direction
            tradeDirection: this.readSelect('tradeDirection', DEFAULT_BACKTEST_SETTINGS.tradeDirection) as TradeDirection,

            // Trade filter
            tradeFilterSettingsToggle: this.readCheckbox('tradeFilterSettingsToggle', DEFAULT_BACKTEST_SETTINGS.tradeFilterSettingsToggle),
            tradeFilterMode: this.readSelect('tradeFilterMode', DEFAULT_BACKTEST_SETTINGS.tradeFilterMode),
            confirmLookback: this.readNumber('confirmLookback', DEFAULT_BACKTEST_SETTINGS.confirmLookback),
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

            // Confirmation strategies
            confirmationStrategiesToggle: this.readCheckbox('confirmationStrategiesToggle', DEFAULT_BACKTEST_SETTINGS.confirmationStrategiesToggle),
            confirmationStrategies: getConfirmationStrategyValues(),
            confirmationStrategyParams: getConfirmationStrategyParams(),

            // Execution realism
            executionModel: this.readSelect('executionModel', DEFAULT_BACKTEST_SETTINGS.executionModel),
            allowSameBarExit: this.readCheckbox('allowSameBarExitToggle', DEFAULT_BACKTEST_SETTINGS.allowSameBarExit),
            slippageBps: this.readNumber('slippageBps', DEFAULT_BACKTEST_SETTINGS.slippageBps),
            strategyTimeframeEnabled: this.readCheckbox('strategyTimeframeToggle', DEFAULT_BACKTEST_SETTINGS.strategyTimeframeEnabled),
            strategyTimeframeMinutes: this.readNumber('strategyTimeframeMinutes', DEFAULT_BACKTEST_SETTINGS.strategyTimeframeMinutes),
        };
    }



    public saveSettings(): void {
        if (!this.autoSaveEnabled) return;

        const settings = this.getCurrentSettings();
        try {
            localStorage.setItem(STORAGE_KEYS.APP_SETTINGS, JSON.stringify(settings));
            debugLogger.event('settings.saved', { strategy: settings.currentStrategyKey });
        } catch (e) {
            console.error('[SettingsManager] Failed to save settings:', e);
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
                const settings = JSON.parse(data) as AppSettings;
                if (!settings || typeof settings !== 'object') return null;

                debugLogger.event('settings.loaded', { strategy: settings.currentStrategyKey });
                return settings;
            }
        } catch (e) {
            console.error('[SettingsManager] Failed to load settings:', e);
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
        this.writeNumber('timeStopBars', settings.timeStopBars);
        this.writeNumber('stopLossPercent', settings.stopLossPercent);
        this.writeNumber('takeProfitPercent', settings.takeProfitPercent);
        this.writeCheckbox('stopLossToggle', settings.stopLossEnabled);
        this.writeCheckbox('takeProfitToggle', settings.takeProfitEnabled);
        this.writeSelect('marketMode', this.resolveMarketMode(settings));

        // Trade direction
        this.writeSelect('tradeDirection', this.resolveTradeDirection(settings));

        // Trade filter
        this.writeCheckbox('tradeFilterSettingsToggle', this.resolveTradeFilterToggle(settings));
        this.writeSelect('tradeFilterMode', this.resolveTradeFilterMode(settings));
        this.writeNumber('confirmLookback', settings.confirmLookback);
        this.writeNumber('volumeSmaPeriod', settings.volumeSmaPeriod);
        this.writeNumber('volumeMultiplier', settings.volumeMultiplier);
        this.writeNumber('confirmRsiPeriod', settings.confirmRsiPeriod);
        this.writeNumber('confirmRsiBullish', settings.confirmRsiBullish);
        this.writeNumber('confirmRsiBearish', settings.confirmRsiBearish);
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

        // Confirmation strategies
        this.writeCheckbox('confirmationStrategiesToggle', settings.confirmationStrategiesToggle ?? DEFAULT_BACKTEST_SETTINGS.confirmationStrategiesToggle);
        setConfirmationStrategyParams(settings.confirmationStrategyParams ?? {});
        const confirmationList = Array.isArray(settings.confirmationStrategies) ? settings.confirmationStrategies : [];
        renderConfirmationStrategyList(confirmationList);

        // Execution realism
        this.writeSelect('executionModel', settings.executionModel ?? DEFAULT_BACKTEST_SETTINGS.executionModel);
        this.writeCheckbox('allowSameBarExitToggle', settings.allowSameBarExit ?? DEFAULT_BACKTEST_SETTINGS.allowSameBarExit);
        this.writeNumber('slippageBps', settings.slippageBps ?? DEFAULT_BACKTEST_SETTINGS.slippageBps);
        this.writeCheckbox('strategyTimeframeToggle', settings.strategyTimeframeEnabled ?? DEFAULT_BACKTEST_SETTINGS.strategyTimeframeEnabled);
        this.writeNumber('strategyTimeframeMinutes', settings.strategyTimeframeMinutes ?? DEFAULT_BACKTEST_SETTINGS.strategyTimeframeMinutes);

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
            console.error('[SettingsManager] Failed to save strategy config:', e);
        }

        return normalized;
    }

    public loadStrategyConfig(name: string): StrategyConfig | null {
        const configs = this.loadAllStrategyConfigs();
        return configs.find(c => c.name === name) || null;
    }

    public applyStrategyConfig(config: StrategyConfig): void {
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
            setTimeout(() => {
                const strategy = strategyRegistry.get(config.strategyKey);
                if (strategy) {
                    paramManager.setValues(strategy, config.strategyParams);
                }
            }, 50);

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
                    return parsed as StrategyConfig[];
                }
                console.warn('[SettingsManager] Invalid strategy configs format, resetting to empty.');
                return [];
            }
        } catch (e) {
            console.error('[SettingsManager] Failed to load strategy configs:', e);
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
                console.error('[SettingsManager] Failed to delete strategy config:', e);
            }
        }
        return false;
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
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (!input) return fallback;
        const value = parseFloat(input.value);
        return Number.isFinite(value) ? value : fallback;
    }



    private readCheckbox(id: string, fallback: boolean): boolean {
        const checkbox = document.getElementById(id) as HTMLInputElement | null;
        return checkbox ? checkbox.checked : fallback;
    }

    private readSelect(id: string, fallback: string): string {
        const select = document.getElementById(id) as HTMLSelectElement | null;
        return select ? select.value : fallback;
    }

    private writeNumber(id: string, value: number): void {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) {
            input.value = String(value);
        }
    }

    private writeCheckbox(id: string, value: boolean): void {
        const checkbox = document.getElementById(id) as HTMLInputElement | null;
        if (checkbox) {
            checkbox.checked = value;
        }
    }

    private writeSelect(id: string, value: string): void {
        const select = document.getElementById(id) as HTMLSelectElement | null;
        if (select) {
            select.value = value;
        }
    }



    private resolveTradeDirection(settings: Partial<BacktestSettingsData>): TradeDirection {
        if (settings.tradeDirection === 'long' || settings.tradeDirection === 'short' || settings.tradeDirection === 'both' || settings.tradeDirection === 'combined') {
            return settings.tradeDirection;
        }

        const legacyShortMode = (settings as { shortModeToggle?: boolean }).shortModeToggle;
        if (legacyShortMode === true) return 'short';
        if (legacyShortMode === false) return 'long';

        return DEFAULT_BACKTEST_SETTINGS.tradeDirection;
    }

    private resolveMarketMode(settings: Partial<BacktestSettingsData>): MarketMode {
        if (settings.marketMode === 'all' || settings.marketMode === 'uptrend' || settings.marketMode === 'downtrend' || settings.marketMode === 'sideway') {
            return settings.marketMode;
        }
        return DEFAULT_BACKTEST_SETTINGS.marketMode;
    }

    private resolveTradeFilterMode(settings: Partial<BacktestSettingsData>): string {
        const mode = settings.tradeFilterMode ?? settings.entryConfirmation;
        if (mode === 'none' || mode === 'close' || mode === 'volume' || mode === 'rsi' || mode === 'trend' || mode === 'adx') {
            return mode;
        }
        return DEFAULT_BACKTEST_SETTINGS.tradeFilterMode;
    }

    private resolveTradeFilterToggle(settings: Partial<BacktestSettingsData>): boolean {
        if (typeof settings.tradeFilterSettingsToggle === 'boolean') {
            return settings.tradeFilterSettingsToggle;
        }
        if (typeof settings.entrySettingsToggle === 'boolean') {
            return settings.entrySettingsToggle;
        }
        return DEFAULT_BACKTEST_SETTINGS.tradeFilterSettingsToggle;
    }

    private triggerChangeEvents(): void {
        // Trigger change events for toggles to update UI state
        const toggleIds = [
            'fixedTradeToggle',
            'riskSettingsToggle',
            'tradeFilterSettingsToggle',
            'confirmationStrategiesToggle',
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

            'stopLossToggle',
            'takeProfitToggle'
        ];

        toggleIds.forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.dispatchEvent(new Event('change', { bubbles: true }));
            }
        });

        // Trigger riskMode change
        const riskMode = document.getElementById('riskMode');
        if (riskMode) {
            riskMode.dispatchEvent(new Event('change', { bubbles: true }));
        }
        const tradeDirection = document.getElementById('tradeDirection');
        if (tradeDirection) {
            tradeDirection.dispatchEvent(new Event('change', { bubbles: true }));
        }
    }
}

export const settingsManager = new SettingsManager();

// Export for debugging
if (typeof window !== 'undefined') {
    (window as any).__settingsManager = settingsManager;
}



