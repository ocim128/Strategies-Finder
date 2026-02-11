/**
 * Alert Handlers - wires up the Alerts tab UI to the alert service.
 */

import { alertService, AlertSubscription, AlertSignalRecord } from '../alert-service';
import { uiManager } from '../ui-manager';
import { state } from '../state';
import { settingsManager } from '../settings-manager';

function el<T extends HTMLElement>(id: string): T | null {
    return document.getElementById(id) as T | null;
}

function safeJsonParse<T>(raw: string, fallback: T): T {
    try {
        return JSON.parse(raw);
    } catch {
        return fallback;
    }
}

function renderSubscriptions(subs: AlertSubscription[]) {
    const emptyState = el('alertEmptyState');
    const tableWrapper = el('alertTableWrapper');
    const tbody = el<HTMLTableSectionElement>('alertTableBody');
    const historySelect = el<HTMLSelectElement>('alertHistoryStreamSelect');

    if (!tbody) return;

    const active = subs.filter((s) => s.enabled === 1);

    if (active.length === 0) {
        if (emptyState) emptyState.style.display = '';
        if (tableWrapper) tableWrapper.style.display = 'none';
    } else {
        if (emptyState) emptyState.style.display = 'none';
        if (tableWrapper) tableWrapper.style.display = '';
    }

    tbody.innerHTML = '';
    active.forEach((sub) => {
        const tr = document.createElement('tr');
        const telegramTag = sub.notify_telegram ? 'TG' : '--';
        const exitTag = sub.notify_exit ? 'EXIT' : '--';
        const lastStatus = sub.last_status ?? '--';
        const statusClass = lastStatus.startsWith('new_entry') ? 'alert-status-new'
            : lastStatus.startsWith('error') ? 'alert-status-error'
                : '';

        tr.innerHTML = `
            <td title="${sub.stream_id}" class="alert-cell-stream">${sub.stream_id.length > 20 ? sub.stream_id.slice(0, 20) + '...' : sub.stream_id}</td>
            <td>${sub.symbol}</td>
            <td>${sub.interval}</td>
            <td>${sub.strategy_key}</td>
            <td class="${statusClass}">${telegramTag} ${exitTag} ${lastStatus}</td>
            <td class="alert-cell-actions">
                <button class="btn btn-secondary btn-compact alert-action-btn" data-action="run" data-stream="${sub.stream_id}" title="Run Now">Run</button>
                <button class="btn btn-secondary btn-compact alert-action-btn" data-action="disable" data-stream="${sub.stream_id}" title="Disable">Disable</button>
            </td>
        `;
        tbody.appendChild(tr);
    });

    if (historySelect) {
        const prevValue = historySelect.value;
        historySelect.innerHTML = '<option value="">Select a subscription...</option>';
        subs.forEach((sub) => {
            const opt = document.createElement('option');
            opt.value = sub.stream_id;
            opt.textContent = `${sub.symbol} | ${sub.interval} | ${sub.strategy_key}`;
            historySelect.appendChild(opt);
        });
        if (prevValue) historySelect.value = prevValue;
    }
}

function renderSignalHistory(signals: AlertSignalRecord[]) {
    const wrapper = el('alertHistoryWrapper');
    const empty = el('alertHistoryEmpty');
    const tbody = el<HTMLTableSectionElement>('alertHistoryBody');
    if (!tbody) return;

    if (signals.length === 0) {
        if (wrapper) wrapper.style.display = 'none';
        if (empty) {
            empty.style.display = '';
            empty.innerHTML = '<p>No signals found for this subscription.</p>';
        }
        return;
    }

    if (wrapper) wrapper.style.display = '';
    if (empty) empty.style.display = 'none';

    tbody.innerHTML = '';
    signals.forEach((sig) => {
        const payload = safeJsonParse<Record<string, unknown>>(sig.payload_json, {});
        const tp = payload.takeProfitPrice != null ? Number(payload.takeProfitPrice).toFixed(2) : '-';
        const sl = payload.stopLossPrice != null ? Number(payload.stopLossPrice).toFixed(2) : '-';
        const dirClass = sig.direction === 'long' ? 'alert-dir-long' : 'alert-dir-short';

        const tr = document.createElement('tr');
        tr.innerHTML = `
            <td>${new Date(sig.signal_time * 1000).toISOString().replace('T', ' ').slice(0, 19)}</td>
            <td class="${dirClass}">${sig.direction.toUpperCase()}</td>
            <td>${sig.signal_price}</td>
            <td>${tp}</td>
            <td>${sl}</td>
        `;
        tbody.appendChild(tr);
    });
}

