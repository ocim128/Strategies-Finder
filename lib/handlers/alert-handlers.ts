/**
 * Alert Handlers - wires up the Alerts tab UI to the alert service.
 */

import {
    alertService,
    AlertSubscription,
    AlertTwoHourCloseParity,
    AlertSignalRecord,
    buildAlertStreamId,
    parseAlertConfigNameFromStreamId,
    parseAlertTwoHourParityFromStreamId,
} from '../alert-service';
import { uiManager } from '../ui-manager';
import { state } from '../state';
import { backtestService } from '../backtest-service';
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

function stableNormalize(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(stableNormalize);
    if (value && typeof value === 'object') {
        const entries = Object.entries(value as Record<string, unknown>)
            .sort(([a], [b]) => a.localeCompare(b))
            .map(([k, v]) => [k, stableNormalize(v)]);
        return Object.fromEntries(entries);
    }
    return value;
}

function stableStringify(value: unknown): string {
    return JSON.stringify(stableNormalize(value));
}

function resolveCurrentConfigName(
    strategyKey: string,
    strategyParams: Record<string, number>,
    backtestSettings: unknown
): string | null {
    const targetParams = stableStringify(strategyParams);
    const targetSettings = stableStringify(backtestSettings);
    const matches = (config: { strategyKey: string; strategyParams: unknown; backtestSettings: unknown }): boolean =>
        config.strategyKey === strategyKey &&
        stableStringify(config.strategyParams) === targetParams &&
        stableStringify(config.backtestSettings) === targetSettings;

    const configSelect = el<HTMLSelectElement>('configSelect');
    const selected = configSelect?.value?.trim();
    const allConfigs = settingsManager.loadAllStrategyConfigs();

    if (selected) {
        const selectedConfig = allConfigs.find((config) => config.name === selected);
        if (selectedConfig && matches(selectedConfig)) {
            return selectedConfig.name;
        }
    }

    const matched = allConfigs.find(matches);

    return matched?.name ?? null;
}

function resolveSubscriptionConfigName(
    sub: AlertSubscription,
    savedConfigs: Array<{
        name: string;
        strategyKey: string;
        strategyParams: unknown;
        backtestSettings: unknown;
    }>
): string | null {
    const parsedFromStreamId = parseAlertConfigNameFromStreamId(sub.stream_id);
    if (parsedFromStreamId) return parsedFromStreamId;

    const subParams = safeJsonParse<unknown>(sub.strategy_params_json, {});
    const subSettings = safeJsonParse<unknown>(sub.backtest_settings_json, {});
    const subParamsKey = stableStringify(subParams);
    const subSettingsKey = stableStringify(subSettings);

    const matched = savedConfigs.find((config) =>
        config.strategyKey === sub.strategy_key &&
        stableStringify(config.strategyParams) === subParamsKey &&
        stableStringify(config.backtestSettings) === subSettingsKey
    );

    return matched?.name ?? null;
}

let subscriptionsByStreamId: Map<string, AlertSubscription> = new Map();
const STREAM_CONFIG_MARKER = ':cfg:';
const STREAM_PARITY_MARKER = ':2hcp:';

function humanizeKey(input: string): string {
    if (!input) return input;
    const spaced = input
        .replace(/_/g, ' ')
        .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
        .trim();
    return spaced.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function formatValue(value: unknown): string {
    if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NaN';
    if (typeof value === 'boolean') return value ? 'on' : 'off';
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value.join(', ');
    if (value === null || value === undefined) return '-';
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}

function getNumber(value: unknown): number | null {
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string' && value.trim() !== '') {
        const parsed = Number(value);
        return Number.isFinite(parsed) ? parsed : null;
    }
    return null;
}

function getIntervalSeconds(interval: string): number {
    const trimmed = interval.trim();
    const match = /^(\d+)(m|h|d|w|M)$/i.exec(trimmed);
    if (!match) return 0;
    const value = Number(match[1]);
    if (!Number.isFinite(value) || value <= 0) return 0;
    const unit = match[2] === 'M' ? 'M' : match[2].toLowerCase();
    if (unit === 'm') return value * 60;
    if (unit === 'h') return value * 3600;
    if (unit === 'd') return value * 86400;
    if (unit === 'w') return value * 604800;
    if (unit === 'M') return value * 2592000;
    return 0;
}

function resolveParityModeFromUi(): 'odd' | 'even' | 'both' {
    const select = el<HTMLSelectElement>('twoHourCloseParity');
    if (select?.value === 'even' || select?.value === 'both') return select.value;
    return 'odd';
}

