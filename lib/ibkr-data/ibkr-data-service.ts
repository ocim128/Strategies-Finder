import { clearLocalDailyAssetCaches, markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import { dataManager } from "../data-manager";
import { finderManager } from "../finder-manager";
import { uiManager } from "../ui-manager";
import { clearBatchDatasetCaches } from "../batch-backtest/batch-backtest-loader";
import { clearRankPairsRecentLoaderCache } from "../rank-pairs/rank-pairs-recent-loader";
import { consumeNdjsonStream } from "../ndjson-stream";
import { createIbkrDataDom, type IbkrDataDom } from "./ibkr-data-dom";
import type { IbkrStreamEvent, IbkrSyncRunSnapshot } from "./ibkr-data-stream-types";
import {
    appendUniqueIbkrSymbols,
    findStaleIbkrSymbols,
    type IbkrCatalogAsset,
} from "./ibkr-stale-symbols";

// Re-export the shared wire types so existing imports of them from this module
// keep resolving — the source of truth now lives in the leaf
// `ibkr-data-stream-types` module shared with the server plugin.
export type { IbkrStreamEvent, IbkrSyncRunSnapshot };

class IbkrDataService {
    private dom: IbkrDataDom | null = null;
    private initialized = false;
    private lastMarkedSymbols: string[] = [];
    // True while this tab is reattached to a sync that started before reload.
    // Used to unlock the UI and emit a final status when the run ends.
    private reattached = false;

    init(): void {
        if (this.initialized) return;
        this.initialized = true;
        const dom = this.getDom();
        dom.ibkrDataStatusBtn.addEventListener("click", () => void this.runStatus());
        dom.ibkrDataResolveBtn.addEventListener("click", () => void this.runAction("/api/ibkr/resolve"));
        dom.ibkrDataDownloadBtn.addEventListener("click", () => void this.runAction("/api/ibkr/download", true));
        dom.ibkrDataSyncBtn.addEventListener("click", () => void this.runAction("/api/ibkr/sync", true));
        dom.ibkrDataStopBtn.addEventListener("click", () => void this.stopSync());
        dom.ibkrDataCopyBtn.addEventListener("click", () => void this.copySymbols());
        dom.ibkrDataAppendStaleBtn.addEventListener("click", () => void this.appendStaleSymbols());
        // Stop is intentionally left enabled at startup so it can recover a
        // stuck server-side sync lock without a server restart.
        // Reattach to any sync that was already running before page reload.
        // The server keeps syncing after the NDJSON response stream is gone;
        // this is how the UI picks it back up and shows live progress.
        void this.reattachToInProgressSync();
    }

    /**
     * Polls GET /api/ibkr/sync/status on init. If a sync is running, locks
     * the UI to busy (so the user can't start a conflicting sync) and updates
     * the status text on each poll until the run ends, then unlocks and
     * invalidates caches for the symbols the server reports as completed.
     *
     * Progress watchdog: a healthy sync advances `(index, currentSymbol,
     * completed, updatedAt)` between polls; each advance resets the no-progress
     * countdown. After ~5 min of consecutive no-progress polls the loop does
     * NOT terminate (audit Finding 5) — it steps the polling frequency down
     * from 2s to 12s so slow historical paging, Gateway retry delays, or a
     * temporarily unavailable session can still recover naturally, and so the
     * post-sync cache invalidation eventually fires when the run completes.
     * `updatedAt` is part of the progress key so the server's snapshot
     * heartbeat still counts as activity even when the indexed cursor hasn't
     * moved. The first advance after a stall resumes the 2s cadence.
     */
    private async reattachToInProgressSync(): Promise<void> {
        const POLL_INTERVAL_MS = 2000;
        const STALLED_POLL_INTERVAL_MS = 12_000;
        const NO_PROGRESS_POLL_LIMIT = 150;
        try {
            let lastProgressKey = "";
            let stalledPolls = 0;
            // True once we have crossed the no-progress threshold at least
            // once; used to (a) display the stalled warning and (b) drive the
            // slow-poll cadence until the run advances again.
            let stalledSlowMode = false;
            // Tracks the last snapshot we saw with `running: true`, so that
            // when the run ends we can invalidate exactly the symbols the
            // server completed while we were watching.
            let lastRunningSnapshot: IbkrSyncRunSnapshot | null = null;
            for (;;) {
                const response = await fetch("/api/ibkr/sync/status", { cache: "no-store" });
                const payload = await response.json() as { running?: boolean; run?: IbkrSyncRunSnapshot };
                if (!payload.running || !payload.run) {
                    if (this.reattached) {
                        this.reattached = false;
                        this.setBusy(false);
                        // Invalidate the symbols the server reported complete
                        // so newly written CSVs are not hidden behind stale
                        // in-memory chart/Finder/Batch caches.
                        const completed = lastRunningSnapshot?.completedSymbols ?? [];
                        if (completed.length > 0) {
                            this.invalidateSyncedData(completed, lastRunningSnapshot?.interval);
                        }
                        const provider = lastRunningSnapshot?.source === "alpaca" ? "Alpaca" : "IBKR";
                        this.setStatus(`${provider} sync finished (reattached).`);
                    }
                    return;
                }
                // First poll that discovers a running sync: lock the UI.
                if (!this.reattached) {
                    this.reattached = true;
                    this.setBusy(true);
                }
                const run = payload.run;
                lastRunningSnapshot = run;
                // Progress watchdog: reset the countdown whenever the run
                // advances; only count consecutive no-progress polls. Include
                // `updatedAt` so the server's snapshot heartbeat (any mutation,
                // including a per-symbol catalog write) still counts as
                // progress even when the indexed cursor hasn't moved.
                const progressKey = `${run.index}|${run.currentSymbol ?? ""}|${run.completed}|${run.updatedAt ?? ""}`;
                const advanced = progressKey !== lastProgressKey;
                if (advanced) {
                    lastProgressKey = progressKey;
                    stalledPolls = 0;
                    if (stalledSlowMode) {
                        // Recovered: resume the normal 2s cadence.
                        stalledSlowMode = false;
                    }
                } else {
                    stalledPolls += 1;
                    if (stalledPolls >= NO_PROGRESS_POLL_LIMIT && !stalledSlowMode) {
                        // No progress for ~5 min: a long gateway fetch, retry
                        // backoff, or temporarily unavailable session. Keep the
                        // UI locked (the server still owns the sync; the user
                        // can still click Stop) but shed polling load from
                        // 2s to 12s. Unlike the prior behavior, we DO NOT
                        // return here — the loop keeps watching so natural
                        // recovery or completion is still observed and the
                        // post-sync cache invalidation still fires.
                        stalledSlowMode = true;
                    }
                }
                // Only render the snapshot progress when it advances or we are
                // still in fast mode. Once in slow mode with no advance, the
                // stalled warning is the more useful signal — renderRunSnapshot
                // would overwrite it with the unchanged `seen/total` line.
                if (advanced || !stalledSlowMode) {
                    this.renderRunSnapshot(run);
                } else {
                    this.setStatus("IBKR sync stalled (no progress for 5 min) — slowing polls; still running. Click Stop or wait.");
                }
                const delay = stalledSlowMode ? STALLED_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
                await new Promise((resolve) => setTimeout(resolve, delay));
            }
        } catch (error) {
            if (this.reattached) {
                this.reattached = false;
                this.setBusy(false);
            }
            this.setStatus(error instanceof Error ? `Sync reattach failed: ${error.message}` : "Sync reattach failed.");
        }
    }

    private renderRunSnapshot(run: IbkrSyncRunSnapshot): void {
        const seen = run.completed + run.failed;
        const current = run.currentSymbol ? ` — syncing ${run.currentSymbol}` : "";
        const failLabel = run.failed > 0 ? `, ${run.failed} failed` : "";
        const cancelLabel = run.cancelled ? " (stopping)" : "";
        const provider = run.source === "alpaca" ? "Alpaca" : "IBKR";
        this.setStatus(`${provider} ${run.mode} ${seen}/${run.total}${failLabel}${cancelLabel}${current}`);
    }

    private getDom(): IbkrDataDom {
        return this.dom ??= createIbkrDataDom();
    }

    private parseSymbols(): string[] {
        const raw = this.getDom().ibkrDataSymbols.value;
        const seen = new Set<string>();
        const symbols: string[] = [];
        for (const token of raw.split(/[\s,]+/)) {
            const symbol = stripIbkrMarker(token.trim().toUpperCase());
            if (!symbol || seen.has(symbol)) continue;
            seen.add(symbol);
            symbols.push(symbol);
        }
        return symbols;
    }

    private getRequestBody(): Record<string, unknown> {
        const dom = this.getDom();
        const period = dom.ibkrDataPeriod.value.trim();
        const source = dom.ibkrDataSource.value === "alpaca" ? "alpaca" : "ibkr";
        return {
            symbols: this.parseSymbols(),
            interval: dom.ibkrDataInterval.value,
            source,
            ...(period ? { period } : {}),
        };
    }

    private setBusy(busy: boolean): void {
        const dom = this.getDom();
        dom.ibkrDataStatusBtn.disabled = busy;
        dom.ibkrDataResolveBtn.disabled = busy;
        dom.ibkrDataDownloadBtn.disabled = busy;
        dom.ibkrDataSyncBtn.disabled = busy;
        dom.ibkrDataAppendStaleBtn.disabled = busy;
        // Stop is always enabled so a stuck server-side sync lock can be
        // force-reset without a server restart. (See /api/ibkr/stop.)
        dom.ibkrDataStopBtn.disabled = false;
    }

    private setStatus(message: string): void {
        this.getDom().ibkrDataStatus.textContent = message;
    }

    private writeOutput(payload: unknown): void {
        this.getDom().ibkrDataOutput.textContent = typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2);
    }

    private async runStatus(): Promise<void> {
        this.setBusy(true);
        this.setStatus("Checking IBKR Gateway...");
        try {
            const response = await fetch("/api/ibkr/status", { cache: "no-store" });
            const payload = await response.json() as { ok?: boolean; error?: string };
            this.writeOutput(payload);
            if (response.ok && payload.ok !== false) {
                this.setStatus("Gateway reachable");
            } else if (response.ok && payload.error) {
                this.setStatus(payload.error);
            } else {
                this.setStatus("Gateway unavailable");
            }
        } catch (error) {
            this.writeOutput(error instanceof Error ? error.message : String(error));
            this.setStatus("Gateway check failed");
        } finally {
            this.setBusy(false);
        }
    }

    private async appendStaleSymbols(): Promise<void> {
        const dom = this.getDom();
        const interval = dom.ibkrDataInterval.value;
        this.setBusy(true);
        this.setStatus(`Checking stale ${interval} prices...`);
        try {
            const response = await fetch("/api/local-price-data/ibkr/catalog", { cache: "no-store" });
            const payload = await response.json() as {
                ok?: boolean;
                assets?: IbkrCatalogAsset[];
                error?: string;
            };
            if (!response.ok || payload.ok === false) {
                throw new Error(payload.error ?? `Catalog request failed (${response.status}).`);
            }

            const stale = findStaleIbkrSymbols(payload.assets ?? [], interval);
            if (!stale.freshestTime) {
                this.writeOutput({ interval, staleSymbols: [], reason: "No catalog prices found for the selected timeframe." });
                this.setStatus(`No ${interval} catalog prices found.`);
                return;
            }

            const appended = appendUniqueIbkrSymbols(dom.ibkrDataSymbols.value, stale.symbols);
            dom.ibkrDataSymbols.value = appended.value;
            this.writeOutput({
                interval,
                freshestTime: stale.freshestTime,
                staleSymbols: stale.symbols,
                appendedSymbols: appended.appended,
            });

            const alreadyListed = stale.symbols.length - appended.appended.length;
            const existingLabel = alreadyListed > 0 ? `; ${alreadyListed} already listed` : "";
            this.setStatus(
                `Appended ${appended.appended.length} of ${stale.symbols.length} stale ${interval} symbol${stale.symbols.length === 1 ? "" : "s"}${existingLabel}.`,
            );
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            this.writeOutput(message);
            this.setStatus(`Stale-price check failed: ${message}`);
        } finally {
            this.setBusy(false);
        }
    }

    private async runAction(url: string, invalidate = false): Promise<void> {
        const body = this.getRequestBody();
        if (!Array.isArray(body.symbols) || body.symbols.length === 0) {
            this.setStatus("Add at least one symbol.");
            return;
        }

        this.setBusy(true);
        const requestedProvider = body.source === "alpaca" ? "Alpaca" : "IBKR";
        this.setStatus(`Running ${requestedProvider} request...`);
        // Aggregated view of the streamed events. `results` / `failed` are
        // filled in by the terminal `done` event; per-symbol events update
        // the status line incrementally so the UI doesn't feel frozen during
        // long batches. `markedSymbolsAcc` accumulates per-symbol so a fatal
        // after partial success still invalidates the symbols that landed.
        const aggregated: { ok: boolean; results: unknown[]; failed: unknown[]; error?: string } = {
            ok: false,
            results: [],
            failed: [],
        };
        const markedSymbolsAcc: string[] = [];
        let hadWarning = false;
        let seen = 0;
        let total = 0;
        // Tracks the source from the `start` event so the post-completion
        // status can show the Alpaca-specific aggregate follow-up command.
        // Typed as `string` because the closure assignment inside `onStart`
        // is not visible to the control-flow narrowing at the comparison
        // site below, which would otherwise narrow the union away.
        let runSource: string = body.source === "alpaca" ? "alpaca" : "ibkr";
        // Whether the streaming POST succeeded (opened a stream). Used by the
        // finally block to decide whether to invalidate partial results.
        let streamOpened = false;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok || !response.body) {
                // Non-streaming error path (e.g. 405, 413, pre-stream 409).
                const text = await response.text();
                let payload: { error?: string } = {};
                try { payload = JSON.parse(text); } catch { /* ignore parse error */ }
                aggregated.error = payload.error ?? `${requestedProvider} request failed (${response.status}).`;
                this.writeOutput(text);
                this.setStatus(aggregated.error);
                return;
            }
            streamOpened = true;

            await consumeNdjsonStream<IbkrStreamEvent>(response.body, {
                onStart: (event: Extract<IbkrStreamEvent, { type: "start" }>) => {
                    total = event.total;
                    if (event.source === "alpaca") runSource = "alpaca";
                    const provider = runSource === "alpaca" ? "Alpaca" : "IBKR";
                    this.setStatus(`${provider} ${event.mode ?? "request"}: 0/${total}`);
                },
                onSymbol: (event: Extract<IbkrStreamEvent, { type: "symbol" }>) => {
                    seen = event.index + 1;
                    // Accumulate as we go so partial-fatal invalidation works.
                    const marked = event.markedSymbol ?? markIbkrSymbol(event.symbol);
                    if (marked && !markedSymbolsAcc.includes(marked)) {
                        markedSymbolsAcc.push(marked);
                    }
                    const delta = event.fetchedBars ?? 0;
                    const deltaLabel = delta > 0 ? ` +${delta} bar${delta === 1 ? "" : "s"}` : "";
                    const provider = runSource === "alpaca" ? "Alpaca" : "IBKR";
                    this.setStatus(`${provider} ${seen}/${total}: ${event.symbol}${deltaLabel}`);
                },
                onSymbolFailed: (event: Extract<IbkrStreamEvent, { type: "symbol_failed" }>) => {
                    seen = event.index + 1;
                    const provider = runSource === "alpaca" ? "Alpaca" : "IBKR";
                    this.setStatus(`${provider} ${seen}/${total}: ${event.symbol} failed — ${event.error}`);
                },
                onSymbolWarning: (event: Extract<IbkrStreamEvent, { type: "symbol_warning" }>) => {
                    hadWarning = true;
                    seen = event.index + 1;
                    // A partial-max symbol still lands data, so accumulate it
                    // for invalidation like a normal success.
                    const marked = markIbkrSymbol(event.symbol);
                    if (!markedSymbolsAcc.includes(marked)) {
                        markedSymbolsAcc.push(marked);
                    }
                    const provider = runSource === "alpaca" ? "Alpaca" : "IBKR";
                    this.setStatus(`${provider} ${seen}/${total}: ${event.symbol} incomplete — ${event.reason}`);
                },
                onDone: (event: Extract<IbkrStreamEvent, { type: "done" }>) => {
                    aggregated.ok = event.ok;
                    aggregated.results = event.results ?? [];
                    aggregated.failed = event.failed ?? [];
                    this.writeOutput(event);
                },
                onFatal: (event: Extract<IbkrStreamEvent, { type: "fatal" }>) => {
                    aggregated.error = event.error;
                    this.writeOutput(event);
                },
            });

            if (aggregated.error) {
                this.setStatus(aggregated.error);
                return;
            }
            if (!aggregated.ok) {
                const provider = runSource === "alpaca" ? "Alpaca" : "IBKR";
                this.setStatus(`${provider} request completed with failures.`);
                return;
            }
            if (hadWarning) {
                const provider = runSource === "alpaca" ? "Alpaca" : "IBKR";
                this.setStatus(`${provider} request complete with warnings — ${seen}/${total} symbol${total === 1 ? "" : "s"} (some partial).`);
                return;
            }
            const provider = runSource === "alpaca" ? "Alpaca" : "IBKR";
            const aggregateHint = runSource === "alpaca"
                ? " Run `npm run ibkr:aggregate -- --from 30m --interval 4h` to derive 4h."
                : "";
            this.setStatus(`${provider} request complete — ${seen}/${total} symbol${total === 1 ? "" : "s"}.${aggregateHint}`);
        } catch (error) {
            this.writeOutput(error instanceof Error ? error.message : String(error));
            const provider = runSource === "alpaca" ? "Alpaca" : "IBKR";
            this.setStatus(`${provider} request failed.`);
        } finally {
            // Invalidate in `finally` so a mid-stream network failure (which
            // throws out of consumeNdjsonStream) still invalidates the symbols
            // that landed before the connection dropped. Previously this ran
            // only on the clean-end path, so a dropped stream left newly
            // written CSVs hidden behind stale in-memory caches.
            if (streamOpened && invalidate) {
                const markedSymbols = markedSymbolsAcc.length > 0
                    ? markedSymbolsAcc
                    : this.captureMarkedSymbols(aggregated);
                if (markedSymbols.length > 0) {
                    this.invalidateSyncedData(markedSymbols, body.interval);
                }
            }
            this.setBusy(false);
        }
    }

    /**
     * NDJSON stream consumption is provided by the shared
     * {@link consumeNdjsonStream} helper in `lib/ndjson-stream.ts`, imported at
     * the top of this module. The previous private copy was extracted so the
     * new Batch Backtest server-side plugin can consume the same shape.
     */

    private async stopSync(): Promise<void> {
        try {
            await fetch("/api/ibkr/stop", { method: "POST" });
            this.setStatus("Stop requested. Current symbol may finish first.");
        } catch (error) {
            this.writeOutput(error instanceof Error ? error.message : String(error));
            this.setStatus("Failed to request stop.");
        }
    }

    private captureMarkedSymbols(payload: { results?: unknown[] }): string[] {
        const symbols = new Set<string>();
        for (const row of payload.results ?? []) {
            if (!row || typeof row !== "object") continue;
            const value = row as Record<string, unknown>;
            const marked = String(value.markedSymbol ?? "");
            const symbol = String(value.symbol ?? "");
            if (marked) {
                symbols.add(marked.trim().toUpperCase());
            } else if (symbol) {
                symbols.add(markIbkrSymbol(symbol));
            }
        }
        if (symbols.size > 0) {
            this.lastMarkedSymbols = Array.from(symbols);
        }
        return Array.from(symbols);
    }

    private invalidateSyncedData(symbols: readonly string[], interval: unknown): void {
        if (symbols.length === 0) return;
        const normalizedInterval = String(interval ?? "").trim().toLowerCase();
        clearLocalDailyAssetCaches();
        dataManager.invalidateLocalSeries(symbols, normalizedInterval ? [normalizedInterval] : undefined);
        finderManager.invalidateLocalDataCaches();
        clearBatchDatasetCaches();
        clearRankPairsRecentLoaderCache();
    }

    private async copySymbols(): Promise<void> {
        const symbols = this.lastMarkedSymbols.length > 0
            ? this.lastMarkedSymbols
            : this.parseSymbols().map((symbol) => markIbkrSymbol(symbol));
        if (symbols.length === 0) {
            this.setStatus("No symbols to copy.");
            return;
        }
        const text = symbols.join("\n");
        try {
            await navigator.clipboard.writeText(text);
            this.setStatus(`Copied ${symbols.length} IBKR symbol${symbols.length === 1 ? "" : "s"}.`);
            uiManager.showToast("IBKR symbols copied.", "success");
        } catch {
            this.writeOutput(text);
            this.setStatus("Clipboard unavailable; symbols written to output.");
        }
    }
}

export const ibkrDataService = new IbkrDataService();
