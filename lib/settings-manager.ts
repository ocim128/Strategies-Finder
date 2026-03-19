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
    triggerSettingsChangeEvents,
} from "./settings-dom";
import { parseInputNumber } from "./dom-input-readers";
import {
    DEFAULT_APP_SETTINGS,
    DEFAULT_BACKTEST_SETTINGS,
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredStrategyConfig,
    resolveExecutionModelValue,
    resolveMarketMode,
    resolveRiskModeValue,
    resolveTradeSizingModeValue,
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
import { BACKTEST_DOM_SETTING_IDS } from "./backtest-settings-resolver";

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

const BACKTEST_SETTINGS_EXTRA_DOM_IDS = Object.freeze([
    'initialCapital',
    'positionSize',
    'commission',
    'fixedTradeToggle',
    'tradeSizingMode',
    'fixedTradeAmount',
    'useRustEngineToggle',
    'warmUpEntryToggle',
]);

const BACKTEST_SETTINGS_DOM_IDS = Object.freeze(
    Array.from(new Set([...BACKTEST_SETTINGS_EXTRA_DOM_IDS, ...BACKTEST_DOM_SETTING_IDS]))
);

const BACKTEST_DOM_ID_TO_SETTING_KEY = Object.freeze<Record<string, keyof BacktestSettingsData | 'entrySettingsToggle'>>({
    tradeSizingMode: 'sizingMode',
    useRustEngineToggle: 'useRustEngine',
    stopLossToggle: 'stopLossEnabled',
    takeProfitToggle: 'takeProfitEnabled',
    riskMaxHoldToggle: 'riskMaxHoldEnabled',
    riskWinStreakStopLossToggle: 'riskWinStreakStopLossEnabled',
    invertSignalsToggle: 'invertSignals',
    allowSameBarExitToggle: 'allowSameBarExit',
    warmUpEntryToggle: 'warmUpEntryEnabled',
    strategyTimeframeToggle: 'strategyTimeframeEnabled',
});

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
        const settings: BacktestSettingsData = { ...DEFAULT_BACKTEST_SETTINGS };

        for (const id of BACKTEST_SETTINGS_DOM_IDS) {
            const rawValue = this.readBacktestDomValue(id);
            if (rawValue === undefined) continue;

            const settingKey = this.getBacktestSettingKey(id);
            const value = this.coerceBacktestSettingValue(settingKey, rawValue);
            if (value !== undefined) {
                (settings as unknown as Record<string, unknown>)[settingKey] = value;
            }
        }

        return settings;
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
        for (const id of BACKTEST_SETTINGS_DOM_IDS) {
            const value = this.resolveBacktestWriteValue(id, settings);
            if (value !== undefined) {
                this.writeBacktestDomValue(id, value);
            }
        }

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
        sizingMode: BacktestSettingsData["sizingMode"];
        fixedTradeAmount: number;
    } {
        const s = config.backtestSettings;
        return {
            initialCapital: Math.max(0, s.initialCapital ?? 10000),
            positionSize: Math.max(0, s.positionSize ?? 100),
            commission: Math.max(0, s.commission ?? 0.1),
            sizingMode: this.resolveTradeSizingModeValue(s.sizingMode, s.fixedTradeToggle ? 'fixed' : 'percent'),
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

    private getBacktestSettingKey(id: string): keyof BacktestSettingsData | 'entrySettingsToggle' {
        return BACKTEST_DOM_ID_TO_SETTING_KEY[id] ?? (id as keyof BacktestSettingsData | 'entrySettingsToggle');
    }

    private readBacktestDomValue(id: string): unknown {
        const element = document.getElementById(id);
        if (!element) return undefined;

        if (element instanceof HTMLInputElement) {
            if (element.type === 'checkbox' || element.type === 'radio') {
                return element.checked;
            }
            return element.value;
        }

        if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
            return element.value;
        }

        return undefined;
    }

    private readNumericValue(value: unknown, fallback: number): number {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value;
        }
        if (typeof value === 'string') {
            const parsed = parseInputNumber(value);
            if (typeof parsed === 'number' && Number.isFinite(parsed)) {
                return parsed;
            }
        }
        return fallback;
    }

    private readBooleanValue(value: unknown, fallback: boolean): boolean {
        if (typeof value === 'boolean') return value;
        if (typeof value === 'number' && Number.isFinite(value)) return value !== 0;
        if (typeof value !== 'string') return fallback;

        const normalized = value.trim().toLowerCase();
        if (["true", "1", "yes", "on"].includes(normalized)) return true;
        if (["false", "0", "no", "off"].includes(normalized)) return false;
        return fallback;
    }

    private coerceBacktestSettingValue(
        settingKey: keyof BacktestSettingsData | 'entrySettingsToggle',
        value: unknown
    ): unknown {
        switch (settingKey) {
            case 'sizingMode':
                return this.resolveTradeSizingModeValue(value, DEFAULT_BACKTEST_SETTINGS.sizingMode);
            case 'riskMode':
                return this.resolveRiskModeValue(value);
            case 'takeProfitMode':
                return this.resolveTakeProfitModeValue(value);
            case 'tradeFilterMode':
                return this.resolveTradeFilterModeValue(value);
            case 'executionModel':
                return this.resolveExecutionModelValue(value);
            case 'twoHourCloseParity':
                return this.resolveTwoHourCloseParity(value);
            case 'entrySettingsToggle':
                return this.readBooleanValue(value, false);
            default: {
                const fallback = (DEFAULT_BACKTEST_SETTINGS as unknown as Record<string, unknown>)[settingKey];
                if (typeof fallback === 'number') {
                    return this.readNumericValue(value, fallback);
                }
                if (typeof fallback === 'boolean') {
                    return this.readBooleanValue(value, fallback);
                }
                if (typeof fallback === 'string') {
                    return typeof value === 'string' ? value : fallback;
                }
                return value;
            }
        }
    }

    private resolveBacktestWriteValue(id: string, settings: BacktestSettingsData): unknown {
        switch (id) {
            case 'tradeSizingMode':
                return this.resolveTradeSizingModeValue(settings.sizingMode, DEFAULT_BACKTEST_SETTINGS.sizingMode);
            case 'tradeFilterSettingsToggle':
                return this.resolveTradeFilterToggle(settings);
            case 'entrySettingsToggle':
                return settings.entrySettingsToggle ?? this.resolveTradeFilterToggle(settings);
            case 'tradeFilterMode':
                return this.resolveTradeFilterMode(settings);
            case 'tradeDirection':
                return this.resolveTradeDirection(settings);
            case 'marketMode':
                return this.resolveMarketMode(settings);
            case 'riskMode':
                return this.resolveRiskModeValue(settings.riskMode);
            case 'takeProfitMode':
                return this.resolveTakeProfitModeValue(settings.takeProfitMode);
            case 'executionModel':
                return this.resolveExecutionModelValue(settings.executionModel);
            case 'twoHourCloseParity':
                return this.resolveTwoHourCloseParity(settings.twoHourCloseParity);
            default: {
                const settingKey = this.getBacktestSettingKey(id);
                if (settingKey === 'entrySettingsToggle') {
                    return settings.entrySettingsToggle;
                }
                return (settings as unknown as Record<string, unknown>)[settingKey]
                    ?? (DEFAULT_BACKTEST_SETTINGS as unknown as Record<string, unknown>)[settingKey];
            }
        }
    }

    private writeBacktestDomValue(id: string, value: unknown): void {
        const element = document.getElementById(id);
        if (!element) return;

        if (element instanceof HTMLInputElement) {
            if (element.type === 'checkbox' || element.type === 'radio') {
                element.checked = this.readBooleanValue(value, false);
                return;
            }
            element.value = String(value);
            return;
        }

        if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
            element.value = String(value);
        }
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

    private resolveTradeSizingModeValue(value: unknown, fallback?: BacktestSettingsData["sizingMode"]) {
        return resolveTradeSizingModeValue(value, DEFAULT_BACKTEST_SETTINGS, fallback);
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
            'tradeSizingMode',
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



