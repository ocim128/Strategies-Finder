import { escapeHtml } from "../../html-escape";
import { hasAssetSwitchDecisionEvents, ASSET_SWITCH_ARM_FIELDS, RAW_DIRECTIONAL_MINIMUM_FRACTION, type AssetSwitchArmField } from "../open-score-replay/arm-contract";
import type { AssetSwitchArmSummary, AssetSwitchReplaySummary } from "../open-score-replay/types";

const METRICS = [
    ["totalNetPnl", "Total P&L"],
    ["realizedNetPnl", "Realized"],
    ["openPositionNetPnl", "Open"],
    ["completedTrades", "Closed trades"],
    ["enteredCount", "Entries"],
    ["totalCosts", "Costs"],
] as const;
type MetricKey = (typeof METRICS)[number][0];

function money(value: number | null, signed = true): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    const tone = signed ? (value > 0 ? "is-positive" : value < 0 ? "is-negative" : "") : "";
    const sign = value < 0 ? "−" : signed && value > 0 ? "+" : "";
    return `<span${tone ? ` class="${tone}"` : ""}>${sign}$${Math.abs(value).toFixed(2)}</span>`;
}

function metric(result: AssetSwitchArmSummary, key: MetricKey): string {
    const value = result[key];
    return key === "completedTrades" || key === "enteredCount"
        ? value?.toLocaleString() ?? "n/a"
        : money(value, key !== "totalCosts");
}

function positionNotes(result: AssetSwitchArmSummary): string {
    let html = "";
    const position = result.openPosition;
    if (position) {
        const holding = position.holdingDurationSec == null ? "" : ` | held ${(position.holdingDurationSec / 86400).toFixed(1)} days`;
        html += `<div class="batch-report-note">Open: ${escapeHtml(position.asset)}${position.direction ? ` ${escapeHtml(position.direction.toUpperCase())}` : ""} | mark ${money(position.openNetPnl)}${holding}</div>`;
    }
    const pending = result.pendingOrder;
    if (pending) {
        const time = pending.scheduledTimeSec === null ? "waiting for target data"
            : `${new Date(pending.scheduledTimeSec * 1000).toISOString().slice(0, 16).replace("T", " ")} UTC`;
        html += `<div class="batch-report-note">Pending ${escapeHtml(pending.side)}${pending.destinationAsset ? ` ${escapeHtml(pending.destinationAsset)}` : ""}${pending.direction ? ` (${escapeHtml(pending.direction.toUpperCase())})` : ""} | ${time}</div>`;
    }
    return html;
}

function isLookAhead(arm: AssetSwitchArmField): boolean {
    return arm === "topRawProfit" || arm === "topMeanProfit";
}

