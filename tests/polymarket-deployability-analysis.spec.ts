import { expect } from "chai";
import { describe, it } from "node:test";
import {
    analyzeFillAdjustedMetrics,
    analyzePolymarketDeployability,
    buildSignificanceTest,
    buildConfidenceSummary,
    buildEntryPriceBucketBreakdown,
    buildLongShortBreakdown,
    buildChronologicalBlocks,
    computeWilsonLowerBound,
    determineVerdict,
    extractScoredTrades,
    type ChronoBlock,
    type ScoredTrade,
    type SignificanceTestResult,
} from "../lib/polymarket-deployability-analysis";
import type { PolymarketFillHistorySummary } from "../lib/polymarket-fill-history";
import type { PolymarketOutcomeRow } from "../lib/types/polymarket-outcomes";
import type { Trade } from "../lib/types/strategies";

function createMockTrade(
    entryTime: number,
    type: "long" | "short",
    entryPrice = 45_000
): Trade {
    return {
        id: entryTime,
        type,
        entryTime,
        exitTime: entryTime + 300,
        entryPrice,
        exitPrice: entryPrice + (type === "long" ? 50 : -50),
        pnl: 10,
        pnlPercent: 0.1,
        size: 1,
        exitReason: "signal",
    };
}

function createMockOutcome(
    eventStartTs: number,
    resolvedOutcomeUp: 0 | 1,
    yesOpenPrice = 0.5,
    checkpointPrices: Array<number | null> = [yesOpenPrice, yesOpenPrice, yesOpenPrice, yesOpenPrice, yesOpenPrice]
): PolymarketOutcomeRow {
    return {
        series_id: "10684",
        event_slug: `event-${eventStartTs}`,
        market_slug: `market-${eventStartTs}`,
        interval: "5m",
        event_start_ts: eventStartTs,
        event_end_ts: eventStartTs + 300,
        yes_token_id: "yes",
        no_token_id: "no",
        yes_open_price: yesOpenPrice,
        yes_entry_minute_1_price: checkpointPrices[1] ?? null,
        yes_entry_minute_2_price: checkpointPrices[2] ?? null,
        yes_entry_minute_3_price: checkpointPrices[3] ?? null,
        yes_entry_minute_4_price: checkpointPrices[4] ?? null,
        resolved_outcome_up: resolvedOutcomeUp,
        resolution_source: "test",
        updated_at: 1,
    };
}

function createHistorySummary(
    eventStartTs: number,
    yesMins: Array<number | null>,
    yesMaxes: Array<number | null>
): PolymarketFillHistorySummary {
    return {
        eventStartTs,
        yesTokenId: `yes-${eventStartTs}`,
        windows: yesMins.map((yesMinPrice, index) => ({
            yesMinPrice,
            yesMaxPrice: yesMaxes[index] ?? null,
            sampleCount: yesMinPrice === null && yesMaxes[index] === null ? 0 : 1,
        })),
    };
}

