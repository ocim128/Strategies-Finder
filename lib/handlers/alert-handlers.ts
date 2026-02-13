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
import { parseIntervalSeconds } from '../interval-utils';
import { replaceTwoHourParityInStreamId, stripTwoHourParityFromStreamId } from '../alert-stream-id';
import { uiManager } from '../ui-manager';
import { state } from '../state';
import { backtestService } from '../backtest-service';
import { settingsManager } from '../settings-manager';
import { dataManager } from '../data-manager';
import { Trade, BacktestSettings, Time } from '../strategies/index';
import { formatJakartaTime, isBusinessDayTime } from '../timezone-utils';
import { getOptionalElement } from '../dom-utils';
import { parseTimeToUnixSeconds } from '../time-normalization';

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

    const configSelect = getOptionalElement<HTMLSelectElement>('configSelect');
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
    return parseIntervalSeconds(interval) ?? 0;
}

function resolveParityModeFromUi(): 'odd' | 'even' | 'both' {
    const select = getOptionalElement<HTMLSelectElement>('twoHourCloseParity');
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

function resolvePairedTwoHourParity(sub: AlertSubscription): AlertTwoHourCloseParity | null {
    if (getIntervalSeconds(sub.interval) !== 7200) return null;
    const baseKey = stripTwoHourParityFromStreamId(sub.stream_id);
    let hasOdd = false;
    let hasEven = false;

    for (const item of subscriptionsByStreamId.values()) {
        if (getIntervalSeconds(item.interval) !== 7200) continue;
        if (stripTwoHourParityFromStreamId(item.stream_id) !== baseKey) continue;
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

async function withTemporaryTwoHourParitySelection<T>(
    parity: AlertTwoHourCloseParity | null,
    task: () => Promise<T>
): Promise<T> {
    if (!parity) {
        return task();
    }

    const select = getOptionalElement<HTMLSelectElement>('twoHourCloseParity');
    if (!select) {
        return task();
    }

    const previous = select.value;
    select.value = parity;
    try {
        return await task();
    } finally {
        select.value = previous;
    }
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
    const overlay = getOptionalElement<HTMLElement>('alertConfigModal');
    if (overlay) overlay.classList.remove('active');
}

function openSubscriptionInfoModal(sub: AlertSubscription, configName: string | null): void {
    const overlay = getOptionalElement<HTMLElement>('alertConfigModal');
    const titleEl = getOptionalElement<HTMLElement>('alertConfigModalTitle');
    const bodyEl = getOptionalElement<HTMLElement>('alertConfigModalBody');
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
    action: 'info' | 'run' | 'sync' | 'disable' | 'lastTrade',
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
    const emptyState = getOptionalElement('alertEmptyState');
    const tableWrapper = getOptionalElement('alertTableWrapper');
    const tbody = getOptionalElement<HTMLTableSectionElement>('alertTableBody');
    const historySelect = getOptionalElement<HTMLSelectElement>('alertHistoryStreamSelect');

    if (!tbody) return;

    const active = subs.filter((s) => Number(s.enabled) === 1);
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
        actionsTd.appendChild(createActionButton('lastTrade', sub.stream_id, 'Show last trade from backtest', 'Last Trade'));
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
    const wrapper = getOptionalElement('alertHistoryWrapper');
    const empty = getOptionalElement('alertHistoryEmpty');
    const tbody = getOptionalElement<HTMLTableSectionElement>('alertHistoryBody');
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
    const dot = getOptionalElement('alertStatusDot');
    const msg = getOptionalElement('alertStatusMsg');

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
            enabled: true,
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
                const otherStreamId = replaceTwoHourParityInStreamId(streamId, otherParity);

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
        } else if (action === 'lastTrade') {
            await handleLastTradeAction(streamId);
        }
    } catch (err) {
        uiManager.showToast('Action failed: ' + (err instanceof Error ? err.message : String(err)), 'error');
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

// Last Trade Modal Functions
function closeLastTradeModal(): void {
    const overlay = getOptionalElement<HTMLElement>('lastTradeModal');
    if (overlay) overlay.classList.remove('active');
}

function openLastTradeModal(title: string): void {
    const overlay = getOptionalElement<HTMLElement>('lastTradeModal');
    const titleEl = getOptionalElement<HTMLElement>('lastTradeModalTitle');
    if (!overlay || !titleEl) return;
    
    titleEl.textContent = title;
    
    // Reset to loading state
    const loadingEl = getOptionalElement<HTMLElement>('lastTradeLoading');
    const contentEl = getOptionalElement<HTMLElement>('lastTradeContent');
    const errorEl = getOptionalElement<HTMLElement>('lastTradeError');
    
    if (loadingEl) loadingEl.style.display = '';
    if (contentEl) contentEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
    
    overlay.classList.add('active');
}

function showLastTradeError(message: string): void {
    const loadingEl = getOptionalElement<HTMLElement>('lastTradeLoading');
    const contentEl = getOptionalElement<HTMLElement>('lastTradeContent');
    const errorEl = getOptionalElement<HTMLElement>('lastTradeError');
    const errorMsgEl = errorEl?.querySelector('.error-message');
    
    if (loadingEl) loadingEl.style.display = 'none';
    if (contentEl) contentEl.style.display = 'none';
    if (errorEl) errorEl.style.display = '';
    if (errorMsgEl) errorMsgEl.textContent = message;
}

function toEpochMs(value: unknown): number | null {
    const unixSeconds = parseTimeToUnixSeconds(value);
    return unixSeconds === null ? null : unixSeconds * 1000;
}

function isBusinessDayValue(value: unknown): value is Time {
    if (typeof value === 'object' && value !== null && 'year' in value) {
        return true;
    }
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function formatTimeForDisplay(time: unknown): string {
    if (time == null) return 'N/A';
    const unixSeconds = parseTimeToUnixSeconds(time);
    if (unixSeconds === null) return 'N/A';
    const displayTime: Time = isBusinessDayValue(time) ? time : (unixSeconds as Time);

    if (isBusinessDayTime(displayTime)) {
        return formatJakartaTime(displayTime, {
            month: 'short',
            day: 'numeric',
            year: 'numeric',
        });
    }

    return formatJakartaTime(displayTime, {
        month: 'short',
        day: 'numeric',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    });
}

function formatDurationForTradeTimes(entryTime: unknown, exitTime: unknown): string {
    if (entryTime == null || exitTime == null) return '-';
    const entryMs = toEpochMs(entryTime);
    const exitMs = toEpochMs(exitTime);
    if (entryMs === null || exitMs === null) return '-';
    return formatDuration(exitMs - entryMs);
}

function showLastTradeResult(trade: Trade | null, symbol: string, interval: string, totalTrades: number): void {
    const loadingEl = getOptionalElement<HTMLElement>('lastTradeLoading');
    const contentEl = getOptionalElement<HTMLElement>('lastTradeContent');
    const errorEl = getOptionalElement<HTMLElement>('lastTradeError');
    const summaryEl = getOptionalElement<HTMLElement>('lastTradeSummary');
    const detailsEl = getOptionalElement<HTMLElement>('lastTradeDetails');
    
    if (loadingEl) loadingEl.style.display = 'none';
    if (errorEl) errorEl.style.display = 'none';
    if (contentEl) contentEl.style.display = '';
    
    if (!trade) {
        if (summaryEl) summaryEl.innerHTML = '<p class="no-trades">No trades found in backtest results.</p>';
        if (detailsEl) detailsEl.innerHTML = '';
        return;
    }
    
    // Format trade details
    const isLong = trade.type === 'long';
    const isWin = trade.pnl >= 0;
    const entryTimeStr = formatTimeForDisplay(trade.entryTime);
    const exitTimeStr = trade.exitTime ? formatTimeForDisplay(trade.exitTime) : 'Still open';
    const duration = trade.entryTime && trade.exitTime 
        ? formatDurationForTradeTimes(trade.entryTime, trade.exitTime)
        : 'Open';
    
    // Exit reason badge
    const exitReasonBadge = getExitReasonBadge(trade.exitReason);
    
    // Summary header
    if (summaryEl) {
        summaryEl.innerHTML = `
            <div class="last-trade-header ${isWin ? 'win' : 'loss'}">
                <span class="trade-type ${isLong ? 'long' : 'short'}">${isLong ? 'LONG' : 'SHORT'}</span>
                <span class="trade-result ${isWin ? 'win' : 'loss'}">${isWin ? '+' : ''}${trade.pnl.toFixed(2)} (${trade.pnlPercent >= 0 ? '+' : ''}${trade.pnlPercent.toFixed(2)}%)</span>
            </div>
        `;
    }
    
    // Details table
    if (detailsEl) {
        let targetsHtml = '';
        if (trade.takeProfitPrice != null && trade.takeProfitPrice > 0) {
            const tpPct = Math.abs((trade.takeProfitPrice - trade.entryPrice) / trade.entryPrice * 100);
            targetsHtml += `<div class="detail-row"><span class="label">TP Price</span><span class="value">${trade.takeProfitPrice.toFixed(2)} (${tpPct.toFixed(2)}%)</span></div>`;
        }
        if (trade.stopLossPrice != null && trade.stopLossPrice > 0) {
            const slPct = Math.abs((trade.stopLossPrice - trade.entryPrice) / trade.entryPrice * 100);
            targetsHtml += `<div class="detail-row"><span class="label">SL Price</span><span class="value">${trade.stopLossPrice.toFixed(2)} (${slPct.toFixed(2)}%)</span></div>`;
        }
        
        detailsEl.innerHTML = `
            <div class="detail-grid">
                <div class="detail-row"><span class="label">Symbol</span><span class="value">${symbol}</span></div>
                <div class="detail-row"><span class="label">Interval</span><span class="value">${interval}</span></div>
                <div class="detail-row"><span class="label">Trade #</span><span class="value">${totalTrades} of ${totalTrades}</span></div>
                <div class="detail-row divider"></div>
                <div class="detail-row"><span class="label">Entry Price</span><span class="value">${trade.entryPrice.toFixed(2)}</span></div>
                <div class="detail-row"><span class="label">Entry Time</span><span class="value">${entryTimeStr}</span></div>
                <div class="detail-row"><span class="label">Exit Price</span><span class="value">${trade.exitPrice?.toFixed(2) ?? 'N/A'}</span></div>
                <div class="detail-row"><span class="label">Exit Time</span><span class="value">${exitTimeStr}</span></div>
                <div class="detail-row"><span class="label">Duration</span><span class="value">${duration}</span></div>
                <div class="detail-row"><span class="label">Exit Reason</span><span class="value">${exitReasonBadge}</span></div>
                ${trade.fees ? `<div class="detail-row"><span class="label">Fees</span><span class="value">${trade.fees.toFixed(2)}</span></div>` : ''}
                ${targetsHtml ? `<div class="detail-row divider"></div>${targetsHtml}` : ''}
            </div>
        `;
    }
}

function getExitReasonBadge(exitReason: string | null | undefined): string {
    if (!exitReason) return '-';
    
    const reasonMap: Record<string, { label: string; color: string }> = {
        signal: { label: 'Signal', color: '#3b82f6' },
        stop_loss: { label: 'Stop Loss', color: '#ef4444' },
        take_profit: { label: 'Take Profit', color: '#22c55e' },
        trailing_stop: { label: 'Trailing Stop', color: '#f59e0b' },
        time_stop: { label: 'Time Stop', color: '#8b5cf6' },
        partial: { label: 'Partial', color: '#06b6d4' },
        end_of_data: { label: 'End of Data', color: '#f97316' },
    };
    
    const info = reasonMap[exitReason];
    if (!info) return exitReason;
    
    return `<span style="background: ${info.color}20; color: ${info.color}; padding: 2px 6px; border-radius: 4px; font-size: 0.75rem;">${info.label}</span>`;
}

function formatDuration(ms: number): string {
    if (ms < 0) return '-';
    const seconds = Math.floor(ms / 1000);
    const minutes = Math.floor(seconds / 60);
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    
    if (days > 0) return `${days}d ${hours % 24}h`;
    if (hours > 0) return `${hours}h ${minutes % 60}m`;
    if (minutes > 0) return `${minutes}m ${seconds % 60}s`;
    return `${seconds}s`;
}

async function handleLastTradeAction(streamId: string): Promise<void> {
    const sub = subscriptionsByStreamId.get(streamId);
    if (!sub) {
        uiManager.showToast(`Subscription not found: ${streamId}`, 'error');
        return;
    }
    
    // Open modal with loading state
    openLastTradeModal(`Last Trade: ${sub.symbol} ${sub.interval}`);
    
    try {
        // Parse subscription configuration
        const strategyParams = safeJsonParse<Record<string, number>>(sub.strategy_params_json, {});
        const backtestSettings = safeJsonParse<BacktestSettings>(sub.backtest_settings_json, {});

        const parityOverride = getIntervalSeconds(sub.interval) === 7200
            ? resolveSubscriptionParity(sub)
            : null;

        // Fetch data for the subscription's symbol and interval
        const ohlcvData = await withTemporaryTwoHourParitySelection(parityOverride, async () =>
            dataManager.fetchData(sub.symbol, sub.interval)
        );
        
        if (ohlcvData.length === 0) {
            throw new Error(`No data available for ${sub.symbol} ${sub.interval}`);
        }
        
        // Run backtest with the subscription's configuration
        const result = await backtestService.runBacktestForSubscription(
            ohlcvData,
            sub.strategy_key,
            strategyParams,
            backtestSettings
        );
        
        // Get the last trade
        const lastTrade = result.trades.length > 0 
            ? result.trades[result.trades.length - 1] 
            : null;
        
        showLastTradeResult(lastTrade, sub.symbol, sub.interval, result.trades.length);
        
    } catch (err) {
        showLastTradeError('Failed to run backtest: ' + (err instanceof Error ? err.message : String(err)));
    }
}

export function initAlertHandlers() {
    const urlInput = getOptionalElement<HTMLInputElement>('alertWorkerUrl');
    if (urlInput) {
        urlInput.value = alertService.getWorkerUrl();
        urlInput.addEventListener('change', () => {
            alertService.setWorkerUrl(urlInput.value.trim());
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

    // Last Trade Modal event listeners
    getOptionalElement('lastTradeModalClose')?.addEventListener('click', closeLastTradeModal);
    getOptionalElement('lastTradeModal')?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) {
            closeLastTradeModal();
        }
    });
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') {
            closeAlertConfigModal();
            closeLastTradeModal();
        }
    });

    const observer = new MutationObserver((mutations) => {
        for (const m of mutations) {
            if (m.attributeName === 'style') {
                const tab = getOptionalElement('alertsTab');
                if (tab && tab.style.display !== 'none') {
                    void refreshSubscriptions();
                    break;
                }
            }
        }
    });

    const alertsTab = getOptionalElement('alertsTab');
    if (alertsTab) {
        observer.observe(alertsTab, { attributes: true, attributeFilter: ['style'] });
    }
}

