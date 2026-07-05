/**
 * Batch Backtest UI service.
 *
 * Lazy-initialized like the other strategy panel services (see
 * `lib/hunt/hunt-service.ts`). Binds the tab's buttons, reads the CURRENT
 * strategy / params / backtest / capital settings once per run, and replays
 * them across every pair in the user's list through the pure runner.
 *
 * Visual output mirrors Finder's universe symbol rows (same verdict labels
 * and metric order) so a Batch run reads the same as a Finder universe run.
 */

import { ensureBuiltInStrategyLoaded } from "../strategies/built-in-catalog";
import { backtestService } from "../backtest-service";
import { shouldUseRustEngine } from "../engine-preferences";
import { paramManager } from "../param-manager";
import { state } from "../state";
import { strategyRegistry } from "../../strategyRegistry";
import { formatProfitFactor } from "../ui-formatters";
import { setVisible } from "../dom-utils";
import { debugLogger } from "../debug-logger";
import { computePerformanceVerdict } from "../finder/finder-universe-metrics";
import type { BacktestResult, OHLCVData, Time } from "../types/strategies";
import { parsePortfolioSyntheticPairSymbol, stripKnownQuoteSuffix } from "../portfolioLab/portfolio-lab-synthetic";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import { clearBatchDatasetCaches, loadBatchDataset } from "./batch-backtest-loader";
import { consumeNdjsonStream } from "../ndjson-stream";
import { mapWithConcurrencyLimit } from "../async-pool";
import {
    parseBatchSymbols,
    runBatchBacktest,
    type BatchBacktestSymbolResult,
} from "./batch-backtest-runner";
import type { BatchStreamEvent, BatchMinerStreamEvent } from "./batch-backtest-stream-types";
import {
    resolveBatchSyntheticTargetSymbol,
    runBatchSyntheticStateMiner,
    BATCH_SYNTHETIC_MINER_DEFAULT_OPTIONS,
    type BatchSyntheticAssetVerdict,
    type BatchSyntheticMinerResult,
    type BatchSyntheticPairContribution,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "./batch-synthetic-state-miner";
import {
    addStabilityVerdicts,
    createStabilityAggregate,
    finalizeStabilityAggregate,
    sampleItems,
    type BatchStabilityMineResult,
    type BatchStabilityRow,
} from "./batch-stability-mine";
import type { Strategy, StrategyParams, BacktestSettings } from "../types/strategies";
import type { CapitalSettings } from "../types/backtest";

class BatchBacktestService {
    private dom: BatchBacktestDom | null = null;
    private initialized = false;
    private cancelled = false;
    private lastResults: BatchBacktestSymbolResult[] = [];
    private lastMinerResult: BatchSyntheticMinerResult | null = null;
    private lastStabilityResult: BatchStabilityMineResult | null = null;
    private lastRunFingerprint: string | null = null;
    private lastRunInterval: string | null = null;
    // Number of result rows already appended to the DOM via onSymbolComplete.
    // Tracked so the post-run path only appends the cancelled back-fill tail
    // instead of rebuilding every row (the runner emits onSymbolComplete in
    // strict input order, so the incremental appends are already ordered).
    private appendedCount = 0;
    // Monotonic run token. A stale run that resumes after a newer run started
    // (e.g. Stop -> Run while the old run is still awaiting executeBacktest)
    // sees its token as stale and stops writing DOM/state, preventing two
    // concurrent runs from racing on `this.lastResults` and the results list.
    private runToken = 0;
    // True when the most recent server-side Run finished with artifacts still
    // on the server (the Mine Timing button is enabled on this flag, NOT on
    // `row.data !== undefined`, because in server-side mode the browser never
    // holds `row.data`).
    private serverHasArtifacts = false;
    // Reattach polling timer id (set when this tab is observing a server-side
    // run that started before page load).
    private reattachTimer: ReturnType<typeof setTimeout> | null = null;

    private getDom(): BatchBacktestDom {
        return this.dom ??= createBatchBacktestDom();
    }

    public init(): void {
        if (this.initialized) {
            return;
        }
        const dom = this.getDom();
        this.bindEvents(dom);
        this.updateSummary(dom);
        this.resetProgress(dom);
        this.initialized = true;
        // Reattach to a server-side run that started before page load. Mirrors
        // IBKR sync's `reattachToInProgressSync` poll on init. Polls every 2s
        // and renders the snapshot rows accumulated server-side so a tab reload
        // mid-run still shows the live progress (2s granularity, not per-symbol).
        void this.reattachToInProgressServerRun();
    }

    private bindEvents(dom: BatchBacktestDom): void {
        dom.batchBacktestRunBtn.addEventListener("click", () => {
            void this.runBatch();
        });
        dom.batchBacktestStopBtn.addEventListener("click", () => {
            this.cancelled = true;
            void this.stopServerRun();
        });
        dom.batchBacktestCopyBtn.addEventListener("click", () => {
            void this.copyResults();
        });
        dom.batchBacktestMineBtn.addEventListener("click", () => {
            void this.runMiner();
        });
        dom.batchBacktestCopyMinerBtn.addEventListener("click", () => {
            void this.copyMinerResults();
        });
        dom.batchBacktestStabilityMineBtn.addEventListener("click", () => {
            void this.runStabilityMine();
        });
        dom.batchBacktestCopyStabilityBtn.addEventListener("click", () => {
            void this.copyStabilityResults();
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
            this.clearStaleResults(dom);
            this.updateSummary(dom);
        });
    }

    private async runBatch(): Promise<void> {
        const dom = this.getDom();
        const symbols = parseBatchSymbols(dom.batchBacktestSymbols.value);
        if (symbols.length === 0) {
            dom.batchBacktestStatus.textContent = "Add at least one pair.";
            return;
        }

        const strategyKey = state.currentStrategyKey;
        await ensureBuiltInStrategyLoaded(strategyKey);
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            dom.batchBacktestStatus.textContent = `Strategy not loaded: ${strategyKey}`;
            return;
        }

        // Read the CURRENT settings once. This is the core contract: Batch
        // replays whatever the user has tuned in the UI right now.
        const strategyParams = paramManager.getValues(strategy);
        const backtestSettings = backtestService.getBacktestSettings();
        const capitalSettings = backtestService.getCapitalSettings();
        const interval = state.currentInterval;
        const runFingerprint = this.buildRunFingerprint(symbols, strategyKey, strategyParams, backtestSettings, capitalSettings, interval);

        // Invalidate any in-flight run and claim this one. The stale run will
        // see its token mismatch after its next await and stop mutating state.
        this.runToken += 1;
        const token = this.runToken;
        this.cancelled = false;
        this.lastResults = [];
        this.lastRunFingerprint = null;
        this.lastRunInterval = null;
        this.appendedCount = 0;
        this.serverHasArtifacts = false;
        this.stopReattachPoll();
        dom.batchBacktestRunBtn.disabled = true;
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestCopyBtn.disabled = true;
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        this.clearMinerResults(dom);
        setVisible(dom.batchBacktestEmpty, false);
        dom.batchBacktestResults.replaceChildren();

        // Server-side mode runs the workload in the Vite dev server process so
        // the browser tab stays bounded for 1000+ pair runs. Browser-side is
        // the legacy in-tab path; retained as a fallback for environments with
        // no dev server (e.g. `vite preview`). See
        // `docs/batch-backtest-server-side.md` for the full contract.
        //
        // `batchExecutionMode` lives on `BacktestSettingsData` (persistence
        // type), not on the narrower `BacktestSettings` runtime type that
        // `backtestService.getBacktestSettings()` returns. Read the DOM select
        // directly — it's the source of truth the user just toggled.
        const useServerMode = this.readBatchExecutionMode() === "server";
        try {
            if (useServerMode) {
                await this.runBatchServer(dom, token, symbols, strategyKey, strategyParams, backtestSettings, capitalSettings, interval, runFingerprint);
            } else {
                await this.runBatchBrowser(dom, token, symbols, strategyKey, strategy, strategyParams, backtestSettings, capitalSettings, interval, runFingerprint);
            }
        } catch (error) {
            if (token !== this.runToken) return;
            const message = error instanceof Error ? error.message : String(error);
            dom.batchBacktestStatus.textContent = `Error: ${message}`;
            debugLogger.error("batch_backtest.run_failed", { error: message });
        } finally {
            // Only restore buttons if this run is still the active one.
            if (token === this.runToken) {
                dom.batchBacktestRunBtn.disabled = false;
                setVisible(dom.batchBacktestStopBtn, false);
                dom.batchBacktestCopyBtn.disabled = this.lastResults.length === 0;
                // In server-side mode the artifacts stay on the server; the
                // Mine button must be gated on the `serverHasArtifacts` flag
                // (set by the `done` event), not on `row.data !== undefined`
                // (the browser never holds `row.data` in this mode).
                dom.batchBacktestMineBtn.disabled = useServerMode
                    ? !this.serverHasArtifacts
                    : !this.hasMineableArtifacts();
                dom.batchBacktestStabilityMineBtn.disabled = useServerMode
                    ? !this.serverHasArtifacts
                    : !this.hasMineableArtifacts();
                this.updateSummary(dom);
                this.setProgress(dom, 100, this.cancelled ? "Stopped" : "Done");
                // The leg/pair LRU was a within-run dedup layer (e.g. ZEC
                // appearing in many pairs fetched once). The run is over, and
                // Mine Timing repopulates only the target-asset datasets it
                // needs. Drop the resolved OHLCV arrays now so they don't sit
                // in memory across Copy / new Run / tab work. If the user
                // clicks Mine next, loadMinerTargets will refetch on miss.
                clearBatchDatasetCaches();
            }
        }
    }

    private async runBatchBrowser(
        dom: BatchBacktestDom,
        token: number,
        symbols: string[],
        strategyKey: string,
        strategy: Strategy,
        strategyParams: StrategyParams,
        backtestSettings: BacktestSettings,
        capitalSettings: CapitalSettings,
        interval: string,
        runFingerprint: string,
    ): Promise<void> {
        const output = await runBatchBacktest(
            {
                interval,
                strategyKey,
                strategy,
                strategyParams,
                backtestSettings,
                capitalSettings,
                symbols,
                loadDataset: (sym, intv, signal) => loadBatchDataset(sym, intv, signal),
            },
            {
                setProgress: (percent, text) => {
                    if (token !== this.runToken) return;
                    this.setProgress(dom, percent, text);
                },
                setStatus: (text) => {
                    if (token !== this.runToken) return;
                    dom.batchBacktestStatus.textContent = text;
                },
                onSymbolComplete: (_index, result) => {
                    if (token !== this.runToken) return;
                    this.lastResults.push(result);
                    this.appendedCount += 1;
                    this.appendResultRow(dom, result);
                },
                isCancelled: () => token !== this.runToken || this.cancelled,
            },
        );
        // A newer run has taken over; leave all UI state to that run.
        if (token !== this.runToken) return;
        this.lastResults = output.results;
        this.lastRunFingerprint = runFingerprint;
        this.lastRunInterval = interval;
        // The runner emits onSymbolComplete in strict input order, so every
        // processed row is already in the DOM. Only the cancelled back-fill
        // tail (slots never processed because Stop broke the loop) needs to
        // be appended here. Avoids a full O(N) rebuild + reflow per run.
        for (let i = this.appendedCount; i < output.results.length; i += 1) {
            this.appendResultRow(dom, output.results[i]);
        }
        this.appendedCount = output.results.length;
        setVisible(dom.batchBacktestEmpty, output.results.length === 0);
        dom.batchBacktestStatus.textContent = this.cancelled
            ? `Stopped (${output.results.length}/${symbols.length} pairs)`
            : `Done (${output.results.length} pairs, ${output.failedSymbols.length} failed)`;
    }

    /**
     * Server-side run path: POST to `/api/batch-backtest/run`, consume the
     * NDJSON stream, and populate `lastResults` with SCALARS ONLY (no `data`,
     * `signals`, or `result.trades`). The server retains the heavy arrays for
     * Mine Timing; the browser tab stays bounded regardless of pair count.
     *
     * Consequence: in this mode the Copy summary renders WITHOUT the B&H rows
     * block and WITHOUT the OPEN_SCORE line (those read array fields). The
     * remaining sections (medians, profitable/losing rows, concentration,
     * robustness) match exactly. See `docs/batch-backtest-server-side.md`.
     */
    private async runBatchServer(
        dom: BatchBacktestDom,
        token: number,
        symbols: string[],
        strategyKey: string,
        strategyParams: StrategyParams,
        backtestSettings: BacktestSettings,
        capitalSettings: CapitalSettings,
        interval: string,
        runFingerprint: string,
    ): Promise<void> {
        const response = await fetch("/api/batch-backtest/run", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                symbols,
                interval,
                strategyKey,
                strategyParams,
                backtestSettings,
                capitalSettings,
                useRustEnginePreference: shouldUseRustEngine(),
            }),
        });
        if (!response.ok || !response.body) {
            const text = await response.text();
            let payload: { error?: string } = {};
            try { payload = JSON.parse(text); } catch { /* ignore */ }
            throw new Error(payload.error ?? `Server run failed (${response.status}).`);
        }

        let doneSummary: string | null = null;
        try {
            await consumeNdjsonStream<BatchStreamEvent>(response.body, {
                onStart: (event: Extract<BatchStreamEvent, { type: "start" }>) => {
                    if (token !== this.runToken) return;
                    dom.batchBacktestStatus.textContent = `Server: 0/${event.total}`;
                },
                onProgress: (event: Extract<BatchStreamEvent, { type: "progress" }>) => {
                    if (token !== this.runToken) return;
                    this.setProgress(dom, event.percent, event.text);
                    dom.batchBacktestStatus.textContent = event.status;
                },
                onSymbol: (event: Extract<BatchStreamEvent, { type: "symbol" }>) => {
                    if (token !== this.runToken) return;
                    this.lastResults.push(event.row);
                    this.appendedCount += 1;
                    this.appendResultRow(dom, event.row);
                },
                onSymbolFailed: (event: Extract<BatchStreamEvent, { type: "symbol_failed" }>) => {
                    if (token !== this.runToken) return;
                    debugLogger.warn("batch.server.symbol_failed", {
                        symbol: event.symbol, index: event.index, error: event.error,
                    });
                },
                onDone: (event: Extract<BatchStreamEvent, { type: "done" }>) => {
                    if (token !== this.runToken) return;
                    this.lastRunFingerprint = runFingerprint;
                    this.lastRunInterval = interval;
                    this.serverHasArtifacts = event.serverHasArtifacts === true;
                    doneSummary = event.summary;
                    setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
                    dom.batchBacktestStatus.textContent = doneSummary;
                },
                onFatal: (event: Extract<BatchStreamEvent, { type: "fatal" }>) => {
                    if (token !== this.runToken) return;
                    throw new Error(event.error);
                },
            });
        } catch (error) {
            if (token !== this.runToken) return;
            if (doneSummary === null) {
                const recovered = await this.recoverCompletedServerRun(dom, runFingerprint, interval);
                if (!recovered) {
                    throw error;
                }
                doneSummary = recovered;
            } else {
                debugLogger.warn("batch.server.stream_closed_after_done", {
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        }
        if (token !== this.runToken) return;
        if (doneSummary !== null) {
            dom.batchBacktestStatus.textContent = doneSummary;
        }
    }

    private async recoverCompletedServerRun(
        dom: BatchBacktestDom,
        runFingerprint: string,
        interval: string,
    ): Promise<string | null> {
        try {
            const response = await fetch("/api/batch-backtest/status", { cache: "no-store" });
            if (!response.ok) return null;
            const payload = await response.json() as {
                running?: boolean;
                lastRun?: {
                    rowCount?: number;
                    hasArtifacts?: boolean;
                    fingerprint?: string | null;
                    interval?: string | null;
                } | null;
            };
            const lastRun = payload.lastRun;
            if (payload.running || !lastRun || lastRun.fingerprint !== runFingerprint) {
                return null;
            }
            this.lastRunFingerprint = runFingerprint;
            this.lastRunInterval = lastRun.interval ?? interval;
            this.serverHasArtifacts = lastRun.hasArtifacts === true;
            setVisible(dom.batchBacktestEmpty, this.lastResults.length === 0);
            dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts;
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts;
            const rowCount = this.lastResults.length || Math.max(0, Math.floor(Number(lastRun.rowCount ?? 0)));
            return `Done (${rowCount} pairs)`;
        } catch (error) {
            debugLogger.warn("batch.server.recover_completed_run_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
    }

    private async copyResults(): Promise<void> {
        if (this.lastResults.length === 0) return;
        const text = formatBatchOverallSummary(this.lastResults).join("\n");
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Clipboard can fail in non-secure contexts; fall back silently.
        }
    }

    private async runMiner(): Promise<void> {
        const dom = this.getDom();
        if (this.lastResults.length === 0 && !this.serverHasArtifacts) {
            dom.batchBacktestMinerSummary.textContent = "Run Batch first.";
            return;
        }
        if (!this.lastRunFingerprint) {
            dom.batchBacktestMinerSummary.textContent = "Rerun Batch before mining; settings or symbols changed.";
            dom.batchBacktestCopyMinerBtn.disabled = true;
            return;
        }
        if (!this.serverHasArtifacts) {
            const currentFingerprint = this.buildCurrentRunFingerprint();
            if (!currentFingerprint || currentFingerprint !== this.lastRunFingerprint) {
                dom.batchBacktestMinerSummary.textContent = "Rerun Batch before mining; settings or symbols changed.";
                dom.batchBacktestCopyMinerBtn.disabled = true;
                return;
            }
        }

        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestMinerSummary.textContent = this.serverHasArtifacts ? "Mining on server..." : "Loading target assets...";
        dom.batchBacktestMinerResults.replaceChildren();

        // Server-side mode: artifacts live on the server. Stream verdicts back
        // via the `/api/batch-backtest/mine` NDJSON endpoint. The browser only
        // reconstructs the per-verdict rows; it never holds the pair artifacts
        // (data/signals/result.trades) that the server-side Run kept.
        if (this.serverHasArtifacts) {
            await this.runMinerServer(dom);
            return;
        }

        const pairArtifacts = this.buildMinerPairArtifacts();
        if (pairArtifacts.length === 0) {
            dom.batchBacktestMinerSummary.textContent = "No completed synthetic pair artifacts to mine.";
            dom.batchBacktestCopyMinerBtn.disabled = true;
            return;
        }

        try {
            const targets = await this.loadMinerTargets(pairArtifacts, this.lastRunInterval ?? state.currentInterval);
            if (targets.length === 0) {
                this.lastMinerResult = null;
                dom.batchBacktestMinerSummary.textContent = "No target asset candles loaded.";
                return;
            }
            dom.batchBacktestMinerSummary.textContent = "Mining timing analogs...";
            const result = runBatchSyntheticStateMiner({
                interval: this.lastRunInterval ?? state.currentInterval,
                targets,
                artifacts: pairArtifacts,
            });
            this.lastMinerResult = result;
            this.renderMinerResult(dom, result);
            dom.batchBacktestCopyMinerBtn.disabled = result.verdicts.length === 0;
            debugLogger.event("batch_synthetic_miner.complete", {
                pairs: pairArtifacts.length,
                targets: targets.length,
                verdicts: result.verdicts.length,
            });
            // The miner was the last consumer of the per-row OHLCV / signal /
            // trade arrays. Drop them so a 1000-pair run doesn't keep ~5 GB
            // of artifacts alive after Mine. Scalars, tradeSummary, and the
            // DOM rows are unaffected, so the result list and Copy summary
            // (minus the OPEN_SCORE line, which read result.trades) still
            // render. Re-mining the same run now requires a fresh Run, which
            // matches the existing fingerprint guard.
            for (const row of this.lastResults) {
                row.data = undefined;
                row.signals = undefined;
                if (row.result) {
                    row.result.trades = [];
                }
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastMinerResult = null;
            dom.batchBacktestMinerSummary.textContent = `Miner error: ${message}`;
            debugLogger.error("batch_synthetic_miner.failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.hasMineableArtifacts();
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
            // The leg/pair caches existed to feed Mine; the miner reads
            // pairArtifacts into its own working set on entry, so the shared
            // LRU no longer needs the resolved arrays. Drop them so the next
            // action (Copy, new Run, tab work) doesn't carry them.
            clearBatchDatasetCaches();
        }
    }

    /**
     * Server-side Mine path: stream verdicts from `/api/batch-backtest/mine`.
     * The server retains artifacts from the run; the browser only reconstructs
     * per-verdict rows for display. After completion the server releases its
     * artifact copy and the browser-side `serverHasArtifacts` flag is cleared
     * so the user must Run again before re-mining (mirrors the fingerprint
     * guard on the browser path).
     */
    private async runMinerServer(dom: BatchBacktestDom): Promise<void> {
        try {
            const response = await fetch("/api/batch-backtest/mine", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval,
                }),
            });
            if (!response.ok || !response.body) {
                const text = await response.text();
                let payload: { error?: string } = {};
                try { payload = JSON.parse(text); } catch { /* ignore */ }
                throw new Error(payload.error ?? `Server mine failed (${response.status}).`);
            }
            const verdicts: BatchSyntheticAssetVerdict[] = [];
            let minerInterval = this.lastRunInterval ?? state.currentInterval;
            await consumeNdjsonStream<BatchMinerStreamEvent>(response.body, {
                onStart: (event: Extract<BatchMinerStreamEvent, { type: "start" }>) => {
                    dom.batchBacktestMinerSummary.textContent = `Mining on server — ${event.assets} assets / ${event.pairs} pairs`;
                },
                onVerdict: (event: Extract<BatchMinerStreamEvent, { type: "verdict" }>) => {
                    verdicts.push(event.verdict);
                    dom.batchBacktestMinerResults.appendChild(this.createMinerRow(event.verdict));
                },
                onDone: (event: Extract<BatchMinerStreamEvent, { type: "done" }>) => {
                    dom.batchBacktestMinerSummary.textContent = event.summary;
                },
                onFatal: (event: Extract<BatchMinerStreamEvent, { type: "fatal" }>) => {
                    throw new Error(event.error);
                },
            });
            this.lastMinerResult = {
                interval: minerInterval,
                options: BATCH_SYNTHETIC_MINER_DEFAULT_OPTIONS,
                verdicts,
                diagnostics: [],
            };
            dom.batchBacktestMinerSummary.textContent = formatMinerSummary(this.lastMinerResult);
            dom.batchBacktestCopyMinerBtn.disabled = verdicts.length === 0;
            // Server has released its artifacts; Mine cannot run again until a
            // new server-side Run produces them.
            this.serverHasArtifacts = false;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastMinerResult = null;
            dom.batchBacktestMinerSummary.textContent = `Miner error: ${message}`;
            debugLogger.error("batch_synthetic_miner.server_failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
        }
    }

    private async stopServerRun(): Promise<void> {
        try {
            await fetch("/api/batch-backtest/stop", { method: "POST" });
        } catch (error) {
            debugLogger.warn("batch.server.stop_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }
    }

    /**
     * Read the `batchExecutionMode` select. Mirrors how `getEnginePreference`
     * reads `useRustEngineToggle` directly from the DOM — both ids live in the
     * `Backend Engine` settings section. Returns `"server"` when the select is
     * missing (default is server-side; see settings-model.ts).
     */
    private readBatchExecutionMode(): "server" | "browser" {
        const select = document.getElementById("batchExecutionMode") as HTMLSelectElement | null;
        if (!select) return "server";
        return select.value === "browser" ? "browser" : "server";
    }

    private stopReattachPoll(): void {
        if (this.reattachTimer) {
            clearTimeout(this.reattachTimer);
            this.reattachTimer = null;
        }
    }

    /**
     * Polls `GET /api/batch-backtest/status` on init. If a run is in flight on
     * the server (started before this tab opened), renders the snapshot rows
     * accumulated so far and long-polls every 2s until the run ends, then
     * renders the final summary. Mirrors IBKR sync's reattach pattern.
     *
     * Granularity is 2s (not per-symbol) because the server's NDJSON stream is
     * owned by the connection that started the run; this poll snapshots the
     * shared in-progress state instead of tapping the stream from a second
     * connection. Single-user dev server, so a multi-subscriber stream tap is
     * not worth the complexity.
     */
    private async reattachToInProgressServerRun(): Promise<void> {
        const POLL_INTERVAL_MS = 2000;
        const MAX_POLLS = 150; // 5 minutes, matching IBKR sync's cap.
        try {
            for (let poll = 0; poll < MAX_POLLS; poll += 1) {
                const response = await fetch("/api/batch-backtest/status", { cache: "no-store" });
                const payload = await response.json() as {
                    running?: boolean;
                    run?: {
                        total: number;
                        completed: number;
                        failed: number;
                        currentSymbol: string | null;
                        cancelled: boolean;
                        interval: string;
                        strategyKey: string;
                        rows: BatchBacktestSymbolResult[];
                    } | null;
                    lastRun?: {
                        rowCount: number;
                        hasArtifacts: boolean;
                        fingerprint: string | null;
                        interval?: string | null;
                    } | null;
                };
                if (!payload.running || !payload.run) {
                    // Adopt any leftover server-side artifacts (Mine Timing
                    // can still run against the prior run if it hasn't TTL'd).
                    if (payload.lastRun && payload.lastRun.hasArtifacts && payload.lastRun.fingerprint && this.lastResults.length === 0) {
                        this.serverHasArtifacts = true;
                        this.lastRunFingerprint = payload.lastRun.fingerprint;
                        this.lastRunInterval = payload.lastRun.interval ?? null;
                        // The browser does not have the per-row scalars for the
                        // prior run (the tab reloaded), but server-side Mine
                        // and Stability Mine can still consume retained
                        // artifacts before their TTL expires.
                        this.getDom().batchBacktestMineBtn.disabled = !this.serverHasArtifacts;
                        this.getDom().batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts;
                    }
                    return;
                }
                const run = payload.run;
                this.serverHasArtifacts = false; // still running; Mine not yet available.
                const dom = this.getDom();
                dom.batchBacktestRunBtn.disabled = true;
                setVisible(dom.batchBacktestStopBtn, true);
                if (this.lastResults.length === 0 && run.rows.length > 0) {
                    dom.batchBacktestResults.replaceChildren();
                }
                if (run.rows.length > this.lastResults.length) {
                    for (let i = this.lastResults.length; i < run.rows.length; i += 1) {
                        const row = run.rows[i]!;
                        this.lastResults.push(row);
                        this.appendedCount += 1;
                        this.appendResultRow(dom, row);
                    }
                }
                const seen = run.completed + run.failed;
                const current = run.currentSymbol ? ` — ${run.currentSymbol}` : "";
                dom.batchBacktestStatus.textContent = `Server run ${seen}/${run.total}${current}`;
                this.setProgress(dom, run.total > 0 ? (seen / run.total) * 100 : 0, `${seen}/${run.total}`);
                await new Promise((resolve) => {
                    this.reattachTimer = setTimeout(resolve, POLL_INTERVAL_MS);
                });
            }
            this.getDom().batchBacktestStatus.textContent = "Server run still in progress after 5 min — stopped watching. Click Stop or retry.";
        } catch (error) {
            debugLogger.warn("batch.server.reattach_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            this.stopReattachPoll();
        }
    }

    private async copyMinerResults(): Promise<void> {
        if (!this.lastMinerResult) return;
        const text = formatMinerCopy(this.lastMinerResult);
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Clipboard can fail in non-secure contexts; fall back silently.
        }
    }

    private async runStabilityMine(): Promise<void> {
        const dom = this.getDom();
        if (this.lastResults.length === 0 && !this.serverHasArtifacts) {
            dom.batchBacktestMinerSummary.textContent = "Run Batch first.";
            return;
        }
        const currentFingerprint = this.buildCurrentRunFingerprint();
        if (!currentFingerprint || currentFingerprint !== this.lastRunFingerprint) {
            dom.batchBacktestMinerSummary.textContent = "Rerun Batch before stability mining; settings or symbols changed.";
            dom.batchBacktestCopyStabilityBtn.disabled = true;
            return;
        }
        const pairArtifacts = this.buildMinerPairArtifacts();
        if (this.serverHasArtifacts && pairArtifacts.length === 0) {
            await this.runStabilityMineServer(dom);
            return;
        }
        if (pairArtifacts.length === 0) {
            dom.batchBacktestMinerSummary.textContent = "No completed synthetic pair artifacts to stability mine.";
            dom.batchBacktestCopyStabilityBtn.disabled = true;
            return;
        }

        const subsetSize = this.readClampedInt(dom.batchBacktestStabilitySubsetSize.value, 200, 10, pairArtifacts.length);
        const reruns = this.readClampedInt(dom.batchBacktestStabilityReruns.value, 50, 1, 200);
        const seed = this.readClampedInt(dom.batchBacktestStabilitySeed.value, 1, 1, Number.MAX_SAFE_INTEGER);
        dom.batchBacktestStabilitySubsetSize.value = String(subsetSize);
        dom.batchBacktestStabilityReruns.value = String(reruns);
        dom.batchBacktestStabilitySeed.value = String(seed);

        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestCopyStabilityBtn.disabled = true;
        dom.batchBacktestMinerSummary.textContent = "Loading target assets for stability mine...";
        dom.batchBacktestMinerResults.replaceChildren();

        try {
            const targets = await this.loadMinerTargets(pairArtifacts, this.lastRunInterval ?? state.currentInterval);
            if (targets.length === 0) {
                this.lastStabilityResult = null;
                dom.batchBacktestMinerSummary.textContent = "No target asset candles loaded.";
                return;
            }

            const aggregate = createStabilityAggregate(reruns, subsetSize, seed, pairArtifacts.length);
            for (let runIndex = 0; runIndex < reruns; runIndex += 1) {
                const subset = sampleItems(pairArtifacts, subsetSize, seed + runIndex);
                const subsetAssets = new Set(subset.flatMap((artifact) => [artifact.baseAsset, artifact.quoteAsset]));
                const subsetTargets = targets.filter((target) => subsetAssets.has(target.asset));
                const result = runBatchSyntheticStateMiner({
                    interval: this.lastRunInterval ?? state.currentInterval,
                    targets: subsetTargets,
                    artifacts: subset,
                });
                addStabilityVerdicts(aggregate, result.verdicts);
                dom.batchBacktestMinerSummary.textContent = `Stability mining ${runIndex + 1}/${reruns} | hits ${aggregate.hitEvents}`;
                if ((runIndex + 1) % 5 === 0) {
                    await yieldToUi();
                }
            }

            this.lastStabilityResult = finalizeStabilityAggregate(aggregate);
            this.renderStabilityResult(dom, this.lastStabilityResult);
            dom.batchBacktestCopyStabilityBtn.disabled = this.lastStabilityResult.rows.length === 0;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastStabilityResult = null;
            dom.batchBacktestMinerSummary.textContent = `Stability miner error: ${message}`;
            debugLogger.error("batch_stability_miner.failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.hasMineableArtifacts();
            dom.batchBacktestStabilityMineBtn.disabled = !this.hasMineableArtifacts();
            clearBatchDatasetCaches();
        }
    }

    private async runStabilityMineServer(dom: BatchBacktestDom): Promise<void> {
        const subsetSize = this.readClampedInt(dom.batchBacktestStabilitySubsetSize.value, 200, 10, Number.MAX_SAFE_INTEGER);
        const reruns = this.readClampedInt(dom.batchBacktestStabilityReruns.value, 50, 1, 200);
        const seed = this.readClampedInt(dom.batchBacktestStabilitySeed.value, 1, 1, Number.MAX_SAFE_INTEGER);
        dom.batchBacktestStabilitySubsetSize.value = String(subsetSize);
        dom.batchBacktestStabilityReruns.value = String(reruns);
        dom.batchBacktestStabilitySeed.value = String(seed);

        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestCopyStabilityBtn.disabled = true;
        dom.batchBacktestMinerSummary.textContent = "Stability mining on server...";
        dom.batchBacktestMinerResults.replaceChildren();

        try {
            const response = await fetch("/api/batch-backtest/stability-mine", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                    fingerprint: this.lastRunFingerprint,
                    interval: this.lastRunInterval ?? state.currentInterval,
                    subsetSize,
                    reruns,
                    seed,
                }),
            });
            if (!response.ok || !response.body) {
                const text = await response.text().catch(() => "");
                throw new Error(text || `HTTP ${response.status}`);
            }
            const received: { result: BatchStabilityMineResult | null } = { result: null };
            await consumeNdjsonStream(response.body, {
                onProgress: (event: { run?: number; reruns?: number; hits?: number }) => {
                    dom.batchBacktestMinerSummary.textContent = `Stability mining on server ${event.run ?? 0}/${event.reruns ?? reruns} | hits ${event.hits ?? 0}`;
                },
                onDone: (event: { result?: BatchStabilityMineResult }) => {
                    received.result = event.result ?? null;
                },
                onFatal: (event: { error?: string }) => {
                    throw new Error(event.error || "Server stability mine failed.");
                },
            });
            if (!received.result) {
                throw new Error("Server stability mine did not return a result.");
            }
            this.lastStabilityResult = received.result;
            this.renderStabilityResult(dom, received.result);
            dom.batchBacktestCopyStabilityBtn.disabled = received.result.rows.length === 0;
            this.serverHasArtifacts = false;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastStabilityResult = null;
            dom.batchBacktestMinerSummary.textContent = `Stability miner error: ${message}`;
            debugLogger.error("batch_stability_miner.server_failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
            dom.batchBacktestStabilityMineBtn.disabled = !this.serverHasArtifacts && !this.hasMineableArtifacts();
        }
    }

    private async copyStabilityResults(): Promise<void> {
        if (!this.lastStabilityResult) return;
        const text = formatStabilityCopy(this.lastStabilityResult);
        try {
            await navigator.clipboard.writeText(text);
        } catch {
            // Clipboard can fail in non-secure contexts; fall back silently.
        }
    }

    private buildMinerPairArtifacts(): BatchSyntheticPairArtifact[] {
        const artifacts: BatchSyntheticPairArtifact[] = [];
        for (const row of this.lastResults) {
            if (!row.result || !row.data || !row.signals) {
                continue;
            }
            const parsed = parsePortfolioSyntheticPairSymbol(row.symbol);
            if (!parsed) {
                continue;
            }
            artifacts.push({
                symbol: row.symbol,
                baseAsset: parsed.baseAsset,
                quoteAsset: parsed.quoteAsset,
                baseSymbol: parsed.baseSymbol,
                quoteSymbol: parsed.quoteSymbol,
                data: row.data,
                signals: row.signals,
                result: row.result,
            });
        }
        return artifacts;
    }

    private async loadMinerTargets(
        pairArtifacts: readonly BatchSyntheticPairArtifact[],
        interval: string
    ): Promise<BatchSyntheticTargetArtifact[]> {
        const assets = Array.from(new Set(
            pairArtifacts.flatMap((artifact) => [artifact.baseAsset, artifact.quoteAsset])
                .map((asset) => asset.trim().toUpperCase())
                .filter(Boolean)
        )).sort();
        // Resolve each stripped asset back to the symbol the loader expects.
        // Crypto pairs (e.g. ZEC+APT) become `ZECUSDT` via the USDT suffix.
        // Marked legs carry their provider routing inline (bullet `•` for
        // IBKR, diamond `♦` for stock_market_data); for those, the stripped
        // `baseAsset`/`quoteAsset` is NOT a Binance ticker, so appending
        // `USDT` would produce a symbol no provider can serve (the cause of
        // "No target asset candles loaded." on IBKR batches). Prefer the
        // original marked symbol when one survives from the parsed pair.
        const markedSymbolByAsset = new Map<string, string>();
        for (const artifact of pairArtifacts) {
            for (const [asset, symbol] of [
                [artifact.baseAsset, artifact.baseSymbol],
                [artifact.quoteAsset, artifact.quoteSymbol],
            ] as const) {
                const key = asset?.trim().toUpperCase();
                if (key && symbol && !markedSymbolByAsset.has(key)) {
                    markedSymbolByAsset.set(key, symbol);
                }
            }
        }
        // Load target datasets with bounded concurrency. Each load is
        // independent (loadBatchDataset goes through the shared LRU caches and
        // dataManager.fetchDataDetached, both safe under concurrency), and the
        // previous sequential `for...await` serialized ~16 network reads. On 4H
        // each target has a deep history, so this was the dominant wall clock
        // cost of Mine. Bounded at 8 in flight so an 80-asset IBKR/stock batch
        // doesn't pin ~80 full datasets in memory at the same instant.
        // Per-target errors are isolated so one failed asset does not reject
        // the batch.
        const BATCH_MINER_TARGET_LOAD_CONCURRENCY = 8;
        const loaded = await mapWithConcurrencyLimit(
            assets,
            BATCH_MINER_TARGET_LOAD_CONCURRENCY,
            async (asset): Promise<BatchSyntheticTargetArtifact | null> => {
                const symbol = markedSymbolByAsset.get(asset) ?? resolveBatchSyntheticTargetSymbol(asset);
                try {
                    const data = await loadBatchDataset(symbol, interval);
                    if (Array.isArray(data) && data.length > 0) {
                        return { asset, symbol, data };
                    }
                    return null;
                } catch (error) {
                    debugLogger.warn("batch_synthetic_miner.target_load_failed", {
                        asset,
                        symbol,
                        error: error instanceof Error ? error.message : String(error),
                    });
                    return null;
                }
            },
        );
        // Preserve the sorted asset order; drop failed/empty loads.
        return loaded.filter((entry): entry is BatchSyntheticTargetArtifact => entry !== null);
    }

    private buildCurrentRunFingerprint(): string | null {
        const strategyKey = state.currentStrategyKey;
        const strategy = strategyRegistry.get(strategyKey);
        if (!strategy) {
            return null;
        }
        return this.buildRunFingerprint(
            parseBatchSymbols(this.getDom().batchBacktestSymbols.value),
            strategyKey,
            paramManager.getValues(strategy),
            backtestService.getBacktestSettings(),
            backtestService.getCapitalSettings(),
            state.currentInterval
        );
    }

    private buildRunFingerprint(
        symbols: readonly string[],
        strategyKey: string,
        strategyParams: unknown,
        backtestSettings: unknown,
        capitalSettings: unknown,
        interval: string
    ): string {
        return JSON.stringify({
            symbols,
            strategyKey,
            strategyParams,
            backtestSettings,
            capitalSettings,
            interval,
        });
    }

    private hasMineableArtifacts(): boolean {
        return this.lastResults.some((row) => Boolean(row.result && row.data && row.signals && parsePortfolioSyntheticPairSymbol(row.symbol)));
    }

    private clearMinerResults(dom: BatchBacktestDom): void {
        this.lastMinerResult = null;
        this.lastStabilityResult = null;
        dom.batchBacktestMinerSummary.textContent = "Miner idle";
        dom.batchBacktestMinerResults.replaceChildren();
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestCopyStabilityBtn.disabled = true;
    }

    private renderMinerResult(dom: BatchBacktestDom, result: BatchSyntheticMinerResult): void {
        dom.batchBacktestMinerResults.replaceChildren();
        dom.batchBacktestMinerSummary.textContent = formatMinerSummary(result);
        for (const verdict of result.verdicts) {
            dom.batchBacktestMinerResults.appendChild(this.createMinerRow(verdict));
        }
    }

    private createMinerRow(verdict: BatchSyntheticAssetVerdict): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "finder-sub finder-symbol-row";
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${getMinerVerdictClass(verdict.verdict)}`;
        badge.textContent = verdict.verdict;
        line.appendChild(badge);
        line.appendChild(document.createTextNode(` ${formatMinerRowPipe(verdict)}`));
        return line;
    }

    private renderStabilityResult(dom: BatchBacktestDom, result: BatchStabilityMineResult): void {
        dom.batchBacktestMinerResults.replaceChildren();
        dom.batchBacktestMinerSummary.textContent = formatStabilitySummary(result);
        for (const row of result.rows) {
            const line = document.createElement("div");
            line.className = "finder-sub finder-symbol-row";
            const badge = document.createElement("span");
            badge.className = "finder-verdict finder-verdict-strong";
            badge.textContent = row.direction;
            line.appendChild(badge);
            line.appendChild(document.createTextNode(` ${formatStabilityRow(row, result.reruns)}`));
            dom.batchBacktestMinerResults.appendChild(line);
        }
    }

    // --------------------------------------------------------------------
    // Rendering
    // --------------------------------------------------------------------

    private appendResultRow(dom: BatchBacktestDom, result: BatchBacktestSymbolResult): void {
        dom.batchBacktestResults.appendChild(this.createResultRow(result));
    }

    private clearStaleResults(dom: BatchBacktestDom): void {
        this.clearMinerResults(dom);
        this.lastRunFingerprint = null;
        this.lastRunInterval = null;
        this.serverHasArtifacts = false;
        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestStabilityMineBtn.disabled = true;
        if (this.lastResults.length === 0) return;
        this.lastResults = [];
        this.appendedCount = 0;
        dom.batchBacktestCopyBtn.disabled = true;
    }

    private createResultRow(result: BatchBacktestSymbolResult): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "finder-sub finder-symbol-row";

        const verdict = computePerformanceVerdict(result.result, result.status);
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${verdict.cssClass}`;
        badge.textContent = verdict.label;
        line.appendChild(badge);

        line.appendChild(document.createTextNode(` ${formatResultRowPipe(result)}`));
        return line;
    }

    // --------------------------------------------------------------------
    // Progress / summary helpers
    // --------------------------------------------------------------------

    private setProgress(dom: BatchBacktestDom, percent: number, text: string): void {
        dom.batchBacktestProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.batchBacktestProgressText.textContent = text;
    }

    private resetProgress(dom: BatchBacktestDom): void {
        this.setProgress(dom, 0, "Ready");
        dom.batchBacktestStatus.textContent = "Idle";
    }

    private updateSummary(dom: BatchBacktestDom): void {
        if (this.lastResults.length > 0) {
            dom.batchBacktestSummary.textContent = formatBatchSummaryLine(this.lastResults);
            return;
        }
        const count = parseBatchSymbols(dom.batchBacktestSymbols.value).length;
        dom.batchBacktestSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
    }

    private readClampedInt(raw: string, fallback: number, min: number, max: number): number {
        const parsed = Number.parseInt(raw, 10);
        const value = Number.isFinite(parsed) ? parsed : fallback;
        return Math.max(min, Math.min(max, Math.floor(value)));
    }
}

function yieldToUi(): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, 0));
}

