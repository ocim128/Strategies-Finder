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
import { paramManager } from "./paramManager";
import { debugLogger } from "./debugLogger";
import { type WebhookSettings, DEFAULT_WEBHOOK_SETTINGS, isValidWebhookUrl } from "./webhookTypes";
import { getConfirmationStrategyParams, getConfirmationStrategyValues, renderConfirmationStrategyList, setConfirmationStrategyParams } from "./confirmationStrategies";
import type { StrategyParams } from "./strategies/types";

export type { WebhookSettings };

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

    // Short mode
    shortModeToggle: boolean;

    // Entry confirmation
    entrySettingsToggle: boolean;
    entryConfirmation: string;
    confirmLookback: number;
    volumeSmaPeriod: number;
    volumeMultiplier: number;
    confirmRsiPeriod: number;
    confirmRsiBullish: number;
    confirmRsiBearish: number;

    // Confirmation strategies
    confirmationStrategiesToggle: boolean;
    confirmationStrategies: string[];
    confirmationStrategyParams: Record<string, StrategyParams>;

    // Execution realism
    executionModel: string;
    allowSameBarExit: boolean;
    slippageBps: number;
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
    webhookSettings: WebhookSettings;
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

    // Short mode
    shortModeToggle: true,

    // Entry confirmation
    entrySettingsToggle: false,
    entryConfirmation: 'none',
    confirmLookback: 1,
    volumeSmaPeriod: 20,
    volumeMultiplier: 1.5,
    confirmRsiPeriod: 14,
    confirmRsiBullish: 55,
    confirmRsiBearish: 45,

    // Confirmation strategies
    confirmationStrategiesToggle: false,
    confirmationStrategies: [],
    confirmationStrategyParams: {},

    // Execution realism
    executionModel: 'next_open',
    allowSameBarExit: false,
    slippageBps: 5,
};

