import {
    settingsManager,
    sortStrategyConfigsNewestFirst,
    type StrategyConfig,
} from "../settings-manager";
import { uiManager } from "../ui-manager";
import { debugLogger } from "../debug-logger";
import { refreshEngineStatus } from "../engine-status-indicator";
import { state } from "../state";
import { setCurrentInterval, setCurrentSymbol } from "../state-actions";
import { dataManager } from "../data-manager";
import {
    createStrategyShareLink,
    parseStrategyConfigFromCurrentUrl,
    parseStrategyConfigFromSharedInput,
} from "../strategy-share-service";
import { strategyPanelController } from "../strategy-panel-controller";
import { copyToClipboard } from "../browser-transfer";
import { createSettingsHandlersDom } from "./settings-handlers-dom";
import { buildSharedSyntheticApplyPlan, type SharedChartContext } from "./settings-handlers-shared";

const STRATEGY_CONFIGS_CHANGED_EVENT = "strategy-configs:changed";
const bulkConfigSelectionAnchors = new WeakMap<HTMLElement, string>();

const SHARED_DEFAULT_SYMBOL = 'ETHUSDT';
const SHARED_DEFAULT_INTERVAL = '120m';

// Dynamic import keeps data-mining-manager (the entire Data Mining UI) out of
// the startup chunk — see lib/synthetic-pair-session.ts. Both call sites are
// async, so this thin wrapper is the only seam.
async function regenerateSyntheticPair(baseSymbol: string, quoteSymbol: string, interval: string): Promise<boolean> {
    const { dataMiningManager } = await import("../data-mining-manager");
    return dataMiningManager.regenerateSyntheticPair(baseSymbol, quoteSymbol, interval);
}

let configApplyTail: Promise<void> = Promise.resolve();

function enqueueConfigApply(work: () => Promise<void>): Promise<void> {
    const next = configApplyTail.then(work, work);
    configApplyTail = next.catch(() => undefined);
    return next;
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

export function applySharedStrategyConfig(
    config: StrategyConfig,
    context: SharedChartContext,
): Promise<void> {
    return enqueueConfigApply(async () => {
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
            const regenerated = await regenerateSyntheticPair(
                plan.syntheticPair.baseSymbol,
                plan.syntheticPair.quoteSymbol,
                plan.nextInterval
            );
            if (!regenerated) throw new Error("Synthetic pair regeneration failed.");
        }
    });
}

