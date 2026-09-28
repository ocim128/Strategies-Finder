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
import { writePersistedJson } from "../persisted-json";
import { TRADE_LEDGER_DEFAULT_HORIZONS } from "./trade-ledger-schema";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { parseTradeLedgerHorizons } from "./trade-ledger-wire";
import type { PairListProvenanceV1 } from "./balanced-pair-list-generator";
// The template blob lives in the lazy-loaded batch feature chunk (via ?raw),
// so it never lands in the cold-start bundle.
import { getBatchSymbolTemplate, type BatchSymbolTemplateKey } from "./batch-symbol-templates";
import { isBatchResultSortKey } from "./batch-results-sort";
import type { OpenScoreUsdReplayResult } from "./batch-open-score-usd-replay-engine";
import {
    BATCH_TRADE_LEDGER_DEFAULT_FOLDER,
    BATCH_TRADE_LEDGER_STORAGE,
    readPersistedTradeLedgerOptions,
    type BatchPersistedActiveServerRun,
    type BatchTradeGateOptions,
    type BatchTradeLedgerOptions,
} from "./browser/batch-browser-store";
import { TopMeanController } from "./browser/top-mean-controller";
import { BatchRunController } from "./browser/batch-run-controller";
import { OpenScoreController } from "./browser/open-score-controller";
import { TradeGateControls } from "./browser/trade-gate-controls";
import { BalancedPairListControls } from "./browser/balanced-pair-list-controls";
import type { TopMeanResultSummary } from "./sp500-top-mean-coordinator-engine";
import {
    createBatchResultsView,
    type BatchResultsView,
} from "./browser/batch-results-view";
import { LATEST_ARM_SELECTOR_ID } from "./browser/top-mean-results-view";
import type { OpenScoreUsdEventDetailSelector } from "./batch-open-score-usd-replay-engine";

export { formatTopMeanCompletionMessage } from "./browser/top-mean-results-view";