function normalizeSubscriptionParity(value: unknown): AlertTwoHourCloseParity | null {
    if (value === 'even') return 'even';
    if (value === 'odd') return 'odd';
    return null;
}

function resolveSubscriptionParity(sub: AlertSubscription): AlertTwoHourCloseParity | null {
    const parsedFromStream = parseAlertTwoHourParityFromStreamId(sub.stream_id);
    if (parsedFromStream) return parsedFromStream;
    const settings = safeJsonParse<Record<string, unknown>>(sub.backtest_settings_json, {});
    return normalizeSubscriptionParity(settings.twoHourCloseParity);
}

function resolveEffectiveTwoHourParity(sub: AlertSubscription): { parity: AlertTwoHourCloseParity; source: 'stream' | 'settings' | 'default' } | null {
    if (getIntervalSeconds(sub.interval) !== 7200) return null;
    const fromStream = parseAlertTwoHourParityFromStreamId(sub.stream_id);
    if (fromStream) return { parity: fromStream, source: 'stream' };
    const settings = safeJsonParse<Record<string, unknown>>(sub.backtest_settings_json, {});
    const fromSettings = normalizeSubscriptionParity(settings.twoHourCloseParity);
    if (fromSettings) return { parity: fromSettings, source: 'settings' };
    return { parity: 'odd', source: 'default' };
}

function stripParityFromStreamId(streamId: string): string {
    const markerIndex = streamId.indexOf(STREAM_PARITY_MARKER);
    if (markerIndex < 0) return streamId;
    const start = markerIndex;
    const valueStart = markerIndex + STREAM_PARITY_MARKER.length;
    const configIndex = streamId.indexOf(STREAM_CONFIG_MARKER, valueStart);
    if (configIndex >= 0) {
        return `${streamId.slice(0, start)}${streamId.slice(configIndex)}`;
    }
    return streamId.slice(0, start);
}

function resolvePairedTwoHourParity(sub: AlertSubscription): AlertTwoHourCloseParity | null {
    if (getIntervalSeconds(sub.interval) !== 7200) return null;
    const baseKey = stripParityFromStreamId(sub.stream_id);
    let hasOdd = false;
    let hasEven = false;

    for (const item of subscriptionsByStreamId.values()) {
        if (getIntervalSeconds(item.interval) !== 7200) continue;
        if (stripParityFromStreamId(item.stream_id) !== baseKey) continue;
        const parity = resolveSubscriptionParity(item);
        if (parity === 'odd') hasOdd = true;
        if (parity === 'even') hasEven = true;
    }

    if (!hasOdd || !hasEven) return null;
    const current = resolveSubscriptionParity(sub);
    if (current === 'odd') return 'even';
    if (current === 'even') return 'odd';
    return null;
}

function applyTwoHourParityToBacktestSettings(
    settings: unknown,
    parity: AlertTwoHourCloseParity | null
): Record<string, unknown> {
    const cloned = (settings && typeof settings === 'object')
        ? { ...(settings as Record<string, unknown>) }
        : {};
    if (parity) {
        cloned.twoHourCloseParity = parity;
    } else {
        delete cloned.twoHourCloseParity;
    }
    return cloned;
}

function appendModalSection(container: HTMLElement, title: string, lines: string[]): void {
    const section = document.createElement('section');
    section.className = 'alert-config-section';

    const heading = document.createElement('h4');
    heading.textContent = title;
    section.appendChild(heading);

    const list = document.createElement('ul');
    list.className = 'alert-config-list';

    if (lines.length === 0) {
        const li = document.createElement('li');
        li.className = 'alert-config-muted';
        li.textContent = 'None';
        list.appendChild(li);
    } else {
        lines.forEach((line) => {
            const li = document.createElement('li');
            li.textContent = line;
            list.appendChild(li);
        });
    }

    section.appendChild(list);
    container.appendChild(section);
}

function collectEnabledSnapshotFilterLines(settings: Record<string, unknown>): string[] {
    const toggleKeys = Object.keys(settings)
        .filter((key) => key.startsWith('snapshot') && key.endsWith('FilterToggle') && settings[key] === true)
        .sort((a, b) => a.localeCompare(b));

    return toggleKeys.map((toggleKey) => {
        const base = toggleKey.slice(0, -'FilterToggle'.length);
        const label = humanizeKey(base.replace(/^snapshot/, ''));
        const valueKeys = Object.keys(settings)
            .filter((key) => key.startsWith(base) && key !== toggleKey)
            .sort((a, b) => a.localeCompare(b));

        if (valueKeys.length === 0) {
            return `${label}: enabled`;
        }

        const valueText = valueKeys
            .map((key) => {
                const suffix = key.slice(base.length);
                const suffixLabel = humanizeKey(suffix || key);
                return `${suffixLabel}=${formatValue(settings[key])}`;
            })
            .join(', ');
        return `${label}: ${valueText}`;
    });
}

