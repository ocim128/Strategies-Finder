import { backtestService } from "../../backtest-service";
import { shouldUseRustEngine } from "../../engine-preferences";
import { paramManager } from "../../param-manager";
import { state } from "../../state";
import { strategyRegistry } from "../../../strategyRegistry";
import { ensureBuiltInStrategyLoaded } from "../../strategies/built-in-catalog";
import { copyToClipboard } from "../../browser-transfer";
import { ServerRunPollLoop } from "../../server-run-poll-loop";
import { postBatchNdjson } from "../batch-ndjson-post";
import { requestBatchControl } from "./batch-control-request";
import { parseScanAssets, scanBudget, validateScanOptions, type ScanRequest, type ScanResult, type ScanStatus, type ScanPreflightDiagnostics } from "../top-raw-scan-contract";
import { validateScanArm, scanArmLabel, type ScanArm } from "../top-raw-scan-arms";
import { escapeHtml } from "../../html-escape";
import type { BatchBacktestDom } from "../batch-backtest-dom";
import { readScanActive, readScanPreferences, readScanRequest, readScanResult, saveScanActive, saveScanPreferences, saveScanRequest, saveScanResult } from "./top-raw-scan-store";
import { renderScanResults } from "./top-raw-scan-results-view";

const API = "/api/batch-backtest/top-raw-scan/";
const terminal = (status: ScanStatus) => ["completed", "interrupted", "failed"].includes(status.phase);
export class TopRawScanController {
    private disposed = false;
    private busy = false;
    private activeId: string | null = null;
    private attempt: { cancelled: boolean; dispatched: boolean } | null = null;
    private result: ScanResult | null = null;
    private lastRequest: ScanRequest | null = null;
    private preflight: ScanPreflightDiagnostics | null = null;
    private preflightText = "";
    private readonly abort = new AbortController();
    private loop: ServerRunPollLoop<ScanStatus> | null = null;
    private cleanup: Array<() => void> = [];
    private legacy: HTMLElement[] = [];
    private legacyVisibility = new Map<HTMLElement, boolean>();
    private modeWasEnabled = false;
    constructor(private readonly getDom: () => BatchBacktestDom, private readonly isOtherBusy: () => boolean, private readonly changed: () => void) {}
    isBusy(): boolean { return this.busy; }
    enabled(): boolean { return this.getDom().batchBacktestFastTopRaw.checked; }
    initialize(): void {
        const dom = this.getDom(), prefs = readScanPreferences();
        dom.batchBacktestFastTopRaw.checked = prefs.enabled;
        dom.batchBacktestScanOpponents.value = String(prefs.opponentsPerAsset); dom.batchBacktestScanArm.value = prefs.arm; dom.batchBacktestScanFinalists.value = String(prefs.finalistCount); dom.batchBacktestScanSeed.value = String(prefs.seed);
        if (prefs.enabled && prefs.assetListText) dom.batchBacktestSymbols.value = prefs.assetListText;
        this.result = readScanResult(); this.lastRequest = readScanRequest();
        this.showPreflight(null);
        const listen = (element: EventTarget, event: string, handler: EventListener) => { element.addEventListener(event, handler); this.cleanup.push(() => element.removeEventListener(event, handler)); };
        const root = dom.batchbacktestTab;
        this.legacy = Array.from(root.querySelectorAll<HTMLElement>(".batch-balanced-generator-disclosure, .batch-execution-actions, .batch-run-state, .batch-main-results-section, .batch-analysis-section, .batch-coordinator-section > .batch-section-heading, .batch-coordinator-section > .batch-coordinator-actions, .batch-coordinator-section > .batch-details-controls, .batch-coordinator-section > .batch-miner-status, .batch-coordinator-section > .finder-list, .batch-coordinator-section > .batch-open-score-details, .batch-coordinator-section > .batch-diagnostic-pre"));
        this.legacy.push(...Array.from(root.querySelectorAll<HTMLElement>(".batch-coordinator-fields > .batch-field")).filter(field => !field.contains(dom.batchBacktestSp500TopMeanWorkers)));
        listen(dom.batchBacktestFastTopRaw, "change", () => {
            if (this.busy || this.isOtherBusy()) { dom.batchBacktestFastTopRaw.checked = this.modeWasEnabled; return; }
            this.syncUi(); this.refresh(); this.changed();
        });
        for (const input of [dom.batchBacktestScanOpponents, dom.batchBacktestScanArm, dom.batchBacktestScanFinalists, dom.batchBacktestScanSeed]) listen(input, "input", () => this.refresh());
        listen(dom.batchBacktestSymbols, "input", () => { if (!this.busy) { this.showPreflight(null); this.refresh(); } });
        listen(dom.batchBacktestScanRun, "click", () => { void this.run(false); });
        listen(dom.batchBacktestScanResume, "click", () => { void this.run(true); });
        listen(dom.batchBacktestScanStop, "click", () => { void this.stop(); });
        listen(dom.batchBacktestScanCopy, "click", () => { const value = this.result ?? this.preflight; if (value) void copyToClipboard(JSON.stringify(value, null, 2)).catch(error => this.message(String(error))); });
        listen(dom.batchBacktestScanDownload, "click", () => {
            const value = this.result ?? this.preflight; if (!value) return;
            const url = URL.createObjectURL(new Blob([JSON.stringify(value)], { type: "application/json" }));
            const link = document.createElement("a"); link.href = url; link.download = `${this.result ? "top_raw_scan" : "top_raw_sync_report"}_${value.runId}.json`; link.click(); URL.revokeObjectURL(url);
        });
        listen(dom.batchBacktestScanResults, "click", event => {
            const page = (event.target as HTMLElement).closest<HTMLElement>("[data-scan-page]")?.dataset.scanPage;
            if (page !== undefined && this.result) renderScanResults(dom.batchBacktestScanResults, this.result, Number(page));
        });
        this.syncUi(); this.refresh();
        if (this.result) renderScanResults(dom.batchBacktestScanResults, this.result);
        const active = readScanActive();
        if (active) { dom.batchBacktestFastTopRaw.checked = true; this.adopt(active); void this.poll(); }
    }
    private options(): ReturnType<typeof validateScanOptions> & { arm: ScanArm } {
        const dom = this.getDom();
        const parse = (text: string) => /^\d+$/.test(text.trim()) ? Number(text) : NaN;
        return { ...validateScanOptions({ opponentsPerAsset: parse(dom.batchBacktestScanOpponents.value), finalistCount: parse(dom.batchBacktestScanFinalists.value), seed: parse(dom.batchBacktestScanSeed.value) }), arm: validateScanArm(dom.batchBacktestScanArm.value) };
    }
    refresh(): void {
        if (this.disposed || this.busy) return;
        const dom = this.getDom();
        if (this.preflight && this.preflightText !== dom.batchBacktestSymbols.value) this.showPreflight(null);
        try {
            const options = this.options();
            saveScanPreferences({ ...options, enabled: this.enabled(), assetListText: dom.batchBacktestSymbols.value });
            if (this.enabled()) {
                const parsed = parseScanAssets(dom.batchBacktestSymbols.value), options = this.options(), budget = scanBudget(parsed.assets.length, options);
                dom.batchBacktestScanBudget.textContent = `${parsed.assets.length} assets (${parsed.duplicateCount} duplicates); ranking by ${scanArmLabel(options.arm)}; effective opponents ${budget.effective.opponentsPerAsset}, finalists ${budget.effective.finalistCount}; ${budget.discovery.toLocaleString()} discovery pairs, at most ${budget.upper.toLocaleString()} unique pairs. Assets without sufficient local data are excluded; at least two must share the evaluation candle.`;
            }
        } catch (error) {
            saveScanPreferences({ ...readScanPreferences(), enabled: this.enabled(), assetListText: dom.batchBacktestSymbols.value });
            dom.batchBacktestScanBudget.textContent = error instanceof Error ? error.message : String(error);
        }
    }
    syncUi(): void {
        if (this.disposed) return;
        const dom = this.getDom(), enabled = this.enabled(), busy = this.busy || this.isOtherBusy();
        dom.batchBacktestFastTopRaw.disabled = busy;
        dom.batchBacktestScanPanel.hidden = !enabled;
        for (const element of this.legacy) {
            if (enabled && !this.legacyVisibility.has(element)) this.legacyVisibility.set(element, element.hidden);
            if (enabled) element.hidden = true;
            else if (this.legacyVisibility.has(element)) { element.hidden = this.legacyVisibility.get(element)!; this.legacyVisibility.delete(element); }
        }
        const label = dom.batchbacktestTab.querySelector('label[for="batchBacktestSymbols"]'); if (label) label.textContent = enabled ? "Assets" : "Pairs";
        const help = dom.batchbacktestTab.querySelector('[aria-label="Batch markets"] .batch-section-note');
        if (help) help.textContent = enabled ? "One marked stock per line. Nasdaq and S&P500 templates use this same asset universe." : "One pair per line, or comma / whitespace separated.";
        dom.batchBacktestSymbols.placeholder = enabled ? "AAPL•\nMSFT•\nNVDA•\nAMD•" : "BTCUSDT\nZEC+APT\nPAXGUSDT\nTSLAUSDT";
        dom.batchBacktestScanRun.disabled = busy;
        dom.batchBacktestScanResume.disabled = busy || !this.lastRequest || this.result?.status === "completed";
        dom.batchBacktestScanStop.disabled = !this.busy;
        for (const input of [dom.batchBacktestScanOpponents, dom.batchBacktestScanArm, dom.batchBacktestScanFinalists, dom.batchBacktestScanSeed]) input.disabled = busy;
        if (enabled) dom.batchBacktestSp500TopMeanWorkers.disabled = busy;
        dom.batchBacktestScanCopy.disabled = busy || !(this.result ?? this.preflight); dom.batchBacktestScanDownload.disabled = busy || !(this.result ?? this.preflight);
        dom.batchBacktestScanCopy.textContent = this.preflight && !this.result ? "Copy sync report" : "Copy Result";
        dom.batchBacktestScanDownload.textContent = this.preflight && !this.result ? "Download sync report" : "Download Result";
        if (enabled) { dom.batchBacktestRunBtn.disabled = true; dom.batchBacktestBalancedGenerateBtn.disabled = true; }
        else if (this.modeWasEnabled) { dom.batchBacktestRunBtn.disabled = busy; dom.batchBacktestBalancedGenerateBtn.disabled = busy; dom.batchBacktestSp500TopMeanWorkers.disabled = busy; }
        this.modeWasEnabled = enabled;
    }
    private message(text: string): void { if (!this.disposed) this.getDom().batchBacktestScanProgress.textContent = text; }
    private showPreflight(diagnostics: ScanPreflightDiagnostics | null): void {
        this.preflight = diagnostics?.schema === "top_raw_scan.preflight.v1" ? diagnostics : null;
        const dom = this.getDom(), report = this.preflight;
        this.preflightText = report ? dom.batchBacktestSymbols.value : "";
        dom.batchBacktestScanPreflight.hidden = !report;
        if (!report) { dom.batchBacktestScanPreflight.innerHTML = ""; this.syncUi(); return; }
        const date = (time: number | null) => time === null ? "Unavailable" : new Date(time * 1000).toISOString();
        const rows = report.assetsToSync.map(row => `${row.asset} | closed bars: ${row.closedBars ?? "unknown"} | first: ${date(row.firstTime)} | last: ${date(row.lastTime)}\n  ${row.reason ?? "Review source coverage."}`).join("\n");
        dom.batchBacktestScanPreflight.innerHTML = `<p><strong>All ${report.requestedAssetCount} requested assets are retained. No ranking was produced.</strong></p>
            <p>${report.usableAssetCount} have at least 200 closed ${escapeHtml(report.interval)} candles. ${report.assetsToSync.length} histories need review/sync.</p>
            <p>Reference candle: ${escapeHtml(date(report.referenceAsOf))}. This is a comparison date for the sync report, not a completed score snapshot.</p>
            <p>Check the ${escapeHtml(report.sourceInterval)} source history in IBKR Data. Sync stale files; download a longer period for short or missing history. Then run the full asset list again.</p>
            <details open><summary>Histories needing sync (${report.assetsToSync.length})</summary><pre class="batch-scan-sync-report">${escapeHtml(rows)}</pre></details>`;
        this.syncUi();
    }
    private adopt(runId: string): void {
        this.showPreflight(null);
        if (this.result?.runId !== runId) { this.result = null; saveScanResult(null); this.getDom().batchBacktestScanResults.replaceChildren(); }
        this.activeId = runId; this.busy = true; saveScanActive(runId); this.changed(); this.syncUi();
    }
    private release(): void { this.activeId = null; this.busy = false; saveScanActive(null); this.changed(); this.syncUi(); }
    private accept(status: ScanStatus): void {
        if (this.disposed || status.runId !== this.activeId) return;
        this.message(`${status.phase}: ${status.completed} / ${status.total} · ${status.message}`);
        if (status.preflight) this.showPreflight(status.preflight);
        if (status.result) {
            this.result = status.result;
            if (terminal(status)) saveScanResult(this.result);
            if (terminal(status) || status.phase === "preflight") renderScanResults(this.getDom().batchBacktestScanResults, this.result);
        }
        if (terminal(status)) this.release();
    }
    async run(resume = false): Promise<void> {
        if (this.disposed || this.busy || this.isOtherBusy() || !this.enabled()) return;
        this.busy = true; this.changed(); this.syncUi();
        const attempt: { cancelled: boolean; dispatched: boolean } = { cancelled: false, dispatched: false };
        this.attempt = attempt;
        let rejected = false;
        try {
            const dom = this.getDom(); let request: ScanRequest;
            if (resume) {
                if (!this.lastRequest) throw new Error("No saved scan request.");
                request = { ...this.lastRequest, resume: true };
                // Resume uses the saved configuration, universe and seed exactly.
                dom.batchBacktestSymbols.value = request.assetListText;
            } else {
                const options = this.options(); parseScanAssets(dom.batchBacktestSymbols.value);
                const strategyKey = state.currentStrategyKey; await ensureBuiltInStrategyLoaded(strategyKey);
                if (this.disposed || attempt.cancelled) return;
                const strategy = strategyRegistry.get(strategyKey); if (!strategy) throw new Error("Select a built-in strategy.");
                const rawWorkers = dom.batchBacktestSp500TopMeanWorkers.value.trim();
                if (rawWorkers && (!/^\d+$/.test(rawWorkers) || Number(rawWorkers) < 1 || Number(rawWorkers) > 32)) throw new Error("Workers must be an integer in 1..32.");
                request = { ...options, runId: `top_raw_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, strategyKey, strategyParams: paramManager.getValues(strategy), backtestSettings: backtestService.getBacktestSettings(), capitalSettings: backtestService.getCapitalSettings(), interval: state.currentInterval, assetListText: dom.batchBacktestSymbols.value, useRustEnginePreference: shouldUseRustEngine(), ...(rawWorkers ? { workerCount: Number(rawWorkers) } : {}) };
            }
            if (this.disposed || attempt.cancelled) return;
            this.lastRequest = request; saveScanRequest(request); this.adopt(request.runId);
            // No asynchronous gap between recording dispatch and starting admission.
            // Stop during admission uses this id even before the server owns it.
            attempt.dispatched = true;
            await postBatchNdjson({ endpoint: API + "run", body: request, signal: this.abort.signal,
                handlers: { onStatus: (event: ScanStatus) => this.accept(event), onDone: (event: ScanStatus) => this.accept(event) },
                onNonOkResponse: status => { rejected = status >= 400 && status < 500; },
            });
        } catch (error) {
            if (this.disposed) return;
            this.message(error instanceof Error ? error.message : String(error));
            if (this.activeId && !rejected) { await this.poll(); return; }
            this.release();
        } finally {
            if (this.attempt === attempt) this.attempt = null;
            if (!this.disposed && !this.activeId) { this.busy = false; this.changed(); this.syncUi(); }
        }
    }
    private async poll(): Promise<void> {
        const runId = this.activeId; if (!runId || this.loop || this.disposed) return;
        this.loop = new ServerRunPollLoop<ScanStatus>({
            signal: this.abort.signal, isOwned: () => !this.disposed && this.activeId === runId,
            fetchStatus: signal => requestBatchControl(API + `status?runId=${encodeURIComponent(runId)}`, {}, async response => {
                if (response.status === 404) return { kind: "not_found" as const };
                if (!response.ok) throw new Error(`Status HTTP ${response.status}`);
                const snapshot = await response.json() as ScanStatus;
                return snapshot.runId === runId ? { kind: "snapshot" as const, snapshot } : { kind: "rejected" as const };
            }, { signal }),
            isTerminal: terminal, nextRequestDelayMs: () => 2000, connectionLostRetryMs: 30000,
            onProgress: status => { if (!terminal(status)) this.accept(status); },
            onTransientFailure: () => this.message("Connection interrupted; retrying scan status. Stop remains available."),
        });
        try {
            const outcome = await this.loop.run();
            if (this.disposed) return;
            if (outcome.kind === "terminal") this.accept(outcome.snapshot);
            else if (outcome.kind === "not_found" || outcome.kind === "rejected") { this.message("Saved scan is unavailable on this server."); this.release(); }
        } finally { this.loop = null; }
    }
    async stop(): Promise<void> {
        if (this.disposed) return;
        if (this.attempt) {
            this.attempt.cancelled = true;
            if (!this.attempt.dispatched) { this.message("Scan cancelled before submission."); return; }
        }
        const runId = this.activeId; if (!runId || this.disposed) return;
        this.message("Stopping scan; waiting for workers and persistence.");
        try {
            await requestBatchControl(API + "stop", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runId }) }, async response => { if (!response.ok) throw new Error(`Stop HTTP ${response.status}`); await response.json(); }, { signal: this.abort.signal });
        } catch (error) { this.message(`Stop failed: ${String(error)}. Retry Stop.`); }
    }
    dispose(): void { this.disposed = true; this.abort.abort(); this.loop?.abort(); for (const cleanup of this.cleanup.splice(0)) cleanup(); }
}
