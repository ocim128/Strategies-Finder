import {
    settingsManager,
    sortStrategyConfigsNewestFirst,
    type StrategyConfig,
    type BacktestSettingsData,
} from "../settings-manager";
import { uiManager } from "../ui-manager";
import { debugLogger } from "../debug-logger";
import { refreshEngineStatus } from "../engine-status-indicator";
import { state } from "../state";
import { setCurrentInterval, setCurrentSymbol } from "../state-actions";
import { backtestService } from "../backtest-service";
import {
    createStrategyShareLink,
    parseStrategyConfigFromCurrentUrl,
    parseStrategyConfigFromSharedInput,
} from "../strategy-share-service";
import { strategyPanelController } from "../strategy-panel-controller";
import { parseInputNumber } from "../dom-input-readers";
import { createSettingsHandlersDom } from "./settings-handlers-dom";

const STRATEGY_CONFIGS_CHANGED_EVENT = "strategy-configs:changed";

const SHARED_DEFAULT_SYMBOL = 'ETHUSDT';
const SHARED_DEFAULT_INTERVAL = '120m';

function notifyStrategyConfigsChanged(): void {
    window.dispatchEvent(new Event(STRATEGY_CONFIGS_CHANGED_EVENT));
}

export function setupSettingsHandlers() {
    const dom = createSettingsHandlersDom();
    // Reset to Default button
    const resetBtn = dom.resetSettingsBtn;
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm('Reset all settings to default values?')) {
                settingsManager.resetToDefault();
                uiManager.showToast('Settings reset to default', 'info');
                debugLogger.event('ui.settings.reset');
            }
        });
    }

    // Save Configuration logic
    const saveConfigBtn = dom.saveConfigBtn;
    const configNameInput = dom.configNameInput;

    const performSave = () => {
        if (!configNameInput) return;

        try {
            const name = configNameInput.value.trim();
            if (!name) {
                uiManager.showToast('Please enter a configuration name', 'error');
                configNameInput.focus();
                return;
            }

            settingsManager.saveStrategyConfig(name);

            // Update dropdown and select the new config
            updateConfigDropdown(name);
            notifyStrategyConfigsChanged();

            configNameInput.value = '';
            uiManager.showToast(`Configuration "${name}" saved`, 'success');
            debugLogger.event('ui.config.saved', { name });

            // Visual feedback on the button
            if (saveConfigBtn) {
                saveConfigBtn.classList.add('btn-pulse-success');
                setTimeout(() => saveConfigBtn.classList.remove('btn-pulse-success'), 1000);
            }
        } catch (error) {
            debugLogger.error('ui.config.save_failed', { error: error instanceof Error ? error.message : String(error) });
            uiManager.showToast('Failed to save configuration', 'error');
        }
    };

    if (saveConfigBtn && configNameInput) {
        saveConfigBtn.addEventListener('click', performSave);

        // Add Enter key support
        configNameInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                performSave();
            }
        });
    }

    // Load Configuration button
    const loadConfigBtn = dom.loadConfigBtn;
    const configSelect = dom.configSelect;
    if (loadConfigBtn && configSelect) {
        loadConfigBtn.addEventListener('click', () => {
            const name = configSelect.value;
            if (!name) {
                uiManager.showToast('Please select a configuration to load', 'error');
                return;
            }
            const config = settingsManager.loadStrategyConfig(name);
            if (config) {
                settingsManager.applyStrategyConfig(config);
                uiManager.showToast(`Configuration "${name}" loaded`, 'success');
                debugLogger.event('ui.config.loaded', { name });
            }
        });
    }

    // Delete Configuration button
    const deleteConfigBtn = dom.deleteConfigBtn;
    if (deleteConfigBtn && configSelect) {
        deleteConfigBtn.addEventListener('click', () => {
            const name = configSelect.value;
            if (!name) {
                uiManager.showToast('Please select a configuration to delete', 'error');
                return;
            }
            if (confirm(`Delete configuration "${name}"?`)) {
                settingsManager.deleteStrategyConfig(name);
                updateConfigDropdown();
                notifyStrategyConfigsChanged();
                uiManager.showToast(`Configuration "${name}" deleted`, 'info');
                debugLogger.event('ui.config.deleted', { name });
            }
        });
    }

    // Share Configuration Link controls
    const generateShareLinkBtn = dom.generateShareLinkBtn;
    const copyShareLinkBtn = dom.copyShareLinkBtn;
    const shareConfigLinkInput = dom.shareConfigLinkInput;
    const loadShareLinkBtn = dom.loadShareLinkBtn;
    const shareConfigImportInput = dom.shareConfigImportInput;
    let currentShareLink = '';

    const setShareLinkOutput = (link: string) => {
        currentShareLink = link;
        if (shareConfigLinkInput) {
            shareConfigLinkInput.value = link;
        }
        if (copyShareLinkBtn) {
            copyShareLinkBtn.disabled = !link;
        }
    };

    const importSharedConfig = (sharedInput: string, source: 'url' | 'manual'): StrategyConfig | null => {
        const parsed = parseStrategyConfigFromSharedInput(sharedInput);
        if (!parsed) {
            if (source === 'manual') {
                uiManager.showToast('Invalid shared strategy link', 'error');
            }
            return null;
        }

        const persisted = settingsManager.upsertStrategyConfig(parsed);
        settingsManager.applyStrategyConfig(persisted);
        updateConfigDropdown(persisted.name);
        notifyStrategyConfigsChanged();
        debugLogger.event('ui.config.shared.loaded', { name: persisted.name, source });
        return persisted;
    };

    if (configSelect) {
        configSelect.addEventListener('change', () => setShareLinkOutput(''));
    }

    if (generateShareLinkBtn && configSelect) {
        generateShareLinkBtn.addEventListener('click', () => {
            const name = configSelect.value;
            if (!name) {
                uiManager.showToast('Please select a configuration to share', 'error');
                return;
            }

            const config = settingsManager.loadStrategyConfig(name);
            if (!config) {
                uiManager.showToast('Selected configuration not found', 'error');
                return;
            }

            const baseLink = createStrategyShareLink(config);
            const withChartContext = new URL(baseLink);
            withChartContext.searchParams.set('symbol', state.currentSymbol);
            withChartContext.searchParams.set('interval', state.currentInterval);
            setShareLinkOutput(withChartContext.toString());
            uiManager.showToast('Share link generated', 'success');
            debugLogger.event('ui.config.shared.link_generated', { name });
        });
    }

    if (copyShareLinkBtn) {
        copyShareLinkBtn.addEventListener('click', async () => {
            if (!currentShareLink) {
                uiManager.showToast('Generate a share link first', 'error');
                return;
            }

            const copied = await copyToClipboard(currentShareLink);
            if (!copied) {
                uiManager.showToast('Failed to copy link', 'error');
                return;
            }

            uiManager.showToast('Share link copied', 'success');
        });
    }

    if (loadShareLinkBtn && shareConfigImportInput) {
        loadShareLinkBtn.addEventListener('click', () => {
            const sharedInput = shareConfigImportInput.value.trim();
            if (!sharedInput) {
                uiManager.showToast('Paste a shared strategy link first', 'error');
                return;
            }

            const imported = importSharedConfig(sharedInput, 'manual');
            if (!imported) return;

            shareConfigImportInput.value = '';
            setShareLinkOutput('');
            uiManager.showToast(`Shared configuration "${imported.name}" loaded`, 'success');
        });
    }

    const sharedConfig = parseStrategyConfigFromCurrentUrl();
    if (sharedConfig) {
        const sharedChartContext = getSharedChartContextFromUrl();
        const previousDataFingerprint = getDataFingerprint(state.ohlcvData);
        const requiresDataReload =
            state.currentSymbol !== sharedChartContext.symbol ||
            state.currentInterval !== sharedChartContext.interval;

        const imported = settingsManager.upsertStrategyConfig(sharedConfig);
        settingsManager.applyStrategyConfig(imported);
        if (state.currentSymbol !== sharedChartContext.symbol) {
            setCurrentSymbol(sharedChartContext.symbol);
        }
        if (state.currentInterval !== sharedChartContext.interval) {
            setCurrentInterval(sharedChartContext.interval);
        }
        updateConfigDropdown(imported.name);
        activateSharedLinkViewMode();
        scheduleSharedAutoBacktest({
            expectedSymbol: sharedChartContext.symbol,
            expectedInterval: sharedChartContext.interval,
            previousDataFingerprint,
            requiresDataReload,
            expectedConfig: imported,
        });
        uiManager.showToast(`Shared configuration "${imported.name}" loaded`, 'success');
        debugLogger.event('ui.config.shared.loaded', { name: imported.name, source: 'url' });
    }


    //  Strategy Combiner handler 
    const runCombinedBtn = dom.runCombinedStrategyBtn;
    if (runCombinedBtn) {
        runCombinedBtn.addEventListener('click', async () => {
            const primarySelect = dom.combinerPrimarySelect;
            const secondarySelect = dom.combinerSecondarySelect;
            const modeSelect = dom.combinerMode;

            const primaryName = primarySelect?.value;
            const secondaryName = secondarySelect?.value;

            if (!primaryName) {
                uiManager.showToast('Please select a primary configuration', 'error');
                return;
            }
            if (!secondaryName) {
                uiManager.showToast('Please select a secondary configuration', 'error');
                return;
            }

            const primaryConfig = settingsManager.loadStrategyConfig(primaryName);
            const secondaryConfig = settingsManager.loadStrategyConfig(secondaryName);

            if (!primaryConfig || !secondaryConfig) {
                uiManager.showToast('Failed to load selected configurations', 'error');
                return;
            }

            const mode = (modeSelect?.value === 'or' ? 'or' : 'and') as 'and' | 'or';

            try {
                await backtestService.runCombinedStrategyBacktest(primaryConfig, secondaryConfig, mode);
                uiManager.showToast('Combined backtest complete (' + mode.toUpperCase() + ')', 'success');
            } catch (error) {
                debugLogger.error('ui.combiner.run_failed', { error: error instanceof Error ? error.message : String(error) });
                uiManager.showToast('Combined backtest failed', 'error');
            }
        });
    }

    setupEnginePreferenceHandlers();

    // Initialize dropdown with saved configs
    updateConfigDropdown();
}

