import { copyToClipboard } from "../browser-transfer";
import { consumeNdjsonStream } from "../ndjson-stream";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import { ensureLazyStylesheet } from "../lazy-styles";
import { createSelectionRulesDom, type SelectionRulesDom } from "../selection-rules-dom";
import type {
    SelectionRuleResult,
    SelectionRulesCatalogEntry,
    SelectionRulesCatalogResponse,
    SelectionRulesStatusResponse,
    SelectionRulesStatusRun,
    SelectionRulesStreamEvent,
} from "./stream-types";

export const SELECTION_RULES_ACTIVE_RUN_STORAGE = {
    key: "playground_selection_rules_active_server_run",
    schema: "selection_rules.active_server_run",
    version: 1,
} as const;

type PersistedSelectionRulesRun = { runId: string; startedAt: number };
type SelectionRulesTerminalEvent = Extract<SelectionRulesStreamEvent, { type: "done" | "cancelled" | "fatal" }>;

function readActiveRun(): PersistedSelectionRulesRun | null {
    return readPersistedJson<PersistedSelectionRulesRun | null>({
        ...SELECTION_RULES_ACTIVE_RUN_STORAGE,
        fallback: null,
        migrate: ({ data }) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;
            const value = data as Partial<PersistedSelectionRulesRun>;
            if (typeof value.runId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.runId)) return null;
            return { runId: value.runId, startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now() };
        },
    });
}

function persistActiveRun(value: PersistedSelectionRulesRun | null): void {
    writePersistedJson({ ...SELECTION_RULES_ACTIVE_RUN_STORAGE, data: value });
}

export function createSelectionRulesRunId(now = Date.now(), random = Math.random()): string {
    return `selection-rules-${now.toString(36)}-${Math.floor(random * 0xFFFFFFF).toString(36)}`.slice(0, 64);
}

function resultKey(result: Pick<SelectionRuleResult, "ruleKey" | "horizonBars">): string {
    return `${result.ruleKey}|${result.horizonBars}`;
}

