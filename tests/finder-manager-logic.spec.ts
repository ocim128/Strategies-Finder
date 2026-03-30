import { expect } from "chai";
import { describe, it } from "node:test";
import {
    addFinderTimeframeSelection,
    buildFinderOptions,
    resolveFinderSortPriority,
} from "./lib/finder/finder-manager-logic";

describe("Finder manager logic", () => {
    it("builds simple sort priority with stable netProfit fallback", () => {
        const sortPriority = resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: false,
            polymarketRankMode: "balanced",
        });

        expect(sortPriority).to.deep.equal(["expectancy", "profitFactor", "netProfit"]);
    });

    it("forces polymarket sort priority and disables mock multi-timeframe runs", () => {
        const options = buildFinderOptions({
            useAdvancedSort: true,
            advancedSortValues: ["winRate", "netProfitPercent"],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            mode: "random",
            multiTimeframeRequested: true,
            isMockSymbol: true,
            selectedTimeframes: ["5m", "15m"],
            maxMultiTimeframes: 10,
            topN: 12,
            steps: 4,
            robustSeed: 1337,
            rangePercent: 40,
            maxRuns: 250,
            tradeFilterEnabled: true,
            minTrades: 30,
            maxTrades: 10,
            freezeRiskManagement: false,
            comboEnabled: true,
            comboPrimaryConfigName: "primary",
            polymarketScoringEnabled: true,
            polymarketRankMode: "balanced",
            polymarketMinScoredPredictions: -5,
            polymarketLockOffset: true,
        });

        expect(options.sortPriority).to.deep.equal(["polyScore", "polyWinRate", "polyPredictions"]);
        expect(options.multiTimeframeEnabled).to.equal(false);
        expect(options.timeframes).to.deep.equal([]);
        expect(options.maxTrades).to.equal(30);
        expect(options.freezeRiskManagement).to.equal(true);
        expect(options.polymarketMinScoredPredictions).to.equal(0);
        expect(options.polymarketLockOffset).to.equal(true);
    });

    it("switches polymarket sort priority by selected rank mode", () => {
        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "accuracy",
        })).to.deep.equal(["polyWinRate", "polyPredictions", "polyCoverage"]);

        expect(resolveFinderSortPriority({
            useAdvancedSort: false,
            advancedSortValues: [],
            primarySort: "expectancy",
            secondarySort: "profitFactor",
            polymarketScoringEnabled: true,
            polymarketRankMode: "volume",
        })).to.deep.equal(["polyWins", "polyPredictions", "polyWinRate"]);
    });

    it("returns structured outcomes for timeframe selection", () => {
        const normalizeInterval = (value: string) => value === "bad" ? null : value.trim().toLowerCase();

        const added = addFinderTimeframeSelection(["5m"], " 15M ", 3, normalizeInterval);
        expect(added).to.deep.equal({
            status: "added",
            normalized: "15m",
            selected: ["5m", "15m"],
        });

        const duplicate = addFinderTimeframeSelection(["5m"], "5m", 3, normalizeInterval);
        expect(duplicate.status).to.equal("duplicate");

        const invalid = addFinderTimeframeSelection(["5m"], "bad", 3, normalizeInterval);
        expect(invalid.status).to.equal("invalid");

        const limitReached = addFinderTimeframeSelection(["1m", "5m", "15m"], "1h", 3, normalizeInterval);
        expect(limitReached.status).to.equal("limit_reached");
    });
});