function setupEnginePreferenceHandlers() {
    const rustToggle = createSettingsHandlersDom().useRustEngineToggle;
    if (!rustToggle) return;

    const updateStatus = () => {
        void refreshEngineStatus();
    };

    rustToggle.addEventListener('change', updateStatus);
    updateStatus();
}



async function copyToClipboard(text: string): Promise<boolean> {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const textarea = document.createElement('textarea');
        textarea.value = text;
        textarea.style.position = 'fixed';
        textarea.style.left = '-9999px';
        document.body.appendChild(textarea);
        textarea.select();
        const copied = document.execCommand('copy');
        document.body.removeChild(textarea);
        return copied;
    }
}

function normalizeSharedInterval(value: string | null): string {
    if (!value) return SHARED_DEFAULT_INTERVAL;
    const trimmed = value.trim().toLowerCase();
    if (!trimmed) return SHARED_DEFAULT_INTERVAL;
    if (/^\d+$/.test(trimmed)) {
        return `${trimmed}m`;
    }
    if (/^\d+(m|h|d|w)$/.test(trimmed)) {
        return trimmed;
    }
    return SHARED_DEFAULT_INTERVAL;
}

function getSharedChartContextFromUrl(): { symbol: string; interval: string } {
    const url = new URL(window.location.href);
    const symbol = (url.searchParams.get('symbol') || SHARED_DEFAULT_SYMBOL).trim().toUpperCase();
    const interval = normalizeSharedInterval(url.searchParams.get('interval'));
    return { symbol, interval };
}

