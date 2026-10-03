import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { getFinderTableColumns, getFinderTableMetric } from "../lib/finder/finder-results-table";
import { refreshFinderSettingsSummaries } from "../lib/finder/browser/finder-workspace";
import { createFakeFinderManagerDom } from "./helpers/fake-finder-manager-dom";

describe("Finder comparison table metrics", () => {
    it("selects columns for all scopes and all Arm Performance measurements", () => {
        const labels = (scope: Parameters<typeof getFinderTableColumns>[0], texts: string[] = []) => getFinderTableColumns(scope, texts).map((column) => column.label);
        assert.deepEqual(labels("current_chart"), ["Net", "PF", "Sharpe", "DD", "Trades"]);
        assert.deepEqual(labels("symbol_universe"), ["Robust", "Ratio", "Active", "Med Exp", "Med PF", "Trades"]);
        assert.deepEqual(labels("asset_opportunity"), ["Support", "Agree", "Exp", "Net", "PF", "Trades"]);
        assert.deepEqual(labels("strategy_quality"), ["Med Exp", "PF", "PnL", "Trades", "Active", "Worst DD"]);
        assert.deepEqual(labels("arm_performance"), ["Mean", "Random", "DeltaMed", "Events"]);
        assert.deepEqual(labels("arm_performance", ["Total net P&L n/a"]), ["Total net P&L", "Realized", "Open", "Completed trades", "Costs"]);
        assert.deepEqual(labels("arm_performance", ["Total net P&L $2", "Selected asset score n/a"]), ["Selected asset score", "Overall ordering accuracy", "Best asset frequency", "Scored events"]);
        for (const sortLabel of ["Ordering CI lower", "Selected asset sort score"]) {
            assert.deepEqual(labels("arm_performance", [`${sortLabel} n/a`, "Rank eligibility insufficient confidence", "Selected asset score 90%"]),
                [sortLabel, "Rank eligibility", "Selected asset score", "Overall ordering accuracy", "Best asset frequency", "Scored events"]);
        }
    });

    it("retains unavailable, zero, signed and contributor-adjusted display values without inventing metrics", () => {
        const texts = ["Med PF --", "PF 0.00", "Total net P&L −$21.50", "Mean n/a", "Completed trades 5 · entries 6"];
        assert.equal(getFinderTableMetric(texts, "PF "), "0.00");
        assert.equal(getFinderTableMetric(texts, "Med PF "), "--");
        assert.equal(getFinderTableMetric(texts, "Total net P&L "), "−$21.50");
        assert.equal(getFinderTableMetric(texts, "Mean "), "n/a");
        assert.equal(getFinderTableMetric(texts, "Completed trades "), "5 · entries 6");
        assert.equal(getFinderTableMetric(texts, "Sharpe "), "--");
    });
});

describe("Finder collapsed setting summaries", () => {
    it("reflects enabled options and changing filter bounds", () => {
        const dom = createFakeFinderManagerDom();
        const summaries = ["risk", "exit", "trades", "universe"].map((key) => ({ dataset: { finderSettingSummary: key }, textContent: "" }));
        dom.finderConfiguration.querySelectorAll = (() => summaries) as unknown as typeof dom.finderConfiguration.querySelectorAll;
        dom.finderFreezeRiskManagementToggle.checked = true;
        dom.finderRandomizePathExitToggle.checked = true;
        dom.finderExitStrategyOverrideToggle.checked = true;
        dom.finderTradesToggle.checked = true;
        dom.finderTradesMin.value = "40";
        dom.finderTradesMax.value = "";
        dom.finderUniverseMinActiveSymbols.value = "3";
        dom.finderUniverseMinTotalTrades.value = "50";
        dom.finderUniverseMinProfitableActiveRatio.value = "0.6";
        refreshFinderSettingsSummaries(dom);
        assert.equal(summaries[0].textContent, "Risk settings fixed · Path exit search selected");
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
