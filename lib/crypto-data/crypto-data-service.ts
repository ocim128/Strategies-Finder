/**
 * Crypto Data tab browser service. Mirrors `lib/ibkr-data/ibkr-data-service.ts`.
 *
 * Browser-side, so it CAN import heavy modules (it's code-split via the lazy
 * feature registry, not bundled into `vite.config.ts`). Responsibilities:
 *   - parse the symbols textarea and expand synthetic pairs (`SOL+TRX`) into
 *     their underlying Binance USDT legs (`SOLUSDT`, `TRXUSDT`)
 *   - POST to `/api/crypto/download` or `/api/crypto/sync`, consume the NDJSON
 *     progress stream, and update the status/output elements
 *   - invalidate local caches after a successful sync so the freshly-stored
 *     SQLite data is picked up by the chart, Finder, and Batch
 *   - reattach to a sync still running after a tab reload
 */

import { clearLocalDailyAssetCaches } from "../local-daily-datasets";
import { dataManager } from "../data-manager";
import { finderManager } from "../finder-manager";
import { uiManager } from "../ui-manager";
import { clearBatchDatasetCaches } from "../batch-backtest/batch-backtest-loader";
import { clearRankPairsRecentLoaderCache } from "../rank-pairs/rank-pairs-recent-loader";
import { consumeNdjsonStream } from "../ndjson-stream";
import { createCryptoDataDom, type CryptoDataDom } from "./crypto-data-dom";
import type { CryptoCompletedTarget, CryptoStreamEvent, CryptoSyncRunSnapshot } from "./crypto-data-stream-types";
import { CRYPTO_SYMBOL_TEMPLATE } from "./crypto-symbol-template";
import { buildCryptoSyncRequestPlans, expandCryptoSymbols } from "./crypto-symbol-plans";

export { buildCryptoSyncRequestPlans, expandCryptoSymbols } from "./crypto-symbol-plans";

// Re-export the shared wire types so existing imports of them from this module
// keep resolving — the source of truth now lives in the leaf
// `crypto-data-stream-types` module shared with the server plugin (audit
// Finding 6).
export type { CryptoStreamEvent, CryptoSyncRunSnapshot };

class CryptoDataService {
    private dom: CryptoDataDom | null = null;
    private initialized = false;
    private lastSyncedSymbols: string[] = [];
    private reattached = false;

    init(): void {
        if (this.initialized) return;
        this.initialized = true;
        const dom = this.getDom();
        dom.cryptoDataDownloadBtn.addEventListener("click", () => void this.runAction("/api/crypto/download"));
        dom.cryptoDataSyncBtn.addEventListener("click", () => void this.runAction("/api/crypto/sync"));
        dom.cryptoDataStopBtn.addEventListener("click", () => void this.stopSync());
        dom.cryptoDataCopyBtn.addEventListener("click", () => void this.copySymbols());
        dom.cryptoDataLoadSymbolTemplateBtn.addEventListener("click", () => {
            // Append rather than clobber so an existing hand-built list is
            // never destroyed by a single misclick.
            const current = dom.cryptoDataSymbols.value.trim();
            const template = CRYPTO_SYMBOL_TEMPLATE.trim();
            dom.cryptoDataSymbols.value = current.length > 0 ? `${current}\n${template}` : template;
            this.setStatus(current.length > 0 ? "Symbol template appended." : "Symbol template loaded.", "success");
        });
        // Stop stays enabled at startup so it can recover a stuck server-side
        // sync lock without a server restart (mirrors IBKR).
        void this.reattachToInProgressSync();
    }

