import { createAssetLeadershipDom, type AssetLeadershipDom } from "./asset-leadership-dom";
import { buildTimingEdgeReport, formatTimingEdgeReportRow, type TimingEdgeAssetRow, type TimingEdgeReport } from "./finder/timing-edge-report";
import type { TimingEdgePersistedRun } from "./batch-backtest/mine-timing-persistence";
import { clearMineTimingRuns, loadMineTimingRuns } from "./local-sqlite-mine-timing-api";
import { debugLogger } from "./debug-logger";
import { uiManager } from "./ui-manager";
import { escapeHtml } from "./html-escape";

/**
 * Asset Leadership service — repurposed.
 *
 * Originally this ranked assets by appearance in winning Finder Universe
 * strategy×param sets (universe-breadth view). It now ranks assets by
 * Mine Timing edge quality, fed by the `mine_timing_*` SQLite tables that
 * the Batch Backtest Mine Timing + Stability features write to.
 *
 * The 6 DOM sections are repurposed (see `html-partials/tab-asset-leadership.html`):
 * - Current Leaders → Top Timing Edge (by score)
 * - Strong Now → Long Triggers (fresh LONG verdicts)
 * - Weak Now → Short Triggers (fresh SHORT verdicts)
 * - Emerging Leaders → Rising Edge (score trending up across runs)
 * - Falling Leaders → Fading Edge
 * - Most Consistent Leaders → Diverse & Stable
 *
 * `persistUniverseRun` is no longer called by the Finder. The Mine Timing
 * path in `batch-backtest-service.ts` now writes the data this tab reads.
 */

const RUN_LIMIT = 50;
const MIGRATION_BANNER_KEY = "playground_asset_leadership_repoint_seen";

class AssetLeadershipService {
    private dom: AssetLeadershipDom | null = null;
    private runs: TimingEdgePersistedRun[] = [];
    private report: TimingEdgeReport | null = null;
    private initialized = false;

    public init(): void {
        if (this.initialized) return;
        this.dom = createAssetLeadershipDom();
        this.bindEvents();
        this.initialized = true;
        void this.loadAndRender();
    }

    public destroy(): void {
        this.initialized = false;
        this.dom = null;
    }

    private bindEvents(): void {
        const dom = this.getDom();
        dom.refresh.addEventListener("click", () => {
            void this.loadAndRender();
        });
        dom.copy.addEventListener("click", () => {
            void this.copyReport();
        });
        dom.clear.addEventListener("click", () => {
            void this.clearData();
        });
    }

    private getDom(): AssetLeadershipDom {
        // dom is always set by init() before any method that calls getDom() runs.
        return this.dom!;
    }

