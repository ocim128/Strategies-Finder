/**
 * Alert Handlers - wires up the Alerts tab UI to the alert service.
 */

import {
    alertService,
    AlertSubscription,
    buildAlertStreamId,
} from '../alert-service';
import {
    closeAlertConfigModal,
    closeLastTradeModal,
    handleLastTradeAction,
    initAlertModals,
    openSubscriptionInfoModal,
} from '../alert-modals';
import { resolveCurrentConfigName, resolveSubscriptionConfigName, safeJsonParse } from '../alert-config-resolver';
import { renderSignalHistory, renderSubscriptions } from '../alert-subscription-renderer';
import { uiManager } from '../ui-manager';
import { state } from '../state';
import { settingsManager } from '../settings-manager';
import { dataManager } from '../data-manager';
import { getOptionalElement } from '../dom-utils';
import {
    getWorkerStrategySupportSnapshot,
    isWorkerSupportedStrategyKey,
} from '../alert-subscription-utils';
import {
    collectCurrentAlertStrategyParams,
    collectCurrentAlertSubscriptionBacktestSettings,
    resolveCurrentAlertSubscriptionContext,
} from '../current-alert-subscription';
import {
    buildAlertWorkerProviderMismatchMessage,
    isAlertWorkerProviderCompatible,
} from '../alert-worker-compat';
import { getBinanceProviderForMarketType, isBinanceDataProvider, resolveBinanceMarketType } from '../binance-market';

let subscriptionsByStreamId: Map<string, AlertSubscription> = new Map();
const localWorkerStrategySupport = getWorkerStrategySupportSnapshot();

function resolveAlertProvider(symbol: string, backtestSettings?: Record<string, unknown>) {
    const provider = dataManager.getProvider(symbol);
    if (!isBinanceDataProvider(provider)) {
        return provider;
    }

    const marketType = resolveBinanceMarketType(backtestSettings?.binanceMarketType, state.binanceMarketType);
    return getBinanceProviderForMarketType(marketType);
}

function getAlertWorkerProviderCompatibilityError(symbol: string, backtestSettings?: Record<string, unknown>): string | null {
    const provider = resolveAlertProvider(symbol, backtestSettings);
    return isAlertWorkerProviderCompatible(provider)
        ? null
        : buildAlertWorkerProviderMismatchMessage(symbol, provider);
}

function normalizeWorkerSupportedStrategyKeys(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim())
        .sort((a, b) => a.localeCompare(b));
}

function summarizeStrategyKeys(keys: readonly string[], maxItems = 6): string {
    if (keys.length === 0) return 'none';
    if (keys.length <= maxItems) return keys.join(', ');
    return `${keys.slice(0, maxItems).join(', ')}, +${keys.length - maxItems} more`;
}

function getMissingWorkerStrategies(remoteSupportedStrategyKeys: readonly string[]): string[] {
    const remoteSupported = new Set(remoteSupportedStrategyKeys);
    return localWorkerStrategySupport.supportedStrategyKeys.filter((key) => !remoteSupported.has(key));
}

function buildWorkerStrategyDriftMessage(remoteSupportedStrategyKeys: readonly string[]): string | null {
    const missingStrategies = getMissingWorkerStrategies(remoteSupportedStrategyKeys);
    if (missingStrategies.length === 0) return null;
    return `Worker is outdated. Missing ${missingStrategies.length} local strategies: ${summarizeStrategyKeys(missingStrategies)}. Deploy the current worker build.`;
}

function formatAlertActionError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    const unsupportedPrefix = 'worker_strategy_not_supported:';
    if (!message.startsWith(unsupportedPrefix)) {
        return message;
    }

    const strategyKey = message.slice(unsupportedPrefix.length).trim();
    if (!strategyKey) {
        return message;
    }

    if (isWorkerSupportedStrategyKey(strategyKey)) {
        return `Worker is outdated and does not support "${strategyKey}" yet. Deploy the current worker build.`;
    }

    return `Worker does not support "${strategyKey}". Register it in the shared strategy manifest and redeploy the worker.`;
}

