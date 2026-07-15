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
import { dataManager } from "../data-manager";
import {
    createStrategyShareLink,
    parseStrategyConfigFromCurrentUrl,
    parseStrategyConfigFromSharedInput,
} from "../strategy-share-service";
import { strategyPanelController } from "../strategy-panel-controller";
import { parseInputNumber } from "../dom-input-readers";
import { copyToClipboard } from "../browser-transfer";
import { createSettingsHandlersDom } from "./settings-handlers-dom";
import { buildSharedSyntheticApplyPlan, type SharedChartContext } from "./settings-handlers-shared";

const STRATEGY_CONFIGS_CHANGED_EVENT = "strategy-configs:changed";

const SHARED_DEFAULT_SYMBOL = 'ETHUSDT';
const SHARED_DEFAULT_INTERVAL = '120m';

// Dynamic import keeps data-mining-manager (the entire Data Mining UI) out of
// the startup chunk — see lib/synthetic-pair-session.ts. Both call sites are
// async, so this thin wrapper is the only seam.
async function regenerateSyntheticPair(baseSymbol: string, quoteSymbol: string, interval: string): Promise<void> {
    const { dataMiningManager } = await import("../data-mining-manager");
    await dataMiningManager.regenerateSyntheticPair(baseSymbol, quoteSymbol, interval);
}

function notifyStrategyConfigsChanged(): void {
    window.dispatchEvent(new Event(STRATEGY_CONFIGS_CHANGED_EVENT));
}

function normalizeConfigSymbol(value: string | undefined): string | null {
    const symbol = value?.trim().toUpperCase();
    return symbol ? symbol : null;
}

function normalizeConfigInterval(value: string | undefined): string | null {
    const interval = value?.trim().toLowerCase();
    if (!interval) return null;
    if (/^\d+$/.test(interval)) {
        return `${interval}m`;
    }
    if (/^\d+(m|h|d|w)$/.test(interval)) {
        return interval;
    }
    return null;
}

function getStrategyConfigChartContext(config: StrategyConfig): { symbol: string | null; interval: string | null } {
    return {
        symbol: normalizeConfigSymbol(config.symbol),
        interval: normalizeConfigInterval(config.interval),
    };
}

function getSyntheticReloadCount(context: { symbol: string | null; interval: string | null }): number {
    const willChangeSymbol = Boolean(context.symbol) && context.symbol !== state.currentSymbol;
    const willChangeInterval = Boolean(context.interval) && context.interval !== state.currentInterval;
    return (willChangeSymbol ? 1 : 0) + (willChangeInterval ? 1 : 0);
}

export async function applySharedStrategyConfig(
    config: StrategyConfig,
    context: SharedChartContext,
): Promise<void> {
    await settingsManager.applyStrategyConfig(config);

    const plan = buildSharedSyntheticApplyPlan({
        config,
        currentSymbol: state.currentSymbol,
        currentInterval: state.currentInterval,
        context,
    });

    if (plan.suppressCount > 0) {
        dataManager.suppressNextAutoReload(plan.suppressCount);
    }

    if (state.currentSymbol !== plan.nextSymbol) {
        setCurrentSymbol(plan.nextSymbol);
    }
    if (state.currentInterval !== plan.nextInterval) {
        setCurrentInterval(plan.nextInterval);
    }

    if (plan.syntheticPair) {
        await regenerateSyntheticPair(
            plan.syntheticPair.baseSymbol,
            plan.syntheticPair.quoteSymbol,
            plan.nextInterval
        );
    }
}

async function applyUserStrategyConfig(config: StrategyConfig): Promise<void> {
    await settingsManager.applyStrategyConfig(config);

    const context = getStrategyConfigChartContext(config);
    // When the saved config carries a synthetic pair, the chart symbol is a
    // derived key (e.g. ZECAPT) that the regular data-fetcher cannot load —
    // it would route to Binance and fail with HTTP 400 + CORS. Suppress the
    // auto-reload that the symbol/interval change would trigger, so the
    // synthetic generator below is what actually populates the chart.
    const hasSyntheticPair = Boolean(config.syntheticPair) && Boolean(context.interval);
    if (hasSyntheticPair) {
        // Each change fires its own subscriber → its own auto-reload attempt.
        dataManager.suppressNextAutoReload(getSyntheticReloadCount(context));
    }
    if (context.symbol && context.symbol !== state.currentSymbol) {
        setCurrentSymbol(context.symbol);
    }
    if (context.interval && context.interval !== state.currentInterval) {
        setCurrentInterval(context.interval);
    }
    if (hasSyntheticPair) {
        await regenerateSyntheticPair(
            config.syntheticPair!.baseSymbol,
            config.syntheticPair!.quoteSymbol,
            context.interval!
        );
    }
}