describe("Polymarket deployability analysis", () => {
    it("computes Wilson lower bound consistently", () => {
        expect(computeWilsonLowerBound(0, 0)).to.equal(0);
        expect(computeWilsonLowerBound(50, 100)).to.be.closeTo(0.4038, 0.001);
        expect(computeWilsonLowerBound(64, 100)).to.be.closeTo(0.5422, 0.001);
    });

    it("extracts scored trades using Polymarket open prices instead of asset prices", () => {
        const t1 = 1_704_067_200;
        const t2 = 1_704_067_500;
        const trades = [
            createMockTrade(t1, "long", 45_000),
            createMockTrade(t2, "short", 46_000),
        ];
        const outcomes = new Map<number, PolymarketOutcomeRow>([
            [t1, createMockOutcome(t1, 1, 0.35)],
            [t2, createMockOutcome(t2, 0, 0.65)],
        ]);

        const scoredTrades = extractScoredTrades(trades, outcomes);

        expect(scoredTrades).to.have.length(2);
        expect(scoredTrades[0]?.marketEntryPrice).to.equal(0.35);
        expect(scoredTrades[1]?.marketEntryPrice).to.equal(0.35);
        expect(scoredTrades[0]?.trade.entryPrice).to.equal(45_000);
    });

    it("builds confidence summary from the full evaluation row set", () => {
        const t1 = 1_704_067_200;
        const t2 = 1_704_067_500;
        const scoredTrades = extractScoredTrades(
            [createMockTrade(t1, "long"), createMockTrade(t2, "short")],
            new Map<number, PolymarketOutcomeRow>([
                [t1, createMockOutcome(t1, 1, 0.40)],
                [t2, createMockOutcome(t2, 0, 0.60)],
            ])
        );
        const evaluationRows = [
            createMockOutcome(t1, 1, 0.40),
            createMockOutcome(t2, 0, 0.60),
            createMockOutcome(1_704_067_800, 1, 0.52),
            createMockOutcome(1_704_068_100, 1, 0.48),
        ];

        const summary = buildConfidenceSummary(scoredTrades, evaluationRows);

        expect(summary.scoredTrades).to.equal(2);
        expect(summary.wins).to.equal(2);
        expect(summary.coverage).to.equal(0.5);
        expect(summary.alwaysYesBaseline).to.equal(0.75);
        expect(summary.alwaysNoBaseline).to.equal(0.25);
        expect(summary.deltaVsAlwaysYes).to.equal(0.25);
    });

    it("creates chronological blocks in timestamp order", () => {
        const scoredTrades: ScoredTrade[] = Array.from({ length: 6 }, (_, index) => ({
            trade: createMockTrade(1_704_067_200 + index * 300, index % 2 === 0 ? "long" : "short"),
            outcome: createMockOutcome(1_704_067_200 + index * 300, index % 2 === 0 ? 1 : 0, 0.5),
            entryTs: 1_704_067_200 + index * 300,
            isWin: true,
            prediction: index % 2 === 0 ? "yes" : "no",
            marketEntryPrice: 0.5,
        }));

        const blocks = buildChronologicalBlocks(scoredTrades, 4);

        expect(blocks).to.have.length(2);
        expect(blocks[0]?.scoredTrades).to.equal(4);
        expect(blocks[1]?.scoredTrades).to.equal(2);
        expect(blocks[0]?.startTs).to.equal(scoredTrades[0]?.entryTs);
        expect(blocks[1]?.endTs).to.equal(scoredTrades[5]?.entryTs);
    });

    it("builds long/short regime breakdowns", () => {
        const scoredTrades: ScoredTrade[] = [
            {
                trade: createMockTrade(1_704_067_200, "long"),
                outcome: createMockOutcome(1_704_067_200, 1, 0.41),
                entryTs: 1_704_067_200,
                isWin: true,
                prediction: "yes",
                marketEntryPrice: 0.41,
            },
            {
                trade: createMockTrade(1_704_067_500, "short"),
                outcome: createMockOutcome(1_704_067_500, 1, 0.63),
                entryTs: 1_704_067_500,
                isWin: false,
                prediction: "no",
                marketEntryPrice: 0.37,
            },
        ];

        const breakdown = buildLongShortBreakdown(scoredTrades);

        expect(breakdown).to.have.length(2);
        expect(breakdown.find((item) => item.label === "Long (YES)")?.winRate).to.equal(1);
        expect(breakdown.find((item) => item.label === "Short (NO)")?.winRate).to.equal(0);
    });

    it("uses Polymarket market prices for entry-price buckets", () => {
        const t1 = 1_704_067_200;
        const t2 = 1_704_067_500;
        const t3 = 1_704_067_800;
        const scoredTrades = extractScoredTrades(
            [
                createMockTrade(t1, "long", 45_000),
                createMockTrade(t2, "long", 50_000),
                createMockTrade(t3, "short", 55_000),
            ],
            new Map<number, PolymarketOutcomeRow>([
                [t1, createMockOutcome(t1, 1, 0.35)],
                [t2, createMockOutcome(t2, 1, 0.46)],
                [t3, createMockOutcome(t3, 0, 0.65)],
            ])
        );

        const breakdown = buildEntryPriceBucketBreakdown(scoredTrades, [30, 40, 50, 60, 70]);

        expect(breakdown.find((bucket) => bucket.label === "30-40c")?.scoredTrades).to.equal(2);
        expect(breakdown.find((bucket) => bucket.label === "40-50c")?.scoredTrades).to.equal(1);
    });

    it("uses a shuffle significance test for mixed-direction predictions", () => {
        const baseTs = 1_704_067_200;
        const scoredTrades = extractScoredTrades(
            [
                createMockTrade(baseTs, "long"),
                createMockTrade(baseTs + 300, "long"),
                createMockTrade(baseTs + 600, "short"),
                createMockTrade(baseTs + 900, "short"),
            ],
            new Map<number, PolymarketOutcomeRow>([
                [baseTs, createMockOutcome(baseTs, 1, 0.40)],
                [baseTs + 300, createMockOutcome(baseTs + 300, 1, 0.41)],
                [baseTs + 600, createMockOutcome(baseTs + 600, 0, 0.60)],
                [baseTs + 900, createMockOutcome(baseTs + 900, 0, 0.61)],
            ])
        );
        const confidence = buildConfidenceSummary(scoredTrades, scoredTrades.map((trade) => trade.outcome));

        const first = buildSignificanceTest(scoredTrades, confidence, 120, 42);
        const second = buildSignificanceTest(scoredTrades, confidence, 120, 42);

        expect(first).to.deep.equal(second);
        expect(first.mode).to.equal("shuffle");
        expect(first.pValue).to.be.lessThan(1);
        expect(first.expectedWinRate).to.be.closeTo(0.5, 0.1);
        expect(first.methodValue).to.equal("Shuffle x120");
    });

    it("uses a one-sided baseline significance test for one-direction strategies", () => {
        const baseTs = 1_704_067_200;
        const scoredTrades = extractScoredTrades(
            [
                createMockTrade(baseTs, "long"),
                createMockTrade(baseTs + 300, "long"),
                createMockTrade(baseTs + 600, "long"),
                createMockTrade(baseTs + 900, "long"),
            ],
            new Map<number, PolymarketOutcomeRow>([
                [baseTs, createMockOutcome(baseTs, 1, 0.40)],
                [baseTs + 300, createMockOutcome(baseTs + 300, 1, 0.41)],
                [baseTs + 600, createMockOutcome(baseTs + 600, 1, 0.42)],
                [baseTs + 900, createMockOutcome(baseTs + 900, 0, 0.43)],
            ])
        );
        const evaluationRows = [
            createMockOutcome(baseTs, 1, 0.40),
            createMockOutcome(baseTs + 300, 1, 0.41),
            createMockOutcome(baseTs + 600, 0, 0.42),
            createMockOutcome(baseTs + 900, 0, 0.43),
            createMockOutcome(baseTs + 1_200, 0, 0.44),
            createMockOutcome(baseTs + 1_500, 0, 0.45),
        ];
        const confidence = buildConfidenceSummary(scoredTrades, evaluationRows);

        const result = buildSignificanceTest(scoredTrades, confidence, 120, 42);

        expect(result.mode).to.equal("one_sided_binomial");
        expect(result.constantPrediction).to.equal("yes");
        expect(result.methodValue).to.equal("Binomial tail");
        expect(result.baselineValue).to.equal("YES baseline 33.3%");
        expect(result.pValue).to.be.lessThan(0.5);
    });

    it("uses synced checkpoint fallback for fill-adjusted metrics when history is absent", () => {
        const t1 = 1_704_067_200;
        const t2 = 1_704_067_500;
        const scoredTrades = extractScoredTrades(
            [createMockTrade(t1, "long"), createMockTrade(t2, "long")],
            new Map<number, PolymarketOutcomeRow>([
                [t1, createMockOutcome(t1, 1, 0.45, [0.45, 0.43, 0.39, 0.39, 0.39])],
                [t2, createMockOutcome(t2, 0, 0.52, [0.52, 0.51, 0.50, 0.49, 0.48])],
            ])
        );

        const result = analyzeFillAdjustedMetrics(scoredTrades, 40, "all");

        expect(result.eligibleTrades).to.equal(2);
        expect(result.scoredTrades).to.equal(1);
        expect(result.wins).to.equal(1);
        expect(result.fillRate).to.equal(0.5);
    });

    it("prefers raw history extrema over coarse checkpoints for fill-adjusted metrics", () => {
        const t1 = 1_704_067_200;
        const scoredTrades = extractScoredTrades(
            [createMockTrade(t1, "long")],
            new Map<number, PolymarketOutcomeRow>([
                [t1, createMockOutcome(t1, 1, 0.50, [0.50, 0.50, 0.50, 0.50, 0.50])],
            ])
        );
        const historySummaryByStartTs = new Map<number, PolymarketFillHistorySummary>([
            [t1, createHistorySummary(t1, [0.50, 0.495, 0.49, 0.49, 0.49], [0.50, 0.51, 0.52, 0.52, 0.52])],
        ]);

        const result = analyzeFillAdjustedMetrics(scoredTrades, 49, "all", historySummaryByStartTs);

        expect(result.scoredTrades).to.equal(1);
        expect(result.fillRate).to.equal(1);
    });

    it("adds fill-subset baseline and break-even context", () => {
        const t1 = 1_704_067_200;
        const t2 = 1_704_067_500;
        const scoredTrades = extractScoredTrades(
            [createMockTrade(t1, "long"), createMockTrade(t2, "long")],
            new Map<number, PolymarketOutcomeRow>([
                [t1, createMockOutcome(t1, 1, 0.45, [0.45, 0.43, 0.39, 0.39, 0.39])],
                [t2, createMockOutcome(t2, 0, 0.38, [0.38, 0.38, 0.38, 0.38, 0.38])],
            ])
        );

        const result = analyzeFillAdjustedMetrics(scoredTrades, 40, "all");

        expect(result.bestBaselineLabel).to.equal("YES");
        expect(result.bestBaseline).to.equal(0.5);
        expect(result.breakEvenWinRate).to.equal(0.4);
        expect(result.edgeVsBreakEven).to.be.closeTo(0.1, 1e-12);
        expect(result.deltaVsBestBaseline).to.equal(0);
    });

    it("derives verdicts from the repaired metrics", () => {
        const confidence = {
            winRate: 0.58,
            wins: 58,
            losses: 42,
            scoredTrades: 100,
            coverage: 0.75,
            wilsonLowerBound: 0.53,
            alwaysYesBaseline: 0.51,
            alwaysNoBaseline: 0.49,
            deltaVsAlwaysYes: 0.07,
            deltaVsAlwaysNo: 0.09,
        };
        const blocks: ChronoBlock[] = [
            { label: "Block 1", startTs: 1, endTs: 2, scoredTrades: 50, wins: 29, losses: 21, winRate: 0.58, wilsonLowerBound: 0.50 },
            { label: "Block 2", startTs: 3, endTs: 4, scoredTrades: 50, wins: 29, losses: 21, winRate: 0.58, wilsonLowerBound: 0.50 },
        ];
        const significance: SignificanceTestResult = {
            mode: "shuffle",
            hint: "test",
            methodValue: "Shuffle x1000",
            baselineValue: "Shuffled outcomes",
            observedWinRate: 0.58,
            expectedWinRate: 0.50,
            pValue: 0.02,
            diagnosticValue: "95th % 57.0%",
        };

        const verdict = determineVerdict(
            confidence,
            blocks,
            significance,
            {
                scoredTrades: 60,
                wins: 36,
                losses: 24,
                winRate: 0.60,
                wilsonLowerBound: 0.52,
                fillRate: 0.6,
                eligibleTrades: 100,
                targetPriceCents: 40,
                scope: "all",
            },
            {}
        );

        expect(verdict.verdict).to.equal("Robust");
        expect(verdict.significancePass).to.equal(true);
    });

    it("produces a complete deployability analysis with full evaluation rows", () => {
        const baseTs = 1_704_067_200;
        const scoredTrades = extractScoredTrades(
            [
                createMockTrade(baseTs, "long"),
                createMockTrade(baseTs + 300, "short"),
                createMockTrade(baseTs + 600, "long"),
                createMockTrade(baseTs + 900, "short"),
            ],
            new Map<number, PolymarketOutcomeRow>([
                [baseTs, createMockOutcome(baseTs, 1, 0.35)],
                [baseTs + 300, createMockOutcome(baseTs + 300, 0, 0.65)],
                [baseTs + 600, createMockOutcome(baseTs + 600, 1, 0.42)],
                [baseTs + 900, createMockOutcome(baseTs + 900, 0, 0.58)],
            ])
        );
        const evaluationRows = [
            createMockOutcome(baseTs, 1, 0.35),
            createMockOutcome(baseTs + 300, 0, 0.65),
            createMockOutcome(baseTs + 600, 1, 0.42),
            createMockOutcome(baseTs + 900, 0, 0.58),
            createMockOutcome(baseTs + 1_200, 1, 0.47),
            createMockOutcome(baseTs + 1_500, 1, 0.48),
        ];

        const result = analyzePolymarketDeployability(scoredTrades, evaluationRows, {
            blockSize: 2,
            shuffleSimulations: 100,
            shuffleSeed: 42,
            fillScope: "all",
            fillTargetPriceCents: 45,
        });

        expect(result.confidence.scoredTrades).to.equal(4);
        expect(result.confidence.coverage).to.equal(4 / 6);
        expect(result.chronologicalBlocks).to.have.length(2);
        expect(result.regimeBreakdown.longShort).to.have.length(2);
        expect(result.significanceTest.pValue).to.be.within(0, 1);
        expect(result.verdict.verdict).to.be.oneOf(["Robust", "Borderline", "Weak"]);
    });
});
