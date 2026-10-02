/**
 * Batch results presentation: result row creation, sort-header display, the
 * coalesced live-render queue, and summary/progress rendering.
 *
 * The view owns its render queue and frame scheduling. Run-token authorization
 * stays with the run owner: the factory receives the current-token check and
 * every queue flush re-validates through it, so a stale run that lost
 * ownership mid-stream never writes DOM after a newer run started. When a
 * sorted full-list re-render is required at flush time, the run owner supplies
 * the callback so the authoritative row list is read at flush time.
 */
import { computePerformanceVerdict } from "../../finder/finder-universe-metrics";
import { parseBatchSymbols } from "../batch-run-contract";
import type { BatchBacktestSymbolResult } from "../batch-backtest-runner";
import {
    buildBatchSummaryCells,
    buildResultRowGrid,
} from "../batch-backtest-summary";
import { sortBatchResults, type BatchResultSortState } from "../batch-results-sort";
import type { BatchBacktestDom } from "../batch-backtest-dom";
import { coalesceAnimationFrame } from "../../render-scheduler";

/**
 * Max rows buffered before a synchronous mid-stream flush (Finding 6). The
 * live stream queues DOM renders and flushes once per animation frame, but a
 * very fast cached run could queue hundreds of rows before the first frame;
 * this cap forces a flush so visible progress never lags too far behind the
 * streamed count. Terminal paths always flush regardless of queue size.
 */
const LIVE_RENDER_MAX_BATCH = 50;

export interface BatchResultsView {
    /** Queue a live-stream row; flushes synchronously at the batch cap. */
    queueLiveRender(
        dom: BatchBacktestDom,
        result: BatchBacktestSymbolResult,
        token: number,
        sortedRender?: () => void,
    ): void;
    /**
     * Drain the render queue synchronously (terminal paths). `sortedRender`
     * must be supplied when a result sort is active; it re-renders the full
     * authoritative list from the run owner.
     */
    flushLiveRenderNow(dom: BatchBacktestDom, token: number, sortedRender?: () => void): void;
    /** Cancel any pending animation-frame flush. */
    cancelLiveRenderRaf(): void;
    /** Drop queued rows without rendering (stale-run paths). */
    dropQueuedRows(): void;
    appendResultRows(dom: BatchBacktestDom, results: readonly BatchBacktestSymbolResult[]): void;
    renderResultRows(
        dom: BatchBacktestDom,
        results: readonly BatchBacktestSymbolResult[],
        sort: BatchResultSortState | null,
    ): void;
    updateBatchResultSortHeader(dom: BatchBacktestDom, active: BatchResultSortState | null): void;
    renderSummaryGrid(dom: BatchBacktestDom, results: readonly BatchBacktestSymbolResult[]): void;
    updateSummary(dom: BatchBacktestDom, results: readonly BatchBacktestSymbolResult[]): void;
    setProgress(dom: BatchBacktestDom, percent: number, text: string): void;
    setRunBusy(
        dom: BatchBacktestDom,
        busy: boolean,
        balanced: { blocked: boolean; hasResult: boolean },
    ): void;
    updateBalancedGeneratorButtons(
        dom: BatchBacktestDom,
        balanced: { blocked: boolean; hasResult: boolean },
    ): void;
}

