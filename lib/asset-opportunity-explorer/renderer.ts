import type { AssetOpportunityExplorerDom } from "./dom";
import type {
    AssetOpportunityExplorerCatalogRun,
    AssetOpportunityExplorerDetailRow,
    AssetOpportunityExplorerDetailsResponse,
    AssetOpportunityExplorerHeatmapCell,
    AssetOpportunityExplorerHeatmapResponse,
    AssetOpportunityExplorerMetric,
} from "./types";

/**
 * Presentation for the Opportunity Explorer: a Canvas heatmap (thousands of
 * cells would be unusable as DOM nodes), an SVG histogram, and text-only
 * tables. All colors resolve from styles/variables.css tokens at draw time so
 * theme changes are picked up on the next frame without inline color objects.
 */

export interface BrushSelection {
    sortMetric: string;
    /** Inclusive holdout bounds over the snapshot's columns. */
    from: number;
    to: number;
}

export interface CellRef {
    rowIndex: number;
    colIndex: number;
}

export interface HeatmapRenderState {
    heatmap: AssetOpportunityExplorerHeatmapResponse;
    metric: AssetOpportunityExplorerMetric;
    /** Max |value| of the current metric across the snapshot; fixed until the metric changes. */
    domain: number;
    hover: CellRef | null;
    focus: CellRef | null;
    brush: BrushSelection | null;
}

const ROW_LABEL_GUTTER = 170;
const COLUMN_HEADER_GUTTER = 24;
const CELL_HEIGHT = 18;
const MIN_CELL_WIDTH = 3;
const MAX_CELL_WIDTH = 14;

export function cellMetricValue(
    cell: AssetOpportunityExplorerHeatmapCell | undefined,
    metric: AssetOpportunityExplorerMetric,
): number | null {
    if (!cell) return null;
    const value = metric === "delta" ? cell.delta : cell.actual;
    return value !== null && Number.isFinite(value) ? value : null;
}

/** Fixed per snapshot + metric: brushing never rescales colors. */
export function colorDomainFor(
    heatmap: AssetOpportunityExplorerHeatmapResponse,
    metric: AssetOpportunityExplorerMetric,
): number {
    let max = 0;
    for (const cell of heatmap.cells) {
        const value = cellMetricValue(cell, metric);
        if (value === null) continue;
        max = Math.max(max, Math.abs(value));
    }
    return max > 0 ? max : 1;
}

function resolveToken(token: string): string {
    if (typeof getComputedStyle !== "function") return "#888888";
    const raw = getComputedStyle(document.documentElement).getPropertyValue(token).trim();
    return raw ? `hsl(${raw})` : "#888888";
}

export function heatCellAt(
    heatmap: AssetOpportunityExplorerHeatmapResponse,
    x: number,
    y: number,
    canvasWidth: number,
): CellRef | null {
    const columns = heatmap.holdoutBars.length;
    const rows = heatmap.sorts.length;
    const cellWidth = heatCellWidth(columns, canvasWidth);
    const colIndex = Math.floor((x - ROW_LABEL_GUTTER) / cellWidth);
    const rowIndex = Math.floor((y - COLUMN_HEADER_GUTTER) / CELL_HEIGHT);
    if (colIndex < 0 || colIndex >= columns || rowIndex < 0 || rowIndex >= rows) return null;
    return { rowIndex, colIndex };
}

function heatCellWidth(columns: number, canvasWidth: number): number {
    const available = Math.max(50, canvasWidth - ROW_LABEL_GUTTER);
    return Math.max(MIN_CELL_WIDTH, Math.min(MAX_CELL_WIDTH, Math.floor(available / Math.max(1, columns))));
}

function heatCanvasSize(
    heatmap: AssetOpportunityExplorerHeatmapResponse,
    wrapWidth: number,
): { width: number; height: number; cellWidth: number } {
    const columns = heatmap.holdoutBars.length;
    const rows = heatmap.sorts.length;
    const cellWidth = heatCellWidth(columns, wrapWidth);
    return {
        width: ROW_LABEL_GUTTER + columns * cellWidth,
        height: COLUMN_HEADER_GUTTER + Math.max(1, rows) * CELL_HEIGHT,
        cellWidth,
    };
}

