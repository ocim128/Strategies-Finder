import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
    FINDER_METRIC_DATA,
    getFinderTableColumns,
    getFinderTableMetric,
    readFinderTableMetricValues,
    type FinderArmTableContext,
    type FinderTableMetricKey,
} from "../lib/finder/finder-results-table";
import { FinderUI } from "../lib/finder/finder-ui";
import { createEmptyBacktestResult } from "../lib/strategies/backtest/position-stats";
import { buildFinderUniverseCandidate } from "../lib/finder/finder-universe-metrics";
import { createEmptyRankingMeasurement } from "../lib/batch-backtest/open-score-replay/types";
import { createMiniDom, MiniElement, type MiniDom } from "./helpers/mini-dom";
import { refreshFinderSettingsSummaries } from "../lib/finder/browser/finder-workspace";
import { createFakeFinderManagerDom } from "./helpers/fake-finder-manager-dom";
import type {
    FinderArmPerformanceCandidate,
    FinderAssetOpportunityResult,
    FinderResult,
    FinderStrategyQualityResult,
    FinderUniverseSymbolResult,
} from "../lib/types/finder";
import type { BacktestResult } from "../lib/types/strategies";

const armContext = (overrides: Partial<FinderArmTableContext> = {}): FinderArmTableContext => ({
    replayMode: "horizon",
    ranking: false,
    rankingSort: "overall_ordering",
    ...overrides,
});

const labels = (scope: Parameters<typeof getFinderTableColumns>[0], arm?: FinderArmTableContext) =>
    getFinderTableColumns(scope, arm).map((column) => column.label);

/** A minimal card stub exposing keyed metric chips, mirroring FinderUI.createMetricChip. */
function fakeCard(chips: ReadonlyArray<{ text: string; key?: FinderTableMetricKey; value?: string }>): HTMLElement {
    const chipNodes = chips.map((chip) => ({
        textContent: chip.text,
        getAttribute: (name: string) => {
            if (name === FINDER_METRIC_DATA.key) return chip.key ?? null;
            if (name === FINDER_METRIC_DATA.value) return chip.value ?? null;
            return null;
        },
    }));
    return {
        querySelector: () => null,
        querySelectorAll: (selector: string) =>
            selector === `.finder-metrics [${FINDER_METRIC_DATA.key}]` ? chipNodes : [],
    } as unknown as HTMLElement;
}

// ---------------------------------------------------------------------------
// Real FinderUI output helpers (mini DOM with working traversal)
// ---------------------------------------------------------------------------

/** Run a body against a fresh mini document installed as the global document. */
function withMiniDom<T>(run: (mini: MiniDom) => T): T {
    const savedDocument = (globalThis as unknown as { document?: unknown }).document;
    const mini = createMiniDom();
    (globalThis as unknown as { document: unknown }).document = mini;
    try {
        return run(mini);
    } finally {
        (globalThis as unknown as { document?: unknown }).document = savedDocument;
    }
}

interface TableRowView {
    rank: string;
    identity: MiniElement;
    apply: MiniElement | null;
    actionText: string;
    /** Metric cell (class `finder-comparison-metric`) by its header label. */
    cells: Map<string, MiniElement>;
}

interface TableView {
    headers: string[];
    rows: TableRowView[];
    table: MiniElement;
}

/** Read the rendered comparison table: headers and per-row header-keyed metric cells. */
function readTable(mini: MiniDom): TableView {
    const list = mini.getElementById("finderList")!;
    const table = list.querySelector(".finder-comparison-table");
    if (!table) throw new Error("comparison table missing from the results list");
    const thead = table.children.find((child) => child.tagName === "THEAD");
    const tbody = table.children.find((child) => child.tagName === "TBODY");
    if (!thead || !tbody) throw new Error("comparison table is missing thead/tbody");
    const headers = thead.children[0]!.children.map((th) => th.textContent);
    const rows: TableRowView[] = tbody.children.map((row) => {
        const [rank, identity, action, ...metricCells] = row.children;
        const cells = new Map<string, MiniElement>();
        headers.slice(3).forEach((label, index) => {
            const cell = metricCells[index];
            if (!cell) throw new Error(`missing cell for column ${label}`);
            assert.equal(cell.className, "finder-comparison-metric", `cell under "${label}" must be a comparison metric cell`);
            cells.set(label, cell);
        });
        const apply = action!.children.find((child) => String(child.className).includes("finder-apply")) ?? null;
        return {
            rank: rank!.textContent,
            identity: identity!,
            apply,
            actionText: apply ? "" : action!.textContent,
            cells,
        };
    });
    return { headers, rows, table };
}

