import type { FinderScope } from "../types/finder";

type Column = { label: string; prefix: string };
const columns = (...labels: string[]): Column[] => labels.map((label) => ({ label, prefix: label + " " }));

/** Tables reuse the card's formatted metrics, including availability and scoring basis. */
export function getFinderTableColumns(scope: FinderScope, metricTexts: readonly string[]): Column[] {
    switch (scope) {
        case "current_chart": return columns("Net", "PF", "Sharpe", "DD", "Trades");
        case "symbol_universe": return columns("Robust", "Ratio", "Active", "Med Exp", "Med PF", "Trades");
        case "asset_opportunity": return columns("Support", "Agree", "Exp", "Net", "PF", "Trades");
        case "strategy_quality": return columns("Med Exp", "PF", "PnL", "Trades", "Active", "Worst DD");
        case "arm_performance":
            if (metricTexts.some((text) => text.startsWith("Selected asset score "))) {
                return columns("Selected asset score", "Overall ordering accuracy", "Best asset frequency", "Scored events");
            }
            if (metricTexts.some((text) => text.startsWith("Total net P&L "))) {
                return columns("Total net P&L", "Realized", "Open", "Completed trades", "Costs");
            }
            return columns("Mean", "Random", "DeltaMed", "Events");
    }
}

export function getFinderTableMetric(texts: readonly string[], prefix: string): string {
    return texts.find((text) => text.startsWith(prefix))?.slice(prefix.length) ?? "--";
}

/** Move existing detail and Apply nodes so their listeners and index contract stay intact. */
export function appendFinderResultsTable(list: HTMLElement, fragment: DocumentFragment, scope: FinderScope): void {
    const cards = Array.from(fragment.querySelectorAll<HTMLElement>(".finder-row"));
    if (cards.length === 0) {
        list.appendChild(fragment);
        return;
    }
    const metricTexts = (card: HTMLElement): string[] => Array.from(card.querySelectorAll<HTMLElement>(".finder-metrics > span"))
        .map((chip) => chip.textContent ?? "");
    const tableColumns = getFinderTableColumns(scope, cards.flatMap(metricTexts));
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
        const row = document.createElement("tr");
        const texts = metricTexts(card);
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
        const status = texts.find((text) => text.startsWith("Status "));
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
            cell.textContent = getFinderTableMetric(texts, column.prefix);
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
