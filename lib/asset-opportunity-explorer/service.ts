import { ensureLazyStylesheet } from "../lazy-styles";
import { coalesceAnimationFrame } from "../render-scheduler";
import { createAssetOpportunityExplorerDom, type AssetOpportunityExplorerDom } from "./dom";
import {
    colorDomainFor,
    drawHeatmap,
    formatDetailSummary,
    heatCellAt,
    readoutText,
    renderDetailRows,
    renderHistogram,
    renderLegend,
    renderMeta,
    type BrushSelection,
    type CellRef,
    type HeatmapRenderState,
} from "./renderer";
import type {
    AssetOpportunityExplorerCatalogResponse,
    AssetOpportunityExplorerCatalogRun,
    AssetOpportunityExplorerDetailRow,
    AssetOpportunityExplorerDetailsResponse,
    AssetOpportunityExplorerHeatmapResponse,
    AssetOpportunityExplorerMetric,
} from "./types";

/**
 * Browser coordination for the Opportunity Explorer. Read-only over the local
 * API: one catalog request, one heatmap snapshot at a time, paged evidence
 * details. Obsolete responses are dropped via a request generation plus an
 * AbortController; detail renders additionally verify the snapshot identity so
 * an evicted snapshot can never repaint the panel. Selection state lives in
 * service-local memory only — no persisted preferences are introduced.
 */

const LOCAL_SERVER_HINT = "The Opportunity Explorer reads the local archive through the Vite server. Start the local dev/preview server (npm run dev) and reload.";

const EXPLORER_DETAILS_PAGE_SIZE = 100;

export class AssetOpportunityExplorerService {
    private dom: AssetOpportunityExplorerDom | null = null;
    private initialized = false;
    private catalog: AssetOpportunityExplorerCatalogResponse | null = null;
    private heatmap: AssetOpportunityExplorerHeatmapResponse | null = null;
    private metric: AssetOpportunityExplorerMetric = "actual";
    private domain = 1;
    private hover: CellRef | null = null;
    private focus: CellRef | null = null;
    private brush: BrushSelection | null = null;
    private detailRows: AssetOpportunityExplorerDetailRow[] = [];
    /** Ownership token for detail requests; independent of the heatmap generation. */
    private detailGeneration = 0;
    private requestGeneration = 0;
    private abortController: AbortController | null = null;
    private dragAnchor: (CellRef & { moved: boolean }) | null = null;
    private readonly renderFrame = coalesceAnimationFrame(() => this.redrawHeatmap());

    private getDom(): AssetOpportunityExplorerDom {
        return this.dom ??= createAssetOpportunityExplorerDom();
    }

    public init(): void {
        ensureLazyStylesheet("asset-opportunity-explorer-styles", new URL("../../styles/asset-opportunity-explorer.css", import.meta.url).href);
        if (this.initialized) return;
        this.initialized = true;
        const dom = this.getDom();
        dom.explorerRunSelect.addEventListener("change", () => {
            this.applyCatalogToControls();
            void this.loadHeatmap();
        });
        dom.explorerHorizonSelect.addEventListener("change", () => { void this.loadHeatmap(); });
        dom.explorerTopKInput.addEventListener("change", () => { void this.loadHeatmap(); });
        dom.explorerSpacingSelect.addEventListener("change", () => { void this.loadHeatmap(); });
        dom.explorerMetricSelect.addEventListener("change", () => this.onMetricChange());
        dom.explorerRefreshBtn.addEventListener("click", () => { void this.refresh(); });
        dom.explorerRangeApplyBtn.addEventListener("click", () => this.applyRangeInputs());
        dom.explorerDetailCloseBtn.addEventListener("click", () => { dom.explorerDetail.hidden = true; });
        dom.explorerDetailLoadOlderBtn.addEventListener("click", () => { void this.loadDetails(this.detailRows.length); });
        this.bindHeatmapInteractions(dom);
        window.addEventListener("resize", () => this.renderFrame.schedule());
        void this.loadCatalog(false);
    }