export class BatchBacktestService {
    private dom: BatchBacktestDom | null = null;
    private initialized = false;
    private get lastOpenScoreUsdResult(): OpenScoreUsdReplayResult | null {
        return this.openScore.getResult();
    }
    private set lastOpenScoreUsdResult(result: OpenScoreUsdReplayResult | null) {
        this.openScore.setResult(result);
    }
    /**
     * Last successful Balanced Generator result. Used by Copy Generated so a
     * user can copy the displayed list without re-running the generator. The
     * pair list is NOT applied to the textarea on Copy; only Generate-and-Apply
     * writes the textarea (and dispatches the existing input invalidation).
     */
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
    private get activeServerRunId(): string | null {
        return this.batchRun.getActiveServerRunId();
    }
    private set activeServerRunId(runId: string | null) {
        this.batchRun.setActiveServerRunId(runId);
    }
    private get runInFlight(): boolean {
        return this.batchRun.getRunInFlight();
    }
    private set runInFlight(value: boolean) {
        this.batchRun.setRunInFlight(value);
    }
    /**
     * Shared UI single-flight lock for TOP_MEAN / stability (and any other
     * Batch action that awaits before claiming ownership). Complements
     * `runInFlight` so rapid clicks cannot stack overlapping POSTs or replace
     * the active run id while another action is mid-preflight.
     */
    private batchActionInFlight = false;
    // OPEN_SCORE USD analysis state (lock, cancel flag, retained result) lives
    // on the controller; the accessors keep the facade wiring unchanged.
    private get analysisInFlight(): boolean {
        return this.openScore.isBusy();
    }
    private set analysisInFlight(value: boolean) {
        this.openScore.setAnalysisInFlight(value);
    }
    private get analysisCancelRequested(): boolean {
        return this.openScore.isCancelRequested();
    }
    private set analysisCancelRequested(value: boolean) {
        this.openScore.setCancelRequested(value);
    }
    // /stop is not operation-scoped, so new work must wait for every request.
    private pendingStopPromise: Promise<void> | null = null;
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
        getPairListProvenance: () => this.balanced.getActiveProvenance(),
        requestServerStop: () => this.requestServerStop(),
    });
    // OPEN_SCORE USD analysis owner (browser/open-score-controller.ts).
    private readonly openScore: OpenScoreController = new OpenScoreController({
        getDom: () => this.getDom(),
        requestServerStop: () => this.requestServerStop(),
        beginAnalysisBusy: (dom) => this.beginAnalysisBusy(dom),
        finishAnalysisBusy: (dom) => this.finishAnalysisBusy(dom),
        updateArtifactActionButtons: (dom) => this.updateArtifactActionButtons(dom),
        serverHasArtifacts: () => this.batchRun.getServerHasArtifacts(),
        lastRunFingerprint: () => this.batchRun.getLastRunFingerprint(),
        lastRunInterval: () => this.batchRun.getLastRunInterval(),
        reissueStopIfNeeded: () => this.reissueStopIfNeeded(),
    });
    // Trade Gate form controls (catalog + persisted options).
    private readonly tradeGate = new TradeGateControls();
    // Balanced Generator controls (generate/copy + applied-list provenance).
    private readonly balanced = new BalancedPairListControls({
        getDom: () => this.getDom(),
        actionGuard: () => this.balancedGeneratorActionGuard(),
        clearStaleResults: (dom) => this.clearStaleResults(dom),
        updateSummary: (dom) => this.updateSummary(dom),
    });


    // Audit Finding 2: typed (was `any`) so a shape drift between the
    // coordinator engine emissions and the UI renderers is a compile failure.
    // TOP_MEAN lifecycle state lives on the controller; these typed accessors
    // keep the facade's own wiring (and the facade-visible surface) working.
    private get latestTopMeanResult(): TopMeanResultSummary | null {
        return this.topMean.getLatestTopMeanResult();
    }
    private set latestTopMeanResult(result: TopMeanResultSummary | null) {
        this.topMean.setLatestTopMeanResult(result);
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
            void this.runBatch();
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
                || this.balanced.getActiveProvenance() !== null;
            if (hasDerivedState) {
                this.clearStaleResults(dom);
                this.balanced.clearActiveProvenanceIfStale(dom);
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
        this.tradeGate.restoreOptions(dom);
    }


    private persistTradeGateOptions(dom: BatchBacktestDom): void {
        this.tradeGate.persistOptions(dom);
    }

    private async refreshTradeGateCatalog(): Promise<boolean> {
        return this.tradeGate.refreshCatalog(() => this.getDom());
    }

    private renderTradeGateSelection(dom: BatchBacktestDom): void {
        this.tradeGate.renderSelection(dom);
    }

    private validateTradeGateSelection(dom: BatchBacktestDom): BatchTradeGateOptions | null {
        return this.tradeGate.validateSelection(dom);
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
            hasResult: this.balanced.hasResult(),
        };
    }

    private async runBatch(): Promise<void> {
        await this.batchRun.runBatch();
    }




    private async copyBenchmarkPerformance(): Promise<void> {
        await this.batchRun.copyBenchmarkPerformance();
    }

    private async copyResults(): Promise<void> {
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
        if (dom.batchBacktestTradeGateToggle.checked && !this.tradeGate.getCatalog()) {
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

    private async stopServerWork(): Promise<void> {
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

    private async runOpenScoreUsdReplay(): Promise<void> {
        await this.openScore.run();
    }

    private async copyOpenScoreUsdResults(): Promise<void> {
        await this.openScore.copyResults();
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

    private async generateAndApplyBalancedPairList(): Promise<void> {
        await this.balanced.generateAndApply();
    }

    private async copyBalancedPairList(): Promise<void> {
        await this.balanced.copyGenerated();
    }


    /** Server-side access to the active provenance (Phase 3 Batch run submission). */
    getActivePairListProvenance(): PairListProvenanceV1 | null {
        return this.balanced.getActiveProvenance();
    }

    private loadPersistedLatestResults(dom: BatchBacktestDom): void {
        this.batchRun.loadPersistedLatestResults(dom);
    }




    private loadPersistedActiveServerRun(): BatchPersistedActiveServerRun | null {
        return this.batchRun.loadPersistedActiveServerRun();
    }


    private updateArtifactActionButtons(dom: BatchBacktestDom): void {
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


    public async copySp500TopMeanResults(): Promise<void> {
        await this.topMean.copySp500TopMeanResults();
    }

    public async copySp500TopMeanOpenScoreResults(): Promise<void> {
        await this.topMean.copySp500TopMeanOpenScoreResults();
    }


    public async copySp500TopMeanDiagnostic(): Promise<void> {
        await this.topMean.copySp500TopMeanDiagnostic();
    }




    private restorePersistedTopMeanDiagnostics(): void {
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

/**
 * Multi-line report for Copy Generated. Mirrors the summary plus any warnings
 * and the provenance fields needed to verify the list server-side. Pair text
 * is appended separately by the caller so the report and the list stay
 * separable.
 */

export function createBatchBacktestService(): BatchBacktestService {
    return new BatchBacktestService();
}

export const batchBacktestService = createBatchBacktestService();