    private async loadAndRender(): Promise<void> {
        const dom = this.getDom();
        dom.status.textContent = "Loading timing-edge data...";
        try {
            this.runs = await loadMineTimingRuns(RUN_LIMIT);
            this.report = buildTimingEdgeReport({ runs: this.runs });
            this.renderReport();
        } catch (error) {
            debugLogger.error("asset_leadership.load_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            dom.status.textContent = "Failed to load timing-edge data.";
        }
    }

    private async clearData(): Promise<void> {
        const ok = await clearMineTimingRuns();
        if (!ok) {
            uiManager.showToast("Failed to clear timing-edge data.", "error");
            return;
        }
        this.runs = [];
        this.report = null;
        this.renderReport();
        uiManager.showToast("Timing-edge data cleared.", "success");
    }

    private renderReport(): void {
        if (!this.dom) return;
        const dom = this.dom;
        const report = this.report;
        if (!report || report.topTimingEdge.length === 0) {
            this.renderEmptyState(dom);
            return;
        }
        const overview = report.overview;
        dom.status.textContent = `Timing Edge: ${overview.totalRuns} runs | ${overview.totalAssets} assets | ${overview.totalVerdicts} LONG/SHORT verdicts`;
        dom.copy.disabled = false;
        dom.clear.disabled = false;

        this.renderOverviewMetrics(dom, overview);
        dom.derived.innerHTML = "";

        this.renderTable(dom.currentLeaders, report.topTimingEdge, ["Asset", "Dir", "Score", "Fresh", "First", "Move", "Conf", "Appr.", "AvgLift", "AvgDiv"]);
        this.renderTable(dom.strongNow, report.longTriggers, ["Asset", "Score", "Fresh", "Move", "Latest Lift", "HMax Lift", "Appr."], "trigger");
        this.renderTable(dom.weakNow, report.shortTriggers, ["Asset", "Score", "Fresh", "Move", "Latest Lift", "HMax Lift", "Appr."], "trigger");
        this.renderTable(dom.emergingLeaders, report.risingEdge, ["Asset", "ΔScore", "Trend", "Latest Lift", "Appr."], "trend");
        this.renderTable(dom.fallingLeaders, report.fallingEdge, ["Asset", "ΔScore", "Trend", "Latest Lift", "Appr."], "trend");
        this.renderTable(dom.consistentLeaders, report.diverseStable, ["Asset", "Score", "Fresh", "Diversity", "Move", "Pair", "Appr."], "diverse");
        this.renderRecentRuns(dom);
    }

    private renderEmptyState(dom: AssetLeadershipDom): void {
        // localStorage access (both getItem and setItem) can throw in private
        // mode / quota-exceeded / disabled storage. Treat any throw as "not
        // seen" so the load path stays intact — a throw on getItem here used
        // to bubble up and surface as a misleading "Failed to load" toast.
        let hasSeenMigration = true;
        try {
            hasSeenMigration = localStorage.getItem(MIGRATION_BANNER_KEY) === "1";
        } catch {
            hasSeenMigration = false;
        }
        const baseHint = this.runs.length === 0
            ? "No timing-edge data yet. Run Mine Timing or Stability Mine in the Batch Backtest tab to populate."
            : `Data loaded (${this.runs.length} runs), but no LONG/SHORT verdicts were produced.`;
        const migrationHint = hasSeenMigration
            ? ""
            : `<div class="param-hint" style="margin-top:6px;color:var(--text-secondary);">`
            + `Asset Leadership now ranks assets by Mine Timing edge quality. `
            + `Earlier Finder-Universe-derived data is preserved in SQLite but no longer shown here. `
            + `</div>`;
        dom.status.innerHTML = `<div>${baseHint}</div>${migrationHint}`;
        if (!hasSeenMigration) {
            // Mark seen once the user has been informed; don't badger them on every open.
            try { localStorage.setItem(MIGRATION_BANNER_KEY, "1"); } catch { /* ignore quota */ }
        }
        dom.overviewMetrics.innerHTML = "";
        dom.derived.innerHTML = "";
        dom.currentLeaders.innerHTML = "";
        dom.strongNow.innerHTML = "";
        dom.weakNow.innerHTML = "";
        dom.emergingLeaders.innerHTML = "";
        dom.fallingLeaders.innerHTML = "";
        dom.consistentLeaders.innerHTML = "";
        dom.recentRuns.innerHTML = "";
        dom.copy.disabled = true;
        dom.clear.disabled = this.runs.length === 0;
    }

    private renderOverviewMetrics(dom: AssetLeadershipDom, overview: TimingEdgeReport["overview"]): void {
        const chips: string[] = [];
        chips.push(this.chip(`Runs ${overview.totalRuns}`));
        // totalUniqueAssets is the honest asset count (an asset in both LONG
        // and SHORT directions counts once). totalAssets (asset×direction
        // rows) is shown as "Edges" so the user can see how many directional
        // signals exist in total.
        chips.push(this.chip(`Assets ${overview.totalUniqueAssets}`));
        if (overview.totalAssets !== overview.totalUniqueAssets) {
            chips.push(this.chip(`Edges ${overview.totalAssets}`));
        }
        chips.push(this.chip(`Verdicts ${overview.totalVerdicts}`));
        chips.push(this.chip(`LONG ${overview.longTriggerCount}`));
        chips.push(this.chip(`SHORT ${overview.shortTriggerCount}`));
        if (overview.topAsset) {
            chips.push(this.chip(`Top ${overview.topAsset} ${overview.topScore.toFixed(1)}`));
        }
        dom.overviewMetrics.innerHTML = chips.join("");
    }

    private renderTable(
        container: HTMLElement,
        rows: readonly TimingEdgeAssetRow[],
        headers: readonly string[],
        mode: "default" | "trigger" | "trend" | "diverse" = "default"
    ): void {
        if (rows.length === 0) {
            container.innerHTML = '<div class="param-hint">No data available.</div>';
            return;
        }
        const headerCells = headers.map((h) => `<th style="text-align:right;padding:2px 6px;font-size:11px;color:var(--text-secondary);">${h}</th>`).join("");
        const bodyRows = rows.map((row) => {
            const cells = this.buildRowCells(row, mode);
            return `<tr style="border-bottom:1px solid var(--glass-border);font-size:12px;">${cells}</tr>`;
        });
        container.innerHTML = `<table style="width:100%;border-collapse:collapse;">`
            + `<thead><tr>${headerCells}</tr></thead>`
            + `<tbody>${bodyRows.join("")}</tbody></table>`;
    }

    private buildRowCells(row: TimingEdgeAssetRow, mode: "default" | "trigger" | "trend" | "diverse"): string {
        const r = (v: number | null | undefined, d = 2) =>
            (v === null || v === undefined || !Number.isFinite(v)) ? "--" : v.toFixed(d);
        const pct = (v: number | null | undefined) =>
            (v === null || v === undefined || !Number.isFinite(v)) ? "--" : `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
        const seen = row.firstAsOfTimeKey ?? (Number.isFinite(row.firstSeenAt) ? new Date(row.firstSeenAt).toLocaleDateString() : "--");
        const fresh = row.hasActiveConflict ? "CONFLICT" : row.freshness;
        const asset = escapeHtml(row.asset);
        const direction = escapeHtml(row.latestDirection ?? "--");
        const seenText = escapeHtml(seen);
        const freshText = escapeHtml(fresh);
        const confidence = escapeHtml(row.latestConfidence);
        const strongestPair = escapeHtml(row.strongestPair ?? "--");
        const dirColor = row.latestDirection === "LONG" ? "var(--color-green)" : row.latestDirection === "SHORT" ? "var(--color-red)" : "var(--text-muted)";
        const trendIcon = row.trend === "up" ? "▲" : row.trend === "down" ? "▼" : "─";
        const trendColor = row.trend === "up" ? "var(--color-green)" : row.trend === "down" ? "var(--color-red)" : "var(--text-muted)";
        const freshColor = row.hasActiveConflict || row.freshness === "LATE" || row.freshness === "STALE"
            ? "var(--color-red)"
            : row.freshness === "AGING" || row.freshness === "UNKNOWN"
                ? "var(--warning)"
                : "var(--color-green)";

        switch (mode) {
            case "trigger":
                return [
                    `<td style="font-weight:600;color:${dirColor};">${asset}</td>`,
                    `<td style="text-align:right;font-weight:600;">${r(row.score, 1)}</td>`,
                    `<td style="text-align:right;color:${freshColor};">${freshText}</td>`,
                    `<td style="text-align:right;">${pct(row.moveSinceFirstPct)}</td>`,
                    `<td style="text-align:right;">${pct(row.latestLiftPct)}</td>`,
                    `<td style="text-align:right;">${pct(row.latestHmaxLiftPct)}</td>`,
                    `<td style="text-align:right;">${row.appearances}</td>`,
                ].join("");
            case "trend":
                return [
                    `<td style="font-weight:600;">${asset} <span style="color:${dirColor};font-weight:400;font-size:11px;">${direction}</span></td>`,
                    `<td style="text-align:right;color:${trendColor};">${row.scoreChange >= 0 ? "+" : ""}${r(row.scoreChange)}</td>`,
                    `<td style="text-align:right;color:${trendColor};">${trendIcon}</td>`,
                    `<td style="text-align:right;">${pct(row.latestLiftPct)}</td>`,
                    `<td style="text-align:right;">${row.appearances}</td>`,
                ].join("");
            case "diverse":
                return [
                    `<td style="font-weight:600;">${asset} <span style="color:${dirColor};font-weight:400;font-size:11px;">${direction}</span></td>`,
                    `<td style="text-align:right;font-weight:600;">${r(row.score, 1)}</td>`,
                    `<td style="text-align:right;color:${freshColor};">${freshText}</td>`,
                    `<td style="text-align:right;">${(row.latestDiversity * 100).toFixed(0)}%</td>`,
                    `<td style="text-align:right;">${pct(row.moveSinceFirstPct)}</td>`,
                    `<td style="text-align:right;">${strongestPair}</td>`,
                    `<td style="text-align:right;">${row.appearances}</td>`,
                ].join("");
            default:
                return [
                    `<td style="font-weight:600;">${asset}</td>`,
                    `<td style="text-align:right;color:${dirColor};">${direction}</td>`,
                    `<td style="text-align:right;font-weight:600;">${r(row.score, 1)}</td>`,
                    `<td style="text-align:right;color:${freshColor};">${freshText}</td>`,
                    `<td style="text-align:right;">${seenText}</td>`,
                    `<td style="text-align:right;">${pct(row.moveSinceFirstPct)}</td>`,
                    `<td style="text-align:right;">${confidence}</td>`,
                    `<td style="text-align:right;">${row.appearances}</td>`,
                    `<td style="text-align:right;">${pct(row.avgLiftPct)}</td>`,
                    `<td style="text-align:right;">${(row.avgDiversity * 100).toFixed(0)}%</td>`,
                ].join("");
        }
    }

    private renderRecentRuns(dom: AssetLeadershipDom): void {
        const runs = this.runs;
        if (runs.length === 0) {
            dom.recentRuns.innerHTML = '<div class="param-hint">No runs stored.</div>';
            return;
        }
        const rows = [...runs].reverse().slice(0, 10).map((run) => {
            const date = new Date(run.createdAt).toLocaleString();
            const verdictCount = run.verdicts.filter((v) => v.verdict === "LONG" || v.verdict === "SHORT").length;
            return `<div style="font-size:11px;padding:3px 0;border-bottom:1px solid var(--glass-border);display:flex;gap:8px;">`
                + `<span style="color:var(--text-secondary);">${escapeHtml(date)}</span>`
                + `<span>${escapeHtml(run.source)}</span>`
                + `<span>${escapeHtml(run.strategyKey || "--")}</span>`
                + `<span>${run.pairCount} pairs</span>`
                + (run.source === "stability" ? `<span>${run.reruns}×${run.subsetSize}</span>` : "")
                + `<span>${verdictCount} verdicts</span>`
                + `<span style="color:var(--text-muted);">${escapeHtml(run.interval)}</span>`
                + `</div>`;
        });
        dom.recentRuns.innerHTML = rows.join("");
    }

    private chip(text: string): string {
        return `<span style="background:var(--bg-tertiary);border:1px solid var(--glass-border);border-radius:6px;padding:2px 8px;font-size:11px;">${escapeHtml(text)}</span>`;
    }

    private async copyReport(): Promise<void> {
        if (!this.report || this.report.topTimingEdge.length === 0) {
            uiManager.showToast("No report to copy.", "info");
            return;
        }
        try {
            const lines = [
                `Timing Edge | Runs ${this.report.overview.totalRuns} | Assets ${this.report.overview.totalAssets} | Verdicts ${this.report.overview.totalVerdicts}`,
                ...this.report.topTimingEdge.map((row) => `TIMING_EDGE | ${formatTimingEdgeReportRow(row)}`),
            ];
            await navigator.clipboard.writeText(lines.join("\n"));
            uiManager.showToast("Timing-edge report copied.", "success");
        } catch {
            uiManager.showToast("Copy failed.", "error");
        }
    }
}

export const assetLeadershipService = new AssetLeadershipService();
