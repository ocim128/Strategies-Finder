import type { ReplayMode } from "../batch-backtest/open-score-replay/types";
import type { FinderArmPerformanceRankingSort } from "./finder-arm-performance-metrics";
import type { FinderScope } from "../types/finder";

/**
 * Stable identity for a formatted card metric the comparison table consumes.
 * Keys decouple table layout from card wording: a chip carries its already
 * formatted value plus this key, so renaming a label cannot change table
 * identity or turn a present value into `--`.
 */
export type FinderTableMetricKey =
    | "net"
    | "pf"
    | "sharpe"
    | "dd"
    | "trades"
    | "robust"
    | "ratio"
    | "active"
    | "medExp"
    | "medPf"
    | "support"
    | "agree"
    | "exp"
    | "pnl"
    | "worstDd"
    | "rankingSortScore"
    | "rankEligibility"
    | "selectedAssetScore"
    | "overallOrderingAccuracy"
    | "bestAssetFrequency"
    | "scoredEvents"
    | "totalNetPnl"
    | "realized"
    | "open"
    | "completedTrades"
    | "costs"
    | "mean"
    | "random"
    | "deltaMed"
    | "events"
    /** Full display text of the replay status line, shown under the candidate title. */
    | "status";

/** data-* attributes carrying a keyed metric chip's identity and formatted value. */
export const FINDER_METRIC_DATA = {
    key: "data-finder-metric",
    value: "data-finder-metric-value",
} as const;

/** Arm Performance column selection, resolved once by the renderer per render pass. */
export interface FinderArmTableContext {
    replayMode: ReplayMode;
    ranking: boolean;
    rankingSort: FinderArmPerformanceRankingSort;
}

type Column = { label: string; key: FinderTableMetricKey };
const columns = (...entries: ReadonlyArray<readonly [label: string, key: FinderTableMetricKey]>): Column[] =>
    entries.map(([label, key]) => ({ label, key }));

/** Tables reuse the card's formatted metrics, including availability and scoring basis. */
export function getFinderTableColumns(scope: FinderScope, arm?: FinderArmTableContext): Column[] {
    switch (scope) {
        case "current_chart": return columns(["Net", "net"], ["PF", "pf"], ["Sharpe", "sharpe"], ["DD", "dd"], ["Trades", "trades"]);
        case "symbol_universe": return columns(["Robust", "robust"], ["Ratio", "ratio"], ["Active", "active"], ["Med Exp", "medExp"], ["Med PF", "medPf"], ["Trades", "trades"]);
        case "asset_opportunity": return columns(["Support", "support"], ["Agree", "agree"], ["Exp", "exp"], ["Net", "net"], ["PF", "pf"], ["Trades", "trades"]);
        case "strategy_quality": return columns(["Med Exp", "medExp"], ["PF", "pf"], ["PnL", "pnl"], ["Trades", "trades"], ["Active", "active"], ["Worst DD", "worstDd"]);
        case "arm_performance":
            // Ranking columns take precedence over switch-return columns, and
            // the renderer resolves one replay mode for the whole supported
            // inventory (snapshot normalization rejects mixed modes).
            if (arm?.ranking) {
                return columns(
                    [arm.rankingSort === "selected_asset" ? "Selected asset sort score" : "Ordering CI lower", "rankingSortScore"],
                    ["Rank eligibility", "rankEligibility"],
                    ["Selected asset score", "selectedAssetScore"],
                    ["Overall ordering accuracy", "overallOrderingAccuracy"],
                    ["Best asset frequency", "bestAssetFrequency"],
                    ["Scored events", "scoredEvents"],
                );
            }
            if (arm?.replayMode === "asset_switch") {
                return columns(["Total net P&L", "totalNetPnl"], ["Realized", "realized"], ["Open", "open"], ["Completed trades", "completedTrades"], ["Costs", "costs"]);
            }
            return columns(["Mean", "mean"], ["Random", "random"], ["DeltaMed", "deltaMed"], ["Events", "events"]);
    }
}

