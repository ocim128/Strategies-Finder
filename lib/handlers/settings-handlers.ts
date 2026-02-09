import { settingsManager, type StrategyConfig } from "../settings-manager";
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

            const link = createStrategyShareLink(config);
            setShareLinkOutput(link);
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
        const imported = settingsManager.upsertStrategyConfig(sharedConfig);
        settingsManager.applyStrategyConfig(imported);
        updateConfigDropdown(imported.name);
        activateSharedLinkViewMode();
        scheduleSharedAutoBacktest();
        uiManager.showToast(`Shared configuration "${imported.name}" loaded`, 'success');
        debugLogger.event('ui.config.shared.loaded', { name: imported.name, source: 'url' });
    }

    // ========================================================================
    // Webhook Settings Event Handlers
    // ========================================================================

    setupWebhookHandlers();
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

/**
 * Setup webhook-specific UI event handlers
 */
function setupWebhookHandlers() {
    const webhookToggle = document.getElementById('webhookEnabledToggle') as HTMLInputElement | null;
    const webhookUrl = document.getElementById('webhookUrl') as HTMLInputElement | null;
    const webhookSecretKey = document.getElementById('webhookSecretKey') as HTMLInputElement | null;
    const webhookSecretToggle = document.getElementById('webhookSecretToggle');
    const webhookTestBtn = document.getElementById('webhookTestBtn') as HTMLButtonElement | null;
    const webhookSettings = document.getElementById('webhookSettings');
    const webhookSendOnSignal = document.getElementById('webhookSendOnSignal') as HTMLInputElement | null;
    const webhookSendOnTrade = document.getElementById('webhookSendOnTrade') as HTMLInputElement | null;

    // Shared function to update webhook status UI
    const updateWebhookStatus = () => {
        const settings = settingsManager.getWebhookSettings();
        const statusDot = document.getElementById('webhookStatusDot');
        const statusText = document.getElementById('webhookStatusText');
        const urlValidation = document.getElementById('webhookUrlValidation');

        // Validate URL
        const isValid = settings.url.trim() !== '' &&
            (() => { try { const u = new URL(settings.url); return u.protocol === 'http:' || u.protocol === 'https:'; } catch { return false; } })();

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
        if (webhookTestBtn) {
            webhookTestBtn.disabled = !settings.enabled || !isValid;
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
    };

    // Handle webhook section visibility toggle
    if (webhookToggle && webhookSettings) {
        const updateVisibility = () => {
            webhookSettings.classList.toggle('is-hidden', !webhookToggle.checked);
            // Update status when toggle changes
            updateWebhookStatus();
            // Trigger settings save
            settingsManager.saveSettingsDebounced();
        };
        webhookToggle.addEventListener('change', updateVisibility);
        // Initial state
        updateVisibility();
    }

    // Handle URL input with validation feedback
    if (webhookUrl) {
        webhookUrl.addEventListener('input', updateWebhookStatus);
        webhookUrl.addEventListener('change', updateWebhookStatus);
    }

    // Handle secret key visibility toggle
    if (webhookSecretToggle && webhookSecretKey) {
        webhookSecretToggle.addEventListener('click', () => {
            const isPassword = webhookSecretKey.type === 'password';
            webhookSecretKey.type = isPassword ? 'text' : 'password';
            webhookSecretToggle.title = isPassword ? 'Hide secret key' : 'Show secret key';
        });
    }

    // Handle test webhook button
    if (webhookTestBtn) {
        webhookTestBtn.addEventListener('click', async () => {
            const settings = settingsManager.getWebhookSettings();
            if (!settings.url) {
                uiManager.showToast('Please enter a webhook URL', 'error');
                return;
            }

            webhookTestBtn.disabled = true;
            const originalContent = webhookTestBtn.innerHTML;
            webhookTestBtn.innerHTML = '<span class="spinner"></span> Testing...';

            try {
                // Import webhook service dynamically to avoid circular deps
                const { webhookService } = await import('../webhook-service');
                const result = await webhookService.sendTestWebhook();

                if (result.success) {
                    uiManager.showToast('Webhook test successful!', 'success');
                } else {
                    uiManager.showToast(`Webhook test failed: ${result.error}`, 'error');
                }
            } catch (error) {
                const errorMessage = error instanceof Error ? error.message : 'Unknown error';
                uiManager.showToast(`Webhook test failed: ${errorMessage}`, 'error');
                debugLogger.event('webhook.test.error', { url: settings.url, error: errorMessage });
            } finally {
                webhookTestBtn.innerHTML = originalContent;
                webhookTestBtn.disabled = !settingsManager.isWebhookValid();
            }
        });
    }

    // Handle checkbox changes for event types
    [webhookSendOnSignal, webhookSendOnTrade].forEach(checkbox => {
        if (checkbox) {
            checkbox.addEventListener('change', () => {
                settingsManager.saveSettingsDebounced();
            });
        }
    });

    // Handle clear queue button
    const clearQueueBtn = document.getElementById('webhookClearBtn');
    if (clearQueueBtn) {
        clearQueueBtn.addEventListener('click', async () => {
            try {
                const { webhookService } = await import('../webhook-service');
                webhookService.clearQueue();
                uiManager.showToast('Webhook queue cleared', 'info');
            } catch (error) {
                console.error('[Webhook] Failed to clear queue:', error);
            }
        });
    }

    // Handle clear activity log button
    const clearActivityBtn = document.getElementById('webhookActivityClearBtn');
    const activityLog = document.getElementById('webhookActivity');
    if (clearActivityBtn && activityLog) {
        clearActivityBtn.addEventListener('click', () => {
            activityLog.innerHTML = '<div class="webhook-activity-empty">No webhook activity yet</div>';
        });
    }

    // Subscribe to webhook status updates
    initWebhookStatusSubscription();
}

/**
 * Activity log entries storage (in-memory, limited to last 20)
 */
const activityLogEntries: Array<{ time: string; event: string; status: 'success' | 'pending' | 'failed' }> = [];
const MAX_ACTIVITY_ENTRIES = 20;

/**
 * Initialize webhook status subscription for live UI updates
 */
async function initWebhookStatusSubscription(): Promise<void> {
    try {
        const { webhookService } = await import('../webhook-service');

        // Subscribe to status updates
        webhookService.subscribe((status) => {
            updateWebhookStatsUI(status);
        });

        // Initial status update
        const initialStatus = webhookService.getStatus();
        updateWebhookStatsUI(initialStatus);
    } catch (error) {
        console.debug('[Webhook] Status subscription not available:', error);
    }
}

/**
 * Update the webhook statistics UI
 */
function updateWebhookStatsUI(status: { pending: number; totalSent: number; totalFailed: number; lastSuccess?: Date; lastError?: string }) {
    const sentEl = document.getElementById('webhookStatSent');
    const pendingEl = document.getElementById('webhookStatPending');
    const failedEl = document.getElementById('webhookStatFailed');

    if (sentEl) sentEl.textContent = String(status.totalSent);
    if (pendingEl) {
        pendingEl.textContent = String(status.pending);
        pendingEl.classList.toggle('has-pending', status.pending > 0);
    }
    if (failedEl) failedEl.textContent = String(status.totalFailed);
}

/**
 * Add an entry to the activity log (called externally)
 */
export function addWebhookActivityEntry(event: string, status: 'success' | 'pending' | 'failed'): void {
    const activityLog = document.getElementById('webhookActivity');
    if (!activityLog) return;

    const now = new Date();
    const timeStr = now.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });

    // Add to in-memory log
    activityLogEntries.unshift({ time: timeStr, event, status });
    if (activityLogEntries.length > MAX_ACTIVITY_ENTRIES) {
        activityLogEntries.pop();
    }

    // Remove empty state if present
    const emptyState = activityLog.querySelector('.webhook-activity-empty');
    if (emptyState) {
        emptyState.remove();
    }

    // Create activity item
    const item = document.createElement('div');
    item.className = 'webhook-activity-item';
    item.innerHTML = `
        <span class="activity-time">${timeStr}</span>
        <span class="activity-event">${event}</span>
        <span class="activity-status ${status}">${status}</span>
    `;

    // Insert at top
    activityLog.insertBefore(item, activityLog.firstChild);

    // Limit visible entries
    while (activityLog.children.length > MAX_ACTIVITY_ENTRIES) {
        activityLog.removeChild(activityLog.lastChild!);
    }
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

function scheduleSharedAutoBacktest(): void {
    const maxAttempts = 40;
    const pollMs = 250;
    let attempt = 0;

    const runWhenReady = () => {
        attempt += 1;
        const hasData = state.ohlcvData.length > 0;
        const runButton = document.getElementById('runBacktest') as HTMLButtonElement | null;
        const isBusy = runButton?.disabled ?? false;

        if (hasData && !isBusy) {
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