function formatStabilitySummary(result: BatchStabilityMineResult): string {
    return [
        "Stability",
        `Runs ${result.reruns}`,
        `Subset ${result.subsetSize}/${result.totalPairs}`,
        `Seed ${result.seed}`,
        `Signals ${result.rows.length}`,
        `Hits ${result.hitEvents}`,
    ].join(" | ");
}

function formatStabilityRow(row: BatchStabilityRow, reruns: number): string {
    return [
        row.asset,
        `Dir ${row.direction}`,
        `Hit ${row.hits}/${reruns} (${formatPercent((row.hits / Math.max(1, reruns)) * 100)})`,
        `High ${row.high}`,
        `Med ${row.medium}`,
        `Low ${row.low}`,
        `Ret ${formatSignedPercent(row.medianRetPct)}`,
        `Lift ${formatSignedPercent(row.medianLiftPct)}`,
        `RR ${formatRatio(row.medianRr)}`,
        `Dist ${formatNumber(row.medianDist, 2)}`,
        `HMaxLift ${formatSignedPercent(row.medianHmaxLiftPct)}`,
        `PairWarn ${row.pairWarnings}`,
    ].join(" | ");
}

function formatStabilityCopy(result: BatchStabilityMineResult): string {
    const lines = [formatStabilitySummary(result)];
    for (const row of result.rows) {
        lines.push(`STABILITY | ${formatStabilityRow(row, result.reruns)}`);
    }
    return lines.join("\n");
}