/**
 * Public entry so other feature tabs (e.g. Signal Committee "Load") can apply
 * a saved configuration to the chart with the same symbol/interval switching
 * semantics as the Settings tab's Load button.
 */
export async function applySavedStrategyConfig(name: string): Promise<boolean> {
    const config = settingsManager.loadStrategyConfig(name);
    if (!config) return false;
    await applyUserStrategyConfig(config);
    return true;
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
        loadConfigBtn.addEventListener('click', async () => {
            const name = configSelect.value;
            if (!name) {
                uiManager.showToast('Please select a configuration to load', 'error');
                return;
            }
            const config = settingsManager.loadStrategyConfig(name);
            if (config) {
                await applyUserStrategyConfig(config);
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
        void applyUserStrategyConfig(persisted);
        updateConfigDropdown(persisted.name);
        notifyStrategyConfigsChanged();
        debugLogger.event('ui.config.shared.loaded', { name: persisted.name, source });
        return persisted;
    };

    if (configSelect) {
        configSelect.addEventListener('change', () => {
            setShareLinkOutput('');
            syncConfigActionButtons(dom, configSelect.value);
        });
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
            const context = getStrategyConfigChartContext(config);
            withChartContext.searchParams.set('symbol', context.symbol ?? state.currentSymbol);
            withChartContext.searchParams.set('interval', context.interval ?? state.currentInterval);
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
        void applySharedStrategyConfig(imported, sharedChartContext);
        updateConfigDropdown(imported.name);
        activateSharedLinkViewMode();
        consumeSharedConfigFromUrl();
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
    const rustToggle = createSettingsHandlersDom().useRustEngineToggle;
    if (!rustToggle) return;

    const updateStatus = () => {
        void refreshEngineStatus();
    };

    rustToggle.addEventListener('change', updateStatus);
    updateStatus();
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

function consumeSharedConfigFromUrl(): void {
    const url = new URL(window.location.href);
    if (!url.searchParams.has('strategyShare')) return;

    url.searchParams.delete('strategyShare');
    window.history.replaceState(window.history.state, '', url.toString());
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
    const dom = createSettingsHandlersDom();
    const configSelect = dom.configSelect;
    if (!configSelect) return;

    const configs = sortStrategyConfigsNewestFirst(settingsManager.loadAllStrategyConfigs());
    const currentValue = selectName || configSelect.value;

    populateConfigSelect(configSelect, configs, '-- Select configuration --', currentValue);
    syncConfigActionButtons(dom, configSelect.value);
}

/**
 * Disable Load/Delete until a real configuration is selected so the
 * destructive action never sits one click away from the placeholder. Mirrors
 * the existing empty-value guards inside the click handlers.
 */
function syncConfigActionButtons(
    dom: ReturnType<typeof createSettingsHandlersDom>,
    selectedValue: string
): void {
    const hasSelection = !!selectedValue;
    if (dom.loadConfigBtn) dom.loadConfigBtn.disabled = !hasSelection;
    if (dom.deleteConfigBtn) dom.deleteConfigBtn.disabled = !hasSelection;
}

function populateConfigSelect(
    select: HTMLSelectElement,
    configs: readonly StrategyConfig[],
    placeholder: string,
    selectedValue: string
): void {
    const fragment = document.createDocumentFragment();
    const placeholderOption = document.createElement('option');
    placeholderOption.value = '';
    placeholderOption.textContent = placeholder;
    fragment.appendChild(placeholderOption);

    configs.forEach(config => {
        const option = document.createElement('option');
        option.value = config.name;
        option.textContent = `${config.name} (${config.strategyKey})`;
        fragment.appendChild(option);
    });

    select.replaceChildren(fragment);
    if (selectedValue && configs.some(c => c.name === selectedValue)) {
        select.value = selectedValue;
    }
}
