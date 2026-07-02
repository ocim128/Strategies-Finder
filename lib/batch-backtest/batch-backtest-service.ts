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
import { paramManager } from "../param-manager";
import { state } from "../state";
import { strategyRegistry } from "../../strategyRegistry";
import { formatProfitFactor } from "../ui-formatters";
import { setVisible } from "../dom-utils";
import { debugLogger } from "../debug-logger";
import { computePerformanceVerdict } from "../finder/finder-universe-metrics";
import type { BacktestResult, Time } from "../types/strategies";
import { parsePortfolioSyntheticPairSymbol } from "../portfolioLab/portfolio-lab-synthetic";
import { createBatchBacktestDom, type BatchBacktestDom } from "./batch-backtest-dom";
import { loadBatchDataset } from "./batch-backtest-loader";
import {
    parseBatchSymbols,
    runBatchBacktest,
    type BatchBacktestSymbolResult,
} from "./batch-backtest-runner";
import {
    resolveBatchSyntheticTargetSymbol,
    runBatchSyntheticStateMiner,
    type BatchSyntheticAssetVerdict,
    type BatchSyntheticMinerResult,
    type BatchSyntheticPairArtifact,
    type BatchSyntheticTargetArtifact,
} from "./batch-synthetic-state-miner";

class BatchBacktestService {
    private dom: BatchBacktestDom | null = null;
    private initialized = false;
    private cancelled = false;
    private lastResults: BatchBacktestSymbolResult[] = [];
    private lastMinerResult: BatchSyntheticMinerResult | null = null;
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
    }

    private bindEvents(dom: BatchBacktestDom): void {
        dom.batchBacktestRunBtn.addEventListener("click", () => {
            void this.runBatch();
        });
        dom.batchBacktestStopBtn.addEventListener("click", () => {
            this.cancelled = true;
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
        dom.batchBacktestRunBtn.disabled = true;
        setVisible(dom.batchBacktestStopBtn, true);
        dom.batchBacktestCopyBtn.disabled = true;
        dom.batchBacktestMineBtn.disabled = true;
        this.clearMinerResults(dom);
        setVisible(dom.batchBacktestEmpty, false);
        dom.batchBacktestResults.replaceChildren();

        try {
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
                dom.batchBacktestMineBtn.disabled = !this.hasMineableArtifacts();
                this.updateSummary(dom);
                this.setProgress(dom, 100, this.cancelled ? "Stopped" : "Done");
            }
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
        if (this.lastResults.length === 0) {
            dom.batchBacktestMinerSummary.textContent = "Run Batch first.";
            return;
        }
        const currentFingerprint = this.buildCurrentRunFingerprint();
        if (!currentFingerprint || currentFingerprint !== this.lastRunFingerprint) {
            dom.batchBacktestMinerSummary.textContent = "Rerun Batch before mining; settings or symbols changed.";
            dom.batchBacktestCopyMinerBtn.disabled = true;
            return;
        }

        const pairArtifacts = this.buildMinerPairArtifacts();
        if (pairArtifacts.length === 0) {
            dom.batchBacktestMinerSummary.textContent = "No completed synthetic pair artifacts to mine.";
            dom.batchBacktestCopyMinerBtn.disabled = true;
            return;
        }

        dom.batchBacktestMineBtn.disabled = true;
        dom.batchBacktestCopyMinerBtn.disabled = true;
        dom.batchBacktestMinerSummary.textContent = "Loading target assets...";
        dom.batchBacktestMinerResults.replaceChildren();

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
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.lastMinerResult = null;
            dom.batchBacktestMinerSummary.textContent = `Miner error: ${message}`;
            debugLogger.error("batch_synthetic_miner.failed", { error: message });
        } finally {
            dom.batchBacktestMineBtn.disabled = !this.hasMineableArtifacts();
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
        // Load all target datasets concurrently. Each load is independent
        // (loadBatchDataset goes through the shared LRU caches and
        // dataManager.fetchDataDetached, both safe under concurrency), and the
        // previous sequential `for...await` serialized ~16 network reads. On
        // 4H each target has a deep history, so this was the dominant wall
        // clock cost of Mine. Per-target errors are isolated so one failed
        // asset does not reject the batch.
        const loaded = await Promise.all(
            assets.map(async (asset) => {
                const symbol = resolveBatchSyntheticTargetSymbol(asset);
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
            }),
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
        dom.batchBacktestMinerSummary.textContent = "Miner idle";
        dom.batchBacktestMinerResults.replaceChildren();
        dom.batchBacktestCopyMinerBtn.disabled = true;
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
        dom.batchBacktestMineBtn.disabled = true;
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

    return [
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
    const horizonLabel = evidence.horizonBarsAll.length > 1
        ? `Hrz [${evidence.horizonBarsAll.join(",")}]`
        : `Hrz ${evidence.horizonBars}`;
    const parts = [
        verdict.asset,
        `Dir ${direction}`,
        `Conf ${verdict.confidence}`,
        horizonLabel,
        `Samples ${evidence.analogCount}/${evidence.candidateCount}`,
        `Pre ${evidence.selectionCount}`,
        `PreRet ${formatSignedPercent(evidence.selectionForwardReturnPct)}`,
        `OOS ${evidence.oosCount}`,
        `Ret ${formatSignedPercent(evidence.expectedForwardReturnPct)}`,
        `Lift ${formatSignedPercent(evidence.oosLiftPct)}`,
        `MFE ${formatSignedPercent(evidence.expectedMfePct)}`,
        `MAE ${formatSignedPercent(evidence.expectedMaePct)}`,
        `Long ${evidence.longestHorizonBars ?? "--"}b ${formatSignedPercent(evidence.longestOosForwardReturnPct)}/${formatSignedPercent(evidence.longestOosLiftPct)}`,
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
            .map((entry) => `${entry.symbol}:${entry.label}`);
        if (warnings.length > 0) {
            lines.push(`PAIR_CHECK | ${verdict.asset} | ${warnings.join(", ")}`);
        }
    }
    return lines.join("\n");
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