interface BatchOverallStats {
    completedRows: BatchBacktestSymbolResult[];
    resultRows: BatchBacktestSymbolResult[];
    profitableRows: BatchBacktestSymbolResult[];
    losingRows: BatchBacktestSymbolResult[];
    noTradeRows: BatchBacktestSymbolResult[];
    failedRows: BatchBacktestSymbolResult[];
    totalNet: number;
    totalTrades: number;
    totalWinningTrades: number;
    grossProfit: number;
    grossLossAbs: number;
    verdictCounts: Map<string, number>;
}

function formatBatchSummaryLine(results: readonly BatchBacktestSymbolResult[]): string {
    const stats = summarizeBatchResults(results);
    if (stats.resultRows.length === 0) {
        return `${stats.completedRows.length} pair${stats.completedRows.length === 1 ? "" : "s"}`;
    }
    return [
        `${stats.resultRows.length} tested`,
        `${stats.profitableRows.length} profitable`,
        `Net ${formatCurrency(stats.totalNet)}`,
        `Trades ${stats.totalTrades}`,
        `Avg/Trade ${formatCurrency(resolveAggregateExpectancy(stats))}`,
        `Med Exposure ${formatPercent(medianMetric(stats.resultRows, (row) => row.tradeSummary?.exposurePercent ?? null))}`,
    ].join(" | ");
}