    private bindHeatmapInteractions(dom: AssetOpportunityExplorerDom): void {
        const canvas = dom.explorerHeatmapCanvas;
        canvas.addEventListener("pointerdown", (event) => {
            const cell = this.cellFromEvent(event);
            if (!cell) return;
            this.dragAnchor = { ...cell, moved: false };
        });
        canvas.addEventListener("pointermove", (event) => {
            const cell = this.cellFromEvent(event);
            const changed = JSON.stringify(cell) !== JSON.stringify(this.hover);
            this.hover = cell;
            if (this.dragAnchor && cell && cell.rowIndex === this.dragAnchor.rowIndex
                && cell.colIndex !== this.dragAnchor.colIndex) {
                this.dragAnchor.moved = true;
            }
            if (cell) this.updateReadout(cell);
            if (changed || (cell && this.dragAnchor?.moved)) this.renderFrame.schedule();
        });
        canvas.addEventListener("pointerleave", () => {
            this.hover = null;
            this.dragAnchor = null;
            dom.explorerHeatmapReadout.textContent = "";
            this.renderFrame.schedule();
        });
        canvas.addEventListener("pointerup", (event) => {
            const anchor = this.dragAnchor;
            this.dragAnchor = null;
            const cell = this.cellFromEvent(event);
            if (!anchor || !cell || !this.heatmap) return;
            const sortMetric = this.heatmap.sorts[anchor.rowIndex];
            if (sortMetric === undefined) return;
            const columns = this.heatmap.holdoutBars;
            if (anchor.moved) {
                const fromCol = Math.min(anchor.colIndex, cell.colIndex);
                const toCol = Math.max(anchor.colIndex, cell.colIndex);
                this.selectRange(sortMetric, columns[toCol]!, columns[fromCol]!);
            } else {
                // A click selects the whole visible row; the detail covers every column.
                this.selectRange(sortMetric, columns[columns.length - 1]!, columns[0]!);
            }
        });
        dom.explorerHeatmapWrap.addEventListener("keydown", (event) => {
            this.handleHeatmapKeydown(event);
        });
        dom.explorerHeatmapWrap.addEventListener("blur", () => {
            this.focus = null;
            this.renderFrame.schedule();
        });
    }

    private cellFromEvent(event: Event): CellRef | null {
        if (!this.heatmap || !(event instanceof PointerEvent)) return null;
        const target = event.currentTarget;
        if (!(target instanceof HTMLCanvasElement)) return null;
        return heatCellAt(this.heatmap, event.offsetX, event.offsetY, target.clientWidth);
    }

    private handleHeatmapKeydown(event: KeyboardEvent): void {
        if (!this.heatmap) return;
        const rows = this.heatmap.sorts.length;
        const columns = this.heatmap.holdoutBars.length;
        if (rows === 0 || columns === 0) return;
        const focus = this.focus ?? { rowIndex: 0, colIndex: 0 };
        let next: CellRef | null = { ...focus };
        switch (event.key) {
            case "ArrowRight": next.colIndex = Math.min(columns - 1, focus.colIndex + 1); break;
            case "ArrowLeft": next.colIndex = Math.max(0, focus.colIndex - 1); break;
            case "ArrowDown": next.rowIndex = Math.min(rows - 1, focus.rowIndex + 1); break;
            case "ArrowUp": next.rowIndex = Math.max(0, focus.rowIndex - 1); break;
            case "Home": next.colIndex = 0; break;
            case "End": next.colIndex = columns - 1; break;
            case "Enter":
            case " ": {
                event.preventDefault();
                const sortMetric = this.heatmap.sorts[focus.rowIndex];
                if (sortMetric !== undefined) {
                    this.selectRange(sortMetric, this.heatmap.holdoutBars[columns - 1]!, this.heatmap.holdoutBars[0]!);
                }
                return;
            }
            case "Escape":
                event.preventDefault();
                this.brush = null;
                this.hideDetail();
                this.renderFrame.schedule();
                return;
            default:
                next = null;
        }
        if (!next) return;
        event.preventDefault();
        this.focus = next;
        this.updateReadout(next);
        this.renderFrame.schedule();
    }

