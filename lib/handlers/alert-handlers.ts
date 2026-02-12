/**
 * Alert Handlers - wires up the Alerts tab UI to the alert service.
 */

import { alertService, AlertSubscription, AlertSignalRecord } from '../alert-service';
import { uiManager } from '../ui-manager';
import { state } from '../state';
import { backtestService } from '../backtest-service';

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

function appendTextCell(
    row: HTMLTableRowElement,
    text: string,
    options?: { className?: string; title?: string }
): HTMLTableCellElement {
    const td = document.createElement('td');
    td.textContent = text;
    if (options?.className) td.className = options.className;
    if (options?.title) td.title = options.title;
    row.appendChild(td);
    return td;
}

function createActionButton(
    action: 'run' | 'sync' | 'disable',
    streamId: string,
    title: string,
    label: string
): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = 'btn btn-secondary btn-compact alert-action-btn';
    btn.dataset.action = action;
    btn.dataset.stream = streamId;
    btn.title = title;
    btn.textContent = label;
    return btn;
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
        appendTextCell(tr, sub.stream_id.length > 20 ? sub.stream_id.slice(0, 20) + '...' : sub.stream_id, {
            className: 'alert-cell-stream',
            title: sub.stream_id,
        });
        appendTextCell(tr, sub.symbol);
        appendTextCell(tr, sub.interval);
        appendTextCell(tr, sub.strategy_key);
        appendTextCell(tr, `${telegramTag} ${exitTag} ${lastStatus}`, {
            className: statusClass,
            title: lastStatus,
        });

        const actionsTd = document.createElement('td');
        actionsTd.className = 'alert-cell-actions';
        actionsTd.appendChild(createActionButton('run', sub.stream_id, 'Run Now', 'Run'));
        actionsTd.appendChild(createActionButton('sync', sub.stream_id, 'Use currently loaded strategy/settings', 'Use Current'));
        actionsTd.appendChild(createActionButton('disable', sub.stream_id, 'Disable', 'Disable'));
        tr.appendChild(actionsTd);

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
        const tpValue = Number(payload.takeProfitPrice);
        const slValue = Number(payload.stopLossPrice);
        const tp = Number.isFinite(tpValue) ? tpValue.toFixed(2) : '-';
        const sl = Number.isFinite(slValue) ? slValue.toFixed(2) : '-';
        const dirClass = sig.direction === 'long' ? 'alert-dir-long' : 'alert-dir-short';

        const tr = document.createElement('tr');
        appendTextCell(tr, new Date(sig.signal_time * 1000).toISOString().replace('T', ' ').slice(0, 19));
        appendTextCell(tr, sig.direction.toUpperCase(), { className: dirClass });
        appendTextCell(tr, String(sig.signal_price));
        appendTextCell(tr, tp);
        appendTextCell(tr, sl);
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

function collectCurrentStrategyParams(): Record<string, number> {
    const strategyParams: Record<string, number> = {};
    document.querySelectorAll<HTMLInputElement>('#settingsTab .param-input[data-param]').forEach((input) => {
        const key = input.dataset.param;
        if (!key) return;
        const parsed = Number.parseFloat(input.value);
        strategyParams[key] = Number.isFinite(parsed) ? parsed : 0;
    });
    return strategyParams;
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

    const strategyParams = collectCurrentStrategyParams();
    const backtestSettings = backtestService.getBacktestSettings();

    try {
        const parsedFreshness = Number.parseInt(freshnessBarsInput?.value ?? '1', 10);
        const result = await alertService.upsertSubscription({
            symbol,
            interval,
            strategyKey,
            strategyParams,
            backtestSettings,
            notifyTelegram: telegramToggle?.checked ?? true,
            notifyExit: exitToggle?.checked ?? false,
            freshnessBars: Number.isFinite(parsedFreshness) ? Math.max(0, parsedFreshness) : 1,
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
            const status = result.status ?? 'unknown';
            const toastType = status.startsWith('error') ? 'error' : status === 'new_entry' ? 'success' : 'info';
            uiManager.showToast(`${streamId}: ${status}`, toastType);
            await refreshSubscriptions();
        } else if (action === 'sync') {
            const strategyKey = state.currentStrategyKey;
            if (!strategyKey) {
                uiManager.showToast('Select a strategy first.', 'error');
                return;
            }

            await alertService.upsertSubscription({
                streamId,
                strategyKey,
                strategyParams: collectCurrentStrategyParams(),
                backtestSettings: backtestService.getBacktestSettings(),
            });
            uiManager.showToast(`Updated ${streamId} to current strategy (${strategyKey}).`, 'success');
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