function cellText(view: TableView, rowIndex: number, header: string): string {
    const cell = view.rows[rowIndex]!.cells.get(header);
    if (!cell) throw new Error(`no column "${header}" (headers: ${view.headers.join(", ")})`);
    return cell.textContent;
}

function makeBacktestResult(overrides: Partial<BacktestResult> = {}): BacktestResult {
    return {
        ...createEmptyBacktestResult(),
        netProfit: 123,
        profitFactor: 2,
        expectancy: 4,
        totalTrades: 50,
        sharpeRatio: 1,
        ...overrides,
    };
}

function makeChartItem(overrides: Partial<FinderResult> = {}): FinderResult {
    const result = makeBacktestResult();
    return {
        key: "fixture",
        name: "Current Chart fixture",
        params: { period: 12 },
        result,
        selectionResult: result,
        ...overrides,
    } as FinderResult;
}

function makeUniverseSymbol(symbol: string, netProfit: number): FinderUniverseSymbolResult {
    return {
        symbol,
        status: "profitable",
        barCount: 100,
        result: makeBacktestResult({ netProfit, expectancy: netProfit / 100 }),
    } as FinderUniverseSymbolResult;
}

function makeAssetRow(overrides: Partial<FinderAssetOpportunityResult> = {}): FinderAssetOpportunityResult {
    return {
        symbol: "AAA",
        strategyKey: "fixture",
        strategyName: "Asset fixture",
        params: {},
        historicalRank: 1,
        totalCandidatesEvaluated: 5,
        freshStatus: "fresh",
        direction: "long",
        latestSignalTime: null,
        signalAgeBars: 0,
        fillTiming: "signal_close",
        selectionResult: makeBacktestResult(),
        grade: "select",
        support: { freshSameDirection: 2, poolSize: 3, directionAgreementRatio: 2 / 3 },
        ...overrides,
    } as FinderAssetOpportunityResult;
}

function makeQualityRow(overrides: Partial<FinderStrategyQualityResult> = {}): FinderStrategyQualityResult {
    return {
        strategyKey: "fixture",
        strategyName: "Audit fixture",
        params: {},
        symbols: [],
        requestedSymbols: 1,
        loadedSymbols: 1,
        failedSymbols: 0,
        activeSymbols: 1,
        profitableSymbols: 1,
        losingSymbols: 0,
        noTradeSymbols: 0,
        totalTrades: 50,
        totalNetProfit: 123,
        averageExpectancy: 4,
        medianExpectancy: 4,
        averageProfitFactor: 2,
        profitFactor: 2,
        averageSharpe: 1,
        sharpeAvailableSymbols: 1,
        weightedWinRate: 50,
        worstMaxDrawdownPercent: 2,
        ...overrides,
    } as FinderStrategyQualityResult;
}

const ARM_KEYS = [
    "TOP_RAW_PROFIT_NOW", "TOP_MEAN_PROFIT_NOW", "TOP_RAW_PROFIT_NOW_CONF", "TOP_Z",
    "TOP_RAW", "TOP_MEAN", "TOP_MEAN_RAW_UNIQUE", "TOP_RAW_PROFIT", "TOP_MEAN_PROFIT",
    "BOT_RAW_PROFIT_NOW", "BOT_MEAN_PROFIT_NOW", "BOT_Z", "BOT_RAW", "BOT_MEAN", "BOT_MEAN_RAW_UNIQUE",
] as const;

