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
    normalizeStoredEnsembleSignalRecipe,
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredStrategyConfig,
    type AppSettings,
    type BacktestSettingsData,
    type EnsembleSignalRecipe,
    type StrategyConfig,
} from "./settings-model";
import { createSettingsManagerDom, type SettingsManagerDom } from "./settings-manager-dom";
import { readPersistedJson, writePersistedJson } from "./persisted-json";

export {
    DEFAULT_APP_SETTINGS,
    DEFAULT_BACKTEST_SETTINGS,
    normalizeStoredAppSettings,
    normalizeStoredBacktestSettings,
    normalizeStoredEnsembleSignalRecipe,
    normalizeStoredStrategyConfig,
};
export type { AppSettings, BacktestSettingsData, EnsembleSignalRecipe, StrategyConfig } from "./settings-model";

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

export function sortEnsembleSignalRecipesNewestFirst(recipes: readonly EnsembleSignalRecipe[]): EnsembleSignalRecipe[] {
    return [...recipes].sort((left, right) => {
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
    ENSEMBLE_SIGNAL_RECIPES: 'playground_ensemble_signal_recipes',
};

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

const ENSEMBLE_SIGNAL_RECIPES_STORAGE = {
    key: STORAGE_KEYS.ENSEMBLE_SIGNAL_RECIPES,
    schema: "settings.ensemble-signal-recipes",
    version: 1,
} as const;

// ============================================================================
// Settings Manager
// ============================================================================

class SettingsManager {
    private autoSaveEnabled: boolean = true;
    private saveDebounceTimeout: number | null = null;

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
        if (!this.autoSaveEnabled) return;

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
        if (!this.autoSaveEnabled) {
            return;
        }
        if (this.saveDebounceTimeout !== null) {
            clearTimeout(this.saveDebounceTimeout);
        }
        this.saveDebounceTimeout = window.setTimeout(() => {
            this.saveSettings();
            this.saveDebounceTimeout = null;
        }, 500);
    }

    public async runWithoutAutoSave<T>(work: () => Promise<T> | T): Promise<T> {
        const previous = this.autoSaveEnabled;
        this.autoSaveEnabled = false;
        try {
            return await work();
        } finally {
            this.autoSaveEnabled = previous;
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
        this.autoSaveEnabled = false;
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
            this.autoSaveEnabled = true;
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

        const config: StrategyConfig = {
            name,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            symbol: state.currentSymbol,
            interval: state.currentInterval,
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

        writePersistedJson({
            ...STRATEGY_CONFIGS_STORAGE,
            data: configs,
            onError: (error) => {
                debugLogger.error('settings.config_save_failed', { error: error instanceof Error ? error.message : String(error), name: config.name });
            },
        });

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

            const targetStrategy = strategyRegistry.get(config.strategyKey)
                ?? await loadBuiltInStrategyByKey(config.strategyKey);

            // Switch to the strategy if different
            if (targetStrategy && config.strategyKey !== state.currentStrategyKey) {
                setCurrentStrategyKey(config.strategyKey);
                this.getDom().strategySelect.value = config.strategyKey;
            }

            // Apply strategy params with a slight delay to ensure params are rendered
            await new Promise<void>((resolve) => {
                setTimeout(() => {
                    const strategy = strategyRegistry.get(config.strategyKey);
                    if (strategy ?? targetStrategy) {
                        paramManager.setValues(strategy ?? targetStrategy!, config.strategyParams);
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
        // Listen for input changes on settings panel
        const { settingsTab } = this.getDom();
        settingsTab.addEventListener('change', () => this.saveSettingsDebounced());
        settingsTab.addEventListener('input', () => this.saveSettingsDebounced());

        // Listen for state changes
        state.subscribe('currentStrategyKey', () => this.saveSettingsDebounced());
        state.subscribe('currentSymbol', () => this.saveSettingsDebounced());
        state.subscribe('currentInterval', () => this.saveSettingsDebounced());
        state.subscribe('binanceMarketType', () => this.saveSettingsDebounced());
        state.subscribe('isDarkTheme', () => this.saveSettingsDebounced());
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

    public upsertEnsembleSignalRecipe(recipe: EnsembleSignalRecipe): EnsembleSignalRecipe {
        const recipes = this.loadAllEnsembleSignalRecipes();
        const existingIndex = recipes.findIndex((entry) => entry.name === recipe.name);
        const nowIso = new Date().toISOString();
        const normalized: EnsembleSignalRecipe = {
            ...recipe,
            createdAt: recipe.createdAt || nowIso,
            updatedAt: recipe.updatedAt || nowIso,
        };

        if (existingIndex >= 0) {
            normalized.createdAt = recipes[existingIndex].createdAt || normalized.createdAt;
            normalized.updatedAt = nowIso;
            recipes[existingIndex] = normalized;
        } else {
            recipes.push(normalized);
        }

        writePersistedJson({
            ...ENSEMBLE_SIGNAL_RECIPES_STORAGE,
            data: recipes,
            onError: (error) => {
                debugLogger.error("settings.ensemble_recipe_save_failed", {
                    error: error instanceof Error ? error.message : String(error),
                    name: recipe.name,
                });
            },
        });

        return normalized;
    }

    public loadEnsembleSignalRecipe(name: string): EnsembleSignalRecipe | null {
        return this.loadAllEnsembleSignalRecipes().find((recipe) => recipe.name === name) ?? null;
    }

    public loadAllEnsembleSignalRecipes(): EnsembleSignalRecipe[] {
        return readPersistedJson<EnsembleSignalRecipe[]>({
            ...ENSEMBLE_SIGNAL_RECIPES_STORAGE,
            fallback: [],
            migrate: ({ data }) => {
                if (Array.isArray(data)) {
                    return data
                        .map((recipe) => normalizeStoredEnsembleSignalRecipe(recipe))
                        .filter((recipe): recipe is EnsembleSignalRecipe => recipe !== null);
                }
                debugLogger.warn("settings.ensemble_recipe_invalid_format");
                return [];
            },
            onError: (error) => {
                debugLogger.error("settings.ensemble_recipe_load_failed", {
                    error: error instanceof Error ? error.message : String(error),
                });
            },
        });
    }

    public deleteEnsembleSignalRecipe(name: string): boolean {
        const recipes = this.loadAllEnsembleSignalRecipes();
        const index = recipes.findIndex((recipe) => recipe.name === name);

        if (index >= 0) {
            recipes.splice(index, 1);
            const saved = writePersistedJson({
                ...ENSEMBLE_SIGNAL_RECIPES_STORAGE,
                data: recipes,
                onError: (error) => {
                    debugLogger.error("settings.ensemble_recipe_delete_failed", {
                        error: error instanceof Error ? error.message : String(error),
                        name,
                    });
                },
            });
            if (saved) {
                debugLogger.event("settings.ensemble_recipe.deleted", { name });
                return true;
            }
        }

        return false;
    }

    private writeBacktestDomValue(id: string, value: unknown): void {
        const element = document.getElementById(id);
        if (!element) return;

        if (element instanceof HTMLInputElement) {
            if (element.type === 'checkbox' || element.type === 'radio') {
                element.checked = Boolean(value);
                return;
            }
            element.value = String(value);
            return;
        }

        if (element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement) {
            element.value = String(value);
        }
    }

    private triggerChangeEvents(): void {
        const dom = this.getDom();
        const toggleIds = [
            'fixedTradeToggle',
            'tradeSizingMode',
            'martingaleBaseSize',
            'riskSettingsToggle',
            'tradeFilterSettingsToggle',
            'invertSignalsToggle',
            'useRustEngineToggle',
            'strategyTimeframeToggle',
            'strategyTimeframeMinutes',
            'polymarketAnnotationEnabled',
            'polymarketOutcomeInterval',
            'polymarketExitMode',
            'polymarketSignalExitAllowMultipleTradesPerEvent',
            'executionModel',
            'stopLossToggle',
            'takeProfitToggle',
            'historicalLevelTakeProfitToggle',
            'historicalLevelStopLossToggle',
            'riskMaxHoldToggle'
        ];

        triggerSettingsChangeEvents(toggleIds);

        // Trigger riskMode change
        dom.riskMode.dispatchEvent(new Event('change', { bubbles: true }));
        dom.takeProfitMode.dispatchEvent(new Event('change', { bubbles: true }));
        dom.tradeFilterMode.dispatchEvent(new Event('change', { bubbles: true }));
        dom.tradeDirection.dispatchEvent(new Event('change', { bubbles: true }));
    }
}

export const settingsManager = new SettingsManager();

// Export for debugging
if (typeof window !== 'undefined') {
    (window as any).__settingsManager = settingsManager;
}