function formatBatchOverallSummary(results: readonly BatchBacktestSymbolResult[]): string[] {
    const stats = summarizeBatchResults(results);
    if (stats.resultRows.length === 0) {
        return [`SUMMARY | Pairs ${stats.completedRows.length} | No completed backtests`];
    }

    const tradeWinRate = stats.totalTrades > 0
        ? (stats.totalWinningTrades / stats.totalTrades) * 100
        : null;
    const aggregateExpectancy = resolveAggregateExpectancy(stats);
    const aggregateProfitFactor = resolveAggregateProfitFactor(stats);
    const verdictText = formatVerdictCounts(stats.verdictCounts);
    const best = maxBy(stats.resultRows, (row) => row.result?.netProfit ?? Number.NEGATIVE_INFINITY);
    const worst = minBy(stats.resultRows, (row) => row.result?.netProfit ?? Number.POSITIVE_INFINITY);

    const lines = [
        [
            "SUMMARY",
            `Pairs ${stats.completedRows.length}`,
            `Tested ${stats.resultRows.length}`,
            `Profitable ${stats.profitableRows.length}/${stats.resultRows.length} (${formatPercent((stats.profitableRows.length / stats.resultRows.length) * 100)})`,
            `Losing ${stats.losingRows.length}`,
            `No Trades ${stats.noTradeRows.length}`,
            `Failed ${stats.failedRows.length}`,
            verdictText,
        ].filter(Boolean).join(" | "),
        [
            "SUMMARY",
            `Total Net ${formatCurrency(stats.totalNet)}`,
            `Avg Net/Pair ${formatCurrency(stats.totalNet / stats.resultRows.length)}`,
            `Median Net ${formatCurrency(medianMetric(stats.resultRows, (row) => row.result?.netProfit ?? null))}`,
            best ? `Best ${best.symbol} ${formatCurrency(best.result!.netProfit)}` : "",
            worst ? `Worst ${worst.symbol} ${formatCurrency(worst.result!.netProfit)}` : "",
        ].filter(Boolean).join(" | "),
        [
            "SUMMARY",
            `Trades ${stats.totalTrades}`,
            `Trade WR ${formatPercent(tradeWinRate)}`,
            `Avg/Trade ${formatCurrency(aggregateExpectancy)}`,
            `PF ${formatProfitFactor(aggregateProfitFactor ?? Number.NaN)}`,
            `Median Trades ${formatNumber(medianMetric(stats.resultRows, (row) => row.result?.totalTrades ?? null), 0)}`,
            `Median AvgTrade ${formatCurrency(medianMetric(stats.resultRows, (row) => row.result?.avgTrade ?? null))}`,
            `Median Sharpe ${formatNumber(medianMetric(stats.resultRows, (row) => row.result?.sharpeRatio ?? null), 2)}`,
            `Median DD ${formatPercent(medianMetric(stats.resultRows, (row) => row.result?.maxDrawdownPercent ?? null))}`,
        ].join(" | "),
        [
            "SUMMARY",
            `Median Hold ${formatHoldSummary(medianMetric(stats.resultRows, (row) => row.tradeSummary?.avgHoldBars ?? null), medianMetric(stats.resultRows, (row) => row.tradeSummary?.avgHoldDays ?? null))}`,
            `Median MaxHold ${formatHoldSummary(medianMetric(stats.resultRows, (row) => row.tradeSummary?.maxHoldBars ?? null), medianMetric(stats.resultRows, (row) => row.tradeSummary?.maxHoldDays ?? null))}`,
            `Median Exposure ${formatPercent(medianMetric(stats.resultRows, (row) => row.tradeSummary?.exposurePercent ?? null))}`,
        ].join(" | "),
    ];

    // Buy-and-hold comparison. B&H is always long-the-series (the ratio
    // series for synthetic pairs, the asset itself for singles), so Alpha =
    // Strategy Net% - B&H% is the same alpha-vs-beta read used by
    // signal-committee-edge. Aggregate uses MEDIAN alpha (mean is meaningless
    // here: a few +9000% B&H pairs dominate it). Per-pair output is trimmed to
    // top/bottom 5 by alpha instead of dumping every row.
    const bhRows = buildBuyHoldRows(stats.resultRows);

    if (bhRows.length > 0) {
        const medStrat = median(bhRows.map((r) => r.strat));
        const medBh = median(bhRows.map((r) => r.bh));
        const medAlpha = median(bhRows.map((r) => r.alpha));
        const avgAlpha = mean(bhRows.map((r) => r.alpha));
        lines.push(
            [
                "SUMMARY",
                `B&H Compare ${bhRows.length}/${stats.resultRows.length} pairs`,
                `Med Strat ${formatSignedPercent(medStrat)}`,
                `Med B&H ${formatSignedPercent(medBh)}`,
                `Med Alpha ${formatSignedPercent(medAlpha)}`,
                `Avg Alpha ${formatSignedPercent(avgAlpha)}`,
            ].join(" | "),
        );

        // Regime split: separates "defensive utility" (downtrend alpha) from
        // "trend capture" (uptrend alpha). A strategy that only wins by
        // avoiding crashes shows positive alpha in the down bucket and
        // negative in the up bucket — a completely different read from the
        // combined headline.
        const regime = summarizeRegimeSplit(bhRows);
        lines.push(
            [
                "REGIME",
                `Uptrend ${regime.up.count} pairs | Strat ${formatSignedPercent(regime.up.avgStrat)} | B&H ${formatSignedPercent(regime.up.avgBh)} | Alpha ${formatSignedPercent(regime.up.avgAlpha)}`,
                `Down ${regime.down.count} pairs | Strat ${formatSignedPercent(regime.down.avgStrat)} | B&H ${formatSignedPercent(regime.down.avgBh)} | Alpha ${formatSignedPercent(regime.down.avgAlpha)}`,
            ].join(" | "),
        );

        // Per-pair B&H detail: one line per pair, sorted by symbol so a
        // specific pair is easy to find in the dump. The full table is kept
        // (rather than a top/bottom-N digest) on request — useful when
        // comparing two strategies pair-by-pair.
        const sortedBySymbol = [...bhRows].sort((a, b) => a.symbol.localeCompare(b.symbol));
        for (const row of sortedBySymbol) {
            lines.push(
                `B&H | ${row.symbol} | Strat ${formatSignedPercent(row.strat)} | B&H ${formatSignedPercent(row.bh)} | Alpha ${formatSignedPercent(row.alpha)}`,
            );
        }
    }

    // Profit concentration: how much of the headline Net comes from a few
    // outliers. "Avg Net/Pair" vs "Median Net" hints at this; the concentration
    // line makes it unmissable. If top-3 = 50% of Net, "110 pairs" is really
    // a 3-pair result and the rest are window dressing.
    const concentration = summarizeProfitConcentration(stats.resultRows);
    lines.push(
        [
            "CONCENTRATION",
            `Net $${concentration.totalNet.toFixed(0)}`,
            `Top1 ${formatPercent(concentration.top1Share * 100)}`,
            `Top3 ${formatPercent(concentration.top3Share * 100)}`,
            `Top10 ${formatPercent(concentration.top10Share * 100)}`,
            concentration.effectiveN !== null ? `EffN ${concentration.effectiveN.toFixed(1)}` : "EffN --",
        ].join(" | "),
    );

    // Robustness: how many pairs clear a basic significance bar. Median
    // Sharpe 0.39 buried in the trades line is the honest headline; surfacing
    // how many pairs clear 1.0 / 2.0 and how many are THIN (<15 trades) makes
    // "is this real?" answerable at a glance.
    const robustness = summarizeRobustness(stats.resultRows);
    lines.push(
        [
            "ROBUSTNESS",
            `Sharpe>1 ${robustness.sharpeGt1}/${robustness.total}`,
            `Sharpe>2 ${robustness.sharpeGt2}/${robustness.total}`,
            `THIN ${robustness.thin} (${formatPercent((robustness.thin / Math.max(1, robustness.total)) * 100)})`,
            `Sample-adequate ${robustness.total - robustness.thin}`,
        ].join(" | "),
    );

    // Per-asset open-trade score tally. Each pair's currently-open trade
    // (last trade with exitReason "end_of_data") decomposes into +/- 1 per
    // leg: a long on BASE+QUOTE is long BASE / short QUOTE; a short flips
    // the signs. Single symbols score their stripped asset directly.
    const scores = computeOpenTradeAssetScores(stats.resultRows);
    if (scores.length > 0) {
        lines.push(
            `OPEN_SCORE | ${scores.map((s) => `${s.asset} ${formatSignedScore(s.score)}`).join(", ")}`,
        );
        // Effective-bets concentration: gross leg exposure share of the top
        // few assets. 110 "pairs" often collapse to a handful of macro bets
        // (e.g. net short APT, net long ZEC across many pairs). HHI on gross
        // legs gives the honest "effective N" independent-bets read.
        const openConcentration = summarizeOpenScoreConcentration(scores);
        lines.push(
            [
                "OPEN_SCORE",
                `EffN ${openConcentration.effectiveN.toFixed(1)}`,
                `Top3 ${openConcentration.top3Assets.join(", ")} = ${formatPercent(openConcentration.top3Share * 100)} gross`,
            ].join(" | "),
        );
    }

    return lines;
}

