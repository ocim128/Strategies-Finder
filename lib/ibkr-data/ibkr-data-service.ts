import { clearLocalDailyAssetCaches, markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import { dataManager } from "../data-manager";
import { finderManager } from "../finder-manager";
import { uiManager } from "../ui-manager";
import { clearBatchDatasetCaches } from "../batch-backtest/batch-backtest-loader";
import { createIbkrDataDom, type IbkrDataDom } from "./ibkr-data-dom";

type IbkrStreamEvent =
    | { type: "start"; total: number; interval?: string; mode?: string }
    | { type: "symbol"; index: number; total: number; symbol: string; markedSymbol?: string; bars?: number; fetchedBars?: number }
    | { type: "symbol_failed"; index: number; total: number; symbol: string; error: string }
    | { type: "done"; ok: boolean; cancelled?: boolean; interval?: string; totals?: { bars: number; fetchedBars: number }; results?: unknown[]; failed?: unknown[] }
    | { type: "fatal"; error: string };

// Shape of GET /api/ibkr/sync/status `run` payload, used by reattach polling.
type IbkrSyncRunSnapshot = {
    startedAt: string;
    mode: "sync" | "download";
    interval: string;
    period: string | null;
    total: number;
    index: number;
    completed: number;
    failed: number;
    currentSymbol: string | null;
    failedSymbols: Array<{ symbol: string; error: string }>;
    cancelled: boolean;
};

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
     * the status text on each poll until the run ends, then unlocks. Falls
     * back to a single fire-and-forget request if fetch is unavailable.
     */
    private async reattachToInProgressSync(): Promise<void> {
        const POLL_INTERVAL_MS = 2000;
        // Bounded poll count: a healthy sync processes at least one symbol
        // within ~5 minutes; if the server hasn't made progress in 150 polls
        // (5 minutes), the gateway fetch is almost certainly hung (no fetch
        // timeout exists in requestGatewayText) and continuing to poll just
        // leaks fetches. The user can still click Stop.
        const MAX_POLLS = 150;
        try {
            for (let poll = 0; poll < MAX_POLLS; poll += 1) {
                const response = await fetch("/api/ibkr/sync/status", { cache: "no-store" });
                const payload = await response.json() as { running?: boolean; run?: IbkrSyncRunSnapshot };
                if (!payload.running || !payload.run) {
                    if (this.reattached) {
                        this.reattached = false;
                        this.setBusy(false);
                        this.setStatus("IBKR sync finished (reattached).");
                    }
                    return;
                }
                // First poll that discovers a running sync: lock the UI.
                if (!this.reattached) {
                    this.reattached = true;
                    this.setBusy(true);
                }
                this.renderRunSnapshot(payload.run);
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            }
            // Loop exhausted: surface that we stopped watching. The server
            // may still be syncing, but we won't observe it from this tab.
            if (this.reattached) {
                this.reattached = false;
                this.setBusy(false);
                this.setStatus("IBKR sync still running after 5 min — stopped watching. Click Stop or retry.");
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
        this.setStatus(`IBKR ${run.mode} ${seen}/${run.total}${failLabel}${cancelLabel}${current}`);
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
        return {
            symbols: this.parseSymbols(),
            interval: dom.ibkrDataInterval.value,
            ...(period ? { period } : {}),
        };
    }

    private setBusy(busy: boolean): void {
        const dom = this.getDom();
        dom.ibkrDataStatusBtn.disabled = busy;
        dom.ibkrDataResolveBtn.disabled = busy;
        dom.ibkrDataDownloadBtn.disabled = busy;
        dom.ibkrDataSyncBtn.disabled = busy;
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
            const payload = await response.json();
            this.writeOutput(payload);
            this.setStatus(response.ok ? "Gateway reachable" : "Gateway unavailable");
        } catch (error) {
            this.writeOutput(error instanceof Error ? error.message : String(error));
            this.setStatus("Gateway check failed");
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
        this.setStatus("Running IBKR request...");
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
        let seen = 0;
        let total = 0;
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
                aggregated.error = payload.error ?? `IBKR request failed (${response.status}).`;
                this.writeOutput(text);
                this.setStatus(aggregated.error);
                return;
            }

            await this.consumeNdjsonStream(response.body, {
                onStart: (event) => {
                    total = event.total;
                    this.setStatus(`IBKR ${event.mode ?? "request"}: 0/${total}`);
                },
                onSymbol: (event) => {
                    seen = event.index + 1;
                    // Accumulate as we go so partial-fatal invalidation works.
                    const marked = event.markedSymbol ?? markIbkrSymbol(event.symbol);
                    if (marked && !markedSymbolsAcc.includes(marked)) {
                        markedSymbolsAcc.push(marked);
                    }
                    const delta = event.fetchedBars ?? 0;
                    const deltaLabel = delta > 0 ? ` +${delta} bar${delta === 1 ? "" : "s"}` : "";
                    this.setStatus(`IBKR ${seen}/${total}: ${event.symbol}${deltaLabel}`);
                },
                onSymbolFailed: (event) => {
                    seen = event.index + 1;
                    this.setStatus(`IBKR ${seen}/${total}: ${event.symbol} failed — ${event.error}`);
                },
                onDone: (event) => {
                    aggregated.ok = event.ok;
                    aggregated.results = event.results ?? [];
                    aggregated.failed = event.failed ?? [];
                    this.writeOutput(event);
                },
                onFatal: (event) => {
                    aggregated.error = event.error;
                    this.writeOutput(event);
                },
            });

            // Use the accumulated marked symbols so partial-fatal still
            // invalidates the symbols that landed before the fatal. Fall back
            // to captureMarkedSymbols (which reads `aggregated.results`) when
            // the full done event landed cleanly.
            const markedSymbols = markedSymbolsAcc.length > 0
                ? markedSymbolsAcc
                : this.captureMarkedSymbols(aggregated);
            if (invalidate && markedSymbols.length > 0) {
                this.invalidateSyncedData(markedSymbols, body.interval);
            }
            if (aggregated.error) {
                this.setStatus(aggregated.error);
                return;
            }
            if (!aggregated.ok) {
                this.setStatus("IBKR request completed with failures.");
                return;
            }
            this.setStatus(`IBKR request complete — ${seen}/${total} symbol${total === 1 ? "" : "s"}.`);
        } catch (error) {
            this.writeOutput(error instanceof Error ? error.message : String(error));
            this.setStatus("IBKR request failed.");
        } finally {
            this.setBusy(false);
        }
    }

    /**
     * Reads an NDJSON (`application/x-ndjson`) response body stream, parses
     * each newline-delimited JSON event, and dispatches to the typed
     * callbacks. Tolerates partial trailing chunks by buffering until the
     * next newline. Used by `runAction` for incremental progress.
     */
    private async consumeNdjsonStream(
        body: ReadableStream<Uint8Array>,
        handlers: {
            onStart: (event: Extract<IbkrStreamEvent, { type: "start" }>) => void;
            onSymbol: (event: Extract<IbkrStreamEvent, { type: "symbol" }>) => void;
            onSymbolFailed: (event: Extract<IbkrStreamEvent, { type: "symbol_failed" }>) => void;
            onDone: (event: Extract<IbkrStreamEvent, { type: "done" }>) => void;
            onFatal: (event: Extract<IbkrStreamEvent, { type: "fatal" }>) => void;
        }
    ): Promise<void> {
        const reader = body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            let newlineIndex: number;
            while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
                const line = buffer.slice(0, newlineIndex).trim();
                buffer = buffer.slice(newlineIndex + 1);
                if (!line) continue;
                let event: IbkrStreamEvent;
                try {
                    event = JSON.parse(line) as IbkrStreamEvent;
                } catch {
                    continue;
                }
                switch (event.type) {
                    case "start": handlers.onStart(event); break;
                    case "symbol": handlers.onSymbol(event); break;
                    case "symbol_failed": handlers.onSymbolFailed(event); break;
                    case "done": handlers.onDone(event); break;
                    case "fatal": handlers.onFatal(event); break;
                }
            }
        }
    }

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
