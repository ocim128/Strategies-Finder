import { clearLocalDailyAssetCaches, markIbkrSymbol, stripIbkrMarker } from "../local-daily-datasets";
import { dataManager } from "../data-manager";
import { finderManager } from "../finder-manager";
import { uiManager } from "../ui-manager";
import { clearBatchDatasetCaches } from "../batch-backtest/batch-backtest-loader";
import { createIbkrDataDom, type IbkrDataDom } from "./ibkr-data-dom";

type IbkrActionResponse = {
    ok?: boolean;
    results?: unknown[];
    failed?: unknown[];
    error?: string;
};

class IbkrDataService {
    private dom: IbkrDataDom | null = null;
    private initialized = false;
    private lastMarkedSymbols: string[] = [];

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
        dom.ibkrDataStopBtn.disabled = true;
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
        dom.ibkrDataStopBtn.disabled = !busy;
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
        try {
            const response = await fetch(url, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(body),
            });
            const payload = await response.json() as IbkrActionResponse;
            this.writeOutput(payload);
            const markedSymbols = this.captureMarkedSymbols(payload);
            if (invalidate && markedSymbols.length > 0) {
                this.invalidateSyncedData(markedSymbols, body.interval);
            }
            if (payload.ok === false || !response.ok) {
                this.setStatus(payload.error ?? "IBKR request completed with failures.");
                return;
            }
            this.setStatus("IBKR request complete.");
        } catch (error) {
            this.writeOutput(error instanceof Error ? error.message : String(error));
            this.setStatus("IBKR request failed.");
        } finally {
            this.setBusy(false);
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

    private captureMarkedSymbols(payload: IbkrActionResponse): string[] {
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
        window.dispatchEvent(new CustomEvent("ibkr-data:catalog-updated", {
            detail: { symbols, interval: normalizedInterval },
        }));
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