// ---------------------------------------------------------------------------
// Buy-and-hold comparison
// ---------------------------------------------------------------------------

interface BuyHoldRow {
    symbol: string;
    strat: number;
    bh: number;
    alpha: number;
}

/**
 * Build per-pair { strategy %, B&H %, alpha % } rows for every result row
 * whose dataset yields a usable buy-and-hold. Alpha = strategy net% minus
 * buy-and-hold %, mirroring signal-committee-edge's alpha convention.
 */
export function buildBuyHoldRows(rows: readonly BatchBacktestSymbolResult[]): BuyHoldRow[] {
    const out: BuyHoldRow[] = [];
    for (const row of rows) {
        if (!row.result) continue;
        const bh = computeBuyAndHoldPct(row.data);
        if (bh === null) continue;
        const strat = row.result.netProfitPercent;
        out.push({ symbol: row.symbol, strat, bh, alpha: strat - bh });
    }
    return out;
}

interface RegimeBucket {
    count: number;
    avgStrat: number;
    avgBh: number;
    avgAlpha: number;
}

export interface RegimeSplit {
    up: RegimeBucket;
    down: RegimeBucket;
}

/**
 * Partition buy-and-hold rows by B&H sign so defensive value (downtrend
 * alpha) can be read separately from trend capture (uptrend alpha). A
 * "crash protector" strategy shows positive alpha in `down` and negative
 * alpha in `up` — a completely different read from the combined headline.
 */