async function testConnection() {
    const dot = getOptionalElement('alertStatusDot');
    const msg = getOptionalElement('alertStatusMsg');

    if (dot) {
        dot.className = 'alert-status-dot alert-status-checking';
        dot.title = 'Checking...';
    }
    if (msg) msg.textContent = 'Testing connection...';

    const result = await alertService.healthCheck();

    if (result.ok) {
        const remoteSupportedStrategyKeys = normalizeWorkerSupportedStrategyKeys(result.supportedStrategyKeys);
        const workerDriftMessage = remoteSupportedStrategyKeys.length > 0
            ? buildWorkerStrategyDriftMessage(remoteSupportedStrategyKeys)
            : null;
        if (dot) {
            dot.className = workerDriftMessage ? 'alert-status-dot alert-status-fail' : 'alert-status-dot alert-status-ok';
            dot.title = workerDriftMessage ? 'Outdated worker' : 'Connected';
        }
        if (msg) {
            msg.textContent = workerDriftMessage
                ? workerDriftMessage
                : `Connected to worker (${result.supportedStrategyCount ?? localWorkerStrategySupport.supportedStrategyCount} strategies).`;
        }
        uiManager.showToast(workerDriftMessage ?? 'Worker connection OK.', workerDriftMessage ? 'error' : 'success');
    } else {
        if (dot) {
            dot.className = 'alert-status-dot alert-status-fail';
            dot.title = 'Failed';
        }
        if (msg) msg.textContent = `Connection failed: ${result.error ?? 'Unknown error'}`;
        uiManager.showToast('Worker connection failed.', 'error');
    }
}