    private setStatus(text: string, tone: "neutral" | "running" | "success" | "warning" | "danger" = "neutral"): void {
        const dom = this.getDom();
        dom.explorerStatus.textContent = text;
        dom.explorerStatus.dataset.tone = tone;
    }

    private async fetchJson<T>(url: string): Promise<T> {
        if (this.abortController) this.abortController.abort();
        const abortController = new AbortController();
        this.abortController = abortController;
        try {
            const response = await fetch(url, { cache: "no-store", signal: abortController.signal });
            if (!response.ok) {
                let message = `HTTP ${response.status}`;
                try {
                    const payload = await response.json() as { error?: string };
                    message = payload.error ?? message;
                } catch {
                    // keep the default status message
                }
                throw new Error(message);
            }
            return await response.json() as T;
        } finally {
            if (this.abortController === abortController) this.abortController = null;
        }
    }

    /** Only a newer request aborts an in-flight one; the aborted caller exits quietly. */
    private static isAbort(error: unknown): boolean {
        return error instanceof DOMException && error.name === "AbortError";
    }

    private isCurrent(generation: number): boolean {
        return generation === this.requestGeneration;
    }

    private async loadCatalog(refresh: boolean): Promise<void> {
        const generation = ++this.requestGeneration;
        const dom = this.getDom();
        this.setStatus(refresh ? "Refreshing archive catalog…" : "Loading archive catalog…", "running");
        try {
            const payload = await this.fetchJson<AssetOpportunityExplorerCatalogResponse>(
                `/api/asset-opportunity-explorer/catalog${refresh ? "?refresh=1" : ""}`,
            );
            if (!this.isCurrent(generation)) return;
            this.catalog = payload;
            this.applyCatalogToControls();
            this.setStatus(`Catalog loaded — ${payload.runs.length} run${payload.runs.length === 1 ? "" : "s"} (${payload.fileCount} files)`, "success");
            if (payload.runs.length === 0) {
                dom.explorerEmpty.hidden = false;
                dom.explorerHeatmapSection.hidden = true;
                dom.explorerMeta.textContent = "";
                return;
            }
            dom.explorerEmpty.hidden = true;
            dom.explorerHeatmapSection.hidden = false;
            await this.loadHeatmap();
        } catch (error) {
            if (AssetOpportunityExplorerService.isAbort(error)) return;
            if (!this.isCurrent(generation)) return;
            const message = error instanceof Error ? error.message : String(error);
            if (refresh && this.catalog) {
                // A failed refresh must leave the previous display clearly stale.
                this.setStatus(`Refresh failed: ${message} — the display is stale, showing the earlier scan from ${this.catalog.scannedAt}`, "danger");
                return;
            }
            if (this.catalog) {
                this.setStatus(`Catalog error: ${message}`, "danger");
                return;
            }
            dom.explorerEmpty.hidden = false;
            dom.explorerHeatmapSection.hidden = true;
            dom.explorerEmpty.querySelector(".empty-state-description")?.replaceChildren(
                `${message}. ${LOCAL_SERVER_HINT}`,
            );
            this.setStatus("Unavailable", "danger");
        }
    }

    private async refresh(): Promise<void> {
        this.heatmap = null;
        this.brush = null;
        this.hideDetail();
        await this.loadCatalog(true);
    }

    private selectedRun(): AssetOpportunityExplorerCatalogRun | null {
        const runId = this.getDom().explorerRunSelect.value;
        return this.catalog?.runs.find((run) => run.batchRunId === runId) ?? null;
    }