export function summarizeRegimeSplit(rows: readonly BuyHoldRow[]): RegimeSplit {
    const up = rows.filter((r) => r.bh >= 0);
    const down = rows.filter((r) => r.bh < 0);
    return {
        up: summarizeRegimeBucket(up),
        down: summarizeRegimeBucket(down),
    };
}

function summarizeRegimeBucket(rows: readonly BuyHoldRow[]): RegimeBucket {
    if (rows.length === 0) {
        return { count: 0, avgStrat: NaN, avgBh: NaN, avgAlpha: NaN };
    }
    return {
        count: rows.length,
        avgStrat: mean(rows.map((r) => r.strat)),
        avgBh: mean(rows.map((r) => r.bh)),
        avgAlpha: mean(rows.map((r) => r.alpha)),
    };
}

// ---------------------------------------------------------------------------
// Profit concentration
// ---------------------------------------------------------------------------

export interface ProfitConcentration {
    totalNet: number;
    /** Top-1 pair share of total net profit (fraction 0..1; can exceed 1 if a
     * single pair's gain exceeds the net of all pairs combined). */
    top1Share: number;
    top3Share: number;
    top10Share: number;
    /** Effective N via Herfindahl on positive net profit. null when total
     * positive profit is non-positive (no profitable pair). */
    effectiveN: number | null;
}

/**
 * How much of the headline Net comes from a few outliers. If top-3 = 50% of
 * net, the "N pairs" result is really a 3-pair result. Effective N is the
 * Herfindahl reciprocal on positive profit shares (1 = concentrated in one
 * pair, N = evenly spread across N pairs).
 */
export function summarizeProfitConcentration(rows: readonly BatchBacktestSymbolResult[]): ProfitConcentration {
    const nets = rows
        .map((r) => r.result?.netProfit ?? 0)
        .filter((v) => Number.isFinite(v));
    const totalNet = nets.reduce((sum, v) => sum + v, 0);
    const sortedDesc = [...nets].sort((a, b) => b - a);
    const grossPositive = sortedDesc.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);

    const share = (topK: number): number => {
        if (grossPositive <= 0) return 0;
        const topSum = sortedDesc.slice(0, topK).filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
        return topSum / grossPositive;
    };

    let effectiveN: number | null = null;
    if (grossPositive > 0) {
        const positiveShares = sortedDesc.filter((v) => v > 0).map((v) => v / grossPositive);
        const hhi = positiveShares.reduce((sum, s) => sum + s * s, 0);
        effectiveN = hhi > 0 ? 1 / hhi : null;
    }

    return {
        totalNet,
        top1Share: share(1),
        top3Share: share(3),
        top10Share: share(10),
        effectiveN,
    };
}

