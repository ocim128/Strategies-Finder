import "../../styles/batch-backtest.css";
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
import { debounce } from "../debounce";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import type { PairListProvenanceV1 } from "./balanced-pair-list-generator";
// The template blob lives in the lazy-loaded batch feature chunk (via ?raw),
// so it never lands in the cold-start bundle.
import { getBatchSymbolTemplate, type BatchSymbolTemplateKey } from "./batch-symbol-templates";
import { isBatchResultSortKey } from "./batch-results-sort";
import type { OpenScoreUsdReplayResult } from "./batch-open-score-usd-replay-engine";
import { TopMeanController } from "./browser/top-mean-controller";
import { BatchRunController } from "./browser/batch-run-controller";
import { OpenScoreController } from "./browser/open-score-controller";
import { BalancedPairListControls } from "./browser/balanced-pair-list-controls";
import type { TopMeanResultSummary } from "./sp500-top-mean-coordinator-engine";
import {
    createBatchResultsView,
    type BatchResultsView,
} from "./browser/batch-results-view";
import { LATEST_ARM_SELECTOR_ID } from "./browser/top-mean-results-view";
import { handleAssetSwitchResultsClick } from "./browser/asset-switch-results-view";

export { formatTopMeanCompletionMessage } from "./browser/top-mean-results-view";

export class BatchBacktestService {
    private dom: BatchBacktestDom | null = null;
    private initialized = false;
    private disposed = false;
    private readonly eventCleanup: Array<() => void> = [];
    private lockedPairListText: string | null = null;
    private readonly updatePairCountDebounced = debounce((dom: BatchBacktestDom) => {
        if (!this.disposed) this.batchRun.updateSummary(dom);
    }, 200);

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
    private actionInFlight = false;
    private get batchActionInFlight(): boolean {
        return this.actionInFlight;
    }
    private set batchActionInFlight(value: boolean) {
        this.actionInFlight = value;
        this.syncPairListControls();
    }
    // OPEN_SCORE USD analysis state (lock, cancel flag, retained result) lives
    // on the controller; the accessors keep the facade wiring unchanged.
    private get analysisInFlight(): boolean {
        return this.openScore.isBusy();
    }
    private set analysisInFlight(value: boolean) {
        this.openScore.setAnalysisInFlight(value);
        this.syncPairListControls();
    }
    private get analysisCancelRequested(): boolean {
        return this.openScore.isCancelRequested();
    }
    private set analysisCancelRequested(value: boolean) {
        this.openScore.setCancelRequested(value);
    }
    // /stop is not operation-scoped, so new work must wait for every request.
    private stopPromise: Promise<void> | null = null;
    private get pendingStopPromise(): Promise<void> | null {
        return this.stopPromise;
    }
    private set pendingStopPromise(value: Promise<void> | null) {
        this.stopPromise = value;
        this.syncPairListControls();
    }
    // Results presentation (rows, sort header, summary/progress, live render
    // queue). The view owns the queue and frame scheduling; run-token
    // authorization stays here via the isRunTokenCurrent check below.
    private readonly resultsView: BatchResultsView = createBatchResultsView({
        isRunTokenCurrent: (token: number) => token === this.batchRun.currentRunToken(),
    });
    // Batch run workflow owner (browser/batch-run-controller.ts). Created
    // closed over this facade; the injected callbacks keep cross-workflow
    // coordination (busy gate, balanced lock, pending Stop)
    // owned by the facade.
    private readonly batchRun: BatchRunController = new BatchRunController({
        getDom: () => this.getDom(),
        resultsView: this.resultsView,
        onBusyStateChange: () => this.syncPairListControls(),
        isUiBusy: () => this.isBatchUiBusy(),
        balancedLock: () => this.balancedGeneratorLockState(),
        getPairListProvenance: () => this.balanced.getActiveProvenance(),
        requestServerStop: () => this.requestServerStop(),
    });
    // OPEN_SCORE USD analysis owner (browser/open-score-controller.ts).
    private readonly openScore: OpenScoreController = new OpenScoreController({
        getDom: () => this.getDom(),
        requestServerStop: () => this.requestServerStop(),
        beginAnalysisBusy: (dom) => this.beginAnalysisBusy(dom),
        finishAnalysisBusy: (dom) => this.finishAnalysisBusy(dom),
        updateArtifactActionButtons: (dom) => this.batchRun.updateArtifactActionButtons(dom),
        serverHasArtifacts: () => this.batchRun.getServerHasArtifacts(),
        lastRunFingerprint: () => this.batchRun.getLastRunFingerprint(),
        lastRunInterval: () => this.batchRun.getLastRunInterval(),
        reissueStopIfNeeded: () => this.reissueStopIfNeeded(),
    });
    // Balanced Generator controls (generate/copy + applied-list provenance).
    private readonly balanced = new BalancedPairListControls({
        getDom: () => this.getDom(),
        actionGuard: () => this.balancedGeneratorActionGuard(),
        clearStaleResults: (dom) => this.clearStaleResults(dom),
        updateSummary: (dom) => this.refreshPairSummary(dom),
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
        onBusyStateChange: () => this.syncPairListControls(),
    });

