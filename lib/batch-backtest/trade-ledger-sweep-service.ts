import { copyToClipboard } from "../browser-transfer";
import { escapeHtml } from "../html-escape";
import { consumeNdjsonStream } from "../ndjson-stream";
import { readPersistedJson, writePersistedJson } from "../persisted-json";
import { ensureLazyStylesheet } from "../lazy-styles";
import { ReattachBackoffController } from "./reattach-backoff";
import { createTradeLedgerSweepDom, type TradeLedgerSweepDom } from "./trade-ledger-sweep-dom";
import type { LedgerSweepFolderCatalogEntry } from "./trade-ledger-sweep-catalog";
import { buildTradeLedgerSweepDiagnosticsSummary, type LedgerSweepDiagnosticsSummaryV1 } from "./trade-ledger-sweep-diagnostics-summary";
import type { LedgerSweepDiagnosticsV1 } from "./trade-ledger-sweep-diagnostics";
import type {
    LedgerSweepCatalogResponse,
    LedgerSweepRuleResult,
    LedgerSweepStatusResponse,
    LedgerSweepStatusRun,
    LedgerSweepStreamEvent,
} from "./trade-ledger-sweep-stream-types";

export const TRADE_LEDGER_SWEEP_ACTIVE_RUN_STORAGE = {
    key: "playground_trade_ledger_sweep_active_server_run",
    schema: "trade_ledger_sweep.active_server_run",
    version: 1,
} as const;

type PersistedSweepRun = { runId: string; startedAt: number };
type LedgerSweepTerminalEvent = Extract<LedgerSweepStreamEvent, { type: "done" | "cancelled" | "fatal" }>;
type LedgerSweepTerminalView = {
    runId: string;
    finishedAt: number | null;
    summary: string | null;
    results: LedgerSweepRuleResult[];
    diagnostics: LedgerSweepDiagnosticsV1;
    outputDir: string;
    error?: string | null;
};

export function isTradeLedgerSweepRunCurrent(activeRunId: string | null, eventRunId: string): boolean {
    return activeRunId !== null && activeRunId === eventRunId;
}

const VERDICT_ORDER: Record<LedgerSweepRuleResult["verdict"], number> = {
    "EDGE-CANDIDATE": 0,
    "HOLDOUT-NEG": 1,
    "TOO-RARE": 2,
    "NO-EDGE": 3,
    ERROR: 4,
};

export function createTradeLedgerSweepRunId(now = Date.now(), random = Math.random()): string {
    const value = `ledger-sweep-${now.toString(36)}-${Math.floor(random * 0xFFFFFFF).toString(36)}`;
    return value.slice(0, 64);
}

export function sortTradeLedgerSweepResults(results: readonly LedgerSweepRuleResult[]): LedgerSweepRuleResult[] {
    return [...results].sort((a, b) => VERDICT_ORDER[a.verdict] - VERDICT_ORDER[b.verdict]
        || (b.holdoutMeanPnlDeltaPp ?? -Infinity) - (a.holdoutMeanPnlDeltaPp ?? -Infinity)
        || (b.isMeanPnlDeltaPp ?? -Infinity) - (a.isMeanPnlDeltaPp ?? -Infinity)
        || (a.ruleName < b.ruleName ? -1 : a.ruleName > b.ruleName ? 1 : 0));
}

export function upsertTradeLedgerSweepResult(results: readonly LedgerSweepRuleResult[], result: LedgerSweepRuleResult): LedgerSweepRuleResult[] {
    const next = [...results];
    const index = next.findIndex((current) => current.ruleId === result.ruleId);
    if (index >= 0) next[index] = result;
    else next.push(result);
    return sortTradeLedgerSweepResults(next);
}

function formatBytes(value: number | null): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GiB`;
    if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MiB`;
    return `${Math.round(value / 1024)} KiB`;
}

function formatMetric(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : value.toFixed(3);
}

export function formatTradeLedgerSweepDiagnostics(diagnostics: unknown): string {
    return JSON.stringify(diagnostics, null, 2);
}

export function formatTradeLedgerSweepDiagnosticsSummary(summary: LedgerSweepDiagnosticsSummaryV1): string {
    return JSON.stringify(summary, null, 2);
}