    private applyCatalogToControls(): void {
        const dom = this.getDom();
        const runs = this.catalog?.runs ?? [];
        // Read the selections BEFORE rebuilding the options: a real <select>
        // resets to its first option the moment its children are replaced, so
        // the previous selection is only recoverable from the captured value.
        const previousRunId = dom.explorerRunSelect.value;
        const previousHorizon = dom.explorerHorizonSelect.value;
        dom.explorerRunSelect.replaceChildren(...runs.map((run) => {
            const option = document.createElement("option");
            option.value = run.batchRunId;
            const suffix = run.support === "fixed_horizon"
                ? ""
                : run.support === "next_exit"
                    ? " — next-exit run (heatmap not supported yet)"
                    : " — mixed measurement modes";
            option.textContent = `${run.batchRunId} · latest ${run.latestTimestamp}${suffix}`;
            option.disabled = run.support !== "fixed_horizon";
            return option;
        }));
        if (previousRunId && runs.some((run) => run.batchRunId === previousRunId)) {
            dom.explorerRunSelect.value = previousRunId;
        } else if (runs[0]) {
            dom.explorerRunSelect.value = runs[0].batchRunId;
        }
        const selected = this.selectedRun();
        const horizons = selected?.horizons ?? [];
        dom.explorerHorizonSelect.replaceChildren(...horizons.map((bars) => {
            const option = document.createElement("option");
            option.value = String(bars);
            option.textContent = `${bars} bars`;
            return option;
        }));
        if (previousHorizon && horizons.includes(Number(previousHorizon))) {
            dom.explorerHorizonSelect.value = previousHorizon;
        } else {
            const preferredHorizon = horizons.includes(12) ? 12 : horizons[horizons.length - 1];
            if (preferredHorizon !== undefined) dom.explorerHorizonSelect.value = String(preferredHorizon);
        }
        if (selected && selected.archiveMaximumRank > 0) {
            dom.explorerTopKInput.max = String(selected.archiveMaximumRank);
            const current = Number(dom.explorerTopKInput.value);
            if (!Number.isInteger(current) || current < 1) dom.explorerTopKInput.value = "10";
            if (current > selected.archiveMaximumRank) dom.explorerTopKInput.value = String(selected.archiveMaximumRank);
        }
        this.renderRunNotice();
        renderMeta(dom, selected, null);
    }

    private renderRunNotice(): void {
        const dom = this.getDom();
        const run = this.selectedRun();
        if (!run || run.support === "fixed_horizon") {
            dom.explorerRunNotice.hidden = true;
            dom.explorerRunNotice.textContent = "";
            return;
        }
        dom.explorerRunNotice.hidden = false;
        dom.explorerRunNotice.textContent = run.support === "next_exit"
            ? `Run ${run.batchRunId} archives next-exit outcomes (each candidate's own exit), which this heatmap does not plot. Version one plots fixed_horizon runs; pick another run or analyze this one with the holdout-analysis CLI.`
            : `Run ${run.batchRunId} mixes fixed-horizon and next-exit archive blocks, so its cells would combine different measurements. It is excluded from the heatmap.`;
    }

    private heatmapUrl(): string {
        const dom = this.getDom();
        const params = new URLSearchParams({
            batchRunId: dom.explorerRunSelect.value,
            horizonBars: dom.explorerHorizonSelect.value,
            topK: dom.explorerTopKInput.value,
            spacing: dom.explorerSpacingSelect.value,
        });
        return `/api/asset-opportunity-explorer/heatmap?${params.toString()}`;
    }