function activateSharedLinkViewMode(): void {
    const allowedTabs = new Set(['results', 'trades']);
    strategyPanelController.setVisibleTabs(allowedTabs);
    strategyPanelController.switchTab('results');
}

interface SharedBacktestWaitOptions {
    expectedSymbol: string;
    expectedInterval: string;
    previousDataFingerprint: string;
    requiresDataReload: boolean;
    expectedConfig: StrategyConfig;
}

function getDataFingerprint(data: Array<{ time: unknown }>): string {
    const length = data.length;
    if (length === 0) return '0';
    const first = String(data[0]?.time ?? '');
    const last = String(data[length - 1]?.time ?? '');
    return `${length}:${first}:${last}`;
}

function isNumberClose(a: number, b: number): boolean {
    const delta = Math.abs(a - b);
    const scale = Math.max(1, Math.abs(a), Math.abs(b));
    return delta <= 1e-6 * scale;
}

function isSharedConfigApplied(config: StrategyConfig): boolean {
    if (state.currentStrategyKey !== config.strategyKey) return false;

    const liveSettings = settingsManager.getBacktestSettings();
    const expectedSettings = config.backtestSettings;
    const expectedKeys = Object.keys(expectedSettings) as Array<keyof BacktestSettingsData>;

    for (const key of expectedKeys) {
        const expected = expectedSettings[key] as unknown;
        const actual = liveSettings[key] as unknown;

        if (typeof expected === 'number') {
            const actualNumber = typeof actual === 'number' ? actual : Number(actual);
            if (!Number.isFinite(actualNumber) || !isNumberClose(actualNumber, expected)) {
                return false;
            }
            continue;
        }

        if (typeof expected === 'boolean' || typeof expected === 'string') {
            if (actual !== expected) return false;
            continue;
        }

        if (Array.isArray(expected) || (expected && typeof expected === 'object')) {
            if (JSON.stringify(actual) !== JSON.stringify(expected)) return false;
        }
    }

    for (const [paramKey, expected] of Object.entries(config.strategyParams)) {
        const input = document.getElementById(`param_${paramKey}`) as HTMLInputElement | HTMLSelectElement | null;
        if (!input) return false;
        const parsed = parseInputNumber(input.value);
        if (parsed === null || !isNumberClose(parsed, expected)) {
            return false;
        }
    }

    return true;
}