function readActiveRun(): PersistedSweepRun | null {
    return readPersistedJson<PersistedSweepRun | null>({
        ...TRADE_LEDGER_SWEEP_ACTIVE_RUN_STORAGE,
        fallback: null,
        migrate: ({ data }) => {
            if (!data || typeof data !== "object" || Array.isArray(data)) return null;
            const value = data as Partial<PersistedSweepRun>;
            if (typeof value.runId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(value.runId)) return null;
            return { runId: value.runId, startedAt: typeof value.startedAt === "number" ? value.startedAt : Date.now() };
        },
    });
}

function persistActiveRun(value: PersistedSweepRun | null): void {
    writePersistedJson({ ...TRADE_LEDGER_SWEEP_ACTIVE_RUN_STORAGE, data: value });
}

export class TradeLedgerSweepService {
    private dom: TradeLedgerSweepDom | null = null;
    private initialized = false;
    private catalog: LedgerSweepCatalogResponse | null = null;
    private activeServerRunId: string | null = null;
    private running = false;
    private results: LedgerSweepRuleResult[] = [];
    private summary: string | null = null;
    private diagnostics: LedgerSweepDiagnosticsV1 | null = null;
    private diagnosticsTerminalPhase: LedgerSweepDiagnosticsSummaryV1["terminalPhase"] = "done";
    private reattachTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly reattachBackoff = new ReattachBackoffController();

    private getDom(): TradeLedgerSweepDom {
        return this.dom ??= createTradeLedgerSweepDom();
    }

    public init(): void {
        ensureLazyStylesheet("trade-ledger-sweep-styles", new URL("../../styles/trade-ledger-sweep.css", import.meta.url).href);
        if (this.initialized) return;
        const dom = this.getDom();
        this.initialized = true;
        dom.tradeLedgerSweepRefreshBtn.addEventListener("click", () => { void this.refreshCatalog(); });
        dom.tradeLedgerSweepFolderSelect.addEventListener("change", () => this.renderSelectedFolder());
        dom.tradeLedgerSweepRunBtn.addEventListener("click", () => { void this.startRun(); });
        dom.tradeLedgerSweepStopBtn.addEventListener("click", () => { void this.stopRun(); });
        dom.tradeLedgerSweepCopySummaryBtn.addEventListener("click", () => { void this.copySummary(); });
        dom.tradeLedgerSweepCopyDiagnosticsBtn.addEventListener("click", () => { void this.copyDiagnostics(); });
        dom.tradeLedgerSweepDiagnosticsSummaryTab.addEventListener("click", () => this.showDiagnosticsView(true));
        dom.tradeLedgerSweepDiagnosticsRawTab.addEventListener("click", () => this.showDiagnosticsView(false));
        dom.tradeLedgerSweepHoldoutWarning.textContent = "This sweep exposes holdout results for every rule. Treat verdicts as surface-specific audit evidence only; EDGE-CANDIDATE still requires a new surface and one raw-engine certification run.";
        this.renderDiagnosticsSummary(null);
        this.showDiagnosticsView(true);
        const active = readActiveRun();
        this.activeServerRunId = active?.runId ?? null;
        this.running = this.activeServerRunId !== null;
        this.setBusy();
        void this.refreshCatalog().then(() => {
            if (this.activeServerRunId) return this.reattach(this.activeServerRunId);
            return undefined;
        });
    }

    private async refreshCatalog(): Promise<void> {
        const dom = this.getDom();
        try {
            const response = await fetch("/api/trade-ledger-sweep/catalog", { cache: "no-store" });
            if (!response.ok) throw new Error(`Catalog request failed: HTTP ${response.status}`);
            this.catalog = await response.json() as LedgerSweepCatalogResponse;
            const selected = dom.tradeLedgerSweepFolderSelect.value;
            const folders = [...this.catalog.folders].sort((a, b) => Number(b.runnable) - Number(a.runnable));
            dom.tradeLedgerSweepFolderSelect.replaceChildren(...folders.map((folder) => {
                const option = document.createElement("option");
                option.value = folder.folderId;
                option.disabled = !folder.runnable;
                option.textContent = folder.runnable ? folder.name : `${folder.name} — ${folder.refusalReason ?? "refused"}`;
                return option;
            }));
            if (folders.some((folder) => folder.folderId === selected)) dom.tradeLedgerSweepFolderSelect.value = selected;
            this.renderSelectedFolder();
            if (!this.activeServerRunId) this.setStatus("Idle");
        } catch (error) {
            dom.tradeLedgerSweepStatus.textContent = `Catalog error: ${error instanceof Error ? error.message : String(error)}`;
        }
    }

    private selectedFolder(): LedgerSweepFolderCatalogEntry | null {
        const id = this.getDom().tradeLedgerSweepFolderSelect.value;
        return this.catalog?.folders.find((folder) => folder.folderId === id) ?? null;
    }