    private getDom(): BatchBacktestDom {
        return this.dom ??= createBatchBacktestDom();
    }

    private refreshPairSummary(dom: BatchBacktestDom): void {
        this.updatePairCountDebounced.cancel();
        if (!this.disposed) this.batchRun.updateSummary(dom);
    }

    public init(): void {
        if (this.disposed) return;
        if (this.initialized) {
            return;
        }
        const dom = this.getDom();
        this.bindEvents(dom);
        this.batchRun.refreshSortHeader(dom);
        this.batchRun.resetProgress(dom);
        this.batchRun.loadPersistedLatestResults(dom);
        this.topMean.loadPersistedLatestTopMeanResult(dom);
        this.topMean.restorePersistedTopMeanDiagnostics();
        // Flush the durable diagnostic log when the page goes away (reload,
        // navigation, tab close) — the trailing debounce would otherwise lose
        // the last window of entries.
        this.bindPageLifecycle();
        this.activeServerRunId = this.batchRun.loadPersistedActiveServerRun()?.runId ?? null;
        this.batchRun.setServerRunActive(this.activeServerRunId !== null);
        this.batchRun.updateSummary(dom);
        this.initialized = true;
        // Reattach to a server-side run that started before page load.
        void this.batchRun.reattachToInProgressServerRun();
        void this.topMean.reattachToInProgressTopMeanRun();
    }