    private async reattachToInProgressSync(): Promise<void> {
        const POLL_INTERVAL_MS = 2000;
        try {
            // Tracks the last snapshot seen with `running: true`, plus the
            // final `completedTargets` from the brief post-completion window
            // the server preserves. Either path feeds invalidation so a tab
            // that reloaded mid-sync still picks up the freshly written
            // SQLite/CSV data instead of serving stale chart/Finder/Batch
            // caches (audit Finding 1).
            let lastRunningSnapshot: CryptoSyncRunSnapshot | null = null;
            let invalidatedFinal = false;
            while (true) {
                const response = await fetch("/api/crypto/sync/status", { cache: "no-store" });
                const payload = await response.json() as { running?: boolean; run?: CryptoSyncRunSnapshot };
                if (!payload.running || !payload.run) {
                    if (this.reattached) {
                        this.reattached = false;
                        this.setBusy(false);
                        // The server retains the final snapshot briefly so a
                        // reattach poll that arrives just after completion can
                        // still read `completedTargets` and invalidate. If the
                        // poll caught the run mid-flight at least once, prefer
                        // the live snapshot's targets; otherwise fall back to
                        // whatever the post-completion status returned.
                        const finalTargets = payload.run?.completedTargets
                            ?? lastRunningSnapshot?.completedTargets
                            ?? [];
                        if (!invalidatedFinal && finalTargets.length > 0) {
                            invalidatedFinal = true;
                            await this.invalidateCompletedTargets(finalTargets);
                        }
                        this.setStatus("Crypto sync finished (reattached).", "success");
                    }
                    return;
                }
                if (!this.reattached) {
                    this.reattached = true;
                    this.setBusy(true);
                }
                lastRunningSnapshot = payload.run;
                this.renderRunSnapshot(payload.run);
                await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
            }
        } catch (error) {
            if (this.reattached) {
                this.reattached = false;
                this.setBusy(false);
            }
            this.setStatus(error instanceof Error ? `Sync reattach failed: ${error.message}` : "Sync reattach failed.", "error");
        }
    }

    /**
     * Invalidate chart / Finder / Batch caches for the symbol/interval pairs
     * the server reported as completed, grouped by interval so each call
     * passes the narrowest interval list to `dataManager`. Mirrors the
     * per-interval grouping the in-tab streaming path already does. Used by
     * the reattach path which otherwise sees only the status snapshot
     * (audit Finding 1).
     */
    private async invalidateCompletedTargets(targets: readonly CryptoCompletedTarget[]): Promise<void> {
        if (targets.length === 0) return;
        const byInterval = new Map<string, Set<string>>();
        for (const target of targets) {
            const interval = String(target.interval ?? "").trim().toLowerCase();
            const symbol = String(target.symbol ?? "").trim().toUpperCase();
            if (!symbol) continue;
            const set = byInterval.get(interval) ?? new Set<string>();
            set.add(symbol);
            byInterval.set(interval, set);
        }
        for (const [interval, symbols] of byInterval) {
            await this.invalidateSyncedData(Array.from(symbols), interval);
        }
    }

    private renderRunSnapshot(run: CryptoSyncRunSnapshot): void {
        const seen = run.completed + run.failed;
        const current = run.currentSymbol
            ? ` — syncing ${run.currentSymbol}${run.currentInterval ? ` ${run.currentInterval}` : ""}`
            : "";
        const failLabel = run.failed > 0 ? `, ${run.failed} failed` : "";
        const cancelLabel = run.cancelled ? " (stopping)" : "";
        this.setStatus(`Crypto ${run.mode} ${seen}/${run.total}${failLabel}${cancelLabel}${current}`);
    }

    private getDom(): CryptoDataDom {
        return this.dom ??= createCryptoDataDom();
    }

    private parseSymbols(): string[] {
        const symbols = expandCryptoSymbols(this.getDom().cryptoDataSymbols.value);
        if (symbols.length > 0) this.lastSyncedSymbols = symbols;
        return symbols;
    }

    private getRequestBody(): Record<string, unknown> {
        const dom = this.getDom();
        const raw = dom.cryptoDataSymbols.value;
        const symbols = expandCryptoSymbols(raw);
        if (symbols.length > 0) this.lastSyncedSymbols = symbols;
        const targets = buildCryptoSyncRequestPlans(raw, dom.cryptoDataInterval.value)
            .flatMap((plan) => plan.symbols.map((symbol) => ({
                symbol,
                interval: plan.interval,
                ...(plan.totalBars ? { totalBars: plan.totalBars } : {}),
            })));
        return {
            targets,
            marketType: dom.cryptoDataMarketType.value,
        };
    }

    private setBusy(busy: boolean): void {
        const dom = this.getDom();
        dom.cryptoDataDownloadBtn.disabled = busy;
        dom.cryptoDataSyncBtn.disabled = busy;
        dom.cryptoDataCopyBtn.disabled = busy;
        dom.cryptoDataStopBtn.disabled = false;
    }

    private setStatus(message: string, tone?: "success" | "error"): void {
        const status = this.getDom().cryptoDataStatus;
        status.textContent = message;
        status.className = tone ? `data-mining-status ${tone}` : "data-mining-status";
    }

    private writeOutput(payload: unknown): void {
        this.getDom().cryptoDataOutput.textContent = typeof payload === "string"
            ? payload
            : JSON.stringify(payload, null, 2);
    }