function closeAlertConfigModal(): void {
    const overlay = el<HTMLElement>('alertConfigModal');
    if (overlay) overlay.classList.remove('active');
}

function openSubscriptionInfoModal(sub: AlertSubscription, configName: string | null): void {
    const overlay = el<HTMLElement>('alertConfigModal');
    const titleEl = el<HTMLElement>('alertConfigModalTitle');
    const bodyEl = el<HTMLElement>('alertConfigModalBody');
    if (!overlay || !titleEl || !bodyEl) return;

    const settings = safeJsonParse<Record<string, unknown>>(sub.backtest_settings_json, {});
    const strategyParams = safeJsonParse<Record<string, unknown>>(sub.strategy_params_json, {});
    const effectiveTwoHourParity = resolveEffectiveTwoHourParity(sub);
    const pairedTwoHourParity = resolvePairedTwoHourParity(sub);
    const twoHourParityText = !effectiveTwoHourParity
        ? formatValue(settings.twoHourCloseParity)
        : effectiveTwoHourParity.source === 'default'
            ? `${effectiveTwoHourParity.parity} (default)`
            : effectiveTwoHourParity.parity;
    const twoHourParityWithPairText = pairedTwoHourParity
        ? `${twoHourParityText} (paired with ${pairedTwoHourParity})`
        : twoHourParityText;

    titleEl.textContent = `Alert Config: ${sub.symbol} ${sub.interval}`;
    bodyEl.innerHTML = '';
    bodyEl.className = 'modal-body alert-config-modal-body';

    const identityLines = [
        `Configuration Name: ${configName ?? '(unresolved - using strategy key)'}`,
        `Strategy Key: ${sub.strategy_key}`,
        `Stream ID: ${sub.stream_id}`,
        `Freshness Bars: ${sub.freshness_bars}`,
        `Notifications: Telegram ${sub.notify_telegram === 1 ? 'on' : 'off'}, Exit ${sub.notify_exit === 1 ? 'on' : 'off'}`,
    ];
    appendModalSection(bodyEl, 'Identity', identityLines);

    const riskLines = [
        `Risk Mode: ${formatValue(settings.riskMode)}`,
        `Take Profit: ${settings.takeProfitEnabled === true ? `on (${formatValue(settings.takeProfitPercent)}%)` : 'off'}`,
        `Stop Loss: ${settings.stopLossEnabled === true ? `on (${formatValue(settings.stopLossPercent)}%)` : 'off'}`,
        `ATR Period: ${formatValue(settings.atrPeriod)}`,
        `Stop Loss ATR: ${formatValue(settings.stopLossAtr)}`,
        `Take Profit ATR: ${formatValue(settings.takeProfitAtr)}`,
        `Trailing ATR: ${formatValue(settings.trailingAtr)}`,
    ];
    appendModalSection(bodyEl, 'Risk / Targets', riskLines);

    const tradeFilterModeRaw = settings.tradeFilterMode ?? settings.entryConfirmation;
    const tradeFilterLines = [
        `Filter Enabled: ${settings.tradeFilterSettingsToggle === true ? 'on' : 'off'}`,
        `Filter Mode: ${formatValue(tradeFilterModeRaw)}`,
        `Confirm Lookback: ${formatValue(settings.confirmLookback)}`,
        `Volume SMA Period: ${formatValue(settings.volumeSmaPeriod)}`,
        `Volume Multiplier: ${formatValue(settings.volumeMultiplier)}`,
        `RSI Period: ${formatValue(settings.confirmRsiPeriod)}`,
        `RSI Bullish: ${formatValue(settings.confirmRsiBullish)}`,
        `RSI Bearish: ${formatValue(settings.confirmRsiBearish)}`,
    ];
    appendModalSection(bodyEl, 'Trade Filter', tradeFilterLines);

    const executionLines = [
        `Trade Direction: ${formatValue(settings.tradeDirection)}`,
        `Execution Model: ${formatValue(settings.executionModel)}`,
        `Allow Same Bar Exit: ${formatValue(settings.allowSameBarExit)}`,
        `Slippage Bps: ${formatValue(settings.slippageBps)}`,
        `Strategy Timeframe Enabled: ${formatValue(settings.strategyTimeframeEnabled)}`,
        `Strategy Timeframe Minutes: ${formatValue(settings.strategyTimeframeMinutes)}`,
        `2H Close Parity: ${twoHourParityWithPairText}`,
    ];
    appendModalSection(bodyEl, 'Execution', executionLines);

    const enabledSnapshotFilters = collectEnabledSnapshotFilterLines(settings);
    appendModalSection(bodyEl, 'Entry Quality Filters (Enabled)', enabledSnapshotFilters);

    const paramsLines = Object.keys(strategyParams)
        .sort((a, b) => a.localeCompare(b))
        .map((key) => `${key}: ${formatValue(strategyParams[key])}`);
    appendModalSection(bodyEl, 'Strategy Params', paramsLines);

    const confirmationStrategies = Array.isArray(settings.confirmationStrategies)
        ? settings.confirmationStrategies
        : [];
    const confirmationLines = confirmationStrategies.length > 0
        ? confirmationStrategies.map((value) => String(value))
        : [];
    appendModalSection(bodyEl, 'Confirmation Strategies', confirmationLines);

    // Show numeric snapshot values with non-zero values even when toggle state is inconsistent.
    const inferredSnapshotLines = Object.keys(settings)
        .filter((key) => key.startsWith('snapshot') && !key.endsWith('FilterToggle'))
        .sort((a, b) => a.localeCompare(b))
        .map((key) => ({ key, value: getNumber(settings[key]) }))
        .filter((row) => row.value !== null && row.value !== 0)
        .map((row) => `${humanizeKey(row.key.replace(/^snapshot/, ''))}: ${row.value}`);
    appendModalSection(bodyEl, 'Snapshot Values (Non-zero)', inferredSnapshotLines);

    overlay.classList.add('active');
}

