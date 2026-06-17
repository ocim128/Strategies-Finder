import { createAssetLeadershipDom, type AssetLeadershipDom } from "./asset-leadership-dom";
import { buildAssetLeadershipReport, buildObservations, createAssetLeadershipPersistedRun } from "./finder/asset-leadership";
import type {
    AssetLeadershipAssetRow,
    AssetLeadershipPersistedRun,
    AssetLeadershipReport,
    FinderUniverseCandidate,
} from "./types/finder";
import { clearAssetLeadershipRuns, loadAssetLeadershipRuns, storeAssetLeadershipRun } from "./local-sqlite-asset-leadership-api";
import { debugLogger } from "./debug-logger";
import { uiManager } from "./ui-manager";

const RUN_LIMIT = 50;

class AssetLeadershipService {
    private dom: AssetLeadershipDom | null = null;
    private runs: AssetLeadershipPersistedRun[] = [];
    private report: AssetLeadershipReport | null = null;
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

    public async persistUniverseRun(args: {
        interval: string;
        strategyPreset?: AssetLeadershipPersistedRun["strategyPreset"];
        strategyCount: number;
        universeSymbolCount: number;
        topN: number;
        candidates: FinderUniverseCandidate[];
    }): Promise<void> {
        const runId = `al-universe-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
        const run = createAssetLeadershipPersistedRun({
            runId,
            interval: args.interval,
            strategyPreset: args.strategyPreset,
            strategyCount: args.strategyCount,
            universeSymbolCount: args.universeSymbolCount,
            topN: args.topN,
            candidates: args.candidates,
        });

        // buildObservations is the single source of truth for extracting per-symbol
        // observations from candidates — reuse it instead of duplicating the loop.
        const observations = buildObservations([run]);

        try {
            await storeAssetLeadershipRun(run, observations);
        } catch (error) {
            debugLogger.error("asset_leadership.persist_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        }

        this.runs.push(run);
        if (this.runs.length > RUN_LIMIT) {
            this.runs = this.runs.slice(-RUN_LIMIT);
        }
        this.report = buildAssetLeadershipReport({ runs: this.runs });
        this.renderReport();
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
        dom.status.textContent = "Loading leadership data...";
        try {
            this.runs = await loadAssetLeadershipRuns(RUN_LIMIT);
            this.report = buildAssetLeadershipReport({ runs: this.runs });
            this.renderReport();
        } catch (error) {
            debugLogger.error("asset_leadership.load_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
            dom.status.textContent = "Failed to load leadership data.";
        }
    }

    private async clearData(): Promise<void> {
        const ok = await clearAssetLeadershipRuns();
        if (!ok) {
            uiManager.showToast("Failed to clear leadership data.", "error");
            return;
        }
        this.runs = [];
        this.report = null;
        this.renderReport();
        uiManager.showToast("Asset leadership data cleared.", "success");
    }

    private renderReport(): void {
        // DOM may not be initialized yet if the Assets tab was never opened
        // but persistUniverseRun was called from the Finder. Skip rendering —
        // the data is persisted to SQLite and will load on next tab open.
        if (!this.dom) return;
        const dom = this.dom;
        const report = this.report;
        if (!report || report.currentLeaders.length === 0) {
            dom.status.textContent = this.runs.length === 0
                ? "No leadership data yet. Run the Finder in Symbol Universe mode to generate data."
                : `Leadership data loaded (${this.runs.length} runs), but no synthetic pair results found.`;
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
            return;
        }

        const overview = report.overview;
        dom.status.textContent = `Asset Leadership: ${overview.totalRuns} runs | ${overview.totalAssets} assets | ${overview.totalObservations} observations`;
        dom.copy.disabled = false;
        dom.clear.disabled = false;

        this.renderOverviewMetrics(dom, report);
        this.renderDerived(dom, report);
        this.renderLeadershipTable(dom.currentLeaders, report.currentLeaders, [
            "Asset", "Score", "Appr.", "Profit%", "Top10%", "AvgSharpe", "AvgExp", "PFScore"
        ]);
        this.renderLeadershipTable(dom.strongNow, report.strongestNow, [
            "Asset", "DirScore", "Obs", "AvgMove", "Leader", "Profit%"
        ], "strongNow");
        this.renderLeadershipTable(dom.weakNow, report.weakestNow, [
            "Asset", "DirScore", "Obs", "AvgMove", "Leader", "Profit%"
        ], "weakNow");
        this.renderLeadershipTable(dom.emergingLeaders, report.emergingLeaders, [
            "Asset", "ΔScore", "Trend", "Appr.", "Profit%", "AvgSharpe"
        ], "emerging");
        this.renderLeadershipTable(dom.fallingLeaders, report.fallingLeaders, [
            "Asset", "ΔScore", "Trend", "Appr.", "Profit%", "AvgSharpe"
        ], "falling");
        this.renderLeadershipTable(dom.consistentLeaders, report.consistentLeaders, [
            "Asset", "Consec", "Appr.", "Profit%", "Consist", "PFScore"
        ], "consistent");
        this.renderRecentRuns(dom, report);
    }

    private renderOverviewMetrics(dom: AssetLeadershipDom, report: AssetLeadershipReport): void {
        const overview = report.overview;
        const chips: string[] = [];
        chips.push(this.chip(`Runs ${overview.totalRuns}`));
        chips.push(this.chip(`Assets ${overview.totalAssets}`));
        chips.push(this.chip(`Obs ${overview.totalObservations}`));
        if (overview.currentLeader) {
            chips.push(this.chip(`Leader ${overview.currentLeader}`));
        }
        if (overview.dominantAssetShare > 0) {
            chips.push(this.chip(`Share ${(overview.dominantAssetShare * 100).toFixed(1)}%`));
        }
        dom.overviewMetrics.innerHTML = chips.join("");
    }

    private renderDerived(dom: AssetLeadershipDom, report: AssetLeadershipReport): void {
        if (report.derivedMetrics.length === 0) {
            dom.derived.innerHTML = "";
            return;
        }
        const rows = report.derivedMetrics.map((metric) =>
            `<div style="display:flex;gap:8px;align-items:baseline;font-size:12px;margin-bottom:4px;">`
            + `<span style="color:var(--text-secondary);min-width:130px;">${metric.label}</span>`
            + `<span style="font-weight:600;">${metric.value}</span>`
            + `<span style="color:var(--text-muted);font-size:11px;">${metric.description}</span>`
            + `</div>`
        );
        dom.derived.innerHTML = rows.join("");
    }

    private renderLeadershipTable(
        container: HTMLElement,
        rows: readonly AssetLeadershipAssetRow[],
        headers: readonly string[],
        mode: "current" | "strongNow" | "weakNow" | "emerging" | "falling" | "consistent" = "current"
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

    private buildRowCells(row: AssetLeadershipAssetRow, mode: string): string {
        const trendIcon = row.trend === "up" ? "▲" : row.trend === "down" ? "▼" : "─";
        const trendColor = row.trend === "up" ? "var(--color-green)" : row.trend === "down" ? "var(--color-red)" : "var(--text-muted)";
        const r = (v: number, d = 2) => v.toFixed(d);

        switch (mode) {
            case "strongNow":
            case "weakNow":
                return [
                    `<td style="font-weight:600;">${row.asset}</td>`,
                    `<td style="text-align:right;font-weight:600;color:${mode === "strongNow" ? "var(--color-green)" : "var(--color-red)"};">${r(row.directionalScore, 1)}</td>`,
                    `<td style="text-align:right;">${row.directionalAppearances}</td>`,
                    `<td style="text-align:right;">${r(row.avgPairChangePercent)}%</td>`,
                    `<td style="text-align:right;">${r(row.score, 1)}</td>`,
                    `<td style="text-align:right;">${(row.profitableRate * 100).toFixed(0)}%</td>`,
                ].join("");
            case "emerging":
                return [
                    `<td style="font-weight:600;">${row.asset}</td>`,
                    `<td style="text-align:right;color:${trendColor};">+${r(row.scoreChange)}</td>`,
                    `<td style="text-align:right;color:${trendColor};">${trendIcon}</td>`,
                    `<td style="text-align:right;">${row.appearances}</td>`,
                    `<td style="text-align:right;">${(row.profitableRate * 100).toFixed(0)}%</td>`,
                    `<td style="text-align:right;">${r(row.avgSharpe)}</td>`,
                ].join("");
            case "falling":
                return [
                    `<td style="font-weight:600;">${row.asset}</td>`,
                    `<td style="text-align:right;color:${trendColor};">${r(row.scoreChange)}</td>`,
                    `<td style="text-align:right;color:${trendColor};">${trendIcon}</td>`,
                    `<td style="text-align:right;">${row.appearances}</td>`,
                    `<td style="text-align:right;">${(row.profitableRate * 100).toFixed(0)}%</td>`,
                    `<td style="text-align:right;">${r(row.avgSharpe)}</td>`,
                ].join("");
            case "consistent":
                return [
                    `<td style="font-weight:600;">${row.asset}</td>`,
                    `<td style="text-align:right;">${row.consecutiveRuns}</td>`,
                    `<td style="text-align:right;">${row.appearances}</td>`,
                    `<td style="text-align:right;">${(row.profitableRate * 100).toFixed(0)}%</td>`,
                    `<td style="text-align:right;">${r(row.consistencyScore)}</td>`,
                    `<td style="text-align:right;">${r(row.avgProfitFactor)}</td>`,
                ].join("");
            default:
                return [
                    `<td style="font-weight:600;">${row.asset}</td>`,
                    `<td style="text-align:right;font-weight:600;">${r(row.score, 1)}</td>`,
                    `<td style="text-align:right;">${row.appearances}</td>`,
                    `<td style="text-align:right;">${(row.profitableRate * 100).toFixed(0)}%</td>`,
                    `<td style="text-align:right;">${(row.topDecileRate * 100).toFixed(0)}%</td>`,
                    `<td style="text-align:right;">${r(row.avgSharpe)}</td>`,
                    `<td style="text-align:right;">${r(row.avgExpectancy)}</td>`,
                    `<td style="text-align:right;">${r(row.avgProfitFactor)}</td>`,
                ].join("");
        }
    }

    private renderRecentRuns(dom: AssetLeadershipDom, report: AssetLeadershipReport): void {
        if (report.recentRuns.length === 0) {
            dom.recentRuns.innerHTML = '<div class="param-hint">No runs stored.</div>';
            return;
        }
        const rows = [...report.recentRuns].reverse().slice(0, 10).map((run) => {
            const date = new Date(run.createdAt).toLocaleString();
            return `<div style="font-size:11px;padding:3px 0;border-bottom:1px solid var(--glass-border);display:flex;gap:8px;">`
                + `<span style="color:var(--text-secondary);">${date}</span>`
                + `<span>${run.strategyCount} strats</span>`
                + (run.strategyPreset ? `<span>${run.strategyPreset}</span>` : "")
                + `<span>${run.universeSymbolCount} syms</span>`
                + `<span>top${run.topN}</span>`
                + `<span style="color:var(--text-muted);">${run.interval}</span>`
                + `</div>`;
        });
        dom.recentRuns.innerHTML = rows.join("");
    }

    private chip(text: string): string {
        return `<span style="background:var(--bg-tertiary);border:1px solid var(--glass-border);border-radius:6px;padding:2px 8px;font-size:11px;">${text}</span>`;
    }

    private async copyReport(): Promise<void> {
        if (!this.report) {
            uiManager.showToast("No report to copy.", "info");
            return;
        }
        try {
            const text = JSON.stringify(this.report, null, 2);
            await navigator.clipboard.writeText(text);
            uiManager.showToast("Asset leadership report copied.", "success");
        } catch {
            uiManager.showToast("Copy failed.", "error");
        }
    }
}

export const assetLeadershipService = new AssetLeadershipService();