const DEFAULT_APP_SETTINGS: AppSettings = {
    currentSymbol: 'ETHUSDT',
    currentInterval: '1d',
    isDarkTheme: true,
    currentStrategyKey: 'sma_crossover',
    chartMode: 'candlestick',
    backtestSettings: { ...DEFAULT_BACKTEST_SETTINGS },
    webhookSettings: { ...DEFAULT_WEBHOOK_SETTINGS },
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
            webhookSettings: this.getWebhookSettings(),
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

            // Short mode
            shortModeToggle: this.readCheckbox('shortModeToggle', DEFAULT_BACKTEST_SETTINGS.shortModeToggle),

            // Entry confirmation
            entrySettingsToggle: this.readCheckbox('entrySettingsToggle', DEFAULT_BACKTEST_SETTINGS.entrySettingsToggle),
            entryConfirmation: this.readSelect('entryConfirmation', DEFAULT_BACKTEST_SETTINGS.entryConfirmation),
            confirmLookback: this.readNumber('confirmLookback', DEFAULT_BACKTEST_SETTINGS.confirmLookback),
            volumeSmaPeriod: this.readNumber('volumeSmaPeriod', DEFAULT_BACKTEST_SETTINGS.volumeSmaPeriod),
            volumeMultiplier: this.readNumber('volumeMultiplier', DEFAULT_BACKTEST_SETTINGS.volumeMultiplier),
            confirmRsiPeriod: this.readNumber('confirmRsiPeriod', DEFAULT_BACKTEST_SETTINGS.confirmRsiPeriod),
            confirmRsiBullish: this.readNumber('confirmRsiBullish', DEFAULT_BACKTEST_SETTINGS.confirmRsiBullish),
            confirmRsiBearish: this.readNumber('confirmRsiBearish', DEFAULT_BACKTEST_SETTINGS.confirmRsiBearish),

            // Confirmation strategies
            confirmationStrategiesToggle: this.readCheckbox('confirmationStrategiesToggle', DEFAULT_BACKTEST_SETTINGS.confirmationStrategiesToggle),
            confirmationStrategies: getConfirmationStrategyValues(),
            confirmationStrategyParams: getConfirmationStrategyParams(),

            // Execution realism
            executionModel: this.readSelect('executionModel', DEFAULT_BACKTEST_SETTINGS.executionModel),
            allowSameBarExit: this.readCheckbox('allowSameBarExitToggle', DEFAULT_BACKTEST_SETTINGS.allowSameBarExit),
            slippageBps: this.readNumber('slippageBps', DEFAULT_BACKTEST_SETTINGS.slippageBps),
        };
    }

    public getWebhookSettings(): WebhookSettings {
        return {
            enabled: this.readCheckbox('webhookEnabledToggle', DEFAULT_WEBHOOK_SETTINGS.enabled),
            url: this.readText('webhookUrl', DEFAULT_WEBHOOK_SETTINGS.url),
            secretKey: this.readText('webhookSecretKey', DEFAULT_WEBHOOK_SETTINGS.secretKey),
            sendOnSignal: this.readCheckbox('webhookSendOnSignal', DEFAULT_WEBHOOK_SETTINGS.sendOnSignal),
            sendOnTrade: this.readCheckbox('webhookSendOnTrade', DEFAULT_WEBHOOK_SETTINGS.sendOnTrade),
        };
    }

    public applyWebhookSettings(settings: WebhookSettings): void {
        this.writeCheckbox('webhookEnabledToggle', settings.enabled);
        this.writeText('webhookUrl', settings.url);
        this.writeText('webhookSecretKey', settings.secretKey);
        this.writeCheckbox('webhookSendOnSignal', settings.sendOnSignal);
        this.writeCheckbox('webhookSendOnTrade', settings.sendOnTrade);
        this.updateWebhookUI();
    }

    public getDefaultWebhookSettings(): WebhookSettings {
        return { ...DEFAULT_WEBHOOK_SETTINGS };
    }

    public isWebhookValid(): boolean {
        const settings = this.getWebhookSettings();
        return settings.enabled && isValidWebhookUrl(settings.url);
    }

    private updateWebhookUI(): void {
        const statusDot = document.getElementById('webhookStatusDot');
        const statusText = document.getElementById('webhookStatusText');
        const testBtn = document.getElementById('webhookTestBtn') as HTMLButtonElement | null;
        const urlValidation = document.getElementById('webhookUrlValidation');

        const settings = this.getWebhookSettings();
        const isValid = isValidWebhookUrl(settings.url);

        // Update status indicator
        if (statusDot) {
            statusDot.className = 'webhook-status-dot ' + (
                !settings.enabled ? 'status-disabled' :
                    !isValid ? 'status-error' : 'status-ready'
            );
        }

        if (statusText) {
            statusText.textContent = !settings.enabled ? 'Webhook disabled' :
                !isValid ? 'Invalid webhook URL' : 'Ready to send';
        }

        // Update test button state
        if (testBtn) {
            testBtn.disabled = !settings.enabled || !isValid;
        }

        // Update URL validation indicator
        if (urlValidation) {
            if (settings.url.trim() === '') {
                urlValidation.innerHTML = '';
                urlValidation.className = 'webhook-url-validation';
            } else if (isValid) {
                urlValidation.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>';
                urlValidation.className = 'webhook-url-validation valid';
            } else {
                urlValidation.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16"><path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/></svg>';
                urlValidation.className = 'webhook-url-validation invalid';
            }
        }
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

            // Apply webhook settings
            if (settings.webhookSettings) {
                this.applyWebhookSettings(settings.webhookSettings);
            }

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

        // Short mode
        this.writeCheckbox('shortModeToggle', settings.shortModeToggle);

        // Entry confirmation
        this.writeCheckbox('entrySettingsToggle', settings.entrySettingsToggle);
        this.writeSelect('entryConfirmation', settings.entryConfirmation);
        this.writeNumber('confirmLookback', settings.confirmLookback);
        this.writeNumber('volumeSmaPeriod', settings.volumeSmaPeriod);
        this.writeNumber('volumeMultiplier', settings.volumeMultiplier);
        this.writeNumber('confirmRsiPeriod', settings.confirmRsiPeriod);
        this.writeNumber('confirmRsiBullish', settings.confirmRsiBullish);
        this.writeNumber('confirmRsiBearish', settings.confirmRsiBearish);

        // Confirmation strategies
        this.writeCheckbox('confirmationStrategiesToggle', settings.confirmationStrategiesToggle ?? DEFAULT_BACKTEST_SETTINGS.confirmationStrategiesToggle);
        setConfirmationStrategyParams(settings.confirmationStrategyParams ?? {});
        const confirmationList = Array.isArray(settings.confirmationStrategies) ? settings.confirmationStrategies : [];
        renderConfirmationStrategyList(confirmationList);

        // Execution realism
        this.writeSelect('executionModel', settings.executionModel ?? DEFAULT_BACKTEST_SETTINGS.executionModel);
        this.writeCheckbox('allowSameBarExitToggle', settings.allowSameBarExit ?? DEFAULT_BACKTEST_SETTINGS.allowSameBarExit);
        this.writeNumber('slippageBps', settings.slippageBps ?? DEFAULT_BACKTEST_SETTINGS.slippageBps);

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

        const configs = this.loadAllStrategyConfigs();
        const existingIndex = configs.findIndex(c => c.name === name);

        if (existingIndex >= 0) {
            config.createdAt = configs[existingIndex].createdAt;
            configs[existingIndex] = config;
        } else {
            configs.push(config);
        }

        try {
            localStorage.setItem(STORAGE_KEYS.STRATEGY_CONFIGS, JSON.stringify(configs));
            debugLogger.event('settings.config.saved', { name, strategy: state.currentStrategyKey });
        } catch (e) {
            console.error('[SettingsManager] Failed to save strategy config:', e);
        }

        return config;
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

    private readText(id: string, fallback: string): string {
        const input = document.getElementById(id) as HTMLInputElement | null;
        return input ? input.value : fallback;
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

    private writeText(id: string, value: string): void {
        const input = document.getElementById(id) as HTMLInputElement | null;
        if (input) {
            input.value = value;
        }
    }

    private triggerChangeEvents(): void {
        // Trigger change events for toggles to update UI state
        const toggleIds = [
            'fixedTradeToggle',
            'riskSettingsToggle',
            'entrySettingsToggle',
            'confirmationStrategiesToggle',
            'shortModeToggle',
            'useRustEngineToggle',
            'webhookEnabledToggle',
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
    }
}

export const settingsManager = new SettingsManager();

// Export for debugging
if (typeof window !== 'undefined') {
    (window as any).__settingsManager = settingsManager;
}