// ---------------------------------------------------------------------------
// Robustness
// ---------------------------------------------------------------------------

export interface RobustnessSummary {
    total: number;
    sharpeGt1: number;
    sharpeGt2: number;
    /** Pairs with < 15 trades (the verdict engine's THIN threshold). */
    thin: number;
}

/**
 * How many pairs clear a basic significance bar. Counters complement median
 * Sharpe: median Sharpe 0.39 with 60% THIN means most pairs don't have
 * enough sample to read at all. THIN mirrors the verdict engine's
 * `totalTrades < 15` gate (computePerformanceVerdict in finder-universe-metrics).
 */
export function summarizeRobustness(rows: readonly BatchBacktestSymbolResult[]): RobustnessSummary {
    let total = 0;
    let sharpeGt1 = 0;
    let sharpeGt2 = 0;
    let thin = 0;
    for (const row of rows) {
        if (!row.result) continue;
        total += 1;
        const sharpe = row.result.sharpeRatio;
        if (Number.isFinite(sharpe) && sharpe > 1) sharpeGt1 += 1;
        if (Number.isFinite(sharpe) && sharpe > 2) sharpeGt2 += 1;
        if (row.result.totalTrades < 15) thin += 1;
    }
    return { total, sharpeGt1, sharpeGt2, thin };
}

// ---------------------------------------------------------------------------
// Open-score concentration
// ---------------------------------------------------------------------------

export interface OpenScoreConcentration {
    /** Effective independent bets via Herfindahl reciprocal on gross leg
     * exposure (1 = one macro bet, N = spread across N assets). */
    effectiveN: number;
    /** Three largest |score| assets, formatted "ASSET s" (signed). */
    top3Assets: string[];
    /** Top-3 |score| share of total gross leg exposure (fraction 0..1). */
    top3Share: number;
}

/**
 * Convert the per-asset open-trade tally into a concentration read. 110
 * "pairs" often collapse to a handful of macro bets because pairs share
 * legs (ZEC+APT, ZEC+WLD, WLD+APT all express long-ZEC / short-APT / long-
 * WLD). HHI on gross leg exposure (= sum of |score|) gives the honest
 * effective independent-bets number.
 */
export function summarizeOpenScoreConcentration(scores: readonly { asset: string; score: number }[]): OpenScoreConcentration {
    const grossByAbs = scores.map((s) => Math.abs(s.score));
    const totalGross = grossByAbs.reduce((sum, v) => sum + v, 0);
    if (totalGross <= 0) {
        return { effectiveN: 0, top3Assets: [], top3Share: 0 };
    }
    const shares = grossByAbs.map((v) => v / totalGross);
    const hhi = shares.reduce((sum, s) => sum + s * s, 0);
    const effectiveN = hhi > 0 ? 1 / hhi : 0;

    const top3 = [...scores]
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.asset.localeCompare(b.asset))
        .slice(0, 3);
    const top3Gross = top3.reduce((sum, s) => sum + Math.abs(s.score), 0);
    return {
        effectiveN,
        top3Assets: top3.map((s) => `${s.asset} ${formatSignedScore(s.score)}`),
        top3Share: top3Gross / totalGross,
    };
}

/**
 * Buy-and-hold return over a series: (lastClose / firstClose - 1) * 100,
 * using the first and last finite positive closes. Returns null when no
 * usable pair of closes exists. For synthetic pairs `data` is the ratio
 * series, so this is "buy the ratio and hold"; for singles it is the
 * asset's own B&H. Mirrors `closeMovePercent` in portfolio-lab-synthetic.
 */
export function computeBuyAndHoldPct(data: readonly OHLCVData[] | undefined | null): number | null {
    if (!data || data.length === 0) return null;
    let first: number | null = null;
    for (const bar of data) {
        if (Number.isFinite(bar.close) && bar.close > 0) {
            first = bar.close;
            break;
        }
    }
    let last: number | null = null;
    for (let i = data.length - 1; i >= 0; i -= 1) {
        const close = data[i]!.close;
        if (Number.isFinite(close) && close > 0) {
            last = close;
            break;
        }
    }
    if (first === null || last === null || first === 0) return null;
    return ((last / first) - 1) * 100;
}

/**
 * Decompose each pair's currently-open trade into per-asset +/- scores.
 *
 * An "open" trade is the last trade with `exitReason === "end_of_data"`
 * (the engine holds one position, so there is at most one). For a synthetic
 * `BASE+QUOTE` pair, a long is long BASE / short QUOTE; a short flips the
 * signs. For a single symbol the stripped base asset is scored directly.
 * Closed and no-trade rows contribute nothing. Results are sorted by
 * abs(score) desc then asset asc so the most conflicted assets surface first.
 */
export function computeOpenTradeAssetScores(
    rows: readonly BatchBacktestSymbolResult[],
): { asset: string; score: number }[] {
    const tally = new Map<string, number>();
    for (const row of rows) {
        const trades = row.result?.trades;
        if (!trades || trades.length === 0) continue;
        const last = trades[trades.length - 1]!;
        if (last.exitReason !== "end_of_data") continue;
        const sign = last.type === "long" ? 1 : last.type === "short" ? -1 : 0;
        if (sign === 0) continue;

        const parsed = parsePortfolioSyntheticPairSymbol(row.symbol);
        if (parsed) {
            // Long the ratio = long base / short quote; short flips both.
            tally.set(parsed.baseAsset, (tally.get(parsed.baseAsset) ?? 0) + sign);
            tally.set(parsed.quoteAsset, (tally.get(parsed.quoteAsset) ?? 0) - sign);
        } else {
            const asset = stripKnownQuoteSuffix(row.symbol);
            if (asset) tally.set(asset, (tally.get(asset) ?? 0) + sign);
        }
    }
    return Array.from(tally.entries())
        .map(([asset, score]) => ({ asset, score }))
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.asset.localeCompare(b.asset));
}

function mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function formatSignedScore(value: number): string {
    if (!Number.isFinite(value)) return "--";
    return value >= 0 ? `+${value}` : `${value}`;
}

function formatMinerSummary(result: BatchSyntheticMinerResult): string {
    const counts = new Map<string, number>();
    for (const verdict of result.verdicts) {
        counts.set(verdict.verdict, (counts.get(verdict.verdict) ?? 0) + 1);
    }
    const parts = ["LONG", "SHORT", "WATCH", "SKIP", "INCONCLUSIVE"]
        .map((label) => {
            const count = counts.get(label) ?? 0;
            return count > 0 ? `${label} ${count}` : "";
        })
        .filter(Boolean);
    return `Miner | Assets ${result.verdicts.length}${parts.length > 0 ? ` | ${parts.join(", ")}` : ""}`;
}

function formatMinerRowPipe(verdict: BatchSyntheticAssetVerdict): string {
    const evidence = verdict.evidence;
    const direction = verdict.direction ? verdict.direction.toUpperCase() : "--";
    const reason = verdict.reasons[0] ?? "";
    const mfeMaeRatio = computeMinerMfeMaeRatio(evidence.expectedMfePct, evidence.expectedMaePct);
    const invalidationPrice = computeMinerInvalidationPrice(verdict);
    const horizonLabel = evidence.horizonBarsAll.length > 1
        ? `Hrz [${evidence.horizonBarsAll.join(",")}]`
        : `Hrz ${evidence.horizonBars}`;
    const parts = [
        verdict.asset,
        `Dir ${direction}`,
        `Conf ${verdict.confidence}`,
        `AsOf ${verdict.currentSnapshot?.timeKey ?? "--"}`,
        horizonLabel,
        `Analogs ${evidence.analogCount}/${evidence.candidateCount}`,
        `Pre ${evidence.selectionCount}`,
        `PreRet ${formatSignedPercent(evidence.selectionForwardReturnPct)}`,
        `OOS ${evidence.oosCount}`,
        `Ret ${formatSignedPercent(evidence.expectedForwardReturnPct)}`,
        `Lift ${formatSignedPercent(evidence.oosLiftPct)}`,
        `MFE ${formatSignedPercent(evidence.expectedMfePct)}`,
        `MAE ${formatSignedPercent(evidence.expectedMaePct)}`,
        `RR ${formatRatio(mfeMaeRatio)}`,
        `Inv ${formatInvalidationPrice(verdict.direction, invalidationPrice)}`,
        `HMax ${evidence.longestHorizonBars ?? "--"}b Ret ${formatSignedPercent(evidence.longestOosForwardReturnPct)} Lift ${formatSignedPercent(evidence.longestOosLiftPct)}`,
        `Dist ${formatNumber(evidence.avgDistance, 2)}`,
        reason,
    ].filter(Boolean);
    return parts.join(" | ");
}

function formatMinerCopy(result: BatchSyntheticMinerResult): string {
    const lines = [formatMinerSummary(result)];
    for (const verdict of result.verdicts) {
        lines.push(`${verdict.verdict} | ${formatMinerRowPipe(verdict)}`);
        if (verdict.verdict !== "LONG" && verdict.verdict !== "SHORT" && verdict.verdict !== "WATCH") {
            continue;
        }
        const warnings = verdict.pairContributions
            .filter((entry) => entry.label === "dominating" || entry.label === "harmful" || entry.label === "opposing")
            .slice(0, 3)
            .map(formatPairContributionWarning);
        if (warnings.length > 0) {
            lines.push(`PAIR_CHECK | ${verdict.asset} | ${warnings.join(", ")}`);
        }
    }
    return lines.join("\n");
}