function renderGroup(summary: AssetSwitchReplaySummary, arms: readonly AssetSwitchArmField[], research: boolean): string {
    const present = arms.filter((arm) => summary.arms[arm]);
    if (present.length === 0) return "";
    const label = research ? "Look-ahead research arms" : "Selector arms";
    let html = `<section class="batch-replay-group${research ? " batch-replay-group--research" : ""}" aria-label="${label}">`;
    html += `<div class="batch-report-subheading">${label}</div>`;
    if (research) html += `<div class="batch-report-note">These arms use future profit information. Their results are research comparisons and cannot be used for live selection.</div>`;
    html += `<div class="batch-report-grid" data-batch-replay-panel="cards">`;
    for (const arm of present) {
        const result = summary.arms[arm]!;
        html += `<article class="batch-report-card batch-replay-card"><div class="batch-replay-card-header"><div class="batch-report-title">${escapeHtml(arm === "topRawDirectional" ? "TOP_RAW_DIRECTIONAL" : arm)}</div><span class="batch-replay-status">${escapeHtml(result.status.replaceAll("_", " ").toUpperCase())}</span></div>`;
        if (arm === "topRawDirectional") {
            const total = summary.directionalTotalPairs;
            const threshold = total === undefined ? null : total * RAW_DIRECTIONAL_MINIMUM_FRACTION;
            html += `<div class="batch-report-note">${threshold === null
                ? "Threshold not recorded in this saved result. Rerun for the 25% threshold."
                : `Largest absolute raw score: minimum 25% of ${escapeHtml(total)} total pairs (long ≥ +${escapeHtml(threshold)}, short ≤ −${escapeHtml(threshold)}).`} ${summary.directionalBelowMinimumPolicy === "exit_next_open"
                    ? "Below minimum closes the position at the next target open."
                    : "Rerun to apply the below-minimum exit rule."} ${summary.directionalVoteDelayBars === 3
                    ? "Votes start on the third subsequent pair candle while the pair trade is still open (entry = 0)."
                    : "Rerun to apply third-bar votes."} Equal-strength qualifying ties hold the current position.</div>`;
        }
        if (research) html += `<div class="batch-replay-research-label">LOOK-AHEAD RESEARCH</div>`;
        html += `<div class="batch-replay-total"><span>Total P&L</span><strong>${money(result.totalNetPnl)}</strong></div>`;
        html += `<dl class="batch-replay-metrics">${METRICS.slice(1).map(([key, name]) => `<div><dt>${name}</dt><dd>${metric(result, key)}</dd></div>`).join("")}</dl>`;
        html += positionNotes(result) + `</article>`;
    }
    html += `</div><div class="batch-replay-table-wrap" data-batch-replay-panel="table" hidden tabindex="0" role="region" aria-label="${label} performance table">`;
    html += `<table class="finder-table batch-report-table batch-replay-table"><caption>${label} performance comparison</caption><thead><tr><th scope="col">Arm</th><th scope="col">Status</th>`;
    html += METRICS.map(([key, name]) => `<th scope="col" aria-sort="none"><button type="button" class="batch-replay-sort" data-batch-replay-sort="${key}" aria-label="Sort by ${name}">${name}<span data-batch-replay-sort-indicator aria-hidden="true">↕</span></button></th>`).join("");
    html += `<th scope="col">Position / Pending</th></tr></thead><tbody>`;
    for (const arm of present) {
        const result = summary.arms[arm]!;
        html += `<tr data-batch-replay-order="${ASSET_SWITCH_ARM_FIELDS.indexOf(arm)}"><th scope="row"><strong>${escapeHtml(arm === "topRawDirectional" ? "TOP_RAW_DIRECTIONAL" : arm)}</strong>${research ? `<div class="batch-replay-research-label">LOOK-AHEAD RESEARCH</div>` : ""}</th><td><span class="batch-replay-status">${escapeHtml(result.status.replaceAll("_", " ").toUpperCase())}</span></td>`;
        html += METRICS.map(([key]) => `<td data-batch-replay-metric="${key}" data-value="${result[key] !== null && Number.isFinite(result[key]) ? result[key] : ""}">${metric(result, key)}</td>`).join("");
        html += `<td>${positionNotes(result) || "—"}</td></tr>`;
    }
    return html + `</tbody></table></div></section>`;
}

