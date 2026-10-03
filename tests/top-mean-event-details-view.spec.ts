import { expect } from "chai";
import { describe, it } from "node:test";
import { renderTopMeanOpenScoreEventDetails } from "../lib/batch-backtest/browser/top-mean-event-details-view";
import type { TopMeanResultSummary } from "../lib/batch-backtest/sp500-top-mean-coordinator-engine";
import type { AssetSwitchTradeRecord } from "../lib/batch-backtest/open-score-replay/types";
import { CAUSAL_ARM_FIELDS, REPLAY_ARM_TO_FINDER_ARM } from "../lib/batch-backtest/open-score-replay/arm-contract";
import { FINDER_CAUSAL_ARMS_V1 } from "../lib/batch-backtest/open-score-replay/causal-arm-constants";

function trade(asset: string, year: number): AssetSwitchTradeRecord {
    const decisionTimeSec = Math.floor(Date.UTC(year, 5, 15, 12) / 1_000);
    return {
        arm: "topMean",
        asset,
        decisionTimeSec,
        entryTimeSec: decisionTimeSec + 3_600,
        entryPrice: 100,
        exitTimeSec: decisionTimeSec + 7_200,
        exitPrice: 101,
        holdingDurationSec: 3_600,
        netPnl: 10,
        entryCost: 1,
        exitCost: 1,
        status: "closed",
    };
}

function summary(fullTrades: AssetSwitchTradeRecord[], annualReports: unknown[] = []): TopMeanResultSummary {
    return {
        runId: "top_mean_event_details_test",
        completed: true,
        replayMode: "asset_switch",
        counts: {} as TopMeanResultSummary["counts"],
        horizons: [],
        assetSwitch: {
            semanticsVersion: "asset_switch.v1",
            windowStartSec: Math.floor(Date.UTC(2024, 0, 1) / 1_000),
            windowEndSec: Math.floor(Date.UTC(2025, 11, 31) / 1_000),
            independentWindow: false,
            sizing: "fixed_entry_notional_non_compounding",
            notionalPerEntry: 1_000,
            slippageRate: 0,
            commissionRate: 0,
            valuation: "last_closed_candle_close_at_or_before_window_end",
            coverage: { requestedAssets: 2, loadedAssets: 2, missingAssets: 0, invalidSeries: 0 },
            arms: {} as NonNullable<TopMeanResultSummary["assetSwitch"]>["arms"],
            trades: fullTrades,
            tradeCount: fullTrades.length,
        },
        annualReports: annualReports as TopMeanResultSummary["annualReports"],
        warnings: [],
        reportLines: [],
    } as unknown as TopMeanResultSummary;
}

describe("TOP_MEAN asset-switch event details", () => {
    for (const field of CAUSAL_ARM_FIELDS) {
        it(`filters ${field} trade records and keeps legacy absence explicit`, () => {
            const result = summary([{ ...trade("NEW_ARM", 2024), arm: field }, trade("OTHER_ARM", 2024)]);
            const arm = REPLAY_ARM_TO_FINDER_ARM[field];
            expect(renderTopMeanOpenScoreEventDetails(result, arm)).to.include("Rerun required");
            result.causalArmDefinitions = { ...FINDER_CAUSAL_ARMS_V1 };
            const html = renderTopMeanOpenScoreEventDetails(result, arm);
            expect(html).to.include("NEW_ARM");
            expect(html).not.to.include("OTHER_ARM");
            expect(html).not.to.include("Rerun required");
        });
    }
    it("filters full-window trades by selected year when no independent annual section exists", () => {
        const result = summary([trade("FULL_2024", 2024), trade("FULL_2025", 2025)]);

        const html = renderTopMeanOpenScoreEventDetails(result, "TOP_MEAN", 2024);

        expect(html).to.include("No independent annual replay section is available for 2024.");
        expect(html).to.include("full-window preview filtered by UTC decision year");
        expect(html).to.include("Filtered Full-Window Preview — Calendar Year 2024 | 1 trade records");
        expect(html).to.include("FULL_2024");
        expect(html).to.not.include("FULL_2025");
        expect(html).to.not.include("No TOP_MEAN trade records in full-window preview for 2024.");
    });

    it("prefers an independent annual replay when its trade preview is present", () => {
        const annualTrade = trade("INDEPENDENT_2024", 2024);
        const result = summary([trade("FULL_2024", 2024)], [{
            year: 2024,
            assetSwitch: { trades: [annualTrade], tradeCount: 1 },
        }]);

        const html = renderTopMeanOpenScoreEventDetails(result, "TOP_MEAN", 2024);

        expect(html).to.include("Independent Calendar Year 2024 | 1 trade records");
        expect(html).to.include("INDEPENDENT_2024");
        expect(html).to.not.include("FULL_2024");
        expect(html).to.not.include("No independent annual replay section is available");
    });

    it("uses the labeled full-window preview when an annual summary has no retained rows", () => {
        const result = summary([trade("FULL_2024", 2024)], [{
            year: 2024,
            assetSwitch: { tradeCount: 12 },
        }]);

        const html = renderTopMeanOpenScoreEventDetails(result, "TOP_MEAN", 2024);

        expect(html).to.include("The independent 2024 replay summary has 12 trades but no retained annual preview.");
        expect(html).to.include("Filtered Full-Window Preview — Calendar Year 2024 | 1 trade records");
        expect(html).to.include("FULL_2024");
    });
});
