import { resolveAlertSignalEntryPrice, parseAlertSignalPayload } from "./alert-signal-utils";
import { buildConfigIndex, resolveSubscriptionConfigNameFromIndex } from "./alert-config-resolver";
import { AlertSubscription, AlertSignalRecord, AlertTwoHourCloseParity } from "./alert-service";
import { getOptionalElement } from "./dom-utils";
import { isTwoHourInterval } from "./interval-utils";
import { settingsManager } from "./settings-manager";

type SubscriptionParityResolver = (sub: AlertSubscription) => AlertTwoHourCloseParity | null;

function appendTextCell(
    row: HTMLTableRowElement,
    text: string,
    options?: { className?: string; title?: string }
): HTMLTableCellElement {
    const td = document.createElement("td");
    td.textContent = text;
    if (options?.className) td.className = options.className;
    if (options?.title) td.title = options.title;
    row.appendChild(td);
    return td;
}

function createActionButton(
    action: "info" | "run" | "sync" | "disable" | "lastTrade",
    streamId: string,
    title: string,
    label: string
): HTMLButtonElement {
    const btn = document.createElement("button");
    btn.className = "btn btn-secondary btn-compact alert-action-btn";
    btn.dataset.action = action;
    btn.dataset.stream = streamId;
    btn.title = title;
    btn.textContent = label;
    return btn;
}

export function renderSubscriptions(
    subs: AlertSubscription[],
    resolveSubscriptionParity: SubscriptionParityResolver
): void {
    const emptyState = getOptionalElement("alertEmptyState");
    const tableWrapper = getOptionalElement("alertTableWrapper");
    const tbody = getOptionalElement<HTMLTableSectionElement>("alertTableBody");
    const historySelect = getOptionalElement<HTMLSelectElement>("alertHistoryStreamSelect");

    if (!tbody) return;

    const active = subs.filter((sub) => Number(sub.enabled) === 1);
    const savedConfigs = settingsManager.loadAllStrategyConfigs();
    const configIndex = buildConfigIndex(savedConfigs);

    if (active.length === 0) {
        if (emptyState) emptyState.style.display = "";
        if (tableWrapper) tableWrapper.style.display = "none";
    } else {
        if (emptyState) emptyState.style.display = "none";
        if (tableWrapper) tableWrapper.style.display = "";
    }

    tbody.innerHTML = "";
    active.forEach((sub) => {
        const tr = document.createElement("tr");
        const telegramTag = sub.notify_telegram ? "TG" : "--";
        const exitTag = sub.notify_exit ? "EXIT" : "--";
        const lastStatus = sub.last_status ?? "--";
        const configName = resolveSubscriptionConfigNameFromIndex(sub, configIndex);
        const parity = resolveSubscriptionParity(sub);
        const paritySuffix = isTwoHourInterval(sub.interval) && parity ? ` [2H-${parity}]` : "";
        const strategyDisplay = `${configName ?? sub.strategy_key}${paritySuffix}`;
        const statusClass = lastStatus.startsWith("new_entry")
            ? "alert-status-new"
            : lastStatus.startsWith("error")
                ? "alert-status-error"
                : "";

        appendTextCell(tr, sub.stream_id.length > 20 ? sub.stream_id.slice(0, 20) + "..." : sub.stream_id, {
            className: "alert-cell-stream",
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

        const actionsTd = document.createElement("td");
        actionsTd.className = "alert-cell-actions";
        actionsTd.appendChild(createActionButton("info", sub.stream_id, "View full alert configuration", "Info"));
        actionsTd.appendChild(createActionButton("run", sub.stream_id, "Run Now", "Run"));
        actionsTd.appendChild(createActionButton("sync", sub.stream_id, "Sync with currently loaded strategy/settings", "Sync"));
        actionsTd.appendChild(createActionButton("disable", sub.stream_id, "Disable", "Disable"));
        actionsTd.appendChild(createActionButton("lastTrade", sub.stream_id, "Show last trade from backtest", "Last Trade"));
        tr.appendChild(actionsTd);

        tbody.appendChild(tr);
    });

    if (!historySelect) {
        return;
    }

    const prevValue = historySelect.value;
    historySelect.innerHTML = '<option value="">Select a subscription...</option>';
    subs.forEach((sub) => {
        const opt = document.createElement("option");
        opt.value = sub.stream_id;
        const configName = resolveSubscriptionConfigNameFromIndex(sub, configIndex);
        const parity = resolveSubscriptionParity(sub);
        const paritySuffix = isTwoHourInterval(sub.interval) && parity ? ` | 2H-${parity}` : "";
        opt.textContent = `${sub.symbol} | ${sub.interval}${paritySuffix} | ${configName ?? sub.strategy_key}`;
        historySelect.appendChild(opt);
    });
    if (prevValue) {
        historySelect.value = prevValue;
    }
}

export function renderSignalHistory(signals: AlertSignalRecord[]): void {
    const wrapper = getOptionalElement("alertHistoryWrapper");
    const empty = getOptionalElement("alertHistoryEmpty");
    const tbody = getOptionalElement<HTMLTableSectionElement>("alertHistoryBody");
    if (!tbody) return;

    if (signals.length === 0) {
        if (wrapper) wrapper.style.display = "none";
        if (empty) {
            empty.style.display = "";
            empty.innerHTML = "<p>No signals found for this subscription.</p>";
        }
        return;
    }

    if (wrapper) wrapper.style.display = "";
    if (empty) empty.style.display = "none";

    tbody.innerHTML = "";
    signals.forEach((sig) => {
        const payload = parseAlertSignalPayload(sig);
        const displayPrice = resolveAlertSignalEntryPrice(sig);
        const tpValue = Number(payload.takeProfitPrice);
        const slValue = Number(payload.stopLossPrice);
        const tp = Number.isFinite(tpValue) ? tpValue.toFixed(2) : "-";
        const sl = Number.isFinite(slValue) ? slValue.toFixed(2) : "-";
        const dirClass = sig.direction === "long" ? "alert-dir-long" : "alert-dir-short";

        const tr = document.createElement("tr");
        appendTextCell(tr, new Date(sig.signal_time * 1000).toISOString().replace("T", " ").slice(0, 19));
        appendTextCell(tr, sig.direction.toUpperCase(), { className: dirClass });
        appendTextCell(tr, displayPrice !== null ? String(displayPrice) : String(sig.signal_price));
        appendTextCell(tr, tp);
        appendTextCell(tr, sl);
        tbody.appendChild(tr);
    });
}
