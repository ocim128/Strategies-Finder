import { debugLogger } from "./debug-logger";
import { getStrategyLibraryAudit, type StrategyLibraryAuditResponse, type StrategyLibraryAuditRow } from "./strategy-library-audit-api";
import { createStrategyLibraryAuditDom, type StrategyLibraryAuditDom } from "./strategy-library-audit-dom";

type AuditStatusTone = "ready" | "warning" | "muted" | "busy";

class StrategyLibraryAuditService {
    private dom: StrategyLibraryAuditDom | null = null;
    private initialized = false;
    private auditBusy = false;
    private auditResult: StrategyLibraryAuditResponse | null = null;

    public init(): void {
        if (this.initialized) {
            return;
        }

        this.dom = createStrategyLibraryAuditDom();
        this.bindEvents();
        this.setStatus("Audit not run.", "muted");
        this.renderEmptyState();
        this.initialized = true;
    }

    private getDom(): StrategyLibraryAuditDom {
        return this.dom ??= createStrategyLibraryAuditDom();
    }

    private bindEvents(): void {
        const {
            runStrategyLibraryAuditBtn,
            strategyLibraryAuditSearch,
            strategyLibraryAuditArchiveHeavyOnly,
            strategyLibraryAuditHideCore,
        } = this.getDom();

        runStrategyLibraryAuditBtn.addEventListener("click", () => {
            void this.runAudit();
        });
        strategyLibraryAuditSearch.addEventListener("input", () => this.renderCurrentResult());
        strategyLibraryAuditArchiveHeavyOnly.addEventListener("change", () => this.renderCurrentResult());
        strategyLibraryAuditHideCore.addEventListener("change", () => this.renderCurrentResult());
    }

    private setStatus(message: string, tone: AuditStatusTone): void {
        const { strategyLibraryAuditStatus } = this.getDom();
        strategyLibraryAuditStatus.textContent = message;
        strategyLibraryAuditStatus.dataset.state = tone;
    }

    private setBusy(isBusy: boolean): void {
        const { runStrategyLibraryAuditBtn } = this.getDom();
        this.auditBusy = isBusy;
        runStrategyLibraryAuditBtn.disabled = isBusy;
        runStrategyLibraryAuditBtn.classList.toggle("is-loading", isBusy);
    }

    private renderEmptyState(): void {
        const {
            strategyLibraryAuditSummary,
            strategyLibraryAuditWarnings,
            strategyLibraryAuditResults,
        } = this.getDom();

        strategyLibraryAuditSummary.replaceChildren();
        strategyLibraryAuditWarnings.replaceChildren();
        strategyLibraryAuditResults.replaceChildren();
    }

