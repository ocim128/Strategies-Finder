import type { ReplayMode } from "../batch-backtest/open-score-replay/types";
import type { FinderArmPerformanceRankingSort } from "./finder-arm-performance-metrics";
import type { FinderScope } from "../types/finder";

/**
 * Stable identity for one comparison-table column's metric. Keys decouple
 * table layout from card wording: a row declares its already formatted value
 * under this key, so renaming a visible label cannot change table identity.
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
    | "events";

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

/**
 * One candidate's display parts, produced once by FinderUI and laid out either
 * as a result card or as a comparison-table row. `main` carries the parameters,
 * detail lines, metric chips and disclosures (with their lazy listeners);
 * `metricValues` carries the same formatted strings the table shows per column.
 * Replay status is explicit so it stays visible outside closed disclosures.
 */
export interface FinderResultRowParts {
    /** 1-based candidate rank shown in the Rank column. */
    rank: string;
    /** Candidate identity heading (strategy name, badges). */
    title: HTMLElement;
    /** Visible OOS verdict badges shown beside the title. */
    oosBadges: readonly HTMLElement[];
    /** Replay status line rendered under the title; absent when complete. */
    status?: string;
    /** Card body: sub text, params, detail lines, metric chips, disclosures. */
    main: HTMLElement;
    /** Apply action; without it the table renders a read-only cell. */
    apply?: HTMLButtonElement;
    /** Formatted metric values keyed for the comparison table. */
    metricValues: ReadonlyMap<FinderTableMetricKey, string>;
}

/** Keyed column value for one row; a missing value keeps the `--` fallback. */
export function getFinderTableMetric(values: ReadonlyMap<FinderTableMetricKey, string>, key: FinderTableMetricKey): string {
    return values.get(key) ?? "--";
}

/**
 * Append the selected comparison-table layout: scope-level notes stay above
 * the table, and each candidate's parts become one final row. Without rows,
 * only the notes are appended and no table is built.
 */
export function appendFinderResultsTable(
    list: HTMLElement,
    notes: readonly Node[],
    rows: readonly FinderResultRowParts[],
    scope: FinderScope,
    arm?: FinderArmTableContext,
): void {
    if (rows.length === 0) {
        for (const note of notes) list.appendChild(note);
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
    for (const parts of rows) {
        const tr = document.createElement("tr");
        const rank = document.createElement("td");
        rank.textContent = parts.rank;
        tr.appendChild(rank);
        const identity = document.createElement("th");
        identity.scope = "row";
        identity.appendChild(parts.title);
        for (const badge of parts.oosBadges) {
            identity.appendChild(badge);
        }
        if (parts.status) {
            const statusLine = document.createElement("div");
            statusLine.className = "finder-sub";
            statusLine.textContent = parts.status;
            identity.appendChild(statusLine);
        }
        const details = document.createElement("details");
        details.className = "finder-table-details";
        const summary = document.createElement("summary");
        summary.textContent = "Parameters & details";
        details.appendChild(summary);
        details.appendChild(parts.main);
        identity.appendChild(details);
        tr.appendChild(identity);
        const action = document.createElement("td");
        if (parts.apply) action.appendChild(parts.apply);
        else action.textContent = "Read only";
        tr.appendChild(action);
        for (const column of tableColumns) {
            const cell = document.createElement("td");
            cell.className = "finder-comparison-metric";
            cell.textContent = getFinderTableMetric(parts.metricValues, column.key);
            tr.appendChild(cell);
        }
        body.appendChild(tr);
    }
    table.appendChild(body);
    wrap.appendChild(table);
    // Scope-level research notes and validation summaries remain above the table.
    for (const note of notes) list.appendChild(note);
    list.appendChild(wrap);
}