function applyUserStrategyConfig(config: StrategyConfig): Promise<void> {
    return enqueueConfigApply(async () => {
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
            const regenerated = await regenerateSyntheticPair(
                config.syntheticPair!.baseSymbol,
                config.syntheticPair!.quoteSymbol,
                context.interval!
            );
            if (!regenerated) throw new Error("Synthetic pair regeneration failed.");
        }
    });
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
    dom.restoreSettingsConfigBtn?.addEventListener('click', async () => {
        const config = settingsManager.getActiveConfiguration();
        if (!config || !dom.restoreSettingsConfigBtn) return;
        const button = dom.restoreSettingsConfigBtn;
        button.dataset.restoring = 'true';
        button.disabled = true;
        try {
            await applyUserStrategyConfig(config);
            uiManager.showToast(`Configuration "${config.name}" restored`, 'success');
        } catch (error) {
            debugLogger.error('ui.config.restore_failed', { name: config.name, error: String(error) });
            uiManager.showToast(`Failed to restore configuration "${config.name}"`, 'error');
        } finally {
            delete button.dataset.restoring;
            button.disabled = !settingsManager.getWorkspaceFeedback().modified;
        }
    });
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
            if (!config) {
                uiManager.showToast(`Configuration "${name}" was not found`, 'error');
                return;
            }
            try {
                await applyUserStrategyConfig(config);
                uiManager.showToast(`Configuration "${name}" loaded`, 'success');
                debugLogger.event('ui.config.loaded', { name });
            } catch (error) {
                debugLogger.error('ui.config.load_failed', {
                    name,
                    error: error instanceof Error ? error.message : String(error),
                });
                uiManager.showToast(`Failed to load configuration "${name}"`, 'error');
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
                if (!settingsManager.deleteStrategyConfig(name)) {
                    uiManager.showToast(`Failed to delete configuration "${name}"`, 'error');
                    return;
                }
                updateConfigDropdown();
                notifyStrategyConfigsChanged();
                uiManager.showToast(`Configuration "${name}" deleted`, 'info');
                debugLogger.event('ui.config.deleted', { name });
            }
        });
    }

    dom.selectAllConfigs?.addEventListener('change', () => {
        if (dom.bulkConfigList) bulkConfigSelectionAnchors.delete(dom.bulkConfigList);
        for (const checkbox of getBulkConfigCheckboxes(dom)) {
            checkbox.checked = dom.selectAllConfigs!.checked;
        }
        syncBulkConfigSelection(dom);
    });
    dom.deleteSelectedConfigsBtn?.addEventListener('click', () => {
        const names = new Set(getBulkConfigCheckboxes(dom).filter(input => input.checked).map(input => input.value));
        if (names.size === 0) return;
        if (!confirm(`Delete ${names.size} saved configuration${names.size === 1 ? '' : 's'}?\n\n${[...names].join('\n')}\n\nThis cannot be undone.`)) return;
        if (!settingsManager.deleteStrategyConfigs(names)) {
            uiManager.showToast('Failed to delete selected configurations. No configurations were deleted.', 'error');
            return;
        }
        updateConfigDropdown();
        notifyStrategyConfigsChanged();
        uiManager.showToast(`${names.size} configuration${names.size === 1 ? '' : 's'} deleted`, 'info');
        debugLogger.event('ui.config.bulk_deleted', { count: names.size });
    });

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

        let persisted: StrategyConfig;
        try {
            persisted = settingsManager.upsertStrategyConfig(parsed);
        } catch (error) {
            debugLogger.error('ui.config.shared.persist_failed', {
                source,
                error: error instanceof Error ? error.message : String(error),
            });
            uiManager.showToast('Failed to persist shared configuration', 'error');
            return null;
        }
        updateConfigDropdown(persisted.name);
        notifyStrategyConfigsChanged();
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
        loadShareLinkBtn.addEventListener('click', async () => {
            const sharedInput = shareConfigImportInput.value.trim();
            if (!sharedInput) {
                uiManager.showToast('Paste a shared strategy link first', 'error');
                return;
            }

            const imported = importSharedConfig(sharedInput, 'manual');
            if (!imported) return;

            try {
                await applyUserStrategyConfig(imported);
                shareConfigImportInput.value = '';
                setShareLinkOutput('');
                uiManager.showToast(`Shared configuration "${imported.name}" loaded`, 'success');
                debugLogger.event('ui.config.shared.loaded', { name: imported.name, source: 'manual' });
            } catch (error) {
                debugLogger.error('ui.config.shared.apply_failed', {
                    name: imported.name,
                    source: 'manual',
                    error: error instanceof Error ? error.message : String(error),
                });
                uiManager.showToast(`Failed to apply shared configuration "${imported.name}"`, 'error');
            }
        });
    }

    const sharedConfig = parseStrategyConfigFromCurrentUrl();
    if (sharedConfig) {
        const sharedChartContext = getSharedChartContextFromUrl();

        let imported: StrategyConfig | null = null;
        try {
            imported = settingsManager.upsertStrategyConfig(sharedConfig);
        } catch (error) {
            debugLogger.error('ui.config.shared.persist_failed', {
                source: 'url',
                error: error instanceof Error ? error.message : String(error),
            });
            uiManager.showToast('Failed to persist shared configuration', 'error');
        }
        if (imported) {
            const importedConfig = imported;
            void applySharedStrategyConfig(importedConfig, sharedChartContext)
                .then(() => {
                    updateConfigDropdown(importedConfig.name);
                    activateSharedLinkViewMode();
                    consumeSharedConfigFromUrl();
                    uiManager.showToast(`Shared configuration "${importedConfig.name}" loaded. Click Run to backtest.`, 'success');
                    debugLogger.event('ui.config.shared.loaded', { name: importedConfig.name, source: 'url' });
                })
                .catch((error) => {
                    debugLogger.error('ui.config.shared.apply_failed', {
                        name: importedConfig.name,
                        source: 'url',
                        error: error instanceof Error ? error.message : String(error),
                    });
                    uiManager.showToast(`Failed to apply shared configuration "${importedConfig.name}"`, 'error');
                });
        }
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
    populateBulkConfigList(dom, configs);
}

