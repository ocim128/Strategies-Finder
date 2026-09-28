/**
 * Batch Backtest UI service.
 *
 * Lazy-initialized like the other strategy panel services. Binds the tab's
 * buttons, reads the CURRENT
 * strategy / params / backtest / capital settings once per run, and replays
 * them across every pair in the user's list through the pure runner.
 *
 * Visual output mirrors Finder's universe symbol rows (same verdict labels
 * and metric order) so a Batch run reads the same as a Finder universe run.
 */

import { ensureBuiltInStrategyLoaded } from "../strategies/built-in-catalog";
import { state } from "../state";
import { strategyRegistry } from "../../strategyRegistry";
import { setVisible } from "../dom-utils";
import { ensureLazyStylesheet } from "../lazy-styles";
import { debugLogger } from "../debug-logger";
import { uiManager } from "../ui-manager";
import { copyToClipboard } from "../browser-transfer";
import { writePersistedJson } from "../persisted-json";
import { TRADE_LEDGER_DEFAULT_HORIZONS } from "./trade-ledger-schema";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { postBatchNdjson } from "./batch-ndjson-post";
import { parseTradeLedgerHorizons } from "./trade-ledger-wire";
import { parseBatchSymbols } from "./batch-run-contract";
import {
    BALANCED_PAIR_LIST_MAX_PAIRS,
    generateBalancedPairList,
    type BalancedPairListResult,
    type PairListProvenanceV1,
} from "./balanced-pair-list-generator";
import { fnv1a64Hex } from "./max-active-research-contract";
import { isActiveCapTiltWeight } from "./cap-tilt-contract";
// The template blob lives in the lazy-loaded batch feature chunk (via ?raw),
// so it never lands in the cold-start bundle.
import { getBatchSymbolTemplate, type BatchSymbolTemplateKey } from "./batch-symbol-templates";
import { isBatchResultSortKey } from "./batch-results-sort";
import type { BatchBenchmarkRunOutcome } from "./batch-benchmark-snapshot";
import type { LedgerSweepCatalogResponse } from "./trade-ledger-sweep-stream-types";
import type { OpenScoreUsdLatestSelections, OpenScoreUsdReplayResult } from "./batch-open-score-usd-replay-engine";
import type { OpenScoreUsdReplayStreamEvent } from "./batch-open-score-usd-replay-stream-types";
import type { StrategyParams, BacktestSettings } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";
import {
    BATCH_TRADE_LEDGER_DEFAULT_FOLDER,
    BATCH_TRADE_GATE_STORAGE,
    BATCH_TRADE_LEDGER_STORAGE,
    readPersistedTradeGateOptions,
    readPersistedTradeLedgerOptions,
    type BatchPersistedActiveServerRun,
    type BatchTradeGateOptions,
    type BatchTradeLedgerOptions,
} from "./browser/batch-browser-store";
import { TopMeanController } from "./browser/top-mean-controller";
import { BatchRunController } from "./browser/batch-run-controller";
import type { TopMeanResultSummary } from "./sp500-top-mean-coordinator-engine";
import {
    createBatchResultsView,
    type BatchResultsView,
} from "./browser/batch-results-view";
import { LATEST_ARM_SELECTOR_ID } from "./browser/top-mean-results-view";
import type { OpenScoreUsdEventDetailSelector } from "./batch-open-score-usd-replay-engine";

export { formatTopMeanCompletionMessage } from "./browser/top-mean-results-view";

type BatchStatusRowsPage = {
    rows?: BatchBacktestSymbolResult[];
    rowOffset?: number;
    nextOffset?: number | null;
};

function formatGatePercent(value: number | null): string {
    return value !== null && Number.isFinite(value) ? value.toFixed(2) : "--";
}

