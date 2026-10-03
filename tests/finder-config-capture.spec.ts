import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildFinderArmPerformanceRunConfiguration,
    captureTradeFilter,
    formatCapturedConfiguration,
} from "../lib/finder/finder-config-capture";

describe("finder config capture trade-filter normalization", () => {
    it("nulls the bounds when the toggle is off so a captured config cannot read as an enforced filter", () => {
        // The exact archive misread this guards against: minTrades 50 captured
        // verbatim next to tradeFilterEnabled: false was read as "strictly
        // enforced" — while the runners skipped filtering entirely.
        expect(captureTradeFilter({ tradeFilterEnabled: false, minTrades: 50, maxTrades: 60 })).to.deep.equal({
            tradeFilterEnabled: false,
            minTrades: null,
            maxTrades: null,
        });
    });

    it("keeps the bounds when the toggle is on", () => {
        expect(captureTradeFilter({ tradeFilterEnabled: true, minTrades: 10, maxTrades: 60 })).to.deep.equal({
            tradeFilterEnabled: true,
            minTrades: 10,
            maxTrades: 60,
        });
    });

    it("treats missing, non-numeric, or non-finite bounds as null even when enabled", () => {
        expect(captureTradeFilter({ tradeFilterEnabled: true })).to.deep.equal({
            tradeFilterEnabled: true,
            minTrades: null,
            maxTrades: null,
        });
        expect(captureTradeFilter({ tradeFilterEnabled: true, minTrades: Number.NaN, maxTrades: Number.POSITIVE_INFINITY })).to.deep.equal({
            tradeFilterEnabled: true,
            minTrades: null,
            maxTrades: null,
        });
    });

    it("treats a missing toggle as disabled", () => {
        expect(captureTradeFilter({ minTrades: 25 })).to.deep.equal({
            tradeFilterEnabled: false,
            minTrades: null,
            maxTrades: null,
        });
    });
});

describe("finder config capture formatting", () => {
    it("inlines arrays of primitives on one line so symbol universes stay compact", () => {
        const text = formatCapturedConfiguration({
            finder: { symbols: ["AAPL•+SPY•", "ABBV•+SPY•"], oosHorizons: [12, 18, 24] },
        });
        expect(text).to.contain('"symbols": ["AAPL•+SPY•","ABBV•+SPY•"]');
        expect(text).to.contain('"oosHorizons": [12,18,24]');
        // A 500-symbol universe costs one line for the array, not 500.
        const lines = formatCapturedConfiguration({
            finder: { symbols: Array.from({ length: 500 }, (_, i) => `SYM${i}•+SPY•`) },
        }).split("\n");
        expect(lines).to.have.length(5);
    });

    it("still pretty-prints objects and mixed arrays, and round-trips as JSON", () => {
        const value = {
            batch: { startHoldoutBars: 12, endHoldoutBars: 160 },
            nested: [{ rank: 1, tags: ["a", "b"] }],
            empty: { list: [], map: {} },
            flag: null,
        };
        const text = formatCapturedConfiguration(value);
        expect(JSON.parse(text)).to.deep.equal(value);
        expect(text).to.contain('"batch": {\n\t\t"startHoldoutBars": 12');
        expect(text).to.contain('"list": []');
        expect(text).to.contain('"map": {}');
    });
});

describe("Arm Performance run configuration capture", () => {
    it("exports the frozen pair universe, window, cutoff, settings, and engine context", () => {
        const context: any = {
            runId: "frozen-run",
            startedAt: 123,
            strategyKeys: ["strategy_a", "strategy_b"],
            pairs: Array.from({ length: 5_000 }, (_, index) => `BASE${index}+QUOTE`),
            interval: "4h",
            horizon: 12,
            dateMode: "date_range",
            sampleFromSec: 1_700_000_000,
            sampleToSec: 1_710_000_000,
            evaluationCutoffSec: 1_720_000_000,
            plannedCandidateCount: 7,
            targetDataBoundary: { earliestBarTimeSec: 1_700_000_100, latestBarTimeSec: 1_719_999_900 },
            actualEngineModes: ["typescript", "rust"],
            capTiltWeight: "off",
            searchOptions: {
                mode: "random",
                randomSeed: 42,
                armPerformance: {
                    horizon: 12,
                    dateMode: "full",
                    scoringBasis: "exclude_top_contributor",
                    eventFilterEnabled: true,
                    minEvents: 4,
                    maxEvents: 20,
                    selectionCooldownEnabled: true,
                    selectionCooldownBars: 5,
                },
            } as any,
            backtestSettings: { executionModel: "next_open", tradeDirection: "long" },
            capitalSettings: { initialCapital: 25_000, commission: 0.1 },
            requestedEngineMode: "rust",
        };

        const captured = buildFinderArmPerformanceRunConfiguration(context, 6, true);
        const restored = JSON.parse(formatCapturedConfiguration(captured));
        expect(restored.finder.runId).to.equal("frozen-run");
        expect(restored.finder.pairs).to.have.length(5_000);
        expect(restored.finder.searchOptions.randomSeed).to.equal(42);
        expect(restored.finder.searchOptions.armPerformance).to.deep.equal(context.searchOptions.armPerformance);
        expect(restored.finder.horizon).to.equal(12);
        expect(restored.finder.sampleFromSec).to.equal(1_700_000_000);
        expect(restored.finder.evaluationCutoffSec).to.equal(1_720_000_000);
        expect(restored.finder.capTiltWeight).to.equal("off");
        expect(restored.finder.actualEngineModes).to.deep.equal(["typescript", "rust"]);
        expect(restored.backtestSettings).to.deep.equal(context.backtestSettings);
        expect(restored.capitalSettings).to.deep.equal(context.capitalSettings);
        expect(restored.finder.defaultSort).to.equal("TOP_RAW_PROFIT_NOW by topMean");
        const selected = { ...context, measurement: "ranking_consistency" as const, searchOptions: { ...context.searchOptions, armPerformance: { ...context.searchOptions.armPerformance!, rankingSort: "selected_asset" as const } } };
        const ranking = buildFinderArmPerformanceRunConfiguration(selected, 6, true);
        expect(ranking.finder.rankingSort).to.equal("selected_asset");
        expect(ranking.finder.defaultSort).to.equal("TOP_RAW_PROFIT_NOW by top1Superiority");
        expect(ranking.finder.rankingSemantics).to.equal("top-five-ranking-v2");
    });
});