async function testConnection() {
    const dot = el('alertStatusDot');
    const msg = el('alertStatusMsg');

    if (dot) {
        dot.className = 'alert-status-dot alert-status-checking';
        dot.title = 'Checking...';
    }
    if (msg) msg.textContent = 'Testing connection...';

    const result = await alertService.healthCheck();

    if (result.ok) {
        if (dot) {
            dot.className = 'alert-status-dot alert-status-ok';
            dot.title = 'Connected';
        }
        if (msg) msg.textContent = 'Connected to worker.';
        uiManager.showToast('Worker connection OK.', 'success');
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
        renderSubscriptions(subs);
    } catch (err) {
        uiManager.showToast('Failed to load subscriptions: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
}

async function quickSubscribe() {
    const telegramToggle = el<HTMLInputElement>('alertTelegramToggle');
    const exitToggle = el<HTMLInputElement>('alertExitToggle');
    const freshnessBarsInput = el<HTMLInputElement>('alertFreshnessBars');

    const symbol = state.currentSymbol;
    const interval = state.currentInterval;
    const strategyKey = state.currentStrategyKey;

    if (!symbol || !interval || !strategyKey) {
        uiManager.showToast('Load a chart and select a strategy first.', 'error');
        return;
    }

    const strategyParams: Record<string, number> = {};
    document.querySelectorAll<HTMLInputElement>('#settingsTab .param-input[data-param]').forEach((input) => {
        const key = input.dataset.param;
        if (!key) return;
        const parsed = parseFloat(input.value);
        strategyParams[key] = Number.isFinite(parsed) ? parsed : 0;
    });

    const backtestSettings = settingsManager.getBacktestSettings();

    try {
        const result = await alertService.upsertSubscription({
            symbol,
            interval,
            strategyKey,
            strategyParams,
            backtestSettings,
            notifyTelegram: telegramToggle?.checked ?? true,
            notifyExit: exitToggle?.checked ?? false,
            freshnessBars: parseInt(freshnessBarsInput?.value ?? '1', 10) || 1,
        });
        uiManager.showToast(`Subscribed: ${result.streamId}`, 'success');
        await refreshSubscriptions();
    } catch (err) {
        uiManager.showToast('Subscribe failed: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
}

async function handleTableAction(action: string, streamId: string) {
    try {
        if (action === 'run') {
            uiManager.showToast(`Running ${streamId}...`, 'info');
            const result = await alertService.runNow(streamId, true);
            uiManager.showToast(`${streamId}: ${result.status}`, 'success');
            await refreshSubscriptions();
        } else if (action === 'disable') {
            await alertService.disableSubscription(streamId);
            uiManager.showToast(`Disabled: ${streamId}`, 'success');
            await refreshSubscriptions();
        }
    } catch (err) {
        uiManager.showToast('Action failed: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
}

async function loadSignalHistory() {
    const select = el<HTMLSelectElement>('alertHistoryStreamSelect');
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
    const urlInput = el<HTMLInputElement>('alertWorkerUrl');
    if (urlInput) {
        urlInput.value = alertService.getWorkerUrl();
        urlInput.addEventListener('change', () => {
            alertService.setWorkerUrl(urlInput.value.trim());
        });
    }

    el('alertTestBtn')?.addEventListener('click', testConnection);
    el('alertQuickSubscribeBtn')?.addEventListener('click', quickSubscribe);
    el('alertRefreshBtn')?.addEventListener('click', refreshSubscriptions);

    el('alertTableBody')?.addEventListener('click', (e) => {
        const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('.alert-action-btn');
        if (!btn) return;
        const action = btn.dataset.action;
        const streamId = btn.dataset.stream;
        if (action && streamId) void handleTableAction(action, streamId);
    });

    el('alertHistoryLoadBtn')?.addEventListener('click', () => {
        void loadSignalHistory();
    });

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.attributeName === 'style') {
                const tab = el('alertsTab');
                if (tab && tab.style.display !== 'none') {
                    void refreshSubscriptions();
                    break;
                }
            }
        }
    });

    const alertsTab = el('alertsTab');
    if (alertsTab) {
        observer.observe(alertsTab, { attributes: true, attributeFilter: ['style'] });
    }
}
