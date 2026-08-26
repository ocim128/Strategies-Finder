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
import { loadBuiltInStrategyByKey, strategyRegistry } from "../strategyRegistry";
import { paramManager } from "./param-manager";
import { debugLogger } from "./debug-logger";
import { uiManager } from "./ui-manager";
import { getSyntheticPairMetadata } from "./synthetic-pair-session";
import {
    triggerSettingsChangeEvents,
} from "./settings-dom";
import {
    BACKTEST_SETTINGS_DOM_CONTRACTS,
    coerceBacktestDomSettingValue,
    resolveBacktestDomSettingWriteValue,
} from "./backtest-settings-dom-contract";
import { setChartMode, setCurrentStrategyKey, setDarkTheme } from "./state-actions";
import {
    DEFAULT_APP_SETTINGS,
    DEFAULT_BACKTEST_SETTINGS,
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredStrategyConfig,
    type AppSettings,
    type BacktestSettingsData,
    type StrategyConfig,
} from "./settings-model";
import { createSettingsManagerDom, type SettingsManagerDom } from "./settings-manager-dom";
import { readPersistedJson, writePersistedJson } from "./persisted-json";
import { debounce } from "./debounce";

export {
    DEFAULT_APP_SETTINGS,
    DEFAULT_BACKTEST_SETTINGS,
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredStrategyConfig,
};

import type { CapitalSettings } from "./types/backtest";
import { resolveCapitalSettingsFromRaw } from "./backtest-capital-settings";

export function sortStrategyConfigsNewestFirst(configs: readonly StrategyConfig[]): StrategyConfig[] {
    return [...configs].sort((left, right) => {
        const leftCreatedAt = Date.parse(left.createdAt || "");
        const rightCreatedAt = Date.parse(right.createdAt || "");

        if (Number.isFinite(leftCreatedAt) && Number.isFinite(rightCreatedAt) && leftCreatedAt !== rightCreatedAt) {
            return rightCreatedAt - leftCreatedAt;
        }

        if (left.createdAt !== right.createdAt) {
            return String(right.createdAt || "").localeCompare(String(left.createdAt || ""));
        }

        return left.name.localeCompare(right.name);
    });
}


// ============================================================================
// Storage Keys
// ============================================================================

const STORAGE_KEYS = {
    APP_SETTINGS: 'playground_app_settings',
    STRATEGY_CONFIGS: 'playground_strategy_configs',
};
export type { AppSettings, BacktestSettingsData, StrategyConfig } from "./settings-model";

const APP_SETTINGS_STORAGE = {
    key: STORAGE_KEYS.APP_SETTINGS,
    schema: "settings.app",
    version: 1,
} as const;

const STRATEGY_CONFIGS_STORAGE = {
    key: STORAGE_KEYS.STRATEGY_CONFIGS,
    schema: "settings.strategy-configs",
    version: 1,
} as const;


// ============================================================================
// Settings Manager
// ============================================================================

class SettingsManager {
    private autoSaveSuppressionDepth = 0;
    private autoSaveDirty = false;
    private autoSaveListenersAttached = false;
    private readonly debouncedSaveSettings = debounce(() => this.saveSettings(), 500);

    private dom: SettingsManagerDom | null = null;

    private getDom(): SettingsManagerDom {
        return this.dom ??= createSettingsManagerDom();
    }

    // ========================================================================
    // Auto-Save Settings
    // ========================================================================

    public getCurrentSettings(): AppSettings {
        return {
            currentSymbol: state.currentSymbol,
            currentInterval: state.currentInterval,
            binanceMarketType: state.binanceMarketType,
            isDarkTheme: state.isDarkTheme,
            currentStrategyKey: state.currentStrategyKey,
            chartMode: state.chartMode,
            backtestSettings: this.getBacktestSettings(),
        };
    }