    private async runAction(url: string): Promise<void> {
        const body = this.getRequestBody();
        const targets = Array.isArray(body.targets) ? body.targets : [];
        if (targets.length === 0) {
            this.setStatus("Add at least one symbol.", "error");
            return;
        }

        this.setBusy(true);
        this.setStatus("Running crypto request...");
        const aggregated: { ok: boolean; results: unknown[]; failed: unknown[]; error?: string } = {
            ok: true,
            results: [],
            failed: [],
        };
        const syncedByInterval = new Map<string, Set<string>>();
        let seen = 0;
        const total = targets.length;
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            if (!response.ok || !response.body) {
                const text = await response.text();
                let payload: { error?: string } = {};
                try { payload = JSON.parse(text); } catch { /* ignore */ }
                aggregated.ok = false;
                aggregated.error = payload.error ?? `Crypto request failed (${response.status}).`;
            } else {
                await consumeNdjsonStream<CryptoStreamEvent>(response.body, {
                    onStart: (event) => {
                        this.setStatus(`Crypto ${event.mode ?? "request"}: 0/${total}`);
                    },
                    onSymbol: (event) => {
                        seen = event.index + 1;
                        const symbols = syncedByInterval.get(event.interval) ?? new Set<string>();
                        symbols.add(event.symbol);
                        syncedByInterval.set(event.interval, symbols);
                        const delta = event.fetchedBars ?? 0;
                        const deltaLabel = delta > 0 ? ` +${delta} bar${delta === 1 ? "" : "s"}` : "";
                        this.setStatus(`Crypto ${seen}/${total}: ${event.symbol} ${event.interval}${deltaLabel}`);
                    },
                    onSymbolFailed: (event) => {
                        seen = event.index + 1;
                        this.setStatus(`Crypto ${seen}/${total}: ${event.symbol} ${event.interval} failed — ${event.error}`, "error");
                    },
                    onDone: (event) => {
                        aggregated.ok = event.ok;
                        aggregated.results = event.results ?? [];
                        aggregated.failed = event.failed ?? [];
                    },
                    onFatal: (event) => {
                        aggregated.ok = false;
                        aggregated.error = event.error;
                    },
                });
            }

            for (const [interval, symbols] of syncedByInterval) {
                await this.invalidateSyncedData(Array.from(symbols), interval);
            }
            this.writeOutput(aggregated);
            if (aggregated.error) {
                this.setStatus(aggregated.error, "error");
                return;
            }
            if (!aggregated.ok) {
                this.setStatus("Crypto request completed with failures.", "error");
                return;
            }
            this.setStatus(`Crypto request complete — ${seen}/${total} symbol${total === 1 ? "" : "s"}.`, "success");
        } catch (error) {
            this.writeOutput(error instanceof Error ? error.message : String(error));
            this.setStatus("Crypto request failed.", "error");
        } finally {
            this.setBusy(false);
        }
    }

    private async invalidateSyncedData(symbols: readonly string[], interval: unknown): Promise<void> {
        if (symbols.length === 0) return;
        const normalizedInterval = String(interval ?? "").trim().toLowerCase();
        clearLocalDailyAssetCaches();
        dataManager.invalidateLocalSeries(symbols, normalizedInterval ? [normalizedInterval] : undefined);
        await finderManager.invalidateLocalDataCaches();
        clearBatchDatasetCaches();
        clearRankPairsRecentLoaderCache();
    }

    private async stopSync(): Promise<void> {
        try {
            await fetch("/api/crypto/stop", { method: "POST" });
            this.setStatus("Stopping crypto sync...");
        } catch (error) {
            this.writeOutput(error instanceof Error ? error.message : String(error));
            this.setStatus("Failed to request stop.", "error");
        }
    }

    private async copySymbols(): Promise<void> {
        const symbols = this.lastSyncedSymbols.length > 0
            ? this.lastSyncedSymbols
            : this.parseSymbols();
        if (symbols.length === 0) {
            this.setStatus("No symbols to copy.", "error");
            return;
        }
        const text = symbols.join("\n");
        try {
            await navigator.clipboard.writeText(text);
            this.setStatus(`Copied ${symbols.length} crypto symbol${symbols.length === 1 ? "" : "s"}.`, "success");
            uiManager.showToast("Crypto symbols copied.", "success");
        } catch {
            this.writeOutput(text);
            this.setStatus("Clipboard unavailable; symbols written to output.", "error");
        }
    }
}

export const cryptoDataService = new CryptoDataService();