function formatPp(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(2)}pp`;
}

function formatPair(mean: number | null, median: number | null): string {
    return `${formatPp(mean)} / ${formatPp(median)}`;
}

function formatShare(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : `${(value * 100).toFixed(1)}%`;
}

function terminalFromStatus(run: SelectionRulesStatusRun): SelectionRulesTerminalEvent {
    if (run.phase === "done") {
        return { type: "done", runId: run.runId, ok: true, cancelled: false, finishedAt: run.finishedAt ?? Date.now(), summary: run.summary!, results: run.results, reportLines: run.reportLines };
    }
    if (run.phase === "cancelled") {
        return { type: "cancelled", runId: run.runId, ok: false, cancelled: true, finishedAt: run.finishedAt ?? Date.now(), summary: run.summary!, results: run.results, reportLines: run.reportLines };
    }
    return {
        type: "fatal",
        runId: run.runId,
        ok: false,
        cancelled: false,
        finishedAt: run.finishedAt ?? Date.now(),
        error: run.error ?? "Pair-selection tally failed.",
        summary: run.summary,
        results: run.results,
        reportLines: run.reportLines,
    };
}

export class SelectionRulesService {
    private dom: SelectionRulesDom | null = null;
    private initialized = false;
    private catalog: SelectionRulesCatalogResponse | null = null;
    private activeServerRunId: string | null = null;
    private running = false;
    private readonly results = new Map<string, SelectionRuleResult>();
    private reportLines: string[] = [];
    private reattachTimer: ReturnType<typeof setTimeout> | null = null;

    private getDom(): SelectionRulesDom {
        return this.dom ??= createSelectionRulesDom();
    }

    public init(): void {
        ensureLazyStylesheet("selection-rules-styles", new URL("../../styles/selection-rules.css", import.meta.url).href);
        if (this.initialized) return;
        const dom = this.getDom();
        this.initialized = true;
        dom.selectionRulesFolderSelect.addEventListener("change", () => this.renderSelectedFolder());
        dom.selectionRulesHorizonSelect.addEventListener("change", () => this.setBusy());
        dom.selectionRulesRuleList.addEventListener("change", () => this.setBusy());
        dom.selectionRulesRunBtn.addEventListener("click", () => { void this.startRun(); });
        dom.selectionRulesStopBtn.addEventListener("click", () => { void this.stopRun(); });
        dom.selectionRulesCopyBtn.addEventListener("click", () => { void this.copyReport(); });
        dom.selectionRulesResults.addEventListener("click", (event) => {
            const target = event.target as Element | null;
            const row = target?.closest<HTMLTableRowElement>("tr[data-result-key]");
            if (row) row.classList.toggle("selection-rules-result-selected");
        });

        const active = readActiveRun();
        this.activeServerRunId = active?.runId ?? null;
        this.running = this.activeServerRunId !== null;
        this.setBusy();
        void this.refreshCatalog().then(() => {
            if (this.activeServerRunId) {
                void this.reattach(this.activeServerRunId);
                return;
            }
            this.setStatus("Idle");
        });
    }

    private async refreshCatalog(): Promise<void> {
        try {
            const response = await fetch("/api/selection-rules/catalog", { cache: "no-store" });
            if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status}`);
            this.catalog = await response.json() as SelectionRulesCatalogResponse;
            this.renderFolders();
            this.renderRules();
            this.renderSelectedFolder();
            if (!this.activeServerRunId) this.setStatus("Idle");
        } catch (error) {
            this.setStatus(`Catalog error: ${error instanceof Error ? error.message : String(error)}`, "danger");
        }
    }

    private renderFolders(): void {
        const dom = this.getDom();
        const selected = dom.selectionRulesFolderSelect.value;
        const folders = this.catalog?.folders ?? [];
        dom.selectionRulesFolderSelect.replaceChildren(...folders.map((folder) => {
            const option = document.createElement("option");
            option.value = folder.folderId;
            option.textContent = `${folder.runId} - ${folder.interval} - ${folder.strategyKey} - signals=${folder.totals.signals}`;
            return option;
        }));
        if (folders.some((folder) => folder.folderId === selected)) dom.selectionRulesFolderSelect.value = selected;
        else if (folders[0]) dom.selectionRulesFolderSelect.value = folders[0].folderId;
        this.renderHorizons();
    }

    private renderHorizons(): void {
        const dom = this.getDom();
        const selected = Number(dom.selectionRulesHorizonSelect.value);
        const horizons = this.selectedFolder()?.ledgerHorizons ?? [];
        dom.selectionRulesHorizonSelect.replaceChildren(...horizons.map((horizon) => {
            const option = document.createElement("option");
            option.value = String(horizon);
            option.textContent = String(horizon);
            return option;
        }));
        if (horizons.includes(selected)) dom.selectionRulesHorizonSelect.value = String(selected);
        else if (horizons[0] !== undefined) dom.selectionRulesHorizonSelect.value = String(horizons[0]);
    }

    private renderRules(): void {
        const dom = this.getDom();
        const existing = new Set(this.selectedRuleKeys());
        const rules = this.catalog?.rules ?? [];
        const initiallyChecked = existing.size === 0;
        dom.selectionRulesRuleList.replaceChildren(...rules.map((rule) => {
            const label = document.createElement("label");
            label.className = "selection-rules-rule-option";
            label.title = rule.description;
            const input = document.createElement("input");
            input.type = "checkbox";
            input.value = rule.key;
            input.checked = initiallyChecked || existing.has(rule.key);
            const text = document.createElement("span");
            text.textContent = rule.name;
            const key = document.createElement("code");
            key.className = "selection-rules-rule-key";
            key.textContent = rule.key;
            const description = document.createElement("small");
            description.textContent = rule.description;
            label.append(input, text, key, description);
            return label;
        }));
    }

    private selectedRuleKeys(): string[] {
        return Array.from(this.getDom().selectionRulesRuleList.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked"))
            .map((input) => input.value);
    }

    private selectedFolder(): SelectionRulesCatalogEntry | null {
        const folderId = this.getDom().selectionRulesFolderSelect.value;
        return this.catalog?.folders.find((folder) => folder.folderId === folderId) ?? null;
    }

    private renderSelectedFolder(): void {
        const folder = this.selectedFolder();
        this.renderHorizons();
        this.getDom().selectionRulesFolderMeta.textContent = folder
            ? `runId=${folder.runId} - ${folder.interval} - strategy=${folder.strategyKey} - signals=${folder.totals.signals} - pairs=${folder.totals.pairs} - ${folder.startedAt} to ${folder.finishedAt} - horizons=${folder.ledgerHorizons.join(", ")}`
            : "No supported v3 mining-ledger folders found.";
        this.setBusy();
    }

    private setStatus(text: string, tone: "neutral" | "running" | "success" | "warning" | "danger" = "neutral"): void {
        const dom = this.getDom();
        dom.selectionRulesStatus.textContent = text;
        dom.selectionRulesStatus.dataset.tone = tone;
    }

    private setBusy(): void {
        const dom = this.getDom();
        const hasFolder = this.selectedFolder() !== null;
        const hasRules = this.selectedRuleKeys().length > 0;
        const hasHorizon = dom.selectionRulesHorizonSelect.value !== "";
        dom.selectionRulesRunBtn.disabled = this.running || !hasFolder || !hasRules || !hasHorizon;
        dom.selectionRulesStopBtn.hidden = !this.running;
        dom.selectionRulesFolderSelect.disabled = this.running;
        dom.selectionRulesHorizonSelect.disabled = this.running;
        dom.selectionRulesRuleList.querySelectorAll<HTMLInputElement>("input").forEach((input) => { input.disabled = this.running; });
    }

    private renderProgress(completedRules: number, totalRules: number, detail: string, currentRuleKey: string | null, currentHorizonBars: number | null): void {
        const dom = this.getDom();
        dom.selectionRulesProgress.hidden = false;
        dom.selectionRulesProgress.classList.add("active");
        const percent = totalRules > 0 ? Math.min(100, Math.max(0, completedRules / totalRules * 100)) : 0;
        dom.selectionRulesProgressFill.value = percent;
        dom.selectionRulesProgress.setAttribute("aria-valuenow", String(Math.round(percent)));
        const current = currentRuleKey ? ` - ${currentRuleKey}${currentHorizonBars === null ? "" : ` - h=${currentHorizonBars}`}` : "";
        dom.selectionRulesProgressText.textContent = `${detail}${current} - ${completedRules}/${totalRules} rules`;
    }

    private renderResults(): void {
        const dom = this.getDom();
        const results = [...this.results.values()].sort((left, right) =>
            (right.othersMeanDeltaMeanPp ?? -Infinity) - (left.othersMeanDeltaMeanPp ?? -Infinity)
            || left.ruleName.localeCompare(right.ruleName)
            || left.horizonBars - right.horizonBars,
        );
        dom.selectionRulesResults.replaceChildren(...results.map((result) => {
            const row = document.createElement("tr");
            row.dataset.resultKey = resultKey(result);
            const values = [
                result.ruleName,
                String(result.horizonBars),
                String(result.n),
                formatPair(result.othersMeanDeltaMeanPp, result.othersMeanDeltaMedianPp),
                formatPair(result.referenceAlphabeticalDeltaMeanPp, result.referenceAlphabeticalDeltaMedianPp),
                formatPair(result.referenceLoudestAtrDeltaMeanPp, result.referenceLoudestAtrDeltaMedianPp),
                result.successBarPass ? "PASS" : "FAIL",
                result.dominantPair ? `${result.dominantPair} - ${formatShare(result.dominantPairShare)}` : "n/a",
                result.dominantBaseLeg ? `${result.dominantBaseLeg} - ${formatShare(result.dominantBaseShare)}` : "n/a",
                result.dominantQuoteLeg ? `${result.dominantQuoteLeg} - ${formatShare(result.dominantQuoteShare)}` : "n/a",
                result.excludingDominantPair
                    ? `${result.excludingDominantPair} - n=${result.excludingDominantN ?? "n/a"} - ${formatPair(result.excludingDominantOthersMeanDeltaMeanPp, result.excludingDominantOthersMeanDeltaMedianPp)}`
                    : "n/a",
            ];
            values.forEach((value, index) => {
                const cell = document.createElement(index === 0 ? "th" : "td");
                if (index === 0) cell.scope = "row";
                cell.textContent = value;
                if (index === 6) cell.className = result.successBarPass ? "selection-rules-result-pass" : "selection-rules-result-fail";
                row.appendChild(cell);
            });
            return row;
        }));
        dom.selectionRulesEmpty.hidden = results.length > 0;
    }

    private renderReport(): void {
        const dom = this.getDom();
        dom.selectionRulesReport.textContent = this.reportLines.join("\n");
        dom.selectionRulesCopyBtn.disabled = this.reportLines.length === 0;
    }

    private resetOutput(): void {
        this.results.clear();
        this.reportLines = [];
        this.renderResults();
        this.renderReport();
    }

    private acceptResult(event: SelectionRulesStreamEvent & { type: "rule_result" }): void {
        this.results.set(resultKey(event.result), event.result);
        this.reportLines.push(...event.result.reportLines);
        this.renderResults();
        this.renderReport();
        this.renderProgress(event.completedRules, event.totalRules, "Tallying", event.result.ruleKey, event.result.horizonBars);
    }

    private adoptTerminal(event: SelectionRulesTerminalEvent): void {
        if (this.activeServerRunId !== event.runId) return;
        this.results.clear();
        for (const result of event.results) this.results.set(resultKey(result), result);
        this.reportLines = [...event.reportLines];
        this.running = false;
        this.renderResults();
        this.renderReport();
        const totalRules = event.summary?.totalRules ?? new Set(event.results.map((result) => result.ruleKey)).size;
        const completedRules = event.summary?.completedRules ?? new Set(event.results.map((result) => result.ruleKey)).size;
        this.getDom().selectionRulesProgress.classList.remove("active");
        this.setStatus(
            event.type === "fatal"
                ? `Fatal: ${event.error}`
                : `${event.type === "cancelled" ? "Cancelled" : "Done"} - ${completedRules}/${totalRules} rules`,
            event.type === "done" ? "success" : event.type === "cancelled" ? "warning" : "danger",
        );
        this.setBusy();
        persistActiveRun({ runId: event.runId, startedAt: Date.now() });
    }

    private async startRun(): Promise<void> {
        if (this.running) return;
        const folder = this.selectedFolder();
        const ruleKeys = this.selectedRuleKeys();
        const horizonBars = Number(this.getDom().selectionRulesHorizonSelect.value);
        if (!folder || ruleKeys.length === 0 || !Number.isInteger(horizonBars) || horizonBars <= 0) return;
        const runId = createSelectionRulesRunId();
        this.activeServerRunId = runId;
        this.running = true;
        this.resetOutput();
        this.getDom().selectionRulesEmpty.hidden = true;
        persistActiveRun({ runId, startedAt: Date.now() });
        this.setBusy();
        this.setStatus("Starting...", "running");
        this.renderProgress(0, ruleKeys.length, "Loading and verifying pair-selection ledger", null, null);
        try {
            const response = await fetch("/api/selection-rules/run", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runId, folderPath: folder.folderId, ruleKeys, horizonBars }),
            });
            if (!response.ok) {
                const detail = await response.text();
                if (this.activeServerRunId === runId) {
                    this.activeServerRunId = null;
                    this.running = false;
                    persistActiveRun(null);
                    this.getDom().selectionRulesEmpty.hidden = false;
                    this.setStatus(detail || `Run failed: HTTP ${response.status}`, "danger");
                    this.setBusy();
                }
                return;
            }
            if (!response.body) throw new Error("Selection Rules response body is missing.");
            await consumeNdjsonStream<SelectionRulesStreamEvent>(response.body, {
                onStart: (event) => { if (this.activeServerRunId === event.runId) this.setStatus("Pair-selection ledger verified; running rules", "running"); },
                onPhase: (event) => { if (this.activeServerRunId === event.runId) this.renderProgress(event.completedRules, event.totalRules, event.detail, event.currentRuleKey, event.currentHorizonBars); },
                onRuleResult: (event) => { if (this.activeServerRunId === event.runId) this.acceptResult(event); },
                onDone: (event) => this.adoptTerminal(event),
                onCancelled: (event) => this.adoptTerminal(event),
                onFatal: (event) => this.adoptTerminal(event),
            }, { requireTerminal: true, terminalTypes: ["done", "cancelled", "fatal"] });
        } catch (error) {
            if (this.activeServerRunId === runId) {
                this.setStatus(`Stream interrupted; reattaching (${error instanceof Error ? error.message : String(error)})`, "warning");
                void this.reattach(runId);
            }
        }
    }

    private async stopRun(): Promise<void> {
        const runId = this.activeServerRunId;
        if (!runId) return;
        try {
            await fetch("/api/selection-rules/stop", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ runId }),
            });
            if (this.activeServerRunId === runId) this.setStatus("Stop requested...", "running");
        } catch (error) {
            if (this.activeServerRunId === runId) this.setStatus(`Stop failed: ${error instanceof Error ? error.message : String(error)}`, "danger");
        }
    }

    private async reattach(runId: string): Promise<void> {
        while (this.activeServerRunId === runId) {
            try {
                const response = await fetch(`/api/selection-rules/status?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const payload = await response.json() as SelectionRulesStatusResponse;
                if (this.activeServerRunId !== runId) return;
                if (payload.runMismatch) {
                    this.activeServerRunId = null;
                    this.running = false;
                    persistActiveRun(null);
                    this.setStatus("Run is no longer retained by the server.", "warning");
                    this.setBusy();
                    return;
                }
                if (payload.run) {
                    this.running = true;
                    this.results.clear();
                    for (const result of payload.run.results) this.results.set(resultKey(result), result);
                    this.reportLines = [...payload.run.reportLines];
                    this.renderResults();
                    this.renderReport();
                    this.renderProgress(payload.run.completedRules, payload.run.totalRules, payload.run.phase === "loading" ? "Loading and verifying pair-selection ledger" : "Reattached", payload.run.currentRuleKey, payload.run.currentHorizonBars);
                    this.setStatus(`Reattached: ${payload.run.phase}`, "running");
                } else if (payload.lastRun) {
                    this.adoptTerminal(terminalFromStatus(payload.lastRun));
                    return;
                }
            } catch (error) {
                if (this.activeServerRunId !== runId) return;
                this.setStatus(`Connection lost; retrying (${error instanceof Error ? error.message : String(error)})`, "warning");
            }
            await this.delay(2_000);
        }
    }

    private delay(ms: number): Promise<void> {
        if (this.reattachTimer !== null) clearTimeout(this.reattachTimer);
        return new Promise((resolve) => {
            this.reattachTimer = setTimeout(() => {
                this.reattachTimer = null;
                resolve();
            }, ms);
        });
    }

    private async copyReport(): Promise<void> {
        if (this.reportLines.length > 0) await copyToClipboard(this.reportLines.join("\n"));
    }
}

export const selectionRulesService = new SelectionRulesService();