    public getBacktestSettings(): BacktestSettingsData {
        const settings: BacktestSettingsData = { ...DEFAULT_BACKTEST_SETTINGS };

        for (const contract of BACKTEST_SETTINGS_DOM_CONTRACTS) {
            const rawValue = this.readBacktestDomValue(contract.domId);
            if (rawValue === undefined) continue;

            const value = coerceBacktestDomSettingValue(contract, rawValue);
            if (value !== undefined) {
                (settings as unknown as Record<string, unknown>)[contract.settingKey] = value;
            }
        }

        return settings;
    }



    public saveSettings(): void {
        if (this.autoSaveSuppressionDepth > 0) {
            this.autoSaveDirty = true;
            return;
        }

        const settings = this.getCurrentSettings();
        const saved = writePersistedJson({
            ...APP_SETTINGS_STORAGE,
            data: settings,
            onError: (error) => {
                debugLogger.error('settings.save_failed', { error: error instanceof Error ? error.message : String(error) });
            },
        });
        if (saved) {
            debugLogger.event('settings.saved', { strategy: settings.currentStrategyKey });
        }
    }

    public saveSettingsDebounced(): void {
        if (this.autoSaveSuppressionDepth > 0) {
            this.autoSaveDirty = true;
            return;
        }
        this.debouncedSaveSettings();
    }

    public async runWithoutAutoSave<T>(work: () => Promise<T> | T): Promise<T> {
        this.beginAutoSaveSuppression();
        try {
            return await work();
        } finally {
            this.endAutoSaveSuppression();
        }
    }

    private beginAutoSaveSuppression(): void {
        this.autoSaveSuppressionDepth += 1;
    }

    private endAutoSaveSuppression(): void {
        this.autoSaveSuppressionDepth = Math.max(0, this.autoSaveSuppressionDepth - 1);
        if (this.autoSaveSuppressionDepth === 0 && this.autoSaveDirty) {
            this.autoSaveDirty = false;
            this.debouncedSaveSettings();
        }
    }

    public loadSettings(): AppSettings | null {
        const settings = readPersistedJson<AppSettings | null>({
            ...APP_SETTINGS_STORAGE,
            fallback: null,
            migrate: ({ data }) => normalizeStoredAppSettings(data),
            onError: (error) => {
                debugLogger.error('settings.load_failed', { error: error instanceof Error ? error.message : String(error) });
            },
        });
        if (settings) {
            debugLogger.event('settings.loaded', { strategy: settings.currentStrategyKey });
        }
        return settings;
    }

    public applySettings(settings: AppSettings): void {
        this.beginAutoSaveSuppression();
        try {
            // Apply backtest settings to UI
            this.applyBacktestSettings(settings.backtestSettings);



            // Set state values (these trigger reactive updates)
            if (settings.isDarkTheme !== state.isDarkTheme) {
                setDarkTheme(settings.isDarkTheme);
            }

            // Apply chart mode
            if (settings.chartMode && settings.chartMode !== state.chartMode) {
                setChartMode(settings.chartMode);
            }

            debugLogger.event('settings.applied', { strategy: settings.currentStrategyKey });
        } finally {
            this.endAutoSaveSuppression();
        }
    }

