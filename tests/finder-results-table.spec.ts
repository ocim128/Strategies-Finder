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
import { refreshFinderSettingsSummaries } from "../lib/finder/browser/finder-workspace";
import { createFakeFinderManagerDom } from "./helpers/fake-finder-manager-dom";

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
        // Ranking renders technical chips (Status, Completed trades, Costs)
        // inside the measurement panel; the card-wide read must use a
        // descendant selector so those nested chips still feed the table.
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