    private async runAudit(): Promise<void> {
        if (this.auditBusy) {
            return;
        }

        this.setBusy(true);
        this.setStatus("Scanning strategy library...", "busy");

        try {
            const result = await getStrategyLibraryAudit();
            this.auditResult = result;
            this.renderCurrentResult();
            this.setStatus(
                result.warnings.length > 0
                    ? `Audit complete with ${result.warnings.length} warning${result.warnings.length === 1 ? "" : "s"}.`
                    : "Audit complete.",
                result.warnings.length > 0 ? "warning" : "ready"
            );
            debugLogger.event("strategy_library_audit.run", {
                currentStrategies: result.currentStrategyFileCount,
                archivedStrategies: result.archivedStrategyFileCount,
                helperRows: result.helperRows.length,
                warnings: result.warnings.length,
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : "Strategy library audit failed.";
            this.auditResult = null;
            this.renderError(message);
            this.setStatus(message, "warning");
            debugLogger.error("strategy_library_audit.failed", { error: message });
        } finally {
            this.setBusy(false);
        }
    }

    private renderCurrentResult(): void {
        if (!this.auditResult) {
            this.renderEmptyState();
            return;
        }

        this.renderSummary(this.auditResult);
        this.renderWarnings(this.auditResult.warnings);
        this.renderRows(this.getFilteredRows(this.auditResult.helperRows));
    }

    private getFilteredRows(rows: readonly StrategyLibraryAuditRow[]): StrategyLibraryAuditRow[] {
        const {
            strategyLibraryAuditSearch,
            strategyLibraryAuditArchiveHeavyOnly,
            strategyLibraryAuditHideCore,
        } = this.getDom();
        const search = strategyLibraryAuditSearch.value.trim().toLowerCase();

        return rows.filter((row) => {
            if (strategyLibraryAuditArchiveHeavyOnly.checked && !row.flags.includes("archive_heavy")) {
                return false;
            }
            if (strategyLibraryAuditHideCore.checked && row.flags.includes("core_helper")) {
                return false;
            }
            if (!search) {
                return true;
            }

            return [
                row.helperName,
                row.moduleGroup,
                row.moduleSpecifier,
                row.evidenceLevel,
                ...row.flags,
            ].some((value) => value.toLowerCase().includes(search));
        });
    }

    private renderSummary(result: StrategyLibraryAuditResponse): void {
        const { strategyLibraryAuditSummary } = this.getDom();
        strategyLibraryAuditSummary.replaceChildren(
            this.createSummaryItem("Current", String(result.currentStrategyFileCount)),
            this.createSummaryItem("Archived", String(result.archivedStrategyFileCount)),
            this.createSummaryItem("Helpers", String(result.helperRows.length)),
            this.createSummaryItem("Generated", this.formatGeneratedAt(result.generatedAt))
        );
    }

    private createSummaryItem(label: string, value: string): HTMLElement {
        const item = document.createElement("div");
        item.className = "strategy-library-audit-summary-item";

        const valueEl = document.createElement("strong");
        valueEl.textContent = value;

        const labelEl = document.createElement("span");
        labelEl.textContent = label;

        item.replaceChildren(valueEl, labelEl);
        return item;
    }

    private renderWarnings(warnings: readonly string[]): void {
        const { strategyLibraryAuditWarnings } = this.getDom();
        strategyLibraryAuditWarnings.replaceChildren();
        strategyLibraryAuditWarnings.hidden = warnings.length === 0;

        if (warnings.length === 0) {
            return;
        }

        const list = document.createElement("ul");
        for (const warning of warnings.slice(0, 6)) {
            const item = document.createElement("li");
            item.textContent = warning;
            list.appendChild(item);
        }
        if (warnings.length > 6) {
            const item = document.createElement("li");
            item.textContent = `+${warnings.length - 6} more warnings`;
            list.appendChild(item);
        }

        strategyLibraryAuditWarnings.replaceChildren(list);
    }

    private renderRows(rows: readonly StrategyLibraryAuditRow[]): void {
        const { strategyLibraryAuditResults } = this.getDom();
        strategyLibraryAuditResults.replaceChildren();

        if (rows.length === 0) {
            const empty = document.createElement("div");
            empty.className = "strategy-library-audit-empty";
            empty.textContent = "No helper rows match the current filters.";
            strategyLibraryAuditResults.replaceChildren(empty);
            return;
        }

        const table = document.createElement("table");
        table.className = "strategy-library-audit-table";
        table.appendChild(this.createTableHead());

        const body = document.createElement("tbody");
        for (const row of rows) {
            body.appendChild(this.createRow(row));
        }
        table.appendChild(body);
        strategyLibraryAuditResults.replaceChildren(table);
    }

    private createTableHead(): HTMLTableSectionElement {
        const head = document.createElement("thead");
        const row = document.createElement("tr");
        for (const label of ["Helper", "Module", "Current", "Archive", "Rates", "Lift", "Evidence", "Flags", "Examples"]) {
            const cell = document.createElement("th");
            cell.scope = "col";
            cell.textContent = label;
            row.appendChild(cell);
        }
        head.appendChild(row);
        return head;
    }

    private createRow(row: StrategyLibraryAuditRow): HTMLTableRowElement {
        const tr = document.createElement("tr");
        tr.dataset.evidence = row.evidenceLevel;

        tr.appendChild(this.createTextCell(row.helperName, "strategy-library-audit-helper"));
        tr.appendChild(this.createTextCell(row.moduleGroup));
        tr.appendChild(this.createTextCell(`${row.currentFileCount} files / ${row.currentImportCount} imports`));
        tr.appendChild(this.createTextCell(`${row.archivedFileCount} files / ${row.archivedImportCount} imports`));
        tr.appendChild(this.createTextCell(`${this.formatPercent(row.currentUsageRate)} / ${this.formatPercent(row.archivedUsageRate)}`));
        tr.appendChild(this.createTextCell(this.formatLift(row.archiveLift)));
        tr.appendChild(this.createTextCell(row.evidenceLevel));
        tr.appendChild(this.createFlagsCell(row));
        tr.appendChild(this.createExamplesCell(row));

        return tr;
    }

    private createTextCell(value: string, className?: string): HTMLTableCellElement {
        const cell = document.createElement("td");
        cell.textContent = value;
        if (className) {
            cell.className = className;
        }
        return cell;
    }

    private createFlagsCell(row: StrategyLibraryAuditRow): HTMLTableCellElement {
        const cell = document.createElement("td");
        const wrap = document.createElement("div");
        wrap.className = "strategy-library-audit-flags";

        if (row.flags.length === 0) {
            const muted = document.createElement("span");
            muted.className = "strategy-library-audit-muted";
            muted.textContent = "-";
            wrap.appendChild(muted);
        } else {
            for (const flag of row.flags) {
                const badge = document.createElement("span");
                badge.className = "strategy-library-audit-flag";
                badge.dataset.flag = flag;
                badge.textContent = flag.replace(/_/g, " ");
                wrap.appendChild(badge);
            }
        }

        cell.appendChild(wrap);
        return cell;
    }

    private createExamplesCell(row: StrategyLibraryAuditRow): HTMLTableCellElement {
        const cell = document.createElement("td");
        const wrap = document.createElement("div");
        wrap.className = "strategy-library-audit-examples";
        this.appendExampleGroup(wrap, "C", row.currentExamples);
        this.appendExampleGroup(wrap, "A", row.archivedExamples);
        cell.appendChild(wrap);
        return cell;
    }

    private appendExampleGroup(target: HTMLElement, label: string, examples: readonly string[]): void {
        if (examples.length === 0) {
            return;
        }

        const group = document.createElement("div");
        const prefix = document.createElement("span");
        prefix.className = "strategy-library-audit-example-prefix";
        prefix.textContent = `${label}:`;
        group.appendChild(prefix);
        group.appendChild(document.createTextNode(` ${examples.join(", ")}`));
        target.appendChild(group);
    }

    private renderError(message: string): void {
        const {
            strategyLibraryAuditSummary,
            strategyLibraryAuditWarnings,
            strategyLibraryAuditResults,
        } = this.getDom();
        strategyLibraryAuditSummary.replaceChildren();
        strategyLibraryAuditWarnings.replaceChildren();
        strategyLibraryAuditWarnings.hidden = true;

        const error = document.createElement("div");
        error.className = "strategy-library-audit-empty";
        error.textContent = message;
        strategyLibraryAuditResults.replaceChildren(error);
    }

    private formatPercent(value: number | null): string {
        if (value === null || !Number.isFinite(value)) {
            return "-";
        }
        return `${(value * 100).toFixed(value > 0 && value < 0.1 ? 1 : 0)}%`;
    }

    private formatLift(value: number | null): string {
        if (value === null || !Number.isFinite(value)) {
            return "-";
        }
        return `${value.toFixed(value < 10 ? 1 : 0)}x`;
    }

    private formatGeneratedAt(value: string): string {
        const date = new Date(value);
        return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
    }
}

export const strategyLibraryAuditService = new StrategyLibraryAuditService();