function getBulkConfigCheckboxes(dom: ReturnType<typeof createSettingsHandlersDom>): HTMLInputElement[] {
    return Array.from(dom.bulkConfigList?.querySelectorAll<HTMLInputElement>('input[type="checkbox"]') ?? []);
}

function syncBulkConfigSelection(dom: ReturnType<typeof createSettingsHandlersDom>): void {
    const checkboxes = getBulkConfigCheckboxes(dom);
    const count = checkboxes.filter(input => input.checked).length;
    if (dom.selectAllConfigs) {
        dom.selectAllConfigs.disabled = checkboxes.length === 0;
        dom.selectAllConfigs.checked = count > 0 && count === checkboxes.length;
        dom.selectAllConfigs.indeterminate = count > 0 && count < checkboxes.length;
    }
    if (dom.bulkConfigSelectionCount) dom.bulkConfigSelectionCount.textContent = `${count} selected`;
    if (dom.deleteSelectedConfigsBtn) dom.deleteSelectedConfigsBtn.disabled = count === 0;
}

function populateBulkConfigList(dom: ReturnType<typeof createSettingsHandlersDom>, configs: readonly StrategyConfig[]): void {
    if (!dom.bulkConfigList) return;
    const selected = new Set(getBulkConfigCheckboxes(dom).filter(input => input.checked).map(input => input.value));
    const list = dom.bulkConfigList;
    const anchor = bulkConfigSelectionAnchors.get(list);
    if (anchor && !configs.some(config => config.name === anchor)) bulkConfigSelectionAnchors.delete(list);
    const fragment = document.createDocumentFragment();
    for (const config of configs) {
        const label = document.createElement('label');
        label.className = 'config-bulk-option';
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.value = config.name;
        checkbox.checked = selected.has(config.name);
        checkbox.addEventListener('click', event => {
            const checkboxes = getBulkConfigCheckboxes(dom);
            const anchorIndex = checkboxes.findIndex(input => input.value === bulkConfigSelectionAnchors.get(list));
            const clickedIndex = checkboxes.indexOf(checkbox);
            if (event.shiftKey && anchorIndex >= 0 && clickedIndex >= 0) {
                const start = Math.min(anchorIndex, clickedIndex);
                const end = Math.max(anchorIndex, clickedIndex);
                for (let index = start; index <= end; index += 1) {
                    checkboxes[index].checked = checkbox.checked;
                }
            }
            bulkConfigSelectionAnchors.set(list, config.name);
            syncBulkConfigSelection(dom);
        });
        checkbox.addEventListener('change', () => syncBulkConfigSelection(dom));
        const text = document.createElement('span');
        text.textContent = `${config.name} (${config.strategyKey})`;
        label.appendChild(checkbox);
        label.appendChild(text);
        fragment.appendChild(label);
    }
    if (configs.length === 0) {
        const empty = document.createElement('span');
        empty.className = 'param-hint';
        empty.textContent = 'No saved configurations.';
        fragment.appendChild(empty);
    }
    dom.bulkConfigList.replaceChildren(fragment);
    syncBulkConfigSelection(dom);
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