function makeArmRow(overrides: Partial<FinderArmPerformanceCandidate> = {}): FinderArmPerformanceCandidate {
    return {
        candidateId: "arm-table-candidate",
        candidateOrdinal: 0,
        strategyKey: "arm_test",
        strategyName: "Arm Test",
        replayMode: "horizon",
        horizon: 5,
        params: { threshold: 1 },
        backtestSettings: {},
        pairCoverage: { requestedPairs: 4, completedPairs: 4, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
        metrics: {},
        requestedEngineMode: "typescript",
        actualEngineMode: "typescript",
        ...overrides,
    } as FinderArmPerformanceCandidate;
}

function armMetric(overrides: Record<string, number> = {}) {
    return {
        events: 17,
        topMean: 0.01,
        randomMean: -0.02,
        delta: 0.03,
        topMedian: 0.01,
        ciLower: -0.04,
        ciUpper: 0.05,
        positiveBlocks: 1,
        totalBlocks: 1,
        ...overrides,
    };
}

function switchMetric(overrides: Record<string, unknown> = {}) {
    return {
        status: "incomplete" as const,
        enteredCount: 6,
        completedTrades: 5,
        realizedNetPnl: -30,
        openPositionNetPnl: 8.5,
        totalNetPnl: -21.5,
        averageCompletedHoldingDurationSec: 0,
        partialRealizedNetPnl: 0,
        completedHoldingDurationSec: 0,
        totalCosts: 1.25,
        diagnosticCounts: {},
        openPosition: null,
        pendingOrder: null,
        ...overrides,
    };
}

function switchRow(metric: Record<string, unknown>): FinderArmPerformanceCandidate {
    return makeArmRow({
        replayMode: "asset_switch",
        assetSwitchMetrics: Object.fromEntries(ARM_KEYS.map((arm) => [arm, metric])) as unknown as FinderArmPerformanceCandidate["assetSwitchMetrics"],
    });
}

function rankingRow(): FinderArmPerformanceCandidate {
    const rankingMeasurement = createEmptyRankingMeasurement(5);
    Object.assign(rankingMeasurement.arms.topRaw, {
        scoredEvents: 1336,
        eligibleEvents: 1336,
        comparisons: 13360,
        meanAccuracy: 0.5361,
        top1Superiority: 0.5633,
        blockCount: 10,
        measurementWindowSec: 60,
        timeBlockWidthSec: 120,
        timeCoverageSec: 1080,
        soleFirstPlaceCount: 200,
        sharedFirstPlaceCount: 100,
        soleFirstPlaceRate: 200 / 1336,
        sharedFirstPlaceRate: 100 / 1336,
        ciLower: 0.51,
        ciUpper: 0.57,
        status: "available",
    });
    return makeArmRow({ rankingMeasurement });
}

function renderTable(mini: MiniDom, render: (ui: FinderUI) => void): TableView {
    const ui = new FinderUI();
    ui.setResultsView("table");
    render(ui);
    return readTable(mini);
}

const descendants = (root: MiniElement, predicate: (node: MiniElement) => boolean): MiniElement[] => {
    const found: MiniElement[] = [];
    const walk = (node: MiniElement): void => {
        for (const child of node.children) {
            if (predicate(child)) found.push(child);
            walk(child);
        }
    };
    walk(root);
    return found;
};

describe("Finder comparison table metrics", () => {
    it("selects columns for all scopes and all Arm Performance measurements", () => {
        assert.deepEqual(labels("current_chart"), ["Net", "PF", "Sharpe", "DD", "Trades"]);
        assert.deepEqual(labels("symbol_universe"), ["Robust", "Ratio", "Active", "Med Exp", "Med PF", "Trades"]);
        assert.deepEqual(labels("asset_opportunity"), ["Support", "Agree", "Exp", "Net", "PF", "Trades"]);
        assert.deepEqual(labels("strategy_quality"), ["Med Exp", "PF", "PnL", "Trades", "Active", "Worst DD"]);
        assert.deepEqual(labels("arm_performance", armContext()), ["Mean", "Random", "DeltaMed", "Events"]);
        assert.deepEqual(
            labels("arm_performance", armContext({ replayMode: "asset_switch" })),
            ["Total net P&L", "Realized", "Open", "Completed trades", "Costs"],
        );
        assert.deepEqual(
            labels("arm_performance", armContext({ ranking: true })),
            ["Ordering CI lower", "Rank eligibility", "Selected asset score", "Overall ordering accuracy", "Best asset frequency", "Scored events"],
        );
        assert.deepEqual(
            labels("arm_performance", armContext({ ranking: true, rankingSort: "selected_asset" })),
            ["Selected asset sort score", "Rank eligibility", "Selected asset score", "Overall ordering accuracy", "Best asset frequency", "Scored events"],
        );
    });

    it("keeps one distinct metric key per table column so no value can be shadowed", () => {
        for (const scope of ["current_chart", "symbol_universe", "asset_opportunity", "strategy_quality", "arm_performance"] as const) {
            const contexts = scope === "arm_performance"
                ? [armContext(), armContext({ replayMode: "asset_switch" }), armContext({ ranking: true }), armContext({ ranking: true, rankingSort: "selected_asset" })]
                : [undefined];
            for (const context of contexts) {
                const keys = getFinderTableColumns(scope, context).map((column) => column.key);
                assert.equal(new Set(keys).size, keys.length, `${scope} column keys must be unique`);
            }
        }
    });

    it("resolves values by metric key, independent of the card's visible wording", () => {
        // Regression: renaming a card label must not change the table's metric
        // identity. The net chip below is displayed as "Revenue" but keeps the
        // `net` key and its formatted value.
        const card = fakeCard([
            { text: "Revenue -$21.50", key: "net", value: "-$21.50" },
            { text: "Payback 0.00", key: "pf", value: "0.00" },
            { text: "Median TP --", key: "medPf", value: "--" },
            { text: "Mean n/a", key: "mean", value: "n/a" },
            { text: "Completed trades 5 · entries 6", key: "completedTrades", value: "5 · entries 6" },
        ]);
        const values = readFinderTableMetricValues(card);
        assert.equal(getFinderTableMetric(values, "net"), "-$21.50");
        assert.equal(getFinderTableMetric(values, "pf"), "0.00");
        assert.equal(getFinderTableMetric(values, "medPf"), "--");
        assert.equal(getFinderTableMetric(values, "mean"), "n/a");
        assert.equal(getFinderTableMetric(values, "completedTrades"), "5 · entries 6");
    });

    it("retains unavailable, zero, signed and contributor-adjusted display values without inventing metrics", () => {
        const values = readFinderTableMetricValues(fakeCard([
            { text: "Med PF --", key: "medPf", value: "--" },
            { text: "PF 0.00", key: "pf", value: "0.00" },
            { text: "Total net P&L −$21.50", key: "totalNetPnl", value: "−$21.50" },
            { text: "Mean n/a", key: "mean", value: "n/a" },
            { text: "Ordering CI lower +3.10%", key: "rankingSortScore", value: "+3.10%" },
            { text: "Rank eligibility rerun required", key: "rankEligibility", value: "rerun required" },
            { text: "Scored events 0", key: "scoredEvents", value: "0" },
            { text: "Status incomplete", key: "status", value: "Status incomplete" },
        ]));
        assert.equal(getFinderTableMetric(values, "medPf"), "--");
        assert.equal(getFinderTableMetric(values, "pf"), "0.00");
        assert.equal(getFinderTableMetric(values, "totalNetPnl"), "−$21.50");
        assert.equal(getFinderTableMetric(values, "mean"), "n/a");
        assert.equal(getFinderTableMetric(values, "rankingSortScore"), "+3.10%");
        assert.equal(getFinderTableMetric(values, "rankEligibility"), "rerun required");
        assert.equal(getFinderTableMetric(values, "scoredEvents"), "0");
        // The status line keeps the full display text.
        assert.equal(values.get("status"), "Status incomplete");
    });

    it("falls back to -- when a column's chip metadata is missing", () => {
        const values = readFinderTableMetricValues(fakeCard([
            { text: "Support 2/3", key: "support", value: "2/3" },
            { text: "Trades 12" },
        ]));
        assert.equal(getFinderTableMetric(values, "support"), "2/3");
        assert.equal(getFinderTableMetric(values, "trades"), "--");
        assert.equal(getFinderTableMetric(values, "net"), "--");
    });

    it("reads chips nested in Arm measurement details with a descendant selector", () => {
        // Ranking renders technical chips inside the measurement panel; the
        // card-wide read must use a descendant selector so those nested chips
        // still feed the table.
        const selectors: string[] = [];
        const card = {
            querySelectorAll: (selector: string) => {
                selectors.push(selector);
                return [];
            },
        } as unknown as HTMLElement;
        readFinderTableMetricValues(card);
        assert.equal(selectors.length, 1);
        assert.match(selectors[0]!, /^\.finder-metrics \[/);
        assert.ok(!selectors[0]!.includes(">"), "must not restrict the read to direct children");
    });
});

describe("Finder comparison table renders keyed cells from FinderUI output", () => {
    it("renders every static scope's cells under their expected headers", () => {
        withMiniDom((mini) => {
            const universeCandidate = buildFinderUniverseCandidate({
                strategyKey: "fixture",
                strategyName: "Universe fixture",
                params: {},
                symbols: [makeUniverseSymbol("AAA", 123), makeUniverseSymbol("BBB", -21)],
            });

            const chart = renderTable(mini, (ui) => ui.renderResults([makeChartItem()]));
            assert.deepEqual(chart.headers.slice(0, 3), ["Rank", "Candidate / Details", "Action"]);
            assert.equal(cellText(chart, 0, "Net"), "+$123.00");
            assert.equal(cellText(chart, 0, "PF"), "2.00");
            assert.equal(cellText(chart, 0, "Sharpe"), "1.00");
            assert.equal(cellText(chart, 0, "DD"), "0.00%");
            assert.equal(cellText(chart, 0, "Trades"), "50");

            const universe = renderTable(mini, (ui) => ui.renderUniverseResults([universeCandidate]));
            assert.deepEqual(universe.headers.slice(3), ["Robust", "Ratio", "Active", "Med Exp", "Med PF", "Trades"]);
            assert.equal(cellText(universe, 0, "Robust"), universeCandidate.robustUniverseScore.toFixed(1));
            assert.equal(cellText(universe, 0, "Ratio"), `${(universeCandidate.profitableActiveRatio * 100).toFixed(1)}%`);
            assert.equal(cellText(universe, 0, "Active"), String(universeCandidate.activeSymbols));
            assert.equal(cellText(universe, 0, "Med Exp"), universeCandidate.medianExpectancy.toFixed(2));
            assert.equal(cellText(universe, 0, "Med PF"), universeCandidate.medianProfitFactor.toFixed(2));
            assert.equal(cellText(universe, 0, "Trades"), String(universeCandidate.totalTrades));

            const asset = renderTable(mini, (ui) => ui.renderAssetOpportunityResults([makeAssetRow()]));
            assert.deepEqual(asset.headers.slice(3), ["Support", "Agree", "Exp", "Net", "PF", "Trades"]);
            assert.equal(cellText(asset, 0, "Support"), "2/3");
            assert.equal(cellText(asset, 0, "Agree"), "67%");
            assert.equal(cellText(asset, 0, "Exp"), "4.00");
            assert.equal(cellText(asset, 0, "Net"), "+$123.00");
            assert.equal(cellText(asset, 0, "PF"), "2.00");
            assert.equal(cellText(asset, 0, "Trades"), "50");

            const quality = renderTable(mini, (ui) => ui.renderStrategyQualityResults([makeQualityRow()]));
            assert.deepEqual(quality.headers.slice(3), ["Med Exp", "PF", "PnL", "Trades", "Active", "Worst DD"]);
            assert.equal(cellText(quality, 0, "Med Exp"), "4.00");
            assert.equal(cellText(quality, 0, "PF"), "2.00");
            assert.equal(cellText(quality, 0, "PnL"), "+$123.00");
            assert.equal(cellText(quality, 0, "Trades"), "50");
            assert.equal(cellText(quality, 0, "Active"), "1/1");
            assert.equal(cellText(quality, 0, "Worst DD"), "2.00%");
            // Quality audits keep Apply read only in table view.
            assert.equal(quality.rows[0]!.apply, null);
            assert.equal(quality.rows[0]!.actionText, "Read only");
        });
    });

    it("renders signed, zero, missing, and contributor-excluded horizon values", () => {
        withMiniDom((mini) => {
            const signed = renderTable(mini, (ui) => ui.renderArmPerformanceResults(
                [makeArmRow({ metrics: { TOP_RAW: armMetric() } as FinderArmPerformanceCandidate["metrics"] })],
                null,
                "TOP_RAW",
            ));
            assert.deepEqual(signed.headers.slice(3), ["Mean", "Random", "DeltaMed", "Events"]);
            assert.equal(cellText(signed, 0, "Mean"), "+1.00%");
            assert.equal(cellText(signed, 0, "Random"), "-2.00%");
            assert.equal(cellText(signed, 0, "DeltaMed"), "+3.00%");
            assert.equal(cellText(signed, 0, "Events"), "17");

            const excluded = makeArmRow({
                metrics: { TOP_RAW: armMetric({ topMean: 0.9 }) } as FinderArmPerformanceCandidate["metrics"],
                metricsExTopContributor: {
                    TOP_RAW: armMetric({ events: 4, topMean: 0.5, randomMean: -0.1, delta: 0.6 }),
                } as FinderArmPerformanceCandidate["metricsExTopContributor"],
            });
            const excludedView = renderTable(mini, (ui) => ui.renderArmPerformanceResults(
                [excluded, makeArmRow({ metricsExTopContributor: {} })],
                null,
                "TOP_RAW",
                false,
                "exclude_top_contributor",
            ));
            // The excluded basis reads the adjusted metrics, not the raw ones.
            assert.equal(cellText(excludedView, 0, "Mean"), "+50.00%");
            assert.equal(cellText(excludedView, 0, "Events"), "4");
            assert.notEqual(cellText(excludedView, 0, "Mean"), "+90.00%");
            // A candidate without an excluded summary falls back per column.
            assert.equal(cellText(excludedView, 1, "Mean"), "n/a");
            assert.equal(cellText(excludedView, 1, "Events"), "n/a");

            const zero = renderTable(mini, (ui) => ui.renderArmPerformanceResults(
                [makeArmRow({ metrics: { TOP_RAW: armMetric({ events: 0, topMean: 0 }) } as FinderArmPerformanceCandidate["metrics"] })],
                null,
                "TOP_RAW",
            ));
            assert.equal(cellText(zero, 0, "Mean"), "+0.00%");
            assert.equal(cellText(zero, 0, "Events"), "0");
        });
    });

    it("renders switch-return cells, replay status, and contributor-excluded adjustments", () => {
        withMiniDom((mini) => {
            const view = renderTable(mini, (ui) => ui.renderArmPerformanceResults(
                [switchRow(switchMetric())],
                null,
                "TOP_RAW",
            ));
            assert.deepEqual(view.headers.slice(3), ["Total net P&L", "Realized", "Open", "Completed trades", "Costs"]);
            assert.equal(cellText(view, 0, "Total net P&L"), "$-21.50");
            assert.equal(cellText(view, 0, "Realized"), "$-30.00");
            assert.equal(cellText(view, 0, "Open"), "+$8.50");
            assert.equal(cellText(view, 0, "Completed trades"), "5 · entries 6");
            assert.equal(cellText(view, 0, "Costs"), "+$1.25");
            // Keyed replay status is a direct identity child, not lost in details.
            const statusLines = view.rows[0]!.identity.children.filter((child) => child.textContent === "Status incomplete");
            assert.equal(statusLines.length, 1);

            const excluded = switchRow(switchMetric({
                topContributorExclusion: {
                    asset: "AAA",
                    contributionNetPnl: -15,
                    adjustedTotalNetPnl: -6.5,
                    adjustedRealizedNetPnl: -15,
                    adjustedOpenPositionNetPnl: 8.5,
                },
            }));
            const excludedView = renderTable(mini, (ui) => ui.renderArmPerformanceResults(
                [excluded],
                null,
                "TOP_RAW",
                false,
                "exclude_top_contributor",
            ));
            assert.equal(cellText(excludedView, 0, "Total net P&L"), "$-6.50");
            assert.equal(cellText(excludedView, 0, "Realized"), "$-15.00");
            assert.equal(cellText(excludedView, 0, "Open"), "+$8.50");
        });
    });

    it("renders both ranking sorts with eligibility and scored-event columns", () => {
        withMiniDom((mini) => {
            const overall = renderTable(mini, (ui) => ui.renderArmPerformanceResults(
                [rankingRow()],
                null,
                "TOP_RAW",
                false,
                "raw",
                { measurement: "ranking_consistency", rankingSort: "overall_ordering" },
            ));
            assert.deepEqual(overall.headers.slice(3), [
                "Ordering CI lower", "Rank eligibility", "Selected asset score",
                "Overall ordering accuracy", "Best asset frequency", "Scored events",
            ]);
            assert.equal(cellText(overall, 0, "Ordering CI lower"), "51.00%");
            assert.equal(cellText(overall, 0, "Rank eligibility"), "available");
            assert.equal(cellText(overall, 0, "Selected asset score"), "56.33%");
            assert.equal(cellText(overall, 0, "Overall ordering accuracy"), "53.61%");
            assert.equal(cellText(overall, 0, "Best asset frequency"), "14.97%");
            assert.equal(cellText(overall, 0, "Scored events"), "1336");

            const selected = renderTable(mini, (ui) => ui.renderArmPerformanceResults(
                [rankingRow()],
                null,
                "TOP_RAW",
                false,
                "raw",
                { measurement: "ranking_consistency", rankingSort: "selected_asset" },
            ));
            assert.equal(selected.headers[3], "Selected asset sort score");
            assert.equal(cellText(selected, 0, "Selected asset sort score"), "56.33%");
            assert.equal(cellText(selected, 0, "Rank eligibility"), "available");
        });
    });

    it("keeps OOS badges, Apply indices, and lazy detail listeners in table view", () => {
        withMiniDom((mini) => {
            const view = renderTable(mini, (ui) => ui.renderResults([
                makeChartItem({ oosResult: makeBacktestResult(), oosVerdict: "pass" }),
                makeChartItem({ key: "fixture-2", name: "Second fixture" }),
            ]));
            // OOS verdict badge moved into the identity column.
            const badges = descendants(view.rows[0]!.identity, (node) => String(node.className).includes("finder-oos"));
            assert.equal(badges.length, 1);
            assert.match(badges[0]!.className, /finder-oos-pass/);
            // Apply buttons keep their candidate index contract.
            assert.equal(view.rows[0]!.apply?.dataset.index, "0");
            assert.equal(view.rows[1]!.apply?.dataset.index, "1");
            assert.equal(view.rows[0]!.rank, "1");

            // The moved card details keep the lazy universe breakdown listener.
            const universeView = renderTable(mini, (ui) => ui.renderUniverseResults([
                buildFinderUniverseCandidate({
                    strategyKey: "fixture",
                    strategyName: "Universe fixture",
                    params: {},
                    symbols: [makeUniverseSymbol("AAA", 123)],
                }),
            ]));
            const breakdown = descendants(universeView.table, (node) => node.tagName === "SUMMARY")
                .find((summary) => summary.textContent.startsWith("Symbol Breakdown"));
            assert.ok(breakdown, "symbol breakdown summary missing");
            const breakdownDetails = breakdown!.parentNode!;
            assert.equal(
                descendants(breakdownDetails, (node) => node.className.includes("finder-symbol-row")).length,
                0,
                "breakdown rows must stay lazy before the details open",
            );
            breakdownDetails.open = true;
            assert.equal(breakdownDetails.dispatchEvent({ type: "toggle" }), true, "toggle listener missing");
            assert.equal(
                descendants(breakdownDetails, (node) => node.className.includes("finder-symbol-row")).length,
                1,
                "opening the breakdown must populate its rows",
            );
        });
    });

    it("keeps the keyed value when the visible card label changes", () => {
        withMiniDom((mini) => {
            const ui = new FinderUI();
            const originalChip = (ui as unknown as {
                createTableMetricChip: (label: string, value: string, key: FinderTableMetricKey) => HTMLSpanElement;
            }).createTableMetricChip.bind(ui);
            (ui as unknown as { createTableMetricChip: unknown }).createTableMetricChip =
                (label: string, value: string, key: FinderTableMetricKey) => originalChip(`RENAMED ${label}`, value, key);
            ui.setResultsView("table");
            ui.renderResults([makeChartItem()]);

            const view = readTable(mini);
            // The renamed chip remains visible inside the moved card details...
            assert.ok(
                descendants(view.table, (node) => node.textContent === "RENAMED Net +$123.00").length > 0,
                "renamed card chip should remain visible in the details",
            );
            // ...while the Net column still resolves the keyed value.
            assert.equal(cellText(view, 0, "Net"), "+$123.00");
            assert.equal(cellText(view, 0, "PF"), "2.00");
        });
    });

    it("shows -- in every comparison cell when chip metadata is stripped", () => {
        // The audit probe stripped metric metadata: whole-row text checks kept
        // passing on values that only lived in Parameters & details. Header-
        // scoped cell assertions must detect exactly this case.
        withMiniDom((mini) => {
            const ui = new FinderUI();
            const bareChip = (text: string): HTMLSpanElement => {
                const span = document.createElement("span");
                span.textContent = text;
                return span;
            };
            (ui as unknown as { createTableMetricChip: unknown }).createTableMetricChip =
                (label: string, value: string) => bareChip(`${label} ${value}`);
            ui.setResultsView("table");
            ui.renderResults([makeChartItem({ oosResult: makeBacktestResult(), oosVerdict: "pass" })]);

            const view = readTable(mini);
            for (const header of view.headers.slice(3)) {
                assert.equal(cellText(view, 0, header), "--", `${header} must not fall back to details text`);
            }
            // The unkeyed chip text is still in the moved card details — only
            // the header-scoped cell assertions can tell the difference.
            assert.ok(
                descendants(view.table, (node) => node.textContent === "Net +$123.00").length > 0,
                "sanity: the stripped chip text still exists inside details",
            );
        });
    });

    it("keeps the empty-fragment path and table chrome intact", () => {
        withMiniDom((mini) => {
            const ui = new FinderUI();
            ui.setResultsView("table");
            ui.renderArmPerformanceResults([], null, "TOP_RAW", false, "raw", { measurement: "ranking_consistency" });
            assert.equal(
                descendants(mini.getElementById("finderList")!, (node) => node.className === "finder-comparison-table").length,
                0,
                "empty inventories must not build a table",
            );

            const view = renderTable(mini, (uiInner) => uiInner.renderResults([makeChartItem()]));
            assert.equal(
                descendants(mini.getElementById("finderList")!, (node) => node.className === "finder-row").length,
                0,
                "table view must consume the source cards",
            );
            assert.equal(view.table.tagName, "TABLE");
            const caption = view.table.children.find((child) => child.tagName === "CAPTION");
            assert.ok(caption && caption.textContent.includes("Re-Sort"), "caption missing");
        });
    });
});

describe("Finder collapsed setting summaries", () => {
    it("reflects enabled options and changing filter bounds", () => {
        const dom = createFakeFinderManagerDom();
        const summaries = ["risk", "exit", "trades", "universe"].map((key) => ({ dataset: { finderSettingSummary: key }, textContent: "" }));
        dom.finderConfiguration.querySelectorAll = (() => summaries) as unknown as typeof dom.finderConfiguration.querySelectorAll;
        dom.finderFreezeRiskManagementToggle.checked = true;
        dom.finderExitStrategyOverrideToggle.checked = true;
        dom.finderTradesToggle.checked = true;
        dom.finderTradesMin.value = "40";
        dom.finderTradesMax.value = "";
        dom.finderUniverseMinActiveSymbols.value = "3";
        dom.finderUniverseMinTotalTrades.value = "50";
        dom.finderUniverseMinProfitableActiveRatio.value = "0.6";
        refreshFinderSettingsSummaries(dom);
        assert.equal(summaries[0].textContent, "Risk settings fixed");
        assert.equal(summaries[1].textContent, "Override search selected");
        assert.equal(summaries[2].textContent, "40–unlimited trades");
        assert.equal(summaries[3].textContent, "Active ≥ 3 · Trades ≥ 50 · Profitable ratio ≥ 0.6");
        dom.finderTradesToggle.checked = false;
        dom.finderExitStrategyOverrideToggle.checked = false;
        refreshFinderSettingsSummaries(dom);
        assert.equal(summaries[2].textContent, "Trade filter off");
        assert.equal(summaries[1].textContent, "Override search off");
    });
});