function formatGateBytes(bytes: number): string {
    if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

function formatGateSweepDate(modifiedAt: number): string {
    return Number.isFinite(modifiedAt) ? new Date(modifiedAt).toISOString().slice(0, 10) : "unknown date";
}

export class BatchBacktestService {
    private dom: BatchBacktestDom | null = null;
    private initialized = false;
    private lastOpenScoreUsdResult: OpenScoreUsdReplayResult | null = null;
    /**
     * Last successful Balanced Generator result. Used by Copy Generated so a
     * user can copy the displayed list without re-running the generator. The
     * pair list is NOT applied to the textarea on Copy; only Generate-and-Apply
     * writes the textarea (and dispatches the existing input invalidation).
     */
    private lastBalancedPairListResult: BalancedPairListResult | null = null;
    /**
     * Provenance of the pair list CURRENTLY applied to the textarea, retained
     * only while the textarea's content still matches `provenance.emittedPairListHash`.
     * Cleared by manual edits, Generate failure, or any other textarea mutation
     * that does not come from the generator's apply path.
     */
    private activePairListProvenance: PairListProvenanceV1 | null = null;
    // Batch run state (run token, results, fingerprints, server-run id,
    // benchmark, reattach loop) lives on the controller; the typed accessors
    // below keep the facade wiring and regression-suite surface intact.
    private get lastResults(): BatchBacktestSymbolResult[] {
        return this.batchRun.getLastResults();
    }
    private set lastResults(results: BatchBacktestSymbolResult[]) {
        this.batchRun.setLastResults(results);
    }
    private get lastRunFingerprint(): string | null {
        return this.batchRun.getLastRunFingerprint();
    }
    private set lastRunFingerprint(fingerprint: string | null) {
        this.batchRun.setLastRunFingerprint(fingerprint);
    }
    private get serverHasArtifacts(): boolean {
        return this.batchRun.getServerHasArtifacts();
    }
    private set serverHasArtifacts(value: boolean) {
        this.batchRun.setServerHasArtifacts(value);
    }
    public get activeServerRunId(): string | null {
        return this.batchRun.getActiveServerRunId();
    }
    public set activeServerRunId(runId: string | null) {
        this.batchRun.setActiveServerRunId(runId);
    }
    public get runInFlight(): boolean {
        return this.batchRun.getRunInFlight();
    }
    private get lastRunInterval(): string | null {
        return this.batchRun.getLastRunInterval();
    }
    private set lastRunInterval(interval: string | null) {
        this.batchRun.setLastRunInterval(interval);
    }
    public set runInFlight(value: boolean) {
        this.batchRun.setRunInFlight(value);
    }
    /**
     * Shared UI single-flight lock for TOP_MEAN / stability (and any other
     * Batch action that awaits before claiming ownership). Complements
     * `runInFlight` so rapid clicks cannot stack overlapping POSTs or replace
     * the active run id while another action is mid-preflight.
     */
    private batchActionInFlight = false;
    // Serializes OPEN_SCORE USD Replay (and any future server-side analysis).
    private analysisInFlight = false;
    // Set when Stop races analysis preflight or POST establishment.
    private analysisCancelRequested = false;
    // /stop is not operation-scoped, so new work must wait for every request.
    private pendingStopPromise: Promise<void> | null = null;
    private tradeGateCatalog: LedgerSweepCatalogResponse | null = null;
    private persistedTradeGateOptions = readPersistedTradeGateOptions();
    // Results presentation (rows, sort header, summary/progress, live render
    // queue). The view owns the queue and frame scheduling; run-token
    // authorization stays here via the isRunTokenCurrent check below.
    private readonly resultsView: BatchResultsView = createBatchResultsView({
        isRunTokenCurrent: (token: number) => token === this.batchRun.currentRunToken(),
    });
    // Batch run workflow owner (browser/batch-run-controller.ts). Created
    // closed over this facade; the injected callbacks keep cross-workflow
    // coordination (busy gate, balanced lock, trade gate, pending Stop)
    // owned by the facade.
    private readonly batchRun: BatchRunController = new BatchRunController({
        getDom: () => this.getDom(),
        resultsView: this.resultsView,
        isUiBusy: () => this.isBatchUiBusy(),
        balancedLock: () => this.balancedGeneratorLockState(),
        resolveTradeGate: (dom) => this.resolveTradeGateForRun(dom),
        readTradeLedgerOptions: (dom) => this.readTradeLedgerOptions(dom),
        getPairListProvenance: () => this.activePairListProvenance,
        requestServerStop: () => this.requestServerStop(),
    });


    // Audit Finding 2: typed (was `any`) so a shape drift between the
    // coordinator engine emissions and the UI renderers is a compile failure.
    // TOP_MEAN lifecycle state lives on the controller; these typed accessors
    // keep the facade's own wiring (and the facade-visible surface) working.
    public get latestTopMeanResult(): TopMeanResultSummary | null {
        return this.topMean.getLatestTopMeanResult();
    }
    public set latestTopMeanResult(result: TopMeanResultSummary | null) {
        this.topMean.setLatestTopMeanResult(result);
    }
    public get activeTopMeanRunId(): string | null {
        return this.topMean.getActiveTopMeanRunId();
    }
    public set activeTopMeanRunId(runId: string | null) {
        this.topMean.setActiveTopMeanRunId(runId);
    }
    public get topMeanDiagnosticEntries() {
        return this.topMean.getDiagnosticEntries();
    }
    public get topMeanDiagnosticRunId(): string | null {
        return this.topMean.getDiagnosticRunId();
    }
    public set topMeanDiagnosticRunId(runId: string | null) {
        this.topMean.setDiagnosticRunId(runId);
    }
    // TOP_MEAN workflow owner: run/stop/reattach lifecycle, diagnostic ring,
    // result/copy/download actions. Created lazily-closed over this facade;
    // see browser/top-mean-controller.ts.
    private readonly topMean = new TopMeanController({
        getDom: () => this.getDom(),
        peekDom: () => this.dom,
    });

    private writeTopMeanDiagnosticLogNow(): void {
        this.topMean.writeTopMeanDiagnosticLogNow();
    }

    private getDom(): BatchBacktestDom {
        return this.dom ??= createBatchBacktestDom();
    }

    public init(): void {
        ensureLazyStylesheet("batch-backtest-styles", new URL("../../styles/batch-backtest.css", import.meta.url).href);
        if (this.initialized) {
            return;
        }
        const dom = this.getDom();
        this.bindEvents(dom);
        this.batchRun.refreshSortHeader(dom);
        this.restoreTradeLedgerOptions(dom);
        this.restoreTradeGateOptions(dom);
        this.resetProgress(dom);
        this.loadPersistedLatestResults(dom);
        this.loadPersistedLatestTopMeanResult(dom);
        this.restorePersistedTopMeanDiagnostics();
        // Flush the durable diagnostic log when the page goes away (reload,
        // navigation, tab close) — the trailing debounce would otherwise lose
        // the last window of entries.
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            window.addEventListener("pagehide", () => this.writeTopMeanDiagnosticLogNow());
        }
        this.activeServerRunId = this.loadPersistedActiveServerRun()?.runId ?? null;
        this.batchRun.setServerRunActive(this.activeServerRunId !== null);
        this.updateSummary(dom);
        this.initialized = true;
        void this.refreshTradeGateCatalog();
        // Reattach to a server-side run that started before page load.
        void this.reattachToInProgressServerRun();
        void this.reattachToInProgressTopMeanRun();
    }

    private bindEvents(dom: BatchBacktestDom): void {
        dom.batchBacktestResultsHeader.addEventListener("click", (event) => {
            if (!(event.target instanceof Element)) return;
            const button = event.target.closest<HTMLButtonElement>("button[data-batch-sort-key]");
            if (!button || !dom.batchBacktestResultsHeader.contains(button)) return;
            const rawKey = button.dataset.batchSortKey;
            if (rawKey === "reset") {
                this.batchRun.resetSort(dom);
            } else if (rawKey && isBatchResultSortKey(rawKey)) {
                this.batchRun.toggleBatchResultSort(dom, rawKey);
            }
        });
        dom.batchBacktestRunBtn.addEventListener("click", () => {
            void this.batchRun.runBatch();
        });
        dom.batchBacktestStopBtn.addEventListener("click", () => {
            // The same button also stops normal Batch runs and analysis.
            this.batchRun.requestLocalCancel();
            if (this.analysisInFlight) {
                this.analysisCancelRequested = true;
            }
            this.requestServerStop();
        });
        dom.batchBacktestCopyBtn.addEventListener("click", () => {
            void this.copyResults();
        });
        dom.batchBacktestCopyBenchmarkBtn.addEventListener("click", () => {
            void this.copyBenchmarkPerformance();
        });
        dom.batchBacktestOpenScoreUsdBtn.addEventListener("click", () => {
            void this.runOpenScoreUsdReplay();
        });
        dom.batchBacktestCopyOpenScoreUsdBtn.addEventListener("click", () => {
            void this.copyOpenScoreUsdResults();
        });
        dom.batchBacktestSp500TopMeanRunBtn.addEventListener("click", () => {
            void this.runSp500TopMeanCoordinator();
        });
        dom.batchBacktestSp500TopMeanStopBtn.addEventListener("click", () => {
            void this.stopSp500TopMeanCoordinator();
        });
        dom.batchBacktestSp500TopMeanCopyBtn.addEventListener("click", () => {
            void this.copySp500TopMeanResults();
        });
        dom.batchBacktestSp500TopMeanCopyOpenScoreBtn.addEventListener("click", () => {
            void this.copySp500TopMeanOpenScoreResults();
        });
        dom.batchBacktestSp500TopMeanDetailsBtn.addEventListener("click", () => {
            this.toggleSp500TopMeanOpenScoreDetails();
        });
        dom.batchBacktestSp500TopMeanDetailsSelector.addEventListener("change", () => {
            if (
                this.latestTopMeanResult
                && !dom.batchBacktestSp500TopMeanDetails.hidden
            ) {
                dom.batchBacktestSp500TopMeanDetails.innerHTML =
                    this.renderTopMeanOpenScoreEventDetails(
                        this.latestTopMeanResult,
                        this.getTopMeanOpenScoreDetailSelector(dom),
                        this.getTopMeanOpenScoreDetailYear(dom),
                    );
            }
        });
        dom.batchBacktestSp500TopMeanDetailsYear.addEventListener("change", () => {
            if (
                this.latestTopMeanResult
                && !dom.batchBacktestSp500TopMeanDetails.hidden
            ) {
                dom.batchBacktestSp500TopMeanDetails.innerHTML =
                    this.renderTopMeanOpenScoreEventDetails(
                        this.latestTopMeanResult,
                        this.getTopMeanOpenScoreDetailSelector(dom),
                        this.getTopMeanOpenScoreDetailYear(dom),
                    );
            }
        });
        // The arm picker is generated inside the Latest OPEN_SCORE card and
        // re-created on every render, so its change events are delegated to
        // the persistent results container.
        dom.batchBacktestSp500TopMeanResults.addEventListener("change", (event) => {
            const target = event?.target as { id?: string; value?: string } | null | undefined;
            if (!target || target.id !== LATEST_ARM_SELECTOR_ID) return;
            this.topMean.setLatestArm(target.value);
            if (this.latestTopMeanResult) {
                this.renderTopMeanResults(dom, this.latestTopMeanResult);
            }
        });
        dom.batchBacktestSp500TopMeanDownloadBtn.addEventListener("click", () => {
            void this.downloadSp500TopMeanResults();
        });
        dom.batchBacktestSp500TopMeanCopyDiagnosticBtn.addEventListener("click", () => {
            void this.copySp500TopMeanDiagnostic();
        });
        dom.batchBacktestSymbolTemplate.addEventListener("change", () => {
            const key = dom.batchBacktestSymbolTemplate.value as BatchSymbolTemplateKey;
            if (!key) return;
            const template = getBatchSymbolTemplate(key);
            if (!template) return;
            dom.batchBacktestSymbols.value = template;
            dom.batchBacktestSymbolTemplate.value = "";
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
        dom.batchBacktestUseCurrent.addEventListener("click", () => {
            const current = state.currentSymbol?.trim().toUpperCase();
            if (current) {
                dom.batchBacktestSymbols.value = dom.batchBacktestSymbols.value.trim();
                dom.batchBacktestSymbols.value = dom.batchBacktestSymbols.value
                    ? `${dom.batchBacktestSymbols.value}\n${current}`
                    : current;
            }
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
        dom.batchBacktestClear.addEventListener("click", () => {
            dom.batchBacktestSymbols.value = "";
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
        dom.batchBacktestSymbols.addEventListener("input", () => {
            // Fast path: when there is nothing derived from a prior run/cache
            // to invalidate (no fingerprint, no live results, no OPEN_SCORE USD
            // result, no active server run, no provenance to recheck), the
            // input event only needs the pair-count summary text. Skipping the
            // heavy path here avoids two `parseBatchSymbols` passes + a
            // `localStorage.removeItem` per keystroke while editing/pasting
            // large pair lists.
            const hasDerivedState = this.lastRunFingerprint !== null
                || this.lastResults.length > 0
                || this.lastOpenScoreUsdResult !== null
                || this.activeServerRunId !== null
                || this.activePairListProvenance !== null;
            if (hasDerivedState) {
                this.clearStaleResults(dom);
                this.clearActivePairListProvenanceIfStale(dom);
            }
            this.updateSummary(dom);
        });
        dom.batchBacktestBalancedGenerateBtn.addEventListener("click", () => {
            void this.generateAndApplyBalancedPairList();
        });
        dom.batchBacktestBalancedCopyBtn.addEventListener("click", () => {
            void this.copyBalancedPairList();
        });
        dom.batchBacktestTradeLedgerToggle.addEventListener("change", () => {
            this.persistTradeLedgerOptions(dom);
        });
        dom.batchBacktestTradeLedgerFolder.addEventListener("change", () => {
            this.persistTradeLedgerOptions(dom);
        });
        dom.batchBacktestTradeLedgerHorizons.addEventListener("change", () => {
            this.persistTradeLedgerOptions(dom);
        });
        dom.batchBacktestTradeGateToggle.addEventListener("change", () => {
            this.persistTradeGateOptions(dom);
            this.clearStaleResults(dom);
            this.updateSummary(dom);
            this.renderTradeGateSelection(dom);
        });
        dom.batchBacktestTradeGateFolder.addEventListener("change", () => {
            this.persistTradeGateOptions(dom);
            this.clearStaleResults(dom);
            this.renderTradeGateSelection(dom);
        });
        dom.batchBacktestTradeGateRules.addEventListener("change", () => {
            this.persistTradeGateOptions(dom);
            this.clearStaleResults(dom);
            this.renderTradeGateSelection(dom);
        });
    }

    /** Restore the persisted trade-ledger toggle + folder into the DOM. */
    private restoreTradeLedgerOptions(dom: BatchBacktestDom): void {
        const options = readPersistedTradeLedgerOptions();
        dom.batchBacktestTradeLedgerToggle.checked = options.enabled;
        if (options.folder) {
            dom.batchBacktestTradeLedgerFolder.value = options.folder;
        }
        dom.batchBacktestTradeLedgerHorizons.value = options.ledgerHorizons.join(",");
    }

    /** Read the trade-ledger options from the DOM (defaults applied). */
    private readTradeLedgerOptions(dom: BatchBacktestDom): BatchTradeLedgerOptions {
        const enabled = dom.batchBacktestTradeLedgerToggle.checked;
        return {
            enabled,
            folder: dom.batchBacktestTradeLedgerFolder.value.trim() || BATCH_TRADE_LEDGER_DEFAULT_FOLDER,
            ledgerHorizons: enabled
                ? parseTradeLedgerHorizons(dom.batchBacktestTradeLedgerHorizons.value)
                : [...TRADE_LEDGER_DEFAULT_HORIZONS],
        };
    }

    private persistTradeLedgerOptions(dom: BatchBacktestDom): void {
        try {
            writePersistedJson({
                ...BATCH_TRADE_LEDGER_STORAGE,
                data: this.readTradeLedgerOptions(dom),
                onError: (error) => debugLogger.warn("batch_backtest.trade_ledger_save_failed", {
                    error: error instanceof Error ? error.message : String(error),
                }),
            });
        } catch (error) {
            debugLogger.warn("batch_backtest.trade_ledger_save_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    private restoreTradeGateOptions(dom: BatchBacktestDom): void {
        dom.batchBacktestTradeGateToggle.checked = this.persistedTradeGateOptions.enabled;
    }

    private readTradeGateOptions(dom: BatchBacktestDom): BatchTradeGateOptions {
        return {
            enabled: dom.batchBacktestTradeGateToggle.checked,
            folderId: dom.batchBacktestTradeGateFolder.value.trim(),
            ruleIds: Array.from(dom.batchBacktestTradeGateRules.selectedOptions).map((option) => option.value),
        };
    }

    private persistTradeGateOptions(dom: BatchBacktestDom): void {
        this.persistedTradeGateOptions = this.readTradeGateOptions(dom);
        writePersistedJson({
            ...BATCH_TRADE_GATE_STORAGE,
            data: this.persistedTradeGateOptions,
            onError: (error) => debugLogger.warn("batch_backtest.trade_gate_save_failed", {
                error: error instanceof Error ? error.message : String(error),
            }),
        });
    }

    private async refreshTradeGateCatalog(): Promise<boolean> {
        try {
            const response = await fetch("/api/trade-ledger-sweep/catalog");
            if (!response.ok) throw new Error(`catalog request failed (${response.status})`);
            const payload = await response.json() as LedgerSweepCatalogResponse;
            if (payload.ok !== true) throw new Error("catalog response was not successful");
            this.tradeGateCatalog = payload;
            const dom = this.dom;
            if (dom) {
                const eligibleFolders = payload.folders.filter((folder) => folder.runnable && folder.latestSweep !== null);
                dom.batchBacktestTradeGateFolder.replaceChildren(...eligibleFolders.map((folder) => {
                    const option = document.createElement("option");
                    option.value = folder.folderId;
                    option.textContent = `${folder.name} · ${formatGateBytes(folder.ledgerBytes)} · sweep ${formatGateSweepDate(folder.latestSweep?.modifiedAt ?? Number.NaN)} · ${folder.latestSweep?.edgeRules.length ?? 0} EDGE rules`;
                    return option;
                }));
                if (eligibleFolders.some((folder) => folder.folderId === this.persistedTradeGateOptions.folderId)) {
                    dom.batchBacktestTradeGateFolder.value = this.persistedTradeGateOptions.folderId;
                } else if (eligibleFolders[0]) {
                    dom.batchBacktestTradeGateFolder.value = eligibleFolders[0].folderId;
                }
                this.renderTradeGateSelection(dom);
            }
            return true;
        } catch (error) {
            this.tradeGateCatalog = null;
            if (this.dom) {
                this.getDom().batchBacktestTradeGateWarning.textContent = "Trade Gate is server-side only; the local sweep catalog is unavailable.";
            }
            debugLogger.warn("batch_backtest.trade_gate_catalog_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return false;
        }
    }

    private renderTradeGateSelection(dom: BatchBacktestDom): void {
        const folder = this.tradeGateCatalog?.folders.find((entry) => entry.folderId === dom.batchBacktestTradeGateFolder.value) ?? null;
        const edgeRules = [...(folder?.latestSweep?.edgeRules ?? [])].sort((a, b) =>
            (b.holdoutMeanPnlDeltaPp ?? Number.NEGATIVE_INFINITY) - (a.holdoutMeanPnlDeltaPp ?? Number.NEGATIVE_INFINITY)
            || a.ruleId.localeCompare(b.ruleId));
        const selectedRuleIds = new Set(this.persistedTradeGateOptions.ruleIds);
        dom.batchBacktestTradeGateRules.replaceChildren(...edgeRules.map((rule) => {
            const option = document.createElement("option");
            option.value = rule.ruleId;
            option.textContent = `${rule.ruleName} · kept ${formatGatePercent(rule.keptPct)}% · IS ${formatGatePercent(rule.isMeanPnlDeltaPp)}pp · holdout ${formatGatePercent(rule.holdoutMeanPnlDeltaPp)}pp`;
            option.selected = selectedRuleIds.has(rule.ruleId);
            return option;
        }));
        const selected = Array.from(dom.batchBacktestTradeGateRules.selectedOptions);
        if (!dom.batchBacktestTradeGateToggle.checked) {
            dom.batchBacktestTradeGateEstimate.textContent = "Trade Gate off. Batch results use the ordinary engine path.";
            dom.batchBacktestTradeGateWarning.textContent = "";
            return;
        }
        if (!folder || edgeRules.length === 0) {
            dom.batchBacktestTradeGateEstimate.textContent = "No completed sweep with EDGE-CANDIDATE rules is available.";
            dom.batchBacktestTradeGateWarning.textContent = "Enable the gate only after selecting a current local sweep folder and rule.";
            return;
        }
        const selectedRules = edgeRules.filter((rule) => selected.some((option) => option.value === rule.ruleId));
        if (selectedRules.length === 0) {
            dom.batchBacktestTradeGateEstimate.textContent = "Select at least one EDGE-CANDIDATE rule.";
            dom.batchBacktestTradeGateWarning.textContent = "The estimate is based on sweep kept rates and is not a measured admission rate.";
            return;
        }
        const estimatedAdmission = 100 * (1 - selectedRules.reduce(
            (product, rule) => product * (1 - Math.max(0, Math.min(100, rule.keptPct ?? 0)) / 100),
            1,
        ));
        const estimatedRejection = Math.max(0, 100 - estimatedAdmission);
        dom.batchBacktestTradeGateEstimate.textContent = `Rule rejects ~${estimatedRejection.toFixed(1)}% of signals (from sweep) · ${selectedRules.length} rule${selectedRules.length === 1 ? "" : "s"} selected.`;
        dom.batchBacktestTradeGateWarning.textContent = selectedRules.length > 1
            ? "OR semantics: a signal is admitted if any selected rule passes. Overlapping rules can stack admissions; this is not diversification."
            : "Server-side only. The run performs a causal feature pre-pass and records gate counters.";
    }

    private validateTradeGateSelection(dom: BatchBacktestDom): BatchTradeGateOptions | null {
        const options = this.readTradeGateOptions(dom);
        if (!options.enabled) return options;
        const folder = this.tradeGateCatalog?.folders.find((entry) => entry.folderId === options.folderId);
        const edgeRuleIds = new Set(folder?.latestSweep?.edgeRules.map((rule) => rule.ruleId) ?? []);
        if (!folder || options.ruleIds.length === 0 || options.ruleIds.some((ruleId) => !edgeRuleIds.has(ruleId))) {
            dom.batchBacktestStatus.textContent = "Trade Gate is server-side only; select a current sweep folder and at least one EDGE-CANDIDATE rule.";
            return null;
        }
        return options;
    }

    /**
     * Synchronous shared busy gate for Batch UI actions. Fires before the first
     * await so rapid clicks cannot stack normal Batch, TOP_MEAN, stability,
     * analysis, Stop transitions, or reattach polling.
     */
    private isBatchUiBusy(): boolean {
        return (
            this.batchActionInFlight
            || this.runInFlight
            || this.analysisInFlight
            || this.batchRun.isBusy()
            || this.pendingStopPromise !== null
            || this.topMean.isUiOwned()
        );
    }

    /** Balanced-generator lock inputs, computed from shared facade state. */
    private balancedGeneratorLockState(): { blocked: boolean; hasResult: boolean } {
        return {
            blocked: this.runInFlight || this.analysisInFlight
                || this.pendingStopPromise !== null || this.batchRun.isServerRunActive(),
            hasResult: this.lastBalancedPairListResult !== null,
        };
    }

    public async runBatch(): Promise<void> {
        await this.batchRun.runBatch();
    }

    public async runBatchServer(
        dom: BatchBacktestDom,
        token: number,
        symbols: string[],
        strategyKey: string,
        strategyParams: StrategyParams,
        backtestSettings: BacktestSettings,
        capitalSettings: CapitalSettings,
        interval: string,
        runFingerprint: string,
        tradeGateOptions: BatchTradeGateOptions,
        onTerminal: (outcome: BatchBenchmarkRunOutcome) => void,
    ): Promise<void> {
        await this.batchRun.runBatchServer(dom, token, symbols, strategyKey, strategyParams, backtestSettings, capitalSettings, interval, runFingerprint, tradeGateOptions, onTerminal);
    }

    public async drainStatusRows(
        dom: BatchBacktestDom,
        initial: BatchStatusRowsPage,
        scopeRunId: string | undefined,
        pageKey: "run" | "lastRun",
        options: {
            limit: number;
            maxRows: number;
            stopWhenPollingStopped?: boolean;
        },
    ): Promise<void> {
        await this.batchRun.drainStatusRows(dom, initial, scopeRunId, pageKey, options);
    }

    public reconcileStatusRows(
        dom: BatchBacktestDom,
        rows: readonly BatchBacktestSymbolResult[] | undefined,
        rowOffsetRaw: number | undefined,
        expectedRunId?: string,
    ): BatchBacktestSymbolResult[] {
        return this.batchRun.reconcileStatusRows(dom, rows, rowOffsetRaw, expectedRunId);
    }

    public async copyBenchmarkPerformance(): Promise<void> {
        await this.batchRun.copyBenchmarkPerformance();
    }

    public async copyResults(): Promise<void> {
        await this.batchRun.copyResults(this.lastOpenScoreUsdResult?.reportLines ?? []);
    }

    /**
     * Trade-gate preflight for a Batch run: validate the selection and, when
     * the gate is enabled but the catalog has not loaded, refresh once and
     * revalidate. Facade-owned because it spans the gate controls and the
     * run preflight.
     */
    private async resolveTradeGateForRun(dom: BatchBacktestDom): Promise<BatchTradeGateOptions | null> {
        let tradeGateOptions = this.validateTradeGateSelection(dom);
        if (dom.batchBacktestTradeGateToggle.checked && !this.tradeGateCatalog) {
            await this.refreshTradeGateCatalog();
            tradeGateOptions = this.validateTradeGateSelection(dom);
        }
        return tradeGateOptions;
    }

    /**
     * Shared Stop sequencing (facade-owned per the split contract): every
     * outstanding Stop request is tracked; they are deliberately not
     * coalesced because the first may arrive before analysis ownership.
     */
    private requestServerStop(): Promise<void> {
        const request = this.stopServerWork();
        const prior = this.pendingStopPromise;
        const pending = prior
            ? Promise.all([prior, request]).then(() => undefined)
            : request;
        this.pendingStopPromise = pending;
        void pending.finally(() => {
            if (this.pendingStopPromise === pending) {
                this.pendingStopPromise = null;
            }
        });
        return request;
    }

    public async stopServerWork(): Promise<void> {
        await this.batchRun.stopServerWork();
    }

    // Fetch resolves after the route owns the miner lock, so a second Stop sent
    // here closes the pre-ownership race.
    private async reissueStopIfNeeded(): Promise<void> {
        if (!this.analysisCancelRequested) return;
        this.analysisCancelRequested = false;
        await this.requestServerStop();
    }

    private async reattachToInProgressServerRun(): Promise<void> {
        await this.batchRun.reattachToInProgressServerRun();
    }

    /**
     * OPEN_SCORE USD Replay: at each historical synthetic-pair decision event,
     * did selecting the highest positive OPEN_SCORE asset (traded vs USD at the
     * next bar's open, fixed-horizon) beat a uniform random pick among the
     * other positive candidates? Read-only on artifacts — no Batch result
     * change, no orders. v1 is an event-level selector study, not a portfolio
     * replay; the report labels TOP_RAW and TOP_ADJUSTED separately and never
     * picks the better-looking formula after seeing results.
     */
    private async runOpenScoreUsdReplay(): Promise<void> {
        if (this.analysisInFlight) return;
        this.analysisInFlight = true;
        this.analysisCancelRequested = false;
        const dom = this.getDom();
        try {
            if (!this.serverHasArtifacts) {
                dom.batchBacktestOpenScoreUsdSummary.textContent = "Run Batch first.";
                return;
            }
            if (!this.lastRunFingerprint) {
                dom.batchBacktestOpenScoreUsdSummary.textContent = "Rerun Batch; settings or symbols changed.";
                dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
                return;
            }
            if (this.analysisCancelRequested) return;
            // Horizons: comma-separated positive bar counts. Required in v1.
            const horizonsRaw = dom.batchBacktestOpenScoreUsdHorizons.value.trim();
            const horizons = horizonsRaw
                ? horizonsRaw.split(",").map((s) => Number(s.trim())).filter((n) => Number.isFinite(n) && n >= 1).map((n) => Math.floor(n))
                : [];
            if (horizons.length === 0) {
                dom.batchBacktestOpenScoreUsdSummary.textContent = "Enter at least one positive horizon (e.g. 12,24,48).";
                dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
                return;
            }
            // Optional decision-event date window (YYYY-MM-DD); blank = full side.
            const sampleFrom = dom.batchBacktestOpenScoreUsdFrom.value.trim();
            const sampleTo = dom.batchBacktestOpenScoreUsdTo.value.trim();
            // Cap-tilt weighting (docs/open-score-cap-tilt.md). "off" is
            // omitted from the body so baseline requests stay byte-identical
            // to the pre-cap-tilt shape.
            const capTiltWeight = dom.batchBacktestOpenScoreUsdCapTilt.value;
            // Slippage/commission are NOT request fields: the server derives
            // them from the retained Batch run's slippageBps / commission so
            // the OPEN_SCORE USD replay uses the same execution-cost
            // assumptions as the artifacts it reads.

            this.beginAnalysisBusy(dom);
            dom.batchBacktestOpenScoreUsdBtn.disabled = true;
            dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
            dom.batchBacktestOpenScoreUsdSummary.textContent = "Replaying OPEN_SCORE events on server...";
            await postBatchNdjson<OpenScoreUsdReplayStreamEvent>({
                endpoint: "/api/batch-backtest/open-score-usd",
                body: {
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval,
                    horizons,
                    ...(sampleFrom ? { sampleFrom } : {}),
                    ...(sampleTo ? { sampleTo } : {}),
                    ...(isActiveCapTiltWeight(capTiltWeight) ? { capTiltWeight } : {}),
                },
                onResponse: () => this.reissueStopIfNeeded(),
                handlers: {
                    onStart: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "start" }>) => {
                        dom.batchBacktestOpenScoreUsdSummary.textContent =
                            `OPEN_SCORE USD — ${event.pairs} pairs / ${event.assets} assets / horizons [${event.horizons.join(",")}]`;
                    },
                    onPhase: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "phase" }>) => {
                        const pct = event.total > 0 ? Math.round((event.completed / event.total) * 100) : 0;
                        dom.batchBacktestOpenScoreUsdSummary.textContent =
                            `OPEN_SCORE USD — ${event.phase}: ${event.detail} (${pct}%, ${(event.elapsedMs / 1000).toFixed(1)}s)`;
                    },
                    onProgress: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "progress" }>) => {
                        const pct = event.total > 0 ? Math.round((event.completed / event.total) * 100) : 0;
                        const extra = [];
                        if (event.events !== undefined) extra.push(`${event.events} events`);
                        if (event.omitted !== undefined) extra.push(`${event.omitted} omitted`);
                        const tail = extra.length > 0 ? ` (${extra.join(", ")})` : "";
                        dom.batchBacktestOpenScoreUsdSummary.textContent =
                            `OPEN_SCORE USD — ${event.phase}: ${event.detail} (${pct}%, ${(event.elapsedMs / 1000).toFixed(1)}s)${tail}`;
                    },
                    onDone: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "done" }>) => {
                        if (event.ok === true && "result" in event && event.result) {
                            this.lastOpenScoreUsdResult = event.result;
                            dom.batchBacktestOpenScoreUsdSummary.textContent = event.result.reportLines.join("\n");
                            dom.batchBacktestCopyOpenScoreUsdBtn.disabled = event.result.reportLines.length === 0;
                        } else if (event.ok === false && "summary" in event) {
                            dom.batchBacktestOpenScoreUsdSummary.textContent = event.summary ?? "OPEN_SCORE USD cancelled.";
                        } else {
                            dom.batchBacktestOpenScoreUsdSummary.textContent = "OPEN_SCORE USD finished.";
                        }
                    },
                    onFatal: (event: Extract<OpenScoreUsdReplayStreamEvent, { type: "fatal" }>) => {
                        throw new Error(event.error);
                    },
                },
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastOpenScoreUsdResult = null;
            dom.batchBacktestOpenScoreUsdSummary.textContent = `OPEN_SCORE USD error: ${message}`;
            dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
            debugLogger.error("batch_open_score_usd.server_failed", { error: message });
        } finally {
            await this.finishAnalysisBusy(dom);
        }
    }

    private async copyOpenScoreUsdResults(): Promise<void> {
        if (!this.lastOpenScoreUsdResult) {
            uiManager.showToast("No OPEN_SCORE USD report to copy", "info");
            return;
        }
        const text = this.lastOpenScoreUsdResult.reportLines.join("\n");
        const copied = await copyToClipboard(text);
        if (copied) {
            uiManager.showToast("OPEN_SCORE USD report copied", "success");
        } else {
            this.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    /**
     * Authoritative guard for the Balanced Generator. Rejects the action
     * (without mutating either textarea or remembered provenance) whenever a
     * Batch run, analysis, Stop transition, or status reattach owns the UI.
     * The disabled button is the visual signal; THIS is the correctness gate.
     * Mirrors the runInFlight / analysisInFlight / pendingStopPromise
     * single-flight discipline the rest of the service uses.
     */
    private balancedGeneratorActionGuard(): boolean {
        return (
            this.runInFlight ||
            this.analysisInFlight ||
            this.pendingStopPromise !== null ||
            // A reloaded tab can have no local in-flight promise while the
            // server still owns the run. Do not let generator edits mutate
            // the submitted universe during that ownership window.
            this.batchRun.isServerRunActive()
        );
    }

    /**
     * Balanced Generator — Generate-and-Apply. Reads the assets textarea,
     * maxPairs, and seed; runs the pure generator; on success writes the
     * generated pair list to the existing Pairs textarea and dispatches its
     * input event so the existing fingerprint/result invalidation path runs
     * exactly as if the user had pasted the list manually. On failure the
     * textarea and provenance are left untouched and actionable errors are
     * shown in the summary area.
     */
    private async generateAndApplyBalancedPairList(): Promise<void> {
        const dom = this.getDom();
        // Authoritative guard fires before any work; the disabled button is
        // the visual signal but cannot be the only gate (a stale tab could
        // re-enable it via reattach).
        if (this.balancedGeneratorActionGuard()) {
            dom.batchBacktestBalancedSummary.textContent =
                "Generator unavailable while a Batch run, analysis, or Stop transition is in progress.";
            return;
        }
        const rawAssets = dom.batchBacktestBalancedAssets.value;
        const assets = rawAssets.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.length > 0);
        const maxPairs = this.readClampedInt(dom.batchBacktestBalancedMaxPairs.value, BALANCED_PAIR_LIST_MAX_PAIRS, 1, BALANCED_PAIR_LIST_MAX_PAIRS);
        const seedRaw = Number.parseInt(dom.batchBacktestBalancedSeed.value, 10);
        const seed = Number.isFinite(seedRaw) ? Math.max(1, Math.floor(seedRaw)) : 1;
        // The pure generator is synchronous; wrap in await so future async
        // extensions (canonicalization that needs a loader) plug in cleanly.
        const result = generateBalancedPairList({ assets, maxPairs, seed });
        if (!result.ok) {
            // Leave the textarea AND the provenance untouched.
            const errors = result.errors.length > 0 ? result.errors : ["Generation failed."];
            dom.batchBacktestBalancedSummary.textContent = errors.join("\n");
            dom.batchBacktestBalancedCopyBtn.disabled = true;
            return;
        }
        // Apply: write the textarea and dispatch the input event so the
        // existing fingerprint/result invalidation path runs identically to
        // a manual paste. Set the remembered provenance BEFORE the dispatch
        // so the input listener's stale-check sees the matching hash and
        // keeps it.
        this.lastBalancedPairListResult = result;
        this.activePairListProvenance = result.provenance;
        dom.batchBacktestSymbols.value = result.pairs.join("\n");
        dom.batchBacktestBalancedCopyBtn.disabled = false;
        dom.batchBacktestBalancedSummary.textContent = formatBalancedPairListSummary(result);
        // Dispatch the existing input invalidation path. Fall back to a
        // plain Event when InputEvent is not available (older Node test
        // harnesses without a DOM polyfill); the bound handler does not read
        // any InputEvent-specific field.
        const EventCtor = typeof InputEvent !== "undefined" ? InputEvent : Event;
        dom.batchBacktestSymbols.dispatchEvent(new EventCtor("input", { bubbles: true }));
        // The dispatched input handler runs clearStaleResults + updateSummary;
        // we then re-affirm the provenance (clearActivePairListProvenanceIfStale
        // inside the input handler keeps it because the hash matches).
    }

    private async copyBalancedPairList(): Promise<void> {
        const result = this.lastBalancedPairListResult;
        if (!result || !result.ok) {
            uiManager.showToast("No balanced pair list to copy", "info");
            return;
        }
        const text = [
            ...formatBalancedPairListReportLines(result),
            "",
            ...result.pairs,
        ].join("\n");
        const copied = await copyToClipboard(text);
        if (copied) {
            uiManager.showToast(`Copied ${result.pairs.length} generated pairs`, "success");
        } else {
            this.getDom().batchBacktestStatus.textContent = "Copy failed.";
        }
    }

    /**
     * If the textarea's content no longer matches the active provenance hash,
     * clear the remembered provenance. Called from the input handler so a
     * manual edit (or any other mutation) drops the link while a generator
     * apply re-sets it before the dispatch reaches here.
     */
    private clearActivePairListProvenanceIfStale(dom: BatchBacktestDom): void {
        if (!this.activePairListProvenance) return;
        const currentText = dom.batchBacktestSymbols.value;
        // Recompute the emitted-list hash with the same normalization the
        // generator used (parseBatchSymbols dedupes + uppercases + trims).
        const normalized = parseBatchSymbols(currentText);
        const currentHash = fnv1a64Hex(normalized.join("\n"));
        if (currentHash !== this.activePairListProvenance.emittedPairListHash) {
            this.activePairListProvenance = null;
        }
    }

    /** Server-side access to the active provenance (Phase 3 Batch run submission). */
    getActivePairListProvenance(): PairListProvenanceV1 | null {
        return this.activePairListProvenance;
    }

    private loadPersistedLatestResults(dom: BatchBacktestDom): void {
        this.batchRun.loadPersistedLatestResults(dom);
    }



    public persistActiveServerRun(runId: string): void {
        this.batchRun.persistActiveServerRun(runId);
    }

    public loadPersistedActiveServerRun(): BatchPersistedActiveServerRun | null {
        return this.batchRun.loadPersistedActiveServerRun();
    }


    public updateArtifactActionButtons(dom: BatchBacktestDom): void {
        this.batchRun.updateArtifactActionButtons(dom);
    }


    private clearStaleResults(dom: BatchBacktestDom): void {
        // Cross-owner coordination: the OPEN_SCORE result belongs to the
        // analysis side; fingerprints/artifacts/rows belong to the run owner.
        this.lastOpenScoreUsdResult = null;
        dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdSummary.textContent = "";
        this.batchRun.clearStaleRows(dom);
    }


    private setRunBusy(dom: BatchBacktestDom, busy: boolean): void {
        this.batchRun.setRunBusy(dom, busy);
    }

    private beginAnalysisBusy(dom: BatchBacktestDom): void {
        this.setRunBusy(dom, true);
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestRunBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestBalancedGenerateBtn.disabled = true;
        dom.batchBacktestBalancedCopyBtn.disabled = true;
    }

    // Keep operations disabled until unscoped /stop requests have settled.
    private async finishAnalysisBusy(dom: BatchBacktestDom): Promise<void> {
        this.analysisCancelRequested = false;
        this.setRunBusy(dom, false);
        setVisible(dom.batchBacktestStopBtn, false);
        dom.batchBacktestRunBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestBalancedGenerateBtn.disabled = true;
        dom.batchBacktestBalancedCopyBtn.disabled = true;
        const pending = this.pendingStopPromise;
        if (pending) {
            try { await pending; } catch { /* stopServerWork swallows errors */ }
        }
        this.analysisInFlight = false;
        dom.batchBacktestRunBtn.disabled = false;
        // Audit artifact-action-gating finding: route the post-analysis restore
        // through the shared helper so Mine, Stability, and OPEN_SCORE USD
        // all flip back together based on the same gate.
        this.updateArtifactActionButtons(dom);
    }

    private resetProgress(dom: BatchBacktestDom): void {
        this.batchRun.resetProgress(dom);
    }

    private updateSummary(dom: BatchBacktestDom): void {
        this.batchRun.updateSummary(dom);
    }

    /**
     * Render the completed-run summary as a compact metric grid (point 7 of the
     * Batch UI refactor): stable cells instead of a long pipe-delimited strip.
     * The full pipe summary stays the clipboard / Copy Results surface.
     */

    private readClampedInt(raw: string, fallback: number, min: number, max: number): number {
        const parsed = Number.parseInt(raw, 10);
        const value = Number.isFinite(parsed) ? parsed : fallback;
        return Math.max(min, Math.min(max, Math.floor(value)));
    }

    /**
     * Audit Finding 6: the coordinator preflight strategy gate. Kept on the
     * facade so the shared preflight seam stays in one place (and overridable
     * by the lifecycle regression suite).
     */
    private async resolveTopMeanBuiltInStrategy(
        dom: BatchBacktestDom,
    ): Promise<{ strategyKey: string; strategy: NonNullable<ReturnType<typeof strategyRegistry.get>> } | undefined> {
        const strategyKey = state.currentStrategyKey;
        await ensureBuiltInStrategyLoaded(strategyKey);
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategyKey || !strategy) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Error: Custom/browser strategies cannot be run in Node worker coordinator. Please select a built-in strategy.";
            return undefined;
        }
        return { strategyKey, strategy };
    }

    public async runSp500TopMeanCoordinator(): Promise<void> {
        const dom = this.getDom();
        // Shared single-flight: must run before the first await so rapid clicks
        // cannot stack multiple coordinator POSTs or replace activeTopMeanRunId.
        if (this.isBatchUiBusy()) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Batch action already in progress — wait for it to finish.";
            return;
        }
        this.batchActionInFlight = true;
        try {
            await this.topMean.run({ resolveStrategy: (dom) => this.resolveTopMeanBuiltInStrategy(dom) });
        } finally {
            this.batchActionInFlight = false;
        }
    }

    public async stopSp500TopMeanCoordinator(): Promise<void> {
        await this.topMean.stop();
    }


    private renderTopMeanResults(dom: BatchBacktestDom, summary: TopMeanResultSummary): void {
        this.topMean.renderTopMeanResults(dom, summary);
    }

    public persistLatestTopMeanResult(result: TopMeanResultSummary): void {
        this.topMean.persistLatestTopMeanResult(result);
    }


    private loadPersistedLatestTopMeanResult(dom: BatchBacktestDom): void {
        this.topMean.loadPersistedLatestTopMeanResult(dom);
    }


    private toggleSp500TopMeanOpenScoreDetails(): void {
        this.topMean.toggleSp500TopMeanOpenScoreDetails();
    }

    private getTopMeanOpenScoreDetailSelector(
        dom: BatchBacktestDom,
    ): OpenScoreUsdEventDetailSelector {
        return this.topMean.getTopMeanOpenScoreDetailSelector(dom);
    }

    /** Selected calendar year for the details table; null = full window. */
    private getTopMeanOpenScoreDetailYear(dom: BatchBacktestDom): number | null {
        return this.topMean.getTopMeanOpenScoreDetailYear(dom);
    }

    private renderTopMeanOpenScoreEventDetails(
        summary: TopMeanResultSummary,
        selector: OpenScoreUsdEventDetailSelector,
        year: number | null = null,
    ): string {
        return this.topMean.renderTopMeanOpenScoreEventDetails(summary, selector, year);
    }


    /**
     * Phase-1 current snapshot lines for the Copy Results output. Mirrors the
     * banner content in plain text so the clipboard surface matches the UI.
     */

    public formatLatestOpenScoreSelectionLines(latestInput: OpenScoreUsdLatestSelections): string[] {
        return this.topMean.formatLatestOpenScoreSelectionLines(latestInput);
    }

    public async copySp500TopMeanResults(): Promise<void> {
        await this.topMean.copySp500TopMeanResults();
    }

    public async copySp500TopMeanOpenScoreResults(): Promise<void> {
        await this.topMean.copySp500TopMeanOpenScoreResults();
    }

    public buildTopMeanOpenScoreText(): string {
        return this.topMean.buildTopMeanOpenScoreText();
    }

    public async copySp500TopMeanDiagnostic(): Promise<void> {
        await this.topMean.copySp500TopMeanDiagnostic();
    }

    public buildTopMeanDiagnosticText(): string {
        return this.topMean.buildTopMeanDiagnosticText();
    }

    public recordTopMeanNdjsonEvent(event: any): void {
        this.topMean.recordTopMeanNdjsonEvent(event);
    }

    public recordTopMeanDiagnostic(type: string, data?: unknown, bytes?: number): void {
        this.topMean.recordTopMeanDiagnostic(type, data, bytes);
    }

    public restorePersistedTopMeanDiagnostics(): void {
        this.topMean.restorePersistedTopMeanDiagnostics();
    }

    public downloadSp500TopMeanResults(): void {
        this.topMean.downloadSp500TopMeanResults();
    }

    private async reattachToInProgressTopMeanRun(): Promise<void> {
        await this.topMean.reattachToInProgressTopMeanRun();
    }

    public dispose(): void {
        // Detach this instance from server-owned work before resolving its
        // polling delays. The TOP_MEAN controller clears its run id first (so
        // its reattach loop wakes without rescheduling), then the Batch
        // reattach poll stops, then pending render work is cancelled.
        this.topMean.dispose();
        this.batchRun.dispose();
    }
}


/**
 * Compact one-line summary of a Balanced Generator result for the UI status
 * area. Surfaces the effective seed/maxPairs, asset/relationship counts,
 * degree range, orientation imbalance, omitted count, and asset-list hash.
 */
function formatBalancedPairListSummary(result: BalancedPairListResult): string {
    if (!result.ok) {
        return result.errors.length > 0 ? result.errors.join("; ") : "Generation failed.";
    }
    const p = result.provenance;
    const omitted = result.omittedPairCount > 0 ? ` omitted=${result.omittedPairCount}` : "";
    const aliases = result.aliasCollisions.length > 0 ? ` aliases=${result.aliasCollisions.length}` : "";
    const invalid = result.invalidTokens.length > 0 ? ` invalid=${result.invalidTokens.length}` : "";
    return [
        `Balanced | seed=${p.effectiveSeed} max=${p.effectiveMaxPairs}`,
        `assets=${p.assetCount} pairs=${p.pairCount}`,
        `deg=${p.degree.min}-${p.degree.median.toFixed(1)}-${p.degree.max}`,
        `orientImbalance=${p.orientationImbalanceMax}`,
        `hash=${p.emittedPairListHash.slice(0, 12)}`,
    ].join(" ") + omitted + aliases + invalid;
}

/**
 * Multi-line report for Copy Generated. Mirrors the summary plus any warnings
 * and the provenance fields needed to verify the list server-side. Pair text
 * is appended separately by the caller so the report and the list stay
 * separable.
 */
function formatBalancedPairListReportLines(result: BalancedPairListResult): string[] {
    if (!result.ok) {
        return ["Balanced Generator failed.", ...result.errors];
    }
    const p = result.provenance;
    const lines: string[] = [
        `Balanced Generator | ${p.schema} | ${p.algorithm}`,
        `seed=${p.effectiveSeed} max=${p.effectiveMaxPairs} assets=${p.assetCount} pairs=${p.pairCount}`,
        `degree min=${p.degree.min} median=${p.degree.median.toFixed(2)} max=${p.degree.max}`,
        `orientationImbalanceMax=${p.orientationImbalanceMax}`,
        `candidatePairCount=${result.candidatePairCount} omitted=${result.omittedPairCount}`,
        `assetListHash=${p.canonicalAssetListHash}`,
        `pairListHash=${p.emittedPairListHash}`,
    ];
    for (const w of result.warnings) lines.push(`WARN: ${w}`);
    return lines;
}

export function createBatchBacktestService(): BatchBacktestService {
    return new BatchBacktestService();
}

export const batchBacktestService = createBatchBacktestService();