    public applyBacktestSettings(settings: BacktestSettingsData): void {
        for (const contract of BACKTEST_SETTINGS_DOM_CONTRACTS) {
            const value = resolveBacktestDomSettingWriteValue(contract, settings);
            if (value !== undefined) {
                this.writeBacktestDomValue(contract.domId, value);
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
        const syntheticMetadata = getSyntheticPairMetadata();

        const config: StrategyConfig = {
            name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            strategyKey: state.currentStrategyKey,
            strategyParams,
            backtestSettings: this.getBacktestSettings(),
            ...(syntheticMetadata ? { syntheticPair: syntheticMetadata } : {}),
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

        const saved = writePersistedJson({
            ...STRATEGY_CONFIGS_STORAGE,
            data: configs,
            onError: (error) => {
                debugLogger.error('settings.config_save_failed', { error: error instanceof Error ? error.message : String(error), name: config.name });
            },
        });

        if (!saved) {
            throw new Error(`Strategy configuration "${config.name}" could not be persisted.`);
        }

        return normalized;
    }

    public loadStrategyConfig(name: string): StrategyConfig | null {
        const configs = this.loadAllStrategyConfigs();
        return configs.find(c => c.name === name) || null;
    }

    /**
     * Bulk variant of {@link loadStrategyConfig} for callers that need several
     * configs by name in one go (e.g. the Signal Committee refresh path, which
     * previously called loadStrategyConfig once per member and re-parsed the
     * whole persisted blob each time). Performs a single read + parse, then a
     * single linear scan. Names not present in storage are simply absent from
     * the returned map; the caller decides how to treat misses.
     */
    public loadStrategyConfigsByName(names: ReadonlySet<string>): Map<string, StrategyConfig> {
        const out = new Map<string, StrategyConfig>();
        if (names.size === 0) return out;
        const all = this.loadAllStrategyConfigs();
        for (const config of all) {
            if (names.has(config.name)) {
                out.set(config.name, config);
            }
        }
        return out;
    }

    public async applyStrategyConfig(config: StrategyConfig): Promise<void> {
        this.beginAutoSaveSuppression();
        try {
            // Regenerate synthetic pair first if needed (loads chart data).
            // Dynamic import keeps data-mining-manager (the entire Data Mining
            // UI) out of the startup chunk — see lib/synthetic-pair-session.ts.
            if (config.syntheticPair && config.interval) {
                const { dataMiningManager } = await import("./data-mining-manager");
                const regenerated = await dataMiningManager.regenerateSyntheticPair(
                    config.syntheticPair.baseSymbol,
                    config.syntheticPair.quoteSymbol,
                    config.interval
                );
                if (!regenerated) {
                    throw new Error(`Synthetic pair ${config.syntheticPair.baseSymbol}/${config.syntheticPair.quoteSymbol} could not be generated.`);
                }
            }

            // Apply backtest settings
            this.applyBacktestSettings(config.backtestSettings);

            const targetStrategy = strategyRegistry.get(config.strategyKey)
                ?? await loadBuiltInStrategyByKey(config.strategyKey);

            // Switch to the strategy if different
            if (targetStrategy && config.strategyKey !== state.currentStrategyKey) {
                setCurrentStrategyKey(config.strategyKey);
                this.getDom().strategySelect.value = config.strategyKey;
            }

            if (targetStrategy) {
                await uiManager.updateStrategyParams(config.strategyKey);
                paramManager.setValues(targetStrategy, config.strategyParams);
            }

            debugLogger.event('settings.config.applied', { name: config.name, strategy: config.strategyKey });
        } finally {
            this.endAutoSaveSuppression();
        }
    }

    public loadAllStrategyConfigs(): StrategyConfig[] {
        return readPersistedJson<StrategyConfig[]>({
            ...STRATEGY_CONFIGS_STORAGE,
            fallback: [],
            migrate: ({ data }) => {
                if (Array.isArray(data)) {
                    return data
                        .map((config) => normalizeStoredStrategyConfig(config))
                        .filter((config): config is StrategyConfig => config !== null);
                }
                debugLogger.warn('settings.config_invalid_format');
                return [];
            },
            onError: (error) => {
                debugLogger.error('settings.config_load_failed', { error: error instanceof Error ? error.message : String(error) });
            },
        });
    }

    public deleteStrategyConfig(name: string): boolean {
        const configs = this.loadAllStrategyConfigs();
        const index = configs.findIndex(c => c.name === name);

        if (index >= 0) {
            configs.splice(index, 1);
            const saved = writePersistedJson({
                ...STRATEGY_CONFIGS_STORAGE,
                data: configs,
                onError: (error) => {
                    debugLogger.error('settings.config_delete_failed', { error: error instanceof Error ? error.message : String(error), name });
                },
            });
            if (saved) {
                debugLogger.event('settings.config.deleted', { name });
                return true;
            }
        }
        return false;
    }

    /**
     * Resolve capital/sizing settings directly from a StrategyConfig
     * without touching the DOM. Used by combined-strategy flow.
     */
    public resolveCapitalFromConfig(config: StrategyConfig): CapitalSettings {
        return resolveCapitalSettingsFromRaw(config.backtestSettings as unknown as Record<string, unknown>);
    }

    // ========================================================================
    // Auto-Save Event Listeners
    // ========================================================================

    public setupAutoSave(): void {
        if (this.autoSaveListenersAttached) return;
        // Listen for input changes on settings panel
        const { settingsTab } = this.getDom();
        this.autoSaveListenersAttached = true;
        const shouldAutoSave = (event: Event): boolean => {
            return !(event.target instanceof HTMLElement && event.target.closest('#strategyParams'));
        };
        settingsTab.addEventListener('change', (event) => {
            if (shouldAutoSave(event)) this.saveSettingsDebounced();
        });
        settingsTab.addEventListener('input', (event) => {
            if (shouldAutoSave(event)) this.saveSettingsDebounced();
        });

        // Listen for state changes
        state.subscribe('currentStrategyKey', () => this.saveSettingsDebounced());
        state.subscribe('currentSymbol', () => this.saveSettingsDebounced());
        state.subscribe('currentInterval', () => this.saveSettingsDebounced());
        state.subscribe('binanceMarketType', () => this.saveSettingsDebounced());
        state.subscribe('isDarkTheme', () => this.saveSettingsDebounced());

        if (typeof window !== 'undefined') {
            window.addEventListener('pagehide', () => this.debouncedSaveSettings.flush());
        }
    }

    // ========================================================================
    // Private Helpers
    // ========================================================================

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


    private writeBacktestDomValue(id: string, value: unknown): void {
        const element = document.getElementById(id);
        if (!element) return;

        if (element instanceof HTMLInputElement) {
            if (element.type === 'checkbox' || element.type === 'radio') {
                element.checked = Boolean(value);
                return;
            }
            element.value = this.formatBacktestDomValue(value);
            return;
        }

        if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
            element.value = this.formatBacktestDomValue(value);
        }
    }

    private formatBacktestDomValue(value: unknown): string {
        if (Array.isArray(value)) {
            return value.join(",");
        }
        if (value && typeof value === "object") {
            return JSON.stringify(value);
        }
        return String(value);
    }

    private triggerChangeEvents(): void {
        const dom = this.getDom();
        const toggleIds = [
            'fixedTradeToggle',
            'tradeSizingMode',
            'martingaleBaseSize',
            'riskSettingsToggle',
            'disableSignalExits',
            'exitStrategyOverrideEnabled',
            'exitStrategyKey',
            'exitStrategyParams',
            'confirmationStrategiesToggle',
            'confirmationStrategies',
            'confirmationStrategyParams',
            'invertSignalsToggle',
            'useRustEngineToggle',
            'strategyTimeframeToggle',
            'strategyTimeframeMinutes',
            'polymarketAnnotationEnabled',
            'polymarketOutcomeInterval',
            'polymarketExitMode',
            'polymarketSignalExitAllowMultipleTradesPerEvent',
            'polymarketProtectionTakeProfitEnabled',
            'polymarketProtectionStopLossEnabled',
            'executionModel',
            'stopLossToggle',
            'takeProfitToggle',
            'riskMinHoldToggle',
            'riskMaxHoldToggle',
            'pathExitEnabled'
        ];

        triggerSettingsChangeEvents(toggleIds);

        // Trigger riskMode change
        dom.riskMode.dispatchEvent(new Event('change', { bubbles: true }));
        dom.takeProfitMode.dispatchEvent(new Event('change', { bubbles: true }));
        dom.tradeDirection.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

export const settingsManager = new SettingsManager();

// Export for debugging
if (typeof window !== 'undefined') {
    (window as any).__settingsManager = settingsManager;
}