    private renderSelectedFolder(): void {
        const dom = this.getDom();
        const folder = this.selectedFolder();
        if (!folder) {
            dom.tradeLedgerSweepFolderMeta.textContent = "No ledger folders found.";
            dom.tradeLedgerSweepRunBtn.disabled = true;
            return;
        }
        const p = folder.preflight;
        dom.tradeLedgerSweepFolderMeta.innerHTML = [
            `<strong>${escapeHtml(folder.name)}</strong>`,
            `ledger ${formatBytes(folder.ledgerBytes)} · ranks ${formatBytes(folder.rankBytes)} · rows ${folder.rows ?? "n/a"} · pairs ${folder.pairs ?? "n/a"}`,
            `versions ${folder.ledgerVersion ?? "n/a"}/${folder.featureVersion ?? "n/a"} · complete ${folder.complete ? "yes" : "no"} · replay ${folder.replayEligible ? "eligible" : "blocked"}`,
            p ? `estimate heap ${formatBytes(p.estimatedHeapBytes)} · RSS ${formatBytes(p.estimatedRssBytes)} · mode ${p.decision}` : (folder.refusalReason ?? "No preflight available."),
        ].join("<br>");
        dom.tradeLedgerSweepRunBtn.disabled = this.running || !folder.runnable;
    }

    private setStatus(text: string): void {
        this.getDom().tradeLedgerSweepStatus.textContent = text;
    }

    private setBusy(): void {
        const dom = this.getDom();
        dom.tradeLedgerSweepRunBtn.disabled = this.running || !(this.selectedFolder()?.runnable ?? false);
        dom.tradeLedgerSweepStopBtn.hidden = !this.running;
        dom.tradeLedgerSweepRefreshBtn.disabled = this.running;
        dom.tradeLedgerSweepFolderSelect.disabled = this.running;
    }

    private renderProgress(event: LedgerSweepStreamEvent): void {
        const dom = this.getDom();
        if (event.type === "progress") {
            dom.tradeLedgerSweepProgress.hidden = false;
            dom.tradeLedgerSweepProgressFill.style.width = `${Math.max(0, Math.min(100, event.percent))}%`;
            dom.tradeLedgerSweepProgressText.textContent = `${event.detail} · ${event.elapsedMs.toFixed(0)} ms · ${event.rulesPerHour.toFixed(1)} rules/hour`;
        } else if (event.type === "phase") {
            dom.tradeLedgerSweepProgress.hidden = false;
            dom.tradeLedgerSweepProgressText.textContent = `${event.detail} · ${event.elapsedMs.toFixed(0)} ms`;
        }
    }

    private showDiagnosticsView(summary: boolean): void {
        const dom = this.getDom();
        dom.tradeLedgerSweepDiagnosticsSummary.hidden = !summary;
        dom.tradeLedgerSweepDiagnostics.hidden = summary;
        dom.tradeLedgerSweepDiagnosticsSummaryTab.classList.toggle("is-active", summary);
        dom.tradeLedgerSweepDiagnosticsSummaryTab.setAttribute("aria-selected", String(summary));
        dom.tradeLedgerSweepDiagnosticsRawTab.classList.toggle("is-active", !summary);
        dom.tradeLedgerSweepDiagnosticsRawTab.setAttribute("aria-selected", String(!summary));
    }