function createActionButton(
    action: 'info' | 'run' | 'sync' | 'disable',
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
    const savedConfigs = settingsManager.loadAllStrategyConfigs();
    subscriptionsByStreamId = new Map(subs.map((sub) => [sub.stream_id, sub]));

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
        const configName = resolveSubscriptionConfigName(sub, savedConfigs);
        const parity = resolveSubscriptionParity(sub);
        const paritySuffix = getIntervalSeconds(sub.interval) === 7200 && parity ? ` [2H-${parity}]` : '';
        const strategyDisplay = `${configName ?? sub.strategy_key}${paritySuffix}`;
        const statusClass = lastStatus.startsWith('new_entry') ? 'alert-status-new'
            : lastStatus.startsWith('error') ? 'alert-status-error'
                : '';
        appendTextCell(tr, sub.stream_id.length > 20 ? sub.stream_id.slice(0, 20) + '...' : sub.stream_id, {
            className: 'alert-cell-stream',
            title: sub.stream_id,
        });
        appendTextCell(tr, sub.symbol);
        appendTextCell(tr, sub.interval);
        appendTextCell(tr, strategyDisplay, {
            title: configName ? `${configName}\nStrategy: ${sub.strategy_key}` : sub.strategy_key,
        });
        appendTextCell(tr, `${telegramTag} ${exitTag} ${lastStatus}`, {
            className: statusClass,
            title: lastStatus,
        });

        const actionsTd = document.createElement('td');
        actionsTd.className = 'alert-cell-actions';
        actionsTd.appendChild(createActionButton('info', sub.stream_id, 'View full alert configuration', 'Info'));
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
            const configName = resolveSubscriptionConfigName(sub, savedConfigs);
            const parity = resolveSubscriptionParity(sub);
            const paritySuffix = getIntervalSeconds(sub.interval) === 7200 && parity ? ` | 2H-${parity}` : '';
            opt.textContent = `${sub.symbol} | ${sub.interval}${paritySuffix} | ${configName ?? sub.strategy_key}`;
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
    const rawBacktestSettings = backtestService.getBacktestSettings() as Record<string, unknown>;
    const configName = resolveCurrentConfigName(strategyKey, strategyParams, rawBacktestSettings);
    const intervalSeconds = getIntervalSeconds(interval);
    const parityMode = resolveParityModeFromUi();
    const parityTargets: AlertTwoHourCloseParity[] = intervalSeconds === 7200
        ? (parityMode === 'both' ? ['odd', 'even'] : [parityMode === 'even' ? 'even' : 'odd'])
        : [];

    try {
        const parsedFreshness = Number.parseInt(freshnessBarsInput?.value ?? '1', 10);
        const candleLimit = Math.max(200, Math.min(50000, state.ohlcvData.length || 350));
        const basePayload = {
            symbol,
            interval,
            strategyKey,
            configName: configName ?? undefined,
            strategyParams,
            notifyTelegram: telegramToggle?.checked ?? true,
            notifyExit: exitToggle?.checked ?? false,
            freshnessBars: Number.isFinite(parsedFreshness) ? Math.max(0, parsedFreshness) : 1,
            candleLimit,
        };

        if (parityTargets.length === 0) {
            const result = await alertService.upsertSubscription({
                ...basePayload,
                streamId: buildAlertStreamId(symbol, interval, strategyKey, configName ?? undefined),
                backtestSettings: applyTwoHourParityToBacktestSettings(rawBacktestSettings, null),
            });
            uiManager.showToast(`Subscribed: ${result.streamId}`, 'success');
        } else {
            const results: string[] = [];
            for (const parity of parityTargets) {
                const streamId = buildAlertStreamId(symbol, interval, strategyKey, configName ?? undefined, parity);
                const upsert = await alertService.upsertSubscription({
                    ...basePayload,
                    streamId,
                    backtestSettings: applyTwoHourParityToBacktestSettings(rawBacktestSettings, parity),
                });
                results.push(upsert.streamId);
            }
            uiManager.showToast(`Subscribed ${results.length} streams (${parityTargets.join(' + ')})`, 'success');
        }
        await refreshSubscriptions();
    } catch (err) {
        uiManager.showToast('Subscribe failed: ' + (err instanceof Error ? err.message : String(err)), 'error');
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
        } else if (action === 'run') {
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

            const sub = subscriptionsByStreamId.get(streamId);
            const streamParity = sub ? resolveSubscriptionParity(sub) : parseAlertTwoHourParityFromStreamId(streamId);
            const currentSettings = backtestService.getBacktestSettings() as Record<string, unknown>;
            const isTwoHourInterval = getIntervalSeconds(sub?.interval ?? state.currentInterval) === 7200;
            const currentParity = normalizeSubscriptionParity(currentSettings.twoHourCloseParity);
            const currentWantsBoth = currentSettings.twoHourCloseParity === 'both';
            const streamIdHasParity = parseAlertTwoHourParityFromStreamId(streamId) !== null;

            if (isTwoHourInterval && currentWantsBoth && !streamIdHasParity) {
                uiManager.showToast(
                    'This 2H alert has no parity tag in its ID. "both" requires separate tagged subscriptions; re-subscribe from Alerts.',
                    'error'
                );
                return;
            }

            const syncParity: AlertTwoHourCloseParity | null = isTwoHourInterval
                ? (streamParity ?? currentParity ?? 'odd')
                : null;

            if (isTwoHourInterval && currentWantsBoth && syncParity) {
                const otherParity = syncParity === 'odd' ? 'even' : 'odd';
                const otherStreamId = streamId.replace(`:2hcp:${syncParity}`, `:2hcp:${otherParity}`);

                const syncedSettingsCurrent = applyTwoHourParityToBacktestSettings(currentSettings, syncParity);
                await alertService.upsertSubscription({
                    streamId,
                    strategyKey,
                    strategyParams: collectCurrentStrategyParams(),
                    backtestSettings: syncedSettingsCurrent,
                });

                const syncedSettingsOther = applyTwoHourParityToBacktestSettings(currentSettings, otherParity);
                await alertService.upsertSubscription({
                    streamId: otherStreamId,
                    strategyKey,
                    strategyParams: collectCurrentStrategyParams(),
                    backtestSettings: syncedSettingsOther,
                });

                uiManager.showToast(`Updated ${streamId} and synced pair ${otherStreamId}.`, 'success');
            } else {
                const syncedSettings = applyTwoHourParityToBacktestSettings(
                    currentSettings,
                    syncParity
                );

                await alertService.upsertSubscription({
                    streamId,
                    strategyKey,
                    strategyParams: collectCurrentStrategyParams(),
                    backtestSettings: syncedSettings,
                });
                uiManager.showToast(`Updated ${streamId} to current strategy (${strategyKey}).`, 'success');
            }

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

    el('alertConfigModalClose')?.addEventListener('click', closeAlertConfigModal);
    el('alertConfigModal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeAlertConfigModal();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAlertConfigModal();
        }
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