export function createBatchResultsView(deps: {
    /** Run-owner token check; false when the token lost ownership. */
    isRunTokenCurrent: (token: number) => boolean;
}): BatchResultsView {
    const liveRenderQueue: BatchBacktestSymbolResult[] = [];
    let pendingLiveRender: { dom: BatchBacktestDom; token: number; sortedRender?: () => void } | null = null;
    const liveRenderFrame = coalesceAnimationFrame(() => {
        const pending = pendingLiveRender;
        pendingLiveRender = null;
        if (pending) {
            flushLiveRenderNow(pending.dom, pending.token, pending.sortedRender);
        }
    });

    function queueLiveRender(
        dom: BatchBacktestDom,
        result: BatchBacktestSymbolResult,
        token: number,
        sortedRender?: () => void,
    ): void {
        liveRenderQueue.push(result);
        if (liveRenderQueue.length >= LIVE_RENDER_MAX_BATCH) {
            flushLiveRenderNow(dom, token, sortedRender);
            return;
        }
        pendingLiveRender = { dom, token, sortedRender };
        liveRenderFrame.schedule();
    }

    /**
     * Drain the live render queue through `appendResultRows` (one
     * DocumentFragment append). Guarded by the run token so a stale run that
     * lost ownership mid-stream doesn't write DOM after a newer run started.
     */
    function flushLiveRenderNow(dom: BatchBacktestDom, token: number, sortedRender?: () => void): void {
        if (!deps.isRunTokenCurrent(token)) {
            liveRenderQueue.length = 0;
            return;
        }
        if (liveRenderQueue.length === 0) return;
        const batch = liveRenderQueue.slice();
        liveRenderQueue.length = 0;
        if (sortedRender) {
            sortedRender();
        } else {
            appendResultRows(dom, batch);
        }
    }

    function cancelLiveRenderRaf(): void {
        liveRenderFrame.cancel();
        pendingLiveRender = null;
    }

    function dropQueuedRows(): void {
        liveRenderQueue.length = 0;
    }

    /**
     * Append many result rows in one DocumentFragment so restore / reattach
     * paths that render hundreds of rows synchronously do a single reflow
     * instead of one per row. Output is identical to calling createResultRow
     * per element; this is purely a layout-cost optimization for bulk paths.
     * The live server stream is frame-batched separately via queueLiveRender
     * (one reflow per animation frame, not one per row).
     */
    function appendResultRows(dom: BatchBacktestDom, results: readonly BatchBacktestSymbolResult[]): void {
        if (results.length === 0) return;
        const fragment = document.createDocumentFragment();
        for (const result of results) {
            fragment.appendChild(createResultRow(result));
        }
        dom.batchBacktestResults.appendChild(fragment);
    }

    function renderResultRows(
        dom: BatchBacktestDom,
        results: readonly BatchBacktestSymbolResult[],
        sort: BatchResultSortState | null,
    ): void {
        dom.batchBacktestResults.replaceChildren();
        const rows = sort
            ? sortBatchResults(results, sort)
            : results;
        appendResultRows(dom, rows);
    }

    function updateBatchResultSortHeader(dom: BatchBacktestDom, active: BatchResultSortState | null): void {
        dom.batchBacktestResultsHeader.querySelectorAll<HTMLButtonElement>("button[data-batch-sort-key]").forEach((button) => {
            const rawKey = button.dataset.batchSortKey;
            const isActive = Boolean(active && rawKey === active.key);
            button.classList.toggle("is-active", isActive);
            button.classList.toggle("is-ascending", isActive && active?.direction === "asc");
            button.classList.toggle("is-descending", isActive && active?.direction === "desc");
            button.setAttribute("aria-pressed", String(isActive));
            const column = button.parentElement;
            if (column?.getAttribute("role") === "columnheader") {
                column.setAttribute("aria-sort", isActive ? active!.direction : "none");
            }
        });
    }

    function renderSummaryGrid(dom: BatchBacktestDom, results: readonly BatchBacktestSymbolResult[]): void {
        const cells = buildBatchSummaryCells(results);
        if (cells === null) {
            dom.batchBacktestSummaryGrid.replaceChildren();
            dom.batchBacktestSummaryGrid.hidden = true;
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const [label, value] of cells) {
            const cell = document.createElement("div");
            cell.className = "batch-summary-cell";
            const labelEl = document.createElement("span");
            labelEl.className = "batch-summary-cell-label";
            labelEl.textContent = label;
            const valueEl = document.createElement("span");
            valueEl.className = "batch-summary-cell-value";
            valueEl.textContent = value;
            cell.appendChild(labelEl);
            cell.appendChild(valueEl);
            fragment.appendChild(cell);
        }
        dom.batchBacktestSummaryGrid.replaceChildren(fragment);
        dom.batchBacktestSummaryGrid.hidden = false;
    }

    function updateSummary(dom: BatchBacktestDom, results: readonly BatchBacktestSymbolResult[]): void {
        if (results.length > 0) {
            const count = results.length;
            dom.batchBacktestSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
            renderSummaryGrid(dom, results);
            return;
        }
        const count = parseBatchSymbols(dom.batchBacktestSymbols.value).length;
        dom.batchBacktestSummary.textContent = `${count} pair${count === 1 ? "" : "s"}`;
        dom.batchBacktestSummaryGrid.replaceChildren();
        dom.batchBacktestSummaryGrid.hidden = true;
    }

    function setProgress(dom: BatchBacktestDom, percent: number, text: string): void {
        dom.batchBacktestProgressFill.style.width = `${Math.max(0, Math.min(100, percent))}%`;
        dom.batchBacktestProgressText.textContent = text;
    }

    /**
     * Toggle the tab root's `is-running` class. The progress bar is hidden by
     * default and only shown while this class is present (see
     * styles/batch-backtest.css). The generic `.progress-container.active` path
     * used by Finder is never toggled for the Batch tab, so without this class
     * hook the Batch progress bar would stay invisible for the entire run.
     */
    function setRunBusy(
        dom: BatchBacktestDom,
        busy: boolean,
        balanced: { blocked: boolean; hasResult: boolean },
    ): void {
        dom.batchbacktestTab.classList.toggle("is-running", busy);
        dom.batchBacktestBalancedGenerateBtn.disabled = busy;
        updateBalancedGeneratorButtons(dom, balanced);
    }

    function updateBalancedGeneratorButtons(
        dom: BatchBacktestDom,
        balanced: { blocked: boolean; hasResult: boolean },
    ): void {
        dom.batchBacktestBalancedGenerateBtn.disabled = balanced.blocked;
        dom.batchBacktestBalancedCopyBtn.disabled = balanced.blocked || !balanced.hasResult;
    }

    function createResultRow(result: BatchBacktestSymbolResult): HTMLDivElement {
        const line = document.createElement("div");
        line.className = "batch-result-row";

        const verdict = computePerformanceVerdict(result.result, result.status);
        const grid = buildResultRowGrid(result);

        // Column 1: verdict badge + symbol + status.
        const identity = document.createElement("div");
        identity.className = "batch-result-identity";
        const badge = document.createElement("span");
        badge.className = `finder-verdict ${verdict.cssClass}`;
        badge.textContent = verdict.label;
        const symbol = document.createElement("span");
        symbol.className = "batch-result-symbol";
        symbol.textContent = grid.symbol;
        const status = document.createElement("span");
        status.className = "batch-result-status";
        status.textContent = grid.status;
        identity.appendChild(badge);
        identity.appendChild(symbol);
        identity.appendChild(status);
        line.appendChild(identity);

        // Columns 2-5: stable metric columns (Net+Exp / PF+Sharpe / DD / Trades).
        line.appendChild(createMetricCell("Net", grid.net.text, grid.net.sign));
        line.appendChild(createMetricCell("Exp", grid.expectancy.text, grid.expectancy.sign));
        line.appendChild(createMetricCell("PF", grid.profitFactor, "neutral", grid.sharpe, "Sharpe"));
        line.appendChild(createMetricCell("DD", grid.drawdown, "neutral", grid.trades, "Trades"));

        // Optional secondary metadata line: bars, hold, exposure, range.
        if (grid.secondary.length > 0) {
            const secondary = document.createElement("div");
            secondary.className = "batch-result-secondary";
            for (const [label, value] of grid.secondary) {
                const pair = document.createElement("span");
                pair.textContent = `${label} ${value}`;
                secondary.appendChild(pair);
            }
            const yearly = document.createElement("span");
            yearly.textContent = `Yearly ${grid.yearlyPnl}`;
            secondary.appendChild(yearly);
            line.appendChild(secondary);
        }

        if (grid.error) {
            const errorEl = document.createElement("div");
            errorEl.className = "batch-result-error";
            errorEl.textContent = grid.error;
            line.appendChild(errorEl);
        }
        return line;
    }

    /**
     * One metric column for a result row. Accepts an optional second value/label
     * so two tightly-related metrics (e.g. PF + Sharpe) share a column under a
     * combined label, keeping the grid to five columns.
     */
    function createMetricCell(
        label: string,
        value: string,
        sign: "profit" | "loss" | "neutral",
        secondValue?: string,
        secondLabel?: string,
    ): HTMLDivElement {
        const cell = document.createElement("div");
        cell.className = "batch-result-metric";
        const valueEl = document.createElement("span");
        valueEl.className = `batch-result-metric-value${sign === "profit" ? " is-profit" : sign === "loss" ? " is-loss" : ""}`;
        valueEl.textContent = secondValue ? `${value} / ${secondValue}` : value;
        const labelEl = document.createElement("span");
        labelEl.className = "batch-result-metric-label";
        labelEl.textContent = secondLabel ? `${label} / ${secondLabel}` : label;
        cell.appendChild(valueEl);
        cell.appendChild(labelEl);
        return cell;
    }

    return {
        queueLiveRender,
        flushLiveRenderNow,
        cancelLiveRenderRaf,
        dropQueuedRows,
        appendResultRows,
        renderResultRows,
        updateBatchResultSortHeader,
        renderSummaryGrid,
        updateSummary,
        setProgress,
        setRunBusy,
        updateBalancedGeneratorButtons,
    };
}