    private renderDiagnosticsSummary(diagnostics: LedgerSweepDiagnosticsV1 | null): void {
        const dom = this.getDom();
        if (!diagnostics) {
            dom.tradeLedgerSweepDiagnosticsSummary.textContent = "Summary is available after the first diagnostic aggregate.";
            return;
        }
        const summary = buildTradeLedgerSweepDiagnosticsSummary(diagnostics, this.diagnosticsTerminalPhase);
        const phaseRows: Array<[string, string]> = [
            ["Load (ledger / ranks / join)", `${summary.phases.load.totalMs.toFixed(1)} ms`],
            ["Rule module loading", `${summary.phases.ruleLoading.totalMs.toFixed(1)} ms`],
            ["Prepare", `${summary.phases.prepare.totalMs.toFixed(1)} ms`],
            ["Rule replay", `${summary.phases.ruleReplay.totalMs.toFixed(1)} ms`],
            ["Controls", `${summary.phases.controls.totalMs.toFixed(1)} ms`],
            ["Report writing", `${summary.phases.reportWriting.totalMs.toFixed(1)} ms`],
            ["Other", `${summary.phases.other.totalMs.toFixed(1)} ms`],
            ["Wall", `${summary.wallMs.toFixed(1)} ms`],
            ["Controls share", `${summary.controlsShareOfCompute?.toFixed(2) ?? "n/a"}% compute / ${summary.controlsShareOfWall?.toFixed(2) ?? "n/a"}% wall`],
            ["Control execution", `${summary.controlExecution}${summary.controlWorkers > 0 ? ` (${summary.controlWorkers} workers)` : ""}`],
        ];
        const throughputRows: Array<[string, string]> = [
            ["Rules", String(summary.throughput.rulesCompleted)],
            ["Rules/hour", summary.throughput.rulesPerHour.toFixed(1)],
            ["Rows loaded/s", summary.throughput.rowsLoadedPerSecond.toFixed(1)],
            ["Aggregate rows/s", summary.throughput.aggregateRowsPerSecond.toFixed(1)],
        ];
        const memoryRows: Array<[string, string]> = [
            ["Peak heapUsed", formatBytes(summary.memory.peakHeapUsed)],
            ["Peak rss", formatBytes(summary.memory.peakRss)],
            ["maxRss", formatBytes(summary.memory.maxRss)],
        ];
        const verdicts = Object.entries(summary.verdictCounts).sort(([a], [b]) => a.localeCompare(b));
        const verdictText = verdicts.length > 0 ? verdicts.map(([verdict, count]) => `${escapeHtml(verdict)}: ${count}`).join(" · ") : "none";
        const topRules = summary.topSlowestRules.length > 0
            ? summary.topSlowestRules.map((rule) => `<tr class="trade-ledger-sweep-summary-rule"><td>${escapeHtml(rule.name)}</td><td>${rule.candidates}</td><td>${rule.kept}</td><td>${rule.controlReplayMs.toFixed(1)} ms</td></tr>`).join("")
            : `<tr><td colspan="4">No completed rule diagnostics.</td></tr>`;
        const renderRows = (rows: readonly (readonly [string, string])[]): string => rows.map(([label, value]) => `<tr><th>${escapeHtml(label)}</th><td>${escapeHtml(value)}</td></tr>`).join("");
        dom.tradeLedgerSweepDiagnosticsSummary.innerHTML = `<table><tbody><tr class="trade-ledger-sweep-summary-section"><th colspan="2">Phase totals</th></tr>${renderRows(phaseRows)}<tr class="trade-ledger-sweep-summary-section"><th colspan="2">Throughput</th></tr>${renderRows(throughputRows)}<tr class="trade-ledger-sweep-summary-section"><th colspan="2">Memory</th></tr>${renderRows(memoryRows)}<tr class="trade-ledger-sweep-summary-section"><th colspan="2">Verdicts / errors</th></tr><tr><th>Verdicts</th><td>${verdictText}</td></tr><tr><th>Errors</th><td>${summary.errors.count}${summary.errors.omitted > 0 ? ` (${summary.errors.omitted} omitted)` : ""}</td></tr></tbody></table><table><thead><tr class="trade-ledger-sweep-summary-section"><th colspan="4">Top slowest rules by controls</th></tr><tr><th>Name</th><th>Candidates</th><th>Kept</th><th>Controls</th></tr></thead><tbody>${topRules}</tbody></table><div class="trade-ledger-sweep-diagnostics-summary-note">Optimization target: ${escapeHtml(summary.optimizationTarget.file)} · ${escapeHtml(summary.optimizationTarget.symbol)} · ${escapeHtml(summary.optimizationTarget.constraint)}</div>`;
    }

    private renderResults(): void {
        const dom = this.getDom();
        const results = sortTradeLedgerSweepResults(this.results);
        dom.tradeLedgerSweepResults.innerHTML = results.map((result) => `<div class="finder-result-row trade-ledger-sweep-result" data-rule-id="${escapeHtml(result.ruleId)}"><div class="finder-result-header"><span class="finder-result-name">${escapeHtml(result.ruleName)}</span><span class="finder-result-verdict">${escapeHtml(result.verdict)}</span></div><div class="finder-result-metrics">kept ${formatMetric(result.keptPct)}% · IS ${formatMetric(result.isMeanPnlDeltaPp)}pp · holdout ${formatMetric(result.holdoutMeanPnlDeltaPp)}pp · replay ${formatMetric(result.ruleReplayMs)}ms · controls ${formatMetric(result.controlReplayMs)}ms</div>${result.note ? `<div class="finder-result-note">${escapeHtml(result.note)}</div>` : ""}${result.error ? `<div class="finder-result-note">${escapeHtml(result.error)}</div>` : ""}</div>`).join("");
        dom.tradeLedgerSweepEmpty.hidden = results.length > 0;
    }