async function refreshSubscriptions() {
    try {
        const subs = await alertService.listSubscriptions();
        subscriptionsByStreamId = new Map(subs.map((sub) => [sub.stream_id, sub]));
        renderSubscriptions(subs);
    } catch (err) {
        uiManager.showToast('Failed to load subscriptions: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
}

async function quickSubscribe() {
    const telegramToggle = getOptionalElement<HTMLInputElement>('alertTelegramToggle');
    const exitToggle = getOptionalElement<HTMLInputElement>('alertExitToggle');
    const freshnessBarsInput = getOptionalElement<HTMLInputElement>('alertFreshnessBars');

    const symbol = state.currentSymbol;
    const interval = state.currentInterval;
    const strategyKey = state.currentStrategyKey;

    if (!symbol || !interval || !strategyKey) {
        uiManager.showToast('Load a chart and select a strategy first.', 'error');
        return;
    }
    const providerError = getAlertWorkerProviderCompatibilityError(symbol);
    if (providerError) {
        uiManager.showToast(providerError, 'error');
        return;
    }
    if (!isWorkerSupportedStrategyKey(strategyKey)) {
        uiManager.showToast(`Alerts only support worker-registered strategies. "${strategyKey}" is not available in the worker library.`, 'error');
        return;
    }

    const alertContext = resolveCurrentAlertSubscriptionContext();
    const strategyParams = alertContext?.strategyParams ?? collectCurrentAlertStrategyParams();
    const rawBacktestSettings = alertContext?.backtestSettings ?? collectCurrentAlertSubscriptionBacktestSettings();
    const configName = alertContext?.configName ?? resolveCurrentConfigName(strategyKey, strategyParams, rawBacktestSettings);
    const streamId = alertContext?.streamId
        ?? buildAlertStreamId(symbol, interval, strategyKey, configName ?? undefined);

    try {
        const parsedFreshness = Number.parseInt(freshnessBarsInput?.value ?? '1', 10);
        const candleLimit = Math.max(200, Math.min(50000, state.ohlcvData.length || 350));
        const basePayload = {
            symbol,
            interval,
            strategyKey,
            configName: configName ?? undefined,
            strategyParams,
            enabled: true,
            notifyTelegram: telegramToggle?.checked ?? true,
            notifyExit: exitToggle?.checked ?? false,
            freshnessBars: Number.isFinite(parsedFreshness) ? Math.max(0, parsedFreshness) : 1,
            candleLimit,
        };
        const result = await alertService.upsertSubscription({
            ...basePayload,
            streamId,
            backtestSettings: rawBacktestSettings,
        });
        uiManager.showToast(`Subscribed: ${result.streamId}`, 'success');
        await refreshSubscriptions();
    } catch (err) {
        uiManager.showToast('Subscribe failed: ' + formatAlertActionError(err), 'error');
    }
}

async function handleTableAction(action: string, streamId: string) {
    try {
        if (action === 'info') {
            const sub = subscriptionsByStreamId.get(streamId);
            if (!sub) {
                uiManager.showToast(`Subscription not found: ${streamId}`, 'error');
                return;
            }
            const configName = resolveSubscriptionConfigName(sub, settingsManager.loadAllStrategyConfigs());
            openSubscriptionInfoModal(sub, configName);
            return;
        }

        if (action === 'run') {
            uiManager.showToast(`Running ${streamId}...`, 'info');
            const result = await alertService.runNow(streamId, true);
            const status = result.status ?? 'unknown';
            const toastType = status.startsWith('error') ? 'error' : status === 'new_entry' ? 'success' : 'info';
            uiManager.showToast(`${streamId}: ${status}`, toastType);
            await refreshSubscriptions();
            return;
        }

        if (action === 'sync') {
            const strategyKey = state.currentStrategyKey;
            if (!strategyKey) {
                uiManager.showToast('Select a strategy first.', 'error');
                return;
            }
            if (!isWorkerSupportedStrategyKey(strategyKey)) {
                uiManager.showToast(`Alerts only support worker-registered strategies. "${strategyKey}" is not available in the worker library.`, 'error');
                return;
            }

            const sub = subscriptionsByStreamId.get(streamId);
            const subBacktestSettings = sub
                ? safeJsonParse<Record<string, unknown>>(sub.backtest_settings_json, {})
                : undefined;
            const providerError = getAlertWorkerProviderCompatibilityError(
                sub?.symbol ?? state.currentSymbol,
                subBacktestSettings
            );
            if (providerError) {
                uiManager.showToast(providerError, 'error');
                return;
            }
            const currentSettings = collectCurrentAlertSubscriptionBacktestSettings();
            const syncedCandleLimit = Math.max(
                200,
                Math.min(50000, state.ohlcvData.length || sub?.candle_limit || 350)
            );
            await alertService.upsertSubscription({
                streamId,
                strategyKey,
                strategyParams: collectCurrentAlertStrategyParams(),
                backtestSettings: currentSettings,
                candleLimit: syncedCandleLimit,
            });
            uiManager.showToast(`Updated ${streamId} to current strategy (${strategyKey}).`, 'success');

            await refreshSubscriptions();
            return;
        }

        if (action === 'disable') {
            await alertService.disableSubscription(streamId);
            uiManager.showToast(`Disabled: ${streamId}`, 'success');
            await refreshSubscriptions();
            return;
        }

        if (action === 'lastTrade') {
            const sub = subscriptionsByStreamId.get(streamId);
            if (!sub) {
                uiManager.showToast(`Subscription not found: ${streamId}`, 'error');
                return;
            }
            await handleLastTradeAction(streamId, sub, {
                getProviderCompatibilityError: getAlertWorkerProviderCompatibilityError,
            });
        }
    } catch (err) {
        uiManager.showToast('Action failed: ' + formatAlertActionError(err), 'error');
    }
}

async function loadSignalHistory() {
    const select = getOptionalElement<HTMLSelectElement>('alertHistoryStreamSelect');
    const streamId = select?.value;
    if (!streamId) {
        uiManager.showToast('Select a subscription first.', 'error');
        return;
    }
    try {
        const signals = await alertService.getSignalHistory(streamId, 50);
        renderSignalHistory(signals);
    } catch (err) {
        uiManager.showToast('Failed to load history: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
}

export function initAlertHandlers() {
    initAlertModals();

    const urlInput = getOptionalElement<HTMLInputElement>('alertWorkerUrl');
    if (urlInput) {
        urlInput.value = alertService.getWorkerUrl();
        urlInput.addEventListener('change', () => {
            alertService.setWorkerUrl(urlInput.value.trim());
        });
    }
    const tokenInput = getOptionalElement<HTMLInputElement>('alertWorkerToken');
    if (tokenInput) {
        tokenInput.value = alertService.getWorkerToken();
        tokenInput.addEventListener('change', () => {
            alertService.setWorkerToken(tokenInput.value);
        });
    }

    getOptionalElement('alertTestBtn')?.addEventListener('click', testConnection);
    getOptionalElement('alertQuickSubscribeBtn')?.addEventListener('click', quickSubscribe);
    getOptionalElement('alertRefreshBtn')?.addEventListener('click', refreshSubscriptions);

    getOptionalElement('alertTableBody')?.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.alert-action-btn');
        if (!btn) return;
        const action = btn.dataset.action;
        const streamId = btn.dataset.stream;
        if (action && streamId) void handleTableAction(action, streamId);
    });

    getOptionalElement('alertHistoryLoadBtn')?.addEventListener('click', () => {
        void loadSignalHistory();
    });

    getOptionalElement('alertConfigModalClose')?.addEventListener('click', closeAlertConfigModal);
    getOptionalElement('alertConfigModal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeAlertConfigModal();
        }
    });

    getOptionalElement('lastTradeModalClose')?.addEventListener('click', closeLastTradeModal);
    getOptionalElement('lastTradeModal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeLastTradeModal();
        }
    });

    window.addEventListener('strategy-panel:tab-change', ((event: Event) => {
        const customEvent = event as CustomEvent<{ tabId?: string }>;
        if (customEvent.detail?.tabId === 'alerts') {
            void refreshSubscriptions();
        }
    }) as EventListener);

    const alertsPanel = getOptionalElement<HTMLElement>('alertsTab');
    if (alertsPanel && !alertsPanel.hidden && alertsPanel.style.display !== 'none') {
        void refreshSubscriptions();
    }
}
