import { settingsManager, type StrategyConfig, type BacktestSettingsData } from "../settings-manager";
import { uiManager } from "../ui-manager";
import { debugLogger } from "../debug-logger";
import { refreshEngineStatus } from "../engine-status-indicator";
import { state } from "../state";
import { backtestService } from "../backtest-service";
import {
    createStrategyShareLink,
    parseStrategyConfigFromCurrentUrl,
    parseStrategyConfigFromSharedInput,
} from "../strategy-share-service";

const SHARED_DEFAULT_SYMBOL = 'ETHUSDT';
const SHARED_DEFAULT_INTERVAL = '120m';

export function setupSettingsHandlers() {
    // Reset to Default button
    const resetBtn = document.getElementById('resetSettingsBtn');
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
    const saveConfigBtn = document.getElementById('saveConfigBtn');
    const configNameInput = document.getElementById('configNameInput') as HTMLInputElement | null;

    const performSave = () => {
        if (!configNameInput) return;

        console.log('[UI] Save Config Triggered');
        try {
            const name = configNameInput.value.trim();
            if (!name) {
                uiManager.showToast('Please enter a configuration name', 'error');
                configNameInput.focus();
                return;
            }

            console.log('[UI] Saving config:', name);
            settingsManager.saveStrategyConfig(name);

            // Update dropdown and select the new config
            updateConfigDropdown(name);

            configNameInput.value = '';
            uiManager.showToast(`Configuration "${name}" saved`, 'success');
            debugLogger.event('ui.config.saved', { name });

            // Visual feedback on the button
            if (saveConfigBtn) {
                saveConfigBtn.classList.add('btn-pulse-success');
                setTimeout(() => saveConfigBtn.classList.remove('btn-pulse-success'), 1000);
            }
        } catch (error) {
            console.error('[UI] Save Config Error:', error);
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
    const loadConfigBtn = document.getElementById('loadConfigBtn');
    const configSelect = document.getElementById('configSelect') as HTMLSelectElement | null;
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
    const deleteConfigBtn = document.getElementById('deleteConfigBtn');
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
                uiManager.showToast(`Configuration "${name}" deleted`, 'info');
                debugLogger.event('ui.config.deleted', { name });
            }
        });
    }

    // Share Configuration Link controls
    const generateShareLinkBtn = document.getElementById('generateShareLinkBtn') as HTMLButtonElement | null;
    const copyShareLinkBtn = document.getElementById('copyShareLinkBtn') as HTMLButtonElement | null;
    const shareConfigLinkInput = document.getElementById('shareConfigLinkInput') as HTMLInputElement | null;
    const loadShareLinkBtn = document.getElementById('loadShareLinkBtn') as HTMLButtonElement | null;
    const shareConfigImportInput = document.getElementById('shareConfigImportInput') as HTMLInputElement | null;
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
            state.set('currentSymbol', sharedChartContext.symbol);
        }
        if (state.currentInterval !== sharedChartContext.interval) {
            state.set('currentInterval', sharedChartContext.interval);
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


    setupEnginePreferenceHandlers();

    // Initialize dropdown with saved configs
    updateConfigDropdown();
}

function setupEnginePreferenceHandlers() {
    const rustToggle = document.getElementById('useRustEngineToggle') as HTMLInputElement | null;
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
    const panelTabs = Array.from(document.querySelectorAll<HTMLElement>('.panel-tab'));

    panelTabs.forEach((tab) => {
        const tabName = tab.dataset.tab ?? '';
        const isAllowed = allowedTabs.has(tabName);
        tab.style.display = isAllowed ? '' : 'none';
        tab.setAttribute('aria-hidden', isAllowed ? 'false' : 'true');
        tab.tabIndex = isAllowed ? 0 : -1;
        if (tab instanceof HTMLButtonElement) {
            tab.disabled = !isAllowed;
        }
    });

    const tabGroups = Array.from(document.querySelectorAll<HTMLElement>('#strategyTabs .tab-group-label, #strategyTabs .tab-group-separator'));
    tabGroups.forEach((group) => {
        group.style.display = 'none';
    });

    const resultsTab = document.querySelector<HTMLElement>('.panel-tab[data-tab="results"]');
    if (resultsTab) {
        resultsTab.click();
    }
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
        const parsed = parseFloat(input.value);
        if (!Number.isFinite(parsed) || !isNumberClose(parsed, expected)) {
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
        const runButton = document.getElementById('runBacktest') as HTMLButtonElement | null;
        const isBusy = runButton?.disabled ?? false;

        if (symbolReady && intervalReady && hasData && dataReloaded && configReady && !isBusy) {
            void backtestService.runCurrentBacktest().catch((error) => {
                console.error('[SharedConfig] Auto backtest failed:', error);
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
    const configSelect = document.getElementById('configSelect') as HTMLSelectElement | null;
    if (!configSelect) return;

    const configs = settingsManager.loadAllStrategyConfigs();
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
}