function cellByPosition(
    heatmap: AssetOpportunityExplorerHeatmapResponse,
    rowIndex: number,
    colIndex: number,
): AssetOpportunityExplorerHeatmapCell | undefined {
    const sortMetric = heatmap.sorts[rowIndex];
    const holdoutBars = heatmap.holdoutBars[colIndex];
    if (sortMetric === undefined || holdoutBars === undefined) return undefined;
    return heatmap.cells.find((cell) => cell.sortMetric === sortMetric && cell.holdoutBars === holdoutBars);
}

function formatValue(value: number | null, unit: "%" | "pp"): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    const sign = value > 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}${unit}`;
}

export function readoutText(
    heatmap: AssetOpportunityExplorerHeatmapResponse,
    ref: CellRef,
): string {
    const sortMetric = heatmap.sorts[ref.rowIndex];
    const holdoutBars = heatmap.holdoutBars[ref.colIndex];
    if (sortMetric === undefined || holdoutBars === undefined) return "";
    const cell = cellByPosition(heatmap, ref.rowIndex, ref.colIndex);
    if (!cell) {
        return `${sortMetric} @ holdout ${holdoutBars} bars — no archived block`;
    }
    const parts = [
        `${sortMetric} @ holdout ${holdoutBars} bars`,
        `actual ${formatValue(cell.actual, "%")}`,
        `baseline ${formatValue(cell.baseline, "%")}`,
        `Δ ${formatValue(cell.delta, "pp")}`,
        `observed ${cell.observedRows}/${cell.selectedRows} rows`,
        `${cell.totalSamples} samples`,
    ];
    if (cell.observedRows === 0) parts.push(`no observations at horizon ${heatmap.horizonBars} — not zero`);
    if (cell.delta === null && cell.actual !== null) parts.push("delta unavailable (no baseline for this block)");
    return parts.join(" — ");
}

/** Offscreen base for the current snapshot+metric+size; overlays redraw on top each frame. */
let baseCanvas: HTMLCanvasElement | null = null;
let baseCanvasKey = "";

/** Blit-only redraw: cells live on an offscreen base rebuilt when snapshot/metric/size change. */
export function drawHeatmap(
    dom: AssetOpportunityExplorerDom,
    state: HeatmapRenderState,
): void {
    const { heatmap } = state;
    const wrapWidth = Math.max(320, dom.explorerHeatmapWrap.clientWidth - 16);
    const { width, height, cellWidth } = heatCanvasSize(heatmap, wrapWidth);
    const ratio = typeof devicePixelRatio === "number" && devicePixelRatio > 0 ? devicePixelRatio : 1;
    const baseKey = `${heatmap.snapshotId}|${state.metric}|${width}x${height}|${ratio}`;
    if (!baseCanvas || baseCanvasKey !== baseKey) {
        baseCanvas = baseCanvas ?? document.createElement("canvas");
        baseCanvas.width = Math.ceil(width * ratio);
        baseCanvas.height = Math.ceil(height * ratio);
        const baseContext = baseCanvas.getContext("2d");
        if (!baseContext) return;
        baseContext.setTransform(ratio, 0, 0, ratio, 0, 0);
        drawHeatmapBase(baseContext, state, width, height, cellWidth);
        baseCanvasKey = baseKey;
    }
    const canvas = dom.explorerHeatmapCanvas;
    canvas.width = Math.ceil(width * ratio);
    canvas.height = Math.ceil(height * ratio);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(baseCanvas, 0, 0);
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    drawOverlays(context, state, cellWidth);
}

function drawHeatmapBase(
    context: CanvasRenderingContext2D,
    state: HeatmapRenderState,
    width: number,
    height: number,
    cellWidth: number,
): void {
    const { heatmap, metric, domain } = state;
    const textColor = resolveToken("--hsl-ink-2");
    const borderColor = resolveToken("--hsl-border-subtle");
    const fillTokens: CellFillTokens = {
        positive: resolveToken("--hsl-success"),
        negative: resolveToken("--hsl-danger"),
        neutral: resolveToken("--hsl-neutral"),
        missing: resolveToken("--hsl-surface-3"),
    };
    context.fillStyle = resolveToken("--hsl-chart");
    context.fillRect(0, 0, width, height);
    context.font = "11px system-ui, sans-serif";
    context.textBaseline = "middle";
    // Column labels: thin to fit by stepping so long holdout lists stay readable.
    const columns = heatmap.holdoutBars.length;
    const labelStep = Math.max(1, Math.ceil(40 / cellWidth));
    context.fillStyle = textColor;
    for (let colIndex = 0; colIndex < columns; colIndex += labelStep) {
        const label = String(heatmap.holdoutBars[colIndex]);
        context.fillText(label, ROW_LABEL_GUTTER + colIndex * cellWidth, COLUMN_HEADER_GUTTER / 2);
    }
    for (let rowIndex = 0; rowIndex < heatmap.sorts.length; rowIndex += 1) {
        const y = COLUMN_HEADER_GUTTER + rowIndex * CELL_HEIGHT;
        context.fillStyle = textColor;
        const label = heatmap.sorts[rowIndex]!;
        context.fillText(label.length > 24 ? `${label.slice(0, 23)}…` : label, 4, y + CELL_HEIGHT / 2);
        for (let colIndex = 0; colIndex < columns; colIndex += 1) {
            const cell = cellByPosition(heatmap, rowIndex, colIndex);
            context.fillStyle = cellFillColor(cellMetricValue(cell, metric), domain, fillTokens);
            context.fillRect(
                ROW_LABEL_GUTTER + colIndex * cellWidth,
                y,
                Math.max(1, cellWidth - 1),
                CELL_HEIGHT - 1,
            );
        }
    }
    context.strokeStyle = borderColor;
    context.lineWidth = 1;
    context.strokeRect(0.5, 0.5, width - 1, height - 1);
}

export interface CellFillTokens {
    positive: string;
    negative: string;
    neutral: string;
    missing: string;
}

/**
 * Cell fill decision for one heatmap value: intensity grows with |value|
 * (extremes are fully saturated), exact zero reads as a neutral fill, and
 * missing/unobservable cells use the dedicated missing colour. Pure so the
 * negative/zero/positive extremes are testable without a canvas.
 */
export function cellFillColor(
    value: number | null,
    domain: number,
    tokens: CellFillTokens,
): string {
    if (value === null || !Number.isFinite(value) || domain <= 0) return tokens.missing;
    if (value === 0) return withAlpha(tokens.neutral, 0.35);
    const intensity = Math.min(1, Math.sqrt(Math.abs(value) / domain));
    const base = value > 0 ? tokens.positive : tokens.negative;
    // Floor keeps faint values visible against the dark canvas instead of
    // vanishing into the background near zero.
    return withAlpha(base, Math.max(intensity, 0.12));
}

function withAlpha(color: string, alpha: number): string {
    if (color.startsWith("hsl(")) return `${color.slice(0, -1)} / ${alpha.toFixed(3)})`;
    return color;
}

function drawOverlays(
    context: CanvasRenderingContext2D,
    state: HeatmapRenderState,
    cellWidth: number,
): void {
    const { heatmap, brush, hover, focus } = state;
    const accent = resolveToken("--hsl-accent-light");
    if (brush) {
        const rowIndex = heatmap.sorts.indexOf(brush.sortMetric);
        const colIndexes = heatmap.holdoutBars
            .map((bars, index) => (bars >= Math.min(brush.from, brush.to) && bars <= Math.max(brush.from, brush.to) ? index : -1))
            .filter((index) => index >= 0);
        if (rowIndex >= 0 && colIndexes.length > 0) {
            const first = colIndexes[0]!;
            const last = colIndexes[colIndexes.length - 1]!;
            context.strokeStyle = accent;
            context.lineWidth = 2;
            context.strokeRect(
                ROW_LABEL_GUTTER + first * cellWidth - 1,
                COLUMN_HEADER_GUTTER + rowIndex * CELL_HEIGHT - 1,
                (last - first + 1) * cellWidth + 1,
                CELL_HEIGHT + 1,
            );
        }
    }
    const outline = (ref: CellRef, color: string, lineWidth: number): void => {
        context.strokeStyle = color;
        context.lineWidth = lineWidth;
        context.strokeRect(
            ROW_LABEL_GUTTER + ref.colIndex * cellWidth - 1,
            COLUMN_HEADER_GUTTER + ref.rowIndex * CELL_HEIGHT - 1,
            cellWidth + 1,
            CELL_HEIGHT + 1,
        );
    };
    if (hover) outline(hover, resolveToken("--hsl-ink-1"), 1);
    if (focus) outline(focus, accent, 2);
}

export function renderLegend(
    dom: AssetOpportunityExplorerDom,
    metric: AssetOpportunityExplorerMetric,
    domain: number,
    basis: AssetOpportunityExplorerHeatmapResponse["basis"],
): void {
    const unit = metric === "delta" ? "pp" : "%";
    const legend = dom.explorerHeatmapLegend;
    legend.replaceChildren();
    const negative = document.createElement("span");
    negative.textContent = `−${domain.toFixed(2)}${unit}`;
    const bar = document.createElement("span");
    bar.className = "explorer-legend-bar";
    bar.style.background = `linear-gradient(to right, ${resolveToken("--hsl-danger")}, ${resolveToken("--hsl-neutral")}, ${resolveToken("--hsl-success")})`;
    const zero = document.createElement("span");
    zero.textContent = "0";
    const positive = document.createElement("span");
    positive.textContent = `+${domain.toFixed(2)}${unit}`;
    const unitLabel = document.createElement("span");
    unitLabel.textContent = metric === "delta"
        ? "percentage points vs the block's all-candidate baseline"
        : "archived forward return, percent";
    const basisLabel = document.createElement("span");
    basisLabel.textContent = basis ? `measured on ${basis === "pair" ? "the synthetic pair" : "the BASE leg only"}` : "measurement basis unknown (older archive)";
    legend.append(negative, bar, zero, positive, unitLabel, basisLabel);
}

export function renderMeta(
    dom: AssetOpportunityExplorerDom,
    run: AssetOpportunityExplorerCatalogRun | null,
    heatmap: AssetOpportunityExplorerHeatmapResponse | null,
): void {
    if (!run) {
        dom.explorerMeta.textContent = "";
        return;
    }
    const lines = [
        `run ${run.batchRunId}`,
        `latest archive export ${run.latestTimestamp}`,
        `holdout offsets ${run.holdoutBars.length} (${run.holdoutBars[0] ?? "n/a"} → ${run.holdoutBars[run.holdoutBars.length - 1] ?? "n/a"} bars, descending on the x-axis)`,
        `archived rank limit ${run.archiveMaximumRank}`,
        `source blocks ${run.sourceBlockCount}`,
        heatmap ? `observed ${heatmap.diagnostics.observedRows}/${heatmap.diagnostics.selectedRows} selected rows; missing ${heatmap.diagnostics.missingRows}; unknown fingerprints ${heatmap.diagnostics.unknownFingerprintRows}` : "",
    ].filter(Boolean);
    if (heatmap) {
        for (const note of heatmap.diagnostics.notes) lines.push(note);
    }
    dom.explorerMeta.replaceChildren(...lines.map((line) => {
        const row = document.createElement("div");
        row.textContent = line;
        return row;
    }));
}

export function renderHistogram(
    host: HTMLDivElement,
    detail: AssetOpportunityExplorerDetailsResponse,
): void {
    host.replaceChildren();
    const bins = detail.histogram.bins;
    if (bins.length === 0 || detail.histogram.valuesCount === 0) {
        const empty = document.createElement("div");
        empty.className = "explorer-detail-status";
        empty.textContent = "No finite cell values in the selected range.";
        host.appendChild(empty);
        return;
    }
    const width = 600;
    const height = 120;
    const padding = { top: 10, right: 10, bottom: 22, left: 10 };
    const maxCount = Math.max(...bins.map((bin) => bin.count));
    const slot = (width - padding.left - padding.right) / bins.length;
    const svgNamespace = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNamespace, "svg");
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("role", "presentation");
    const zeroX = bins[0]!.from < 0 && bins[bins.length - 1]!.to > 0
        ? padding.left + ((0 - bins[0]!.from) / (bins[bins.length - 1]!.to - bins[0]!.from)) * (width - padding.left - padding.right)
        : null;
    if (zeroX !== null) {
        const zeroLine = document.createElementNS(svgNamespace, "line");
        zeroLine.setAttribute("x1", String(zeroX));
        zeroLine.setAttribute("x2", String(zeroX));
        zeroLine.setAttribute("y1", String(padding.top));
        zeroLine.setAttribute("y2", String(height - padding.bottom));
        zeroLine.setAttribute("stroke", resolveToken("--hsl-ink-3"));
        zeroLine.setAttribute("stroke-dasharray", "3 3");
        svg.appendChild(zeroLine);
    }
    bins.forEach((bin, binIndex) => {
        if (bin.count === 0) return;
        const barHeight = ((height - padding.top - padding.bottom) * bin.count) / maxCount;
        const rect = document.createElementNS(svgNamespace, "rect");
        rect.setAttribute("x", String(padding.left + slot * binIndex + 1));
        rect.setAttribute("y", String(height - padding.bottom - barHeight));
        rect.setAttribute("width", String(Math.max(1, slot - 2)));
        rect.setAttribute("height", String(barHeight));
        const binMid = (bin.from + bin.to) / 2;
        rect.setAttribute("fill", binMid >= 0 ? resolveToken("--hsl-success") : resolveToken("--hsl-danger"));
        const title = document.createElementNS(svgNamespace, "title");
        title.textContent = `${bin.from.toFixed(2)}–${bin.to.toFixed(2)}${detail.unit}: ${bin.count} holdouts`;
        rect.appendChild(title);
        svg.appendChild(rect);
    });
    const axis = document.createElementNS(svgNamespace, "text");
    axis.setAttribute("x", String(width - padding.right));
    axis.setAttribute("y", String(height - 6));
    axis.setAttribute("text-anchor", "end");
    axis.setAttribute("font-size", "10");
    axis.setAttribute("fill", resolveToken("--hsl-ink-2"));
    axis.textContent = `cell values (${detail.unit}), equal weight per holdout — ${detail.histogram.valuesCount} finite`;
    svg.appendChild(axis);
    host.appendChild(svg);
}

export function renderDetailRows(
    rows: HTMLTableSectionElement,
    page: readonly AssetOpportunityExplorerDetailRow[],
): void {
    rows.replaceChildren(...page.map((row) => {
        const tr = document.createElement("tr");
        const cells: Array<string> = [
            String(row.holdoutBars),
            String(row.rank),
            row.symbol,
            row.strategyName ?? row.strategyId,
            formatValue(row.actual, "%"),
            formatValue(row.baseline, "%"),
            row.actual === null ? "—" : String(row.sampleSize),
            row.candidateFingerprint ?? "unknown",
            `${row.sourceFile} @ ${row.blockTimestamp}`,
        ];
        cells.forEach((value, index) => {
            const cell = document.createElement(index === 0 ? "th" : "td");
            if (index === 0) cell.scope = "row";
            cell.textContent = value;
            if (index === 4 && row.actual !== null) {
                cell.className = row.actual >= 0 ? "explorer-cell-pos" : "explorer-cell-neg";
            }
            tr.appendChild(cell);
        });
        return tr;
    }));
}

export function formatDetailSummary(detail: AssetOpportunityExplorerDetailsResponse): string {
    const summary = detail.summary;
    const parts = [
        `${detail.sortMetric} — holdouts ${detail.holdoutFrom} to ${detail.holdoutTo} bars inclusive`,
        `metric: ${detail.metric === "delta" ? "difference from baseline (pp)" : "actual archived return (%)"}`,
        `equal-holdout mean ${formatValue(summary.mean, detail.unit)}, median ${formatValue(summary.median, detail.unit)} over ${summary.observedHoldouts}/${summary.totalHoldouts} observed holdouts`,
        `rows ${summary.totalRows} (observed ${summary.observedRows}, missing ${summary.missingRows})`,
        `confirmed candidate identities ${summary.uniqueCandidates}`,
    ];
    if (summary.unknownFingerprintRows > 0) {
        parts.push(`${summary.unknownFingerprintRows} rows without a parameter fingerprint (counted unknown, excluded from the confirmed identity count)`);
    }
    parts.push("Range summaries weight each holdout equally; they differ from a pooled all-row mean when coverage varies.");
    return parts.join(" · ");
}