/** Keyed formatted values declared by one card's metric chips, in DOM order. */
export function readFinderTableMetricValues(card: HTMLElement): Map<FinderTableMetricKey, string> {
    const values = new Map<FinderTableMetricKey, string>();
    for (const chip of Array.from(card.querySelectorAll<HTMLElement>(`.finder-metrics [${FINDER_METRIC_DATA.key}]`))) {
        const key = chip.getAttribute(FINDER_METRIC_DATA.key) as FinderTableMetricKey | null;
        if (key) values.set(key, chip.getAttribute(FINDER_METRIC_DATA.value) ?? "--");
    }
    return values;
}

/** Keyed column value for one row; missing metadata keeps the `--` fallback. */
export function getFinderTableMetric(values: ReadonlyMap<FinderTableMetricKey, string>, key: FinderTableMetricKey): string {
    return values.get(key) ?? "--";
}

/** Move existing detail and Apply nodes so their listeners and index contract stay intact. */
export function appendFinderResultsTable(
    list: HTMLElement,
    fragment: DocumentFragment,
    scope: FinderScope,
    arm?: FinderArmTableContext,
): void {
    const cards = Array.from(fragment.querySelectorAll<HTMLElement>(".finder-row"));
    if (cards.length === 0) {
        list.appendChild(fragment);
        return;
    }
    const tableColumns = getFinderTableColumns(scope, arm);
    const wrap = document.createElement("div");
    wrap.className = "finder-comparison-wrap";
    wrap.tabIndex = 0;
    wrap.setAttribute("role", "region");
    wrap.setAttribute("aria-label", "Finder results comparison; scroll horizontally for all columns");
    const table = document.createElement("table");
    table.className = "finder-comparison-table";
    const caption = document.createElement("caption");
    caption.textContent = "Ranked candidates · Re-Sort changes the ranking across the retained results";
    table.appendChild(caption);
    const head = document.createElement("thead");
    const header = document.createElement("tr");
    for (const label of ["Rank", "Candidate / Details", "Action", ...tableColumns.map((column) => column.label)]) {
        const cell = document.createElement("th");
        cell.scope = "col";
        cell.textContent = label;
        header.appendChild(cell);
    }
    head.appendChild(header);
    table.appendChild(head);
    const body = document.createElement("tbody");
    for (const card of cards) {
        const values = readFinderTableMetricValues(card);
        const row = document.createElement("tr");
        const rank = document.createElement("td");
        rank.textContent = card.querySelector(".finder-rank")?.textContent ?? "";
        row.appendChild(rank);
        const identity = document.createElement("th");
        identity.scope = "row";
        const title = card.querySelector<HTMLElement>(".finder-title");
        if (title) identity.appendChild(title);
        for (const badge of Array.from(card.querySelectorAll<HTMLElement>(".finder-metrics > .finder-oos"))) {
            identity.appendChild(badge);
        }
        const status = values.get("status");
        if (status) {
            const statusLine = document.createElement("div");
            statusLine.className = "finder-sub";
            statusLine.textContent = status;
            identity.appendChild(statusLine);
        }
        const details = document.createElement("details");
        details.className = "finder-table-details";
        const summary = document.createElement("summary");
        summary.textContent = "Parameters & details";
        details.appendChild(summary);
        const main = card.querySelector<HTMLElement>(".finder-main");
        if (main) details.appendChild(main);
        identity.appendChild(details);
        row.appendChild(identity);
        const action = document.createElement("td");
        const apply = card.querySelector<HTMLButtonElement>(".finder-apply");
        if (apply) action.appendChild(apply);
        else action.textContent = "Read only";
        row.appendChild(action);
        for (const column of tableColumns) {
            const cell = document.createElement("td");
            cell.className = "finder-comparison-metric";
            cell.textContent = getFinderTableMetric(values, column.key);
            row.appendChild(cell);
        }
        body.appendChild(row);
        card.remove();
    }
    table.appendChild(body);
    wrap.appendChild(table);
    // Scope-level research notes and validation summaries remain above the table.
    list.appendChild(fragment);
    list.appendChild(wrap);
}