/** Generated report controls are delegated from the persistent TOP_MEAN results container. */
export function renderAssetSwitchReplay(summary: AssetSwitchReplaySummary, heading = "Asset-Switch Replay"): string {
    let html = `<section class="batch-replay-report" data-batch-replay-report aria-label="${escapeHtml(heading)}">`;
    html += `<div class="batch-replay-heading"><div class="batch-report-subheading batch-report-subheading--accent">${escapeHtml(heading)}</div>`;
    html += `<div class="batch-replay-view-controls" role="group" aria-label="${escapeHtml(heading)} view"><button type="button" class="btn btn-secondary btn-compact" data-batch-replay-view="cards" aria-pressed="true">Cards</button><button type="button" class="btn btn-secondary btn-compact" data-batch-replay-view="table" aria-pressed="false">Table</button></div></div>`;
    html += `<div class="batch-report-note">${escapeHtml(summary.semanticsVersion)} | fixed $${summary.notionalPerEntry.toLocaleString()} per entry, non-compounding | costs include slippage and commission | entry and switch orders fill at the next target open. Each arm holds at most one position; TOP_RAW_DIRECTIONAL supports long and short. Unavailable data is not ranked.</div>`;
    const windowLabel = !hasAssetSwitchDecisionEvents(summary) ? "No decision events"
        : summary.windowStartSec === null ? `Full history through ${new Date(summary.windowEndSec * 1000).toISOString().slice(0, 10)}`
            : `${new Date(summary.windowStartSec * 1000).toISOString().slice(0, 10)}..${new Date(summary.windowEndSec * 1000).toISOString().slice(0, 10)}`;
    html += `<div class="batch-report-note">Window: ${windowLabel} | target data ${summary.coverage.loadedAssets}/${summary.coverage.requestedAssets} loaded${summary.tradeCount !== undefined ? ` | ${summary.tradeCount.toLocaleString()} trade records` : ""}</div>`;
    html += renderGroup(summary, ASSET_SWITCH_ARM_FIELDS.filter((arm) => !isLookAhead(arm)), false);
    html += renderGroup(summary, ASSET_SWITCH_ARM_FIELDS.filter(isLookAhead), true);
    return html + `</section>`;
}

/** Missing/non-finite results stay last in either direction; callers preserve tie order. */
export function compareReplayMetricValues(a: number | null, b: number | null, ascending: boolean): number {
    const aValid = a !== null && Number.isFinite(a);
    const bValid = b !== null && Number.isFinite(b);
    if (!aValid || !bValid) return aValid ? -1 : bValid ? 1 : 0;
    return ascending ? a - b : b - a;
}

/** Only the clicked report/table changes, preserving mounted controls and annual disclosures. */
export function handleAssetSwitchResultsClick(container: HTMLElement, event: Event): void {
    if (!(event.target instanceof Element)) return;
    const button = event.target.closest<HTMLButtonElement>("button[data-batch-replay-view], button[data-batch-replay-sort]");
    if (!button || !container.contains(button)) return;
    const report = button.closest<HTMLElement>("[data-batch-replay-report]");
    if (!report) return;
    const view = button.dataset.batchReplayView;
    if (view === "cards" || view === "table") {
        report.querySelectorAll<HTMLElement>("[data-batch-replay-panel]").forEach((panel) => { panel.hidden = panel.dataset.batchReplayPanel !== view; });
        report.querySelectorAll<HTMLButtonElement>("[data-batch-replay-view]").forEach((control) => { control.setAttribute("aria-pressed", String(control.dataset.batchReplayView === view)); });
        return;
    }
    const key = button.dataset.batchReplaySort;
    if (!METRICS.some(([metricKey]) => metricKey === key)) return;
    const table = button.closest<HTMLTableElement>("table");
    const body = table?.tBodies[0];
    if (!table || !body) return;
    const ascending = button.closest("th")?.getAttribute("aria-sort") === "descending";
    const value = (row: HTMLTableRowElement): number | null => {
        const raw = row.querySelector<HTMLElement>(`[data-batch-replay-metric="${key}"]`)?.dataset.value;
        return raw == null || raw === "" ? null : Number(raw);
    };
    const rows = Array.from(body.rows).sort((a, b) => compareReplayMetricValues(value(a), value(b), ascending)
        || Number(a.dataset.batchReplayOrder) - Number(b.dataset.batchReplayOrder));
    rows.forEach((row) => body.appendChild(row));
    table.querySelectorAll<HTMLButtonElement>("[data-batch-replay-sort]").forEach((control) => {
        const active = control === button;
        control.closest("th")?.setAttribute("aria-sort", active ? ascending ? "ascending" : "descending" : "none");
        const indicator = control.querySelector("[data-batch-replay-sort-indicator]");
        if (indicator) indicator.textContent = active ? ascending ? "↑" : "↓" : "↕";
    });
}