    private async loadHeatmap(): Promise<void> {
        const dom = this.getDom();
        const run = this.selectedRun();
        if (!run) return;
        if (run.support !== "fixed_horizon") {
            dom.explorerHeatmapSection.hidden = true;
            return;
        }
        const generation = ++this.requestGeneration;
        const topK = Number(dom.explorerTopKInput.value);
        if (!Number.isInteger(topK) || topK < 1) {
            this.setStatus("Top K must be a positive integer.", "danger");
            return;
        }
        this.setStatus("Loading heatmap…", "running");
        this.brush = null;
        this.hover = null;
        this.focus = null;
        this.hideDetail();
        try {
            const payload = await this.fetchJson<AssetOpportunityExplorerHeatmapResponse>(this.heatmapUrl());
            if (!this.isCurrent(generation)) return;
            this.heatmap = payload;
            this.metric = dom.explorerMetricSelect.value as AssetOpportunityExplorerMetric;
            this.domain = colorDomainFor(payload, this.metric);
            dom.explorerHeatmapSection.hidden = false;
            renderLegend(dom, this.metric, this.domain, payload.basis);
            renderMeta(dom, run, payload);
            this.renderRunNotice();
            this.renderFrame.schedule();
            const diag = payload.diagnostics;
            this.setStatus(
                `Heatmap loaded — ${payload.sorts.length} sorts × ${payload.holdoutBars.length} columns; observed ${diag.observedRows}/${diag.selectedRows} rows, missing ${diag.missingRows}`,
                "success",
            );
        } catch (error) {
            if (AssetOpportunityExplorerService.isAbort(error)) return;
            if (!this.isCurrent(generation)) return;
            const message = error instanceof Error ? error.message : String(error);
            dom.explorerRunNotice.hidden = false;
            dom.explorerRunNotice.textContent = message;
            this.setStatus(`Heatmap unavailable: ${message}`, "danger");
        }
    }

    /** Metric switches recolour cached cells; only the detail needs a refetch. */
    private onMetricChange(): void {
        if (!this.heatmap) return;
        this.metric = this.getDom().explorerMetricSelect.value as AssetOpportunityExplorerMetric;
        this.domain = colorDomainFor(this.heatmap, this.metric);
        renderLegend(this.getDom(), this.metric, this.domain, this.heatmap.basis);
        this.renderFrame.schedule();
        if (this.brush) void this.loadDetails(0);
    }

    private redrawHeatmap(): void {
        if (!this.heatmap || !this.dom) return;
        const state: HeatmapRenderState = {
            heatmap: this.heatmap,
            metric: this.metric,
            domain: this.domain,
            hover: this.hover,
            focus: this.focus,
            brush: this.brush,
        };
        drawHeatmap(this.dom, state);
    }

    private updateReadout(ref: CellRef): void {
        if (!this.heatmap) return;
        this.getDom().explorerHeatmapReadout.textContent = readoutText(this.heatmap, ref);
    }

    private selectRange(sortMetric: string, from: number, to: number): void {
        const dom = this.getDom();
        this.brush = { sortMetric, from, to };
        dom.explorerRangeStart.value = String(from);
        dom.explorerRangeEnd.value = String(to);
        this.renderFrame.schedule();
        void this.loadDetails(0);
    }

    private applyRangeInputs(): void {
        if (!this.heatmap || !this.brush) {
            this.setDetailStatus("Select a sort row first (click or drag on the heatmap).");
            return;
        }
        const dom = this.getDom();
        const columns = this.heatmap.holdoutBars;
        const start = Number(dom.explorerRangeStart.value);
        const end = Number(dom.explorerRangeEnd.value);
        if (!columns.includes(start) || !columns.includes(end)) {
            this.setDetailStatus(`Both bounds must be visible holdout columns (${columns[0]}…${columns[columns.length - 1]}${dom.explorerSpacingSelect.value === "horizon" ? ", horizon-spaced" : ""}).`);
            return;
        }
        void this.selectRange(this.brush.sortMetric, start, end);
    }

    private hideDetail(): void {
        this.detailRows = [];
        const dom = this.getDom();
        dom.explorerDetail.hidden = true;
        dom.explorerDetailLoadOlderBtn.hidden = true;
        this.setDetailStatus("");
    }

    private setDetailStatus(text: string): void {
        this.getDom().explorerDetailStatus.textContent = text;
    }