    private renderTerminal(run: LedgerSweepStatusRun | LedgerSweepTerminalView): void {
        const dom = this.getDom();
        this.results = [...run.results];
        this.summary = run.summary;
        this.diagnostics = run.diagnostics;
        this.renderDiagnosticsSummary(run.diagnostics);
        dom.tradeLedgerSweepOutput.textContent = `${run.outputDir}${run.error ? ` · ${run.error}` : ""}`;
        dom.tradeLedgerSweepProgress.hidden = false;
        dom.tradeLedgerSweepProgressFill.style.width = run.error ? `${dom.tradeLedgerSweepProgressFill.style.width || "0"}` : "100%";
        dom.tradeLedgerSweepDiagnostics.textContent = formatTradeLedgerSweepDiagnostics(run.diagnostics);
        dom.tradeLedgerSweepCopySummaryBtn.disabled = !this.summary;
        dom.tradeLedgerSweepCopyDiagnosticsBtn.disabled = false;
        this.renderResults();
    }

    private async startRun(): Promise<void> {
        if (this.running) return;
        const folder = this.selectedFolder();
        if (!folder || !folder.runnable) return;
        const runId = createTradeLedgerSweepRunId();
        this.activeServerRunId = runId;
        this.running = true;
        this.results = [];
        this.summary = null;
        this.diagnostics = null;
        this.diagnosticsTerminalPhase = "done";
        this.renderDiagnosticsSummary(null);
        persistActiveRun({ runId, startedAt: Date.now() });
        this.setBusy();
        this.renderResults();
        this.setStatus(`Starting ${folder.name}…`);
        try {
            const response = await fetch("/api/trade-ledger-sweep/run", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId, folderId: folder.folderId }) });
            if (!response.ok) {
                const detail = await response.text();
                if (this.activeServerRunId === runId) {
                    this.running = false;
                    this.activeServerRunId = null;
                    persistActiveRun(null);
                    this.setStatus(detail || `Sweep start failed: HTTP ${response.status}`);
                    this.setBusy();
                }
                return;
            }
            if (!response.body) throw new Error("Sweep start failed: response body is missing.");
            await consumeNdjsonStream<LedgerSweepStreamEvent>(response.body, {
                onStart: (event) => { if (!isTradeLedgerSweepRunCurrent(this.activeServerRunId, event.runId)) return; this.setStatus(`Running ${event.folderName}`); },
                onPhase: (event) => { if (isTradeLedgerSweepRunCurrent(this.activeServerRunId, event.runId)) this.renderProgress(event); },
                onProgress: (event) => { if (isTradeLedgerSweepRunCurrent(this.activeServerRunId, event.runId)) this.renderProgress(event); },
                onRuleResult: (event) => { if (!isTradeLedgerSweepRunCurrent(this.activeServerRunId, event.runId)) return; this.results = upsertTradeLedgerSweepResult(this.results, event.result); this.renderResults(); },
                onDiagnostics: (event) => { if (isTradeLedgerSweepRunCurrent(this.activeServerRunId, event.runId)) { this.getDom().tradeLedgerSweepDiagnostics.textContent = formatTradeLedgerSweepDiagnostics(event.entry); } },
                onDone: (event) => this.adoptTerminal(event),
                onCancelled: (event) => this.adoptTerminal(event),
                onFatal: (event) => this.adoptTerminal(event),
            }, { requireTerminal: true, terminalTypes: ["done", "cancelled", "fatal"] });
        } catch (error) {
            if (this.activeServerRunId === runId) {
                this.setStatus(`Stream interrupted; reattaching (${error instanceof Error ? error.message : String(error)})`);
                await this.reattach(runId);
            }
        }
    }

    private adoptTerminal(event: LedgerSweepTerminalEvent): void {
        if (this.activeServerRunId !== event.runId) return;
        this.diagnosticsTerminalPhase = event.type;
        this.renderTerminal(event);
        this.running = false;
        this.activeServerRunId = null;
        persistActiveRun(null);
        this.setStatus(event.type === "done" ? "Done" : event.type === "cancelled" ? "Cancelled" : `Fatal: ${event.error}`);
        this.setBusy();
    }

    private async stopRun(): Promise<void> {
        const runId = this.activeServerRunId;
        if (!runId) return;
        try {
            await fetch("/api/trade-ledger-sweep/stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }) });
            if (this.activeServerRunId === runId) this.setStatus("Stop requested…");
        } catch (error) {
            if (this.activeServerRunId === runId) this.setStatus(`Stop failed: ${error instanceof Error ? error.message : String(error)}`);
        }
    }

    private async reattach(runId: string): Promise<void> {
        this.reattachBackoff.reset();
        while (this.activeServerRunId === runId) {
            try {
                const response = await fetch(`/api/trade-ledger-sweep/status?runId=${encodeURIComponent(runId)}`, { cache: "no-store" });
                if (!response.ok) throw new Error(`HTTP ${response.status}`);
                const payload = await response.json() as LedgerSweepStatusResponse;
                if (this.activeServerRunId !== runId) return;
                this.reattachBackoff.recordSuccess();
                if (payload.runMismatch) {
                    this.running = false;
                    this.activeServerRunId = null;
                    persistActiveRun(null);
                    this.setStatus("Sweep run is no longer retained by the server.");
                    this.setBusy();
                    return;
                }
                if (payload.run) {
                    this.results = [...payload.run.results];
                    this.diagnostics = payload.run.diagnostics;
                    this.renderResults();
                    this.renderDiagnosticsSummary(payload.run.diagnostics);
                    this.getDom().tradeLedgerSweepDiagnostics.textContent = formatTradeLedgerSweepDiagnostics(payload.run.diagnostics);
                    this.setStatus(`Reattached: ${payload.run.phase}`);
                    this.renderProgress({ type: "progress", runId, phase: payload.run.phase, percent: payload.run.percent, detail: payload.run.phase, completedRules: payload.run.completedRules, totalRules: payload.run.totalRules, currentRuleId: payload.run.currentRuleId, elapsedMs: payload.run.elapsedMs, controlCompleted: null, controlRuns: null, rulesPerHour: 0 });
                } else if (payload.lastRun) {
                    const terminal: LedgerSweepTerminalEvent = payload.lastRun.phase === "done"
                        ? { type: "done", runId, ok: true, cancelled: false, finishedAt: payload.lastRun.finishedAt ?? Date.now(), summary: payload.lastRun.summary ?? "", results: payload.lastRun.results, diagnostics: payload.lastRun.diagnostics, outputDir: payload.lastRun.outputDir }
                        : payload.lastRun.phase === "cancelled"
                            ? { type: "cancelled", runId, ok: false, cancelled: true, finishedAt: payload.lastRun.finishedAt ?? Date.now(), summary: payload.lastRun.summary ?? "", results: payload.lastRun.results, diagnostics: payload.lastRun.diagnostics, outputDir: payload.lastRun.outputDir }
                            : { type: "fatal", runId, ok: false, cancelled: false, finishedAt: payload.lastRun.finishedAt ?? Date.now(), error: payload.lastRun.error ?? "Ledger Sweep failed.", summary: payload.lastRun.summary, results: payload.lastRun.results, diagnostics: payload.lastRun.diagnostics, outputDir: payload.lastRun.outputDir };
                    this.adoptTerminal(terminal);
                    return;
                }
            } catch (error) {
                const failure = this.reattachBackoff.recordFailure();
                if (failure.gaveUp || this.activeServerRunId !== runId) {
                    this.setStatus("Reattach gave up; start a new sweep.");
                    this.running = false;
                    this.activeServerRunId = null;
                    persistActiveRun(null);
                    this.setBusy();
                    return;
                }
                this.setStatus(`Reattaching (${failure.consecutive}/${failure.max})…`);
                await this.delay(failure.backoffDelayMs);
                continue;
            }
            await this.delay(2_000);
        }
    }

    private delay(ms: number): Promise<void> {
        if (this.reattachTimer) clearTimeout(this.reattachTimer);
        return new Promise((resolve) => { this.reattachTimer = setTimeout(() => { this.reattachTimer = null; resolve(); }, ms); });
    }

    private async copySummary(): Promise<void> {
        if (this.summary) await copyToClipboard(this.summary);
    }

    private async copyDiagnostics(): Promise<void> {
        if (this.diagnostics !== null) {
            const summary = buildTradeLedgerSweepDiagnosticsSummary(this.diagnostics, this.diagnosticsTerminalPhase);
            await copyToClipboard(formatTradeLedgerSweepDiagnosticsSummary(summary));
        }
    }
}

export const tradeLedgerSweepService = new TradeLedgerSweepService();
