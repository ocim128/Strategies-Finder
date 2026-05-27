import type { StrategyDebuggerDom } from "./strategy-debugger-dom";
import type {
    StrategyDebuggerCandidateReport,
    StrategyDebuggerDiagnostic,
} from "./strategy-debugger-types";

function formatPct(value: number | null | undefined, digits = 1): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
    return `${(value * 100).toFixed(digits)}%`;
}

function formatCents(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(1)}c`;
}

function formatMoney(value: number | null | undefined): string {
    if (typeof value !== "number" || !Number.isFinite(value)) return "n/a";
    const sign = value > 0 ? "+" : value < 0 ? "-" : "";
    return `${sign}$${Math.abs(value).toFixed(2)}`;
}

function createTextEl(tag: keyof HTMLElementTagNameMap, className: string, text: string): HTMLElement {
    const el = document.createElement(tag);
    el.className = className;
    el.textContent = text;
    return el;
}

function createDiagnosticSummary(diagnostic: StrategyDebuggerDiagnostic): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "finder-result-summary";
    wrapper.append(
        createTextEl("span", "finder-metric", `Exp ${formatCents(diagnostic.candidate.expectancyCents)}`),
        createTextEl("span", "finder-metric", `Win ${formatPct(diagnostic.candidate.winRate)}`),
        createTextEl("span", "finder-metric", `Scored ${diagnostic.candidate.scoredTrades}`),
        createTextEl("span", "finder-metric", `Coverage ${formatPct(diagnostic.candidate.scoredTradeShare)}`),
        createTextEl("span", "finder-metric", `Match ${diagnostic.tradeOverlap.matchQuality}`)
    );
    return wrapper;
}

function createCandidateRow(
    report: StrategyDebuggerCandidateReport,
    selected: boolean,
    onSelect: (candidateKey: string) => void
): HTMLElement {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "finder-row";
    row.dataset.strategyKey = report.candidateKey;
    row.setAttribute("aria-pressed", String(selected));
    row.addEventListener("click", () => onSelect(report.candidateKey));

    if (!report.diagnostic) {
        row.append(
            createTextEl("span", "finder-rank", "!"),
            createTextEl("span", "finder-strategy-name", report.candidateName),
            createTextEl("span", "finder-metric", report.error ?? "Failed")
        );
        return row;
    }

    const diagnostic = report.diagnostic;
    const strategyCell = document.createElement("span");
    strategyCell.className = "finder-strategy-name";
    strategyCell.append(
        document.createTextNode(report.candidateName),
        createDiagnosticSummary(diagnostic)
    );

    const deltaParts = [
        `Exp ${formatCents(diagnostic.delta.expectancyCents)}`,
        `Net ${formatMoney(diagnostic.delta.sizedNet)}`,
    ];

    row.append(
        createTextEl("span", "finder-rank", diagnostic.diagnosis.verdict),
        strategyCell,
        createTextEl("span", "finder-metric", deltaParts.join(" | "))
    );
    return row;
}

export function renderStrategyDebuggerResults(
    dom: StrategyDebuggerDom,
    reports: readonly StrategyDebuggerCandidateReport[],
    selectedCandidateKey: string | null,
    onSelect: (candidateKey: string) => void
): void {
    dom.results.replaceChildren();
    dom.empty.style.display = reports.length === 0 ? "" : "none";

    for (const report of reports) {
        dom.results.appendChild(createCandidateRow(report, report.candidateKey === selectedCandidateKey, onSelect));
    }
}

export function renderStrategyDebuggerDiagnostic(
    dom: StrategyDebuggerDom,
    diagnostic: StrategyDebuggerDiagnostic | null
): void {
    dom.copyDiagnostic.disabled = diagnostic === null;
    dom.diagnosticOutput.textContent = diagnostic
        ? JSON.stringify(diagnostic, null, 2)
        : "No diagnostic selected.";
}