    private detailsUrl(offset: number, limit: number): string | null {
        if (!this.heatmap || !this.brush) return null;
        const params = new URLSearchParams({
            snapshotId: this.heatmap.snapshotId,
            sortMetric: this.brush.sortMetric,
            horizonBars: String(this.heatmap.horizonBars),
            holdoutFrom: String(this.brush.from),
            holdoutTo: String(this.brush.to),
            metric: this.metric,
            offset: String(offset),
            limit: String(limit),
        });
        return `/api/asset-opportunity-explorer/details?${params.toString()}`;
    }

    /** The complete selection a detail request/page must still describe to render. */
    private detailSelectionKey(offset: number): {
        snapshotId: string;
        sortMetric: string;
        holdoutFrom: number;
        holdoutTo: number;
        metric: AssetOpportunityExplorerMetric;
        offset: number;
    } | null {
        if (!this.heatmap || !this.brush) return null;
        return {
            snapshotId: this.heatmap.snapshotId,
            sortMetric: this.brush.sortMetric,
            holdoutFrom: Math.min(this.brush.from, this.brush.to),
            holdoutTo: Math.max(this.brush.from, this.brush.to),
            metric: this.metric,
            offset,
        };
    }

    private async loadDetails(offset: number): Promise<void> {
        const url = this.detailsUrl(offset, EXPLORER_DETAILS_PAGE_SIZE);
        if (!url) return;
        // Detail requests own their lifecycle: a newer detail request supersedes
        // an in-flight one, and heatmap loads/refreshes must never orphan the
        // loading state (that would permanently block further details).
        const detailToken = ++this.detailGeneration;
        const request = this.detailSelectionKey(offset)!;
        const dom = this.getDom();
        dom.explorerDetailLoadOlderBtn.disabled = true;
        this.setDetailStatus(offset === 0 ? "Loading range detail…" : "Loading older rows…");
        try {
            const payload = await this.fetchJson<AssetOpportunityExplorerDetailsResponse>(url);
            if (this.detailGeneration !== detailToken) return;
            // Full selection-key check: the response must still describe the
            // current snapshot, sort, bounds, metric, and page to render.
            const current = this.detailSelectionKey(offset);
            if (!current
                || this.heatmap?.snapshotId !== request.snapshotId
                || payload.snapshotId !== request.snapshotId
                || payload.sortMetric !== request.sortMetric
                || payload.holdoutFrom !== request.holdoutFrom
                || payload.holdoutTo !== request.holdoutTo
                || payload.metric !== request.metric
                || payload.offset !== request.offset) {
                this.setDetailStatus("Detail response does not match the current selection; it was discarded.");
                return;
            }
            dom.explorerDetail.hidden = false;
            dom.explorerDetailTitle.textContent = `Range detail — ${payload.sortMetric} (${payload.holdoutFrom}–${payload.holdoutTo} bars, horizon ${payload.horizonBars})`;
            dom.explorerDetailSummary.textContent = formatDetailSummary(payload);
            renderHistogram(dom.explorerHistogram, payload);
            if (offset === 0) this.detailRows = [...payload.rows];
            else this.detailRows = [...this.detailRows, ...payload.rows];
            renderDetailRows(dom.explorerDetailRows, this.detailRows);
            dom.explorerDetailLoadOlderBtn.hidden = !payload.hasMore;
            this.setDetailStatus(
                `Showing ${this.detailRows.length} of ${payload.totalRows} candidate rows in range. Source references are archive filenames and block timestamps.`,
            );
        } catch (error) {
            if (AssetOpportunityExplorerService.isAbort(error)) return;
            if (this.detailGeneration !== detailToken) return;
            const message = error instanceof Error ? error.message : String(error);
            if (message.includes("no longer retained") || message.includes("409")) {
                this.setDetailStatus("The heatmap snapshot was replaced on the server; reloading the view…");
                void this.loadHeatmap();
                return;
            }
            this.setDetailStatus(`Detail unavailable: ${message}`);
        } finally {
            if (this.detailGeneration === detailToken) {
                dom.explorerDetailLoadOlderBtn.disabled = false;
            }
        }
    }
}

export const assetOpportunityExplorerService = new AssetOpportunityExplorerService();