function computeMinerMfeMaeRatio(mfePct: number | null, maePct: number | null): number | null {
    if (mfePct === null || maePct === null || !Number.isFinite(mfePct) || !Number.isFinite(maePct)) {
        return null;
    }
    const adverse = Math.abs(maePct);
    if (adverse <= 1e-9) {
        return mfePct > 0 ? Number.POSITIVE_INFINITY : null;
    }
    return mfePct / adverse;
}

function computeMinerInvalidationPrice(verdict: BatchSyntheticAssetVerdict): number | null {
    const close = verdict.currentSnapshot?.close;
    const maePct = verdict.evidence.expectedMaePct;
    if (!verdict.direction || close === null || close === undefined || maePct === null || !Number.isFinite(close) || !Number.isFinite(maePct) || close <= 0) {
        return null;
    }
    const adversePct = Math.abs(maePct) / 100;
    if (verdict.direction === "long") {
        return close * (1 - adversePct);
    }
    return close * (1 + adversePct);
}

function formatInvalidationPrice(direction: BatchSyntheticAssetVerdict["direction"], value: number | null): string {
    if (!direction || value === null || !Number.isFinite(value)) {
        return "--";
    }
    const comparator = direction === "long" ? "<" : ">";
    return `${comparator}${formatPrice(value)}`;
}

function formatPrice(value: number): string {
    if (Math.abs(value) >= 100) {
        return value.toFixed(2);
    }
    if (Math.abs(value) >= 1) {
        return value.toFixed(4);
    }
    return value.toPrecision(4);
}

function formatRatio(value: number | null): string {
    if (value === null || Number.isNaN(value)) {
        return "--";
    }
    if (!Number.isFinite(value)) {
        return "Inf";
    }
    return value.toFixed(value >= 10 ? 1 : 2);
}

function formatPairContributionWarning(entry: BatchSyntheticPairContribution): string {
    return `${entry.symbol}:${entry.label}`
        + `(n=${entry.oosCountWithout}, ret=${formatSignedPercent(entry.oosReturnWithoutPct)}, delta=${formatSignedPercent(entry.returnDeltaPct)})`;
}

function getMinerVerdictClass(verdict: BatchSyntheticAssetVerdict["verdict"]): string {
    switch (verdict) {
        case "LONG":
        case "SHORT":
            return "finder-verdict-strong";
        case "WATCH":
            return "finder-verdict-marginal";
        case "SKIP":
            return "finder-verdict-losing";
        case "INCONCLUSIVE":
        default:
            return "finder-verdict-thin";
    }
}

function summarizeBatchResults(results: readonly BatchBacktestSymbolResult[]): BatchOverallStats {
    const completedRows = results.filter((row) => row.status !== "no_trades" || row.error !== "Skipped (cancelled).");
    const resultRows = completedRows.filter((row) => Boolean(row.result));
    const profitableRows = resultRows.filter((row) => row.result!.netProfit > 0);
    const losingRows = resultRows.filter((row) => row.result!.netProfit < 0);
    const noTradeRows = completedRows.filter((row) => row.status === "no_trades");
    const failedRows = completedRows.filter((row) => row.status === "load_failed" || row.status === "run_failed");
    const verdictCounts = new Map<string, number>();

    let totalNet = 0;
    let totalTrades = 0;
    let totalWinningTrades = 0;
    let grossProfit = 0;
    let grossLossAbs = 0;
    for (const row of resultRows) {
        const result = row.result!;
        totalNet += result.netProfit;
        totalTrades += result.totalTrades;
        totalWinningTrades += result.winningTrades;
        grossProfit += Math.max(0, result.avgWin) * result.winningTrades;
        grossLossAbs += Math.max(0, result.avgLoss) * result.losingTrades;

        const verdict = computePerformanceVerdict(result, row.status).label;
        verdictCounts.set(verdict, (verdictCounts.get(verdict) ?? 0) + 1);
    }

    return {
        completedRows,
        resultRows,
        profitableRows,
        losingRows,
        noTradeRows,
        failedRows,
        totalNet,
        totalTrades,
        totalWinningTrades,
        grossProfit,
        grossLossAbs,
        verdictCounts,
    };
}

function resolveAggregateExpectancy(stats: BatchOverallStats): number | null {
    return stats.totalTrades > 0 ? stats.totalNet / stats.totalTrades : null;
}

function resolveAggregateProfitFactor(stats: BatchOverallStats): number | null {
    if (stats.grossLossAbs > 0) {
        return stats.grossProfit / stats.grossLossAbs;
    }
    return stats.grossProfit > 0 ? Infinity : null;
}

/**
 * Format one result row as pipe-delimited text, mirroring the Symbol Universe
 * symbol-breakdown line the user is already used to reading.
 */
function formatResultRowPipe(result: BatchBacktestSymbolResult): string {
    const parts: string[] = [result.symbol, formatStatus(result.status)];
    parts.push(`Bars ${result.barCount}`);
    if (result.result) {
        const r: BacktestResult = result.result;
        parts.push(`Net ${formatCurrency(r.netProfit)}`);
        parts.push(`Exp ${r.expectancy.toFixed(2)}`);
        parts.push(`PF ${formatProfitFactor(r.profitFactor)}`);
        parts.push(`WR ${r.winRate.toFixed(0)}%`);
        parts.push(`Sharpe ${Number.isFinite(r.sharpeRatio) ? r.sharpeRatio.toFixed(2) : "--"}`);
        parts.push(
            Number.isFinite(r.maxDrawdownPercent)
                ? `DD ${r.maxDrawdownPercent.toFixed(2)}%`
                : "DD --",
        );
        parts.push(`Trades ${r.totalTrades}`);
        parts.push(`AvgTrade ${formatCurrency(r.avgTrade)}`);
        parts.push(`Hold ${formatHold(result)}`);
        parts.push(`Exposure ${formatPercent(result.tradeSummary?.exposurePercent)}`);
    }
    if (result.error) parts.push(result.error);
    const range = formatTimeRange(result.firstTime, result.lastTime);
    if (range) parts.push(range);
    return parts.join(" | ");
}

function formatStatus(status: BatchBacktestSymbolResult["status"]): string {
    switch (status) {
        case "profitable": return "Profitable";
        case "losing": return "Losing";
        case "flat": return "Flat";
        case "no_trades": return "No Trades";
        case "load_failed": return "Load Failed";
        case "run_failed": return "Run Failed";
        default: return status;
    }
}

function formatCurrency(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}$${value.toFixed(2)}`;
}

function formatNumber(value: number | null | undefined, digits: number): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return value.toFixed(digits);
}

function formatVerdictCounts(verdictCounts: ReadonlyMap<string, number>): string {
    const labels = ["STRONG", "SOLID", "MARGINAL", "WEAK", "THIN", "LOSING"];
    const parts = labels
        .map((label) => {
            const count = verdictCounts.get(label) ?? 0;
            return count > 0 ? `${label} ${count}` : "";
        })
        .filter(Boolean);
    return parts.length > 0 ? `Verdicts ${parts.join(", ")}` : "";
}

function medianMetric(
    rows: readonly BatchBacktestSymbolResult[],
    select: (row: BatchBacktestSymbolResult) => number | null | undefined,
): number | null {
    const values = rows
        .map(select)
        .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
        .sort((a, b) => a - b);
    if (values.length === 0) return null;
    const middle = Math.floor(values.length / 2);
    if (values.length % 2 === 1) return values[middle];
    return (values[middle - 1] + values[middle]) / 2;
}

function maxBy<T>(items: readonly T[], select: (item: T) => number): T | null {
    let best: T | null = null;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const item of items) {
        const value = select(item);
        if (value > bestValue) {
            best = item;
            bestValue = value;
        }
    }
    return best;
}

function minBy<T>(items: readonly T[], select: (item: T) => number): T | null {
    let best: T | null = null;
    let bestValue = Number.POSITIVE_INFINITY;
    for (const item of items) {
        const value = select(item);
        if (value < bestValue) {
            best = item;
            bestValue = value;
        }
    }
    return best;
}

function formatHoldSummary(bars: number | null, days: number | null): string {
    const barsText = formatHoldBars(bars);
    const daysText = formatHoldDuration(days);
    return daysText === "--" ? barsText : `${barsText} (${daysText})`;
}

function formatHold(result: BatchBacktestSymbolResult): string {
    const summary = result.tradeSummary;
    const bars = `${formatHoldBars(summary?.avgHoldBars)}/${formatHoldBars(summary?.maxHoldBars)}`;
    const days = `${formatHoldDuration(summary?.avgHoldDays)}/${formatHoldDuration(summary?.maxHoldDays)}`;
    return days === "--/--" ? bars : `${bars} (${days})`;
}

function formatHoldBars(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)}b`;
}

function formatHoldDuration(days: number | null | undefined): string {
    if (days === null || days === undefined || !Number.isFinite(days)) {
        return "--";
    }
    if (days >= 1) {
        return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
    }
    const hours = days * 24;
    if (hours >= 1) {
        return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
    }
    return `${Math.max(0, hours * 60).toFixed(0)}m`;
}

function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatSignedPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
}

function formatTimeRange(firstTime?: Time, lastTime?: Time): string {
    if (!firstTime && !lastTime) return "";
    const firstLabel = firstTime ? formatTime(firstTime) : "?";
    const lastLabel = lastTime ? formatTime(lastTime) : "?";
    return `${firstLabel} -> ${lastLabel}`;
}

function formatTime(time: Time): string {
    if (typeof time === "string") return time;
    if (typeof time === "number") {
        const ms = time > 1_000_000_000_000 ? time : time * 1000;
        return new Date(ms).toISOString().slice(0, 10);
    }
    if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
        const month = String(time.month).padStart(2, "0");
        const day = String(time.day).padStart(2, "0");
        return `${time.year}-${month}-${day}`;
    }
    return String(time);
}

export const batchBacktestService = new BatchBacktestService();