    private bindPageLifecycle(): void {
        if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
            this.listen(window, "pagehide", () => this.topMean.writeTopMeanDiagnosticLogNow());
        }
    }

    private listen(target: EventTarget, type: string, listener: EventListener): void {
        target.addEventListener(type, listener);
        this.eventCleanup.push(() => target.removeEventListener(type, listener));
    }

    private bindEvents(dom: BatchBacktestDom): void {
        this.listen(dom.batchBacktestResultsHeader, "click", (event) => {
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
        this.listen(dom.batchBacktestRunBtn, "click", () => {
            this.refreshPairSummary(dom);
            void this.batchRun.runBatch();
        });
        this.listen(dom.batchBacktestStopBtn, "click", () => {
            // The same button also stops normal Batch runs and analysis.
            this.batchRun.requestLocalCancel();
            if (this.analysisInFlight) {
                this.analysisCancelRequested = true;
            }
            this.requestServerStop();
        });
        this.listen(dom.batchBacktestCopyBtn, "click", () => {
            void this.copyResults();
        });
        this.listen(dom.batchBacktestCopyOpenPositionsBtn, "click", () => {
            void this.batchRun.copyOpenPositionPairs();
        });
        this.listen(dom.batchBacktestCopyBenchmarkBtn, "click", () => {
            void this.batchRun.copyBenchmarkPerformance();
        });
        this.listen(dom.batchBacktestOpenScoreUsdBtn, "click", () => {
            void this.openScore.run();
        });
        this.listen(dom.batchBacktestCopyOpenScoreUsdBtn, "click", () => {
            void this.openScore.copyResults();
        });
        this.listen(dom.batchBacktestSp500TopMeanRunBtn, "click", () => {
            this.refreshPairSummary(dom);
            void this.runSp500TopMeanCoordinator();
        });
        this.topMean.initializeReplayModeControls(dom);
        this.listen(dom.batchBacktestSp500TopMeanStopBtn, "click", () => {
            void this.stopSp500TopMeanCoordinator();
        });
        this.listen(dom.batchBacktestSp500TopMeanCopyBtn, "click", () => {
            void this.copySp500TopMeanResults();
        });
        this.listen(dom.batchBacktestSp500TopMeanCopyOpenScoreBtn, "click", () => {
            void this.copySp500TopMeanOpenScoreResults();
        });
        this.listen(dom.batchBacktestSp500TopMeanDetailsBtn, "click", () => {
            this.topMean.toggleSp500TopMeanOpenScoreDetails();
        });
        this.listen(dom.batchBacktestSp500TopMeanDetailsSelector, "change", () => this.topMean.refreshTopMeanDetails());
        this.listen(dom.batchBacktestSp500TopMeanDetailsYear, "change", () => this.topMean.refreshTopMeanDetails());
        this.listen(dom.batchBacktestSp500TopMeanTieBreak, "change", () => this.topMean.refreshTopMeanDisplay(dom));
        this.listen(dom.batchBacktestSp500TopMeanResults, "click", (event) => {
            handleAssetSwitchResultsClick(dom.batchBacktestSp500TopMeanResults, event);
        });
        // Delegate changes from the generated arm picker. Display updates keep
        // the picker mounted, and a new result replaces the card.
        this.listen(dom.batchBacktestSp500TopMeanResults, "change", (event) => {
            const target = event?.target as { id?: string; value?: string } | null | undefined;
            if (!target || target.id !== LATEST_ARM_SELECTOR_ID) return;
            this.topMean.setLatestArm(target.value);
            if (this.latestTopMeanResult) this.topMean.refreshLatestArm(dom);
        });
        this.listen(dom.batchBacktestSp500TopMeanDownloadBtn, "click", () => {
            void this.downloadSp500TopMeanResults();
        });
        this.listen(dom.batchBacktestSp500TopMeanCopyDiagnosticBtn, "click", () => {
            void this.copySp500TopMeanDiagnostic();
        });
        this.listen(dom.batchBacktestSymbolTemplate, "change", () => {
            if (this.isBatchUiBusy()) return;
            const key = dom.batchBacktestSymbolTemplate.value as BatchSymbolTemplateKey;
            if (!key) return;
            const template = getBatchSymbolTemplate(key);
            if (!template) return;
            dom.batchBacktestSymbols.value = template;
            dom.batchBacktestSymbolTemplate.value = "";
            this.clearStaleResults(dom);
            this.refreshPairSummary(dom);
        });
        this.listen(dom.batchBacktestUseCurrent, "click", () => {
            if (this.isBatchUiBusy()) return;
            const current = state.currentSymbol?.trim().toUpperCase();
            if (current) {
                dom.batchBacktestSymbols.value = dom.batchBacktestSymbols.value.trim();
                dom.batchBacktestSymbols.value = dom.batchBacktestSymbols.value
                    ? `${dom.batchBacktestSymbols.value}\n${current}`
                    : current;
            }
            this.clearStaleResults(dom);
            this.refreshPairSummary(dom);
        });
        this.listen(dom.batchBacktestClear, "click", () => {
            if (this.isBatchUiBusy()) return;
            dom.batchBacktestSymbols.value = "";
            this.clearStaleResults(dom);
            this.refreshPairSummary(dom);
        });
        this.listen(dom.batchBacktestSymbols, "input", () => {
            if (this.isBatchUiBusy()) {
                if (this.lockedPairListText !== null) dom.batchBacktestSymbols.value = this.lockedPairListText;
                return;
            }
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
            this.updatePairCountDebounced(dom);
        });
        this.listen(dom.batchBacktestSymbols, "change", () => {
            if (!this.isBatchUiBusy()) this.refreshPairSummary(dom);
        });
        this.listen(dom.batchBacktestBalancedGenerateBtn, "click", () => {
            void this.balanced.generateAndApply();
        });
        this.listen(dom.batchBacktestBalancedCopyBtn, "click", () => {
            void this.balanced.copyGenerated();
        });
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

    /** Refresh editing controls from the same ownership gate as Run. */
    private syncPairListControls(): void {
        const dom = this.dom;
        if (!dom || this.disposed) return;
        const busy = this.isBatchUiBusy();
        if (busy && this.lockedPairListText === null) this.lockedPairListText = dom.batchBacktestSymbols.value;
        if (!busy) this.lockedPairListText = null;
        dom.batchBacktestSymbols.readOnly = busy;
        dom.batchBacktestSymbolTemplate.disabled = busy;
        dom.batchBacktestUseCurrent.disabled = busy;
        dom.batchBacktestClear.disabled = busy;
        this.resultsView.updateBalancedGeneratorButtons(dom, this.balancedGeneratorLockState());
    }

    /** Balanced-generator lock inputs, computed from shared facade state. */
    private balancedGeneratorLockState(): { blocked: boolean; hasResult: boolean } {
        return {
            blocked: this.isBatchUiBusy(),
            hasResult: this.balanced.hasResult(),
        };
    }

    private async copyResults(): Promise<void> {
        await this.batchRun.copyResults(this.lastOpenScoreUsdResult?.reportLines ?? []);
    }

    /**
     * Shared Stop sequencing (facade-owned per the split contract): every
     * outstanding Stop request is tracked; they are deliberately not
     * coalesced because the first may arrive before analysis ownership.
     */
    private requestServerStop(): Promise<void> {
        if (this.disposed) return Promise.resolve();
        const request = this.batchRun.stopServerWork();
        const prior = this.pendingStopPromise;
        const pending = prior
            ? Promise.all([prior, request]).then(() => undefined)
            : request;
        this.pendingStopPromise = pending;
        void pending.finally(() => {
            if (this.pendingStopPromise === pending) {
                this.pendingStopPromise = null;
                // The last settled Stop may have been the only flag blocking
                // the Balanced Generator buttons; re-assert their state.
                if (!this.disposed) this.batchRun.updateBalancedGeneratorButtons(this.getDom());
            }
        });
        return request;
    }

    // Fetch resolves after the route owns the miner lock, so a second Stop sent
    // here closes the pre-ownership race.
    private async reissueStopIfNeeded(): Promise<void> {
        if (this.disposed || !this.analysisCancelRequested) return;
        this.analysisCancelRequested = false;
        await this.requestServerStop();
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
        return this.isBatchUiBusy();
    }

    /** Server-side access to the active provenance (Phase 3 Batch run submission). */
    getActivePairListProvenance(): PairListProvenanceV1 | null {
        return this.balanced.getActiveProvenance();
    }

    private clearStaleResults(dom: BatchBacktestDom): void {
        // Cross-owner coordination: the OPEN_SCORE result belongs to the
        // analysis side; fingerprints/artifacts/rows belong to the run owner.
        this.lastOpenScoreUsdResult = null;
        dom.batchBacktestCopyOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdSummary.textContent = "";
        this.batchRun.clearStaleRows(dom);
    }

    private beginAnalysisBusy(dom: BatchBacktestDom): void {
        this.batchRun.setRunBusy(dom, true);
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestRunBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestBalancedGenerateBtn.disabled = true;
        dom.batchBacktestBalancedCopyBtn.disabled = true;
    }

    // Keep operations disabled until unscoped /stop requests have settled.
    private async finishAnalysisBusy(dom: BatchBacktestDom): Promise<void> {
        if (this.disposed) return;
        this.analysisCancelRequested = false;
        this.batchRun.setRunBusy(dom, false);
        setVisible(dom.batchBacktestStopBtn, false);
        dom.batchBacktestRunBtn.disabled = true;
        dom.batchBacktestOpenScoreUsdBtn.disabled = true;
        dom.batchBacktestBalancedGenerateBtn.disabled = true;
        dom.batchBacktestBalancedCopyBtn.disabled = true;
        const pending = this.pendingStopPromise;
        if (pending) {
            try { await pending; } catch { /* stopServerWork swallows errors */ }
        }
        if (this.disposed) return;
        this.analysisInFlight = false;
        // beginAnalysisBusy hard-disabled both Balanced Generator buttons;
        // restore them from the now-unblocked lock state.
        this.batchRun.updateBalancedGeneratorButtons(dom);
        dom.batchBacktestRunBtn.disabled = false;
        // Audit artifact-action-gating finding: route the post-analysis restore
        // through the shared helper so Mine, Stability, and OPEN_SCORE USD
        // all flip back together based on the same gate.
        this.batchRun.updateArtifactActionButtons(dom);
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
        if (this.disposed) return undefined;
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategyKey || !strategy) {
            dom.batchBacktestSp500TopMeanProgressText.textContent =
                "Error: Custom/browser strategies cannot be run in Node worker coordinator. Please select a built-in strategy.";
            return undefined;
        }
        return { strategyKey, strategy };
    }

    public async runSp500TopMeanCoordinator(): Promise<void> {
        if (this.disposed) return;
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

    public renderTopMeanResults(dom: BatchBacktestDom, summary: TopMeanResultSummary): void {
        this.topMean.renderTopMeanResults(dom, summary);
    }

    public async copySp500TopMeanResults(): Promise<void> {
        await this.topMean.copySp500TopMeanResults();
    }

    public async copySp500TopMeanOpenScoreResults(): Promise<void> {
        await this.topMean.copySp500TopMeanOpenScoreResults();
    }

    public async copySp500TopMeanDiagnostic(): Promise<void> {
        await this.topMean.copySp500TopMeanDiagnostic();
    }

    public async downloadSp500TopMeanResults(): Promise<void> {
        await this.topMean.downloadSp500TopMeanResults();
    }

    public dispose(): void {
        this.disposed = true;
        this.updatePairCountDebounced.cancel();
        for (const cleanup of this.eventCleanup.splice(0)) cleanup();
        // Detach this instance from server-owned work before resolving its
        // polling delays. The TOP_MEAN controller clears its run id first (so
        // its reattach loop wakes without rescheduling), then the Batch
        // reattach poll stops, then pending render work is cancelled.
        this.topMean.dispose();
        this.openScore.dispose();
        this.batchRun.dispose();
    }
}

export function createBatchBacktestService(): BatchBacktestService {
    return new BatchBacktestService();
}

export const batchBacktestService = createBatchBacktestService();