function scheduleSharedAutoBacktest(options: SharedBacktestWaitOptions): void {
    const maxAttempts = 40;
    const pollMs = 250;
    let attempt = 0;

    const runWhenReady = () => {
        attempt += 1;
        if (attempt === 1 || attempt % 8 === 0) {
            settingsManager.applyStrategyConfig(options.expectedConfig);
        }

        const symbolReady = state.currentSymbol === options.expectedSymbol;
        const intervalReady = state.currentInterval === options.expectedInterval;
        const hasData = state.ohlcvData.length > 0;
        const dataFingerprint = getDataFingerprint(state.ohlcvData);
        const dataReloaded = !options.requiresDataReload || dataFingerprint !== options.previousDataFingerprint;
        const configReady = isSharedConfigApplied(options.expectedConfig);
        const runButton = createSettingsHandlersDom().runBacktest;
        const isBusy = runButton?.disabled ?? false;

        if (symbolReady && intervalReady && hasData && dataReloaded && configReady && !isBusy) {
            void backtestService.runCurrentBacktest().catch((error) => {
                debugLogger.error('ui.config.shared.autobacktest_failed', { error: error instanceof Error ? error.message : String(error) });
                uiManager.showToast('Auto backtest failed. Run manually.', 'error');
            });
            return;
        }

        if (attempt < maxAttempts) {
            window.setTimeout(runWhenReady, pollMs);
            return;
        }

        uiManager.showToast('Shared config loaded. Data still syncing, run backtest manually.', 'warning');
    };

    window.setTimeout(runWhenReady, 200);
}

/**
 * Updates the configuration dropdown list from localStorage.
 * @param selectName Optional name of the configuration to select after updating.
 */
export function updateConfigDropdown(selectName?: string) {
    const configSelect = createSettingsHandlersDom().configSelect;
    if (!configSelect) return;

    const configs = sortStrategyConfigsNewestFirst(settingsManager.loadAllStrategyConfigs());
    const currentValue = selectName || configSelect.value;

    // Clear existing options
    configSelect.innerHTML = '<option value="">-- Select configuration --</option>';

    // Add saved configurations
    configs.forEach(config => {
        const option = document.createElement('option');
        option.value = config.name;
        option.textContent = `${config.name} (${config.strategyKey})`;
        configSelect.appendChild(option);
    });

    // Restore selection if still valid or specifically requested
    if (currentValue && configs.some(c => c.name === currentValue)) {
        configSelect.value = currentValue;
    }

    // Also refresh combiner dropdowns
    updateCombinerDropdowns();
}

/**
 * Populates the Strategy Combiner primary/secondary dropdowns from saved configs.
 */
function updateCombinerDropdowns() {
    const { combinerPrimarySelect: primarySelect, combinerSecondarySelect: secondarySelect } = createSettingsHandlersDom();
    if (!primarySelect && !secondarySelect) return;

    const configs = sortStrategyConfigsNewestFirst(settingsManager.loadAllStrategyConfigs());

    for (const select of [primarySelect, secondarySelect]) {
        if (!select) continue;
        const currentValue = select.value;
        const placeholder = select === primarySelect ? '-- Select primary --' : '-- Select secondary --';
        select.innerHTML = `<option value="">${placeholder}</option>`;
        configs.forEach(config => {
            const option = document.createElement('option');
            option.value = config.name;
            option.textContent = `${config.name} (${config.strategyKey})`;
            select.appendChild(option);
        });
        if (currentValue && configs.some(c => c.name === currentValue)) {
            select.value = currentValue;
        }
    }
}
