import { expect } from "chai";
import { describe, it } from "node:test";
import {
    buildTimingEdgeReport,
    formatTimingEdgeReportRow,
} from "../lib/finder/timing-edge-report";
import type { TimingEdgePersistedRun } from "../lib/batch-backtest/mine-timing-persistence";

/**
 * Timing Edge report builder tests.
 *
 * Intent being locked (AGENTS.md rule 8): the report is the new data
 * backbone of the Assets tab, replacing the universe-breadth view. It must
 * (a) rank by Mine Timing edge quality, (b) ignore non-actionable verdicts
 * (WATCH/SKIP/INCONCLUSIVE), and (c) compute Rising/Falling only when there
 * is a previous window — otherwise every first-appearance asset would trend
 * "up" from a 0 baseline and pollute the section with noise.
 */

function makeStabilityRun(args: {
    createdAt: number;
    verdicts: Array<{
        asset: string;
        verdict?: "LONG" | "SHORT";
        confidence?: "high" | "medium" | "low";
        timingEdgeScore?: number;
        medianLiftPct?: number;
        medianDiversity?: number;
        dominantPair?: string | null;
        hits?: number;
        pairWarnings?: number;
        direction?: "LONG" | "SHORT";
        close?: number | null;
        asOfTimeKey?: string | null;
        expectedForwardReturnPct?: number | null;
    }>;
    interval?: string;
    strategyKey?: string;
}): TimingEdgePersistedRun {
    return {
        runId: `run-${args.createdAt}`,
        createdAt: args.createdAt,
        interval: args.interval ?? "1h",
        strategyKey: args.strategyKey ?? "test_strategy",
        source: "stability",
        pairCount: 100,
        reruns: 25,
        subsetSize: 200,
        seed: 1,
        verdicts: args.verdicts.map((v) => ({
            asset: v.asset,
            verdict: v.verdict ?? "LONG",
            direction: v.direction ?? (v.verdict === "SHORT" ? "short" : "long"),
            confidence: v.confidence ?? "medium",
            close: v.close ?? null,
            medianBarsHeld: null,
            agreementTransition: null,
            asOfTimeKey: v.asOfTimeKey ?? "t",
            horizonBars: null,
            longestHorizonBars: null,
            expectedForwardReturnPct: v.expectedForwardReturnPct ?? null,
            oosLiftPct: v.medianLiftPct ?? null,
            longestOosForwardReturnPct: null,
            expectedMfePct: null,
            expectedMaePct: null,
            analogCount: null,
            candidateCount: null,
            pairWarnings: v.pairWarnings ?? 0,
            timingEdgeScore: v.timingEdgeScore ?? 0,
            medianDiversity: v.medianDiversity ?? 0,
            dominantPair: v.dominantPair ?? null,
            dominantPairShare: 0,
            hits: v.hits ?? 1,
            high: v.confidence === "high" ? 1 : 0,
            medium: v.confidence === "medium" ? 1 : 0,
            low: v.confidence === "low" ? 1 : 0,
            medianLiftPct: v.medianLiftPct ?? null,
            medianRr: null,
            medianHmaxLiftPct: v.medianLiftPct ?? null,
            medianDist: null,
        })),
    };
}

describe("buildTimingEdgeReport", () => {
    it("returns an empty report when no runs exist", () => {
        const report = buildTimingEdgeReport({ runs: [] });
        expect(report.topTimingEdge).to.deep.equal([]);
        expect(report.overview.totalAssets).to.equal(0);
        expect(report.overview.totalVerdicts).to.equal(0);
        expect(report.overview.topAsset).to.equal(null);
    });

    it("ranks assets by timingEdgeScore descending in Top Timing Edge", () => {
        const report = buildTimingEdgeReport({ runs: [makeStabilityRun({
            createdAt: 1,
            verdicts: [
                { asset: "LOW", verdict: "LONG", timingEdgeScore: 5 },
                { asset: "HIGH", verdict: "LONG", timingEdgeScore: 67 },
                { asset: "MID", verdict: "LONG", timingEdgeScore: 30 },
            ],
        })] });
        expect(report.topTimingEdge.map((r) => r.asset)).to.deep.equal(["HIGH", "MID", "LOW"]);
    });

    it("ignores WATCH / SKIP / INCONCLUSIVE verdicts — they're not timing-edge signals", () => {
        const report = buildTimingEdgeReport({ runs: [makeStabilityRun({
            createdAt: 1,
            verdicts: [
                { asset: "REAL", verdict: "LONG", timingEdgeScore: 30 },
                // @ts-expect-error — WATCH shouldn't appear in valid input, but
                // the report must filter non-LONG/SHORT defensively.
                { asset: "WATCH_ONLY", verdict: "WATCH", timingEdgeScore: 99 },
            ],
        })] });
        expect(report.overview.totalAssets).to.equal(1);
        expect(report.topTimingEdge[0]!.asset).to.equal("REAL");
    });

    it("partitions Long Triggers and Short Triggers by latest verdict direction", () => {
        const report = buildTimingEdgeReport({ runs: [makeStabilityRun({
            createdAt: 1,
            verdicts: [
                { asset: "LONGA", verdict: "LONG", timingEdgeScore: 30 },
                { asset: "SHORTA", verdict: "SHORT", timingEdgeScore: 30 },
                { asset: "LONGB", verdict: "LONG", timingEdgeScore: 20 },
            ],
        })] });
        expect(report.longTriggers.map((r) => r.asset)).to.deep.equal(["LONGA", "LONGB"]);
        expect(report.shortTriggers.map((r) => r.asset)).to.deep.equal(["SHORTA"]);
    });

    it("Diverse & Stable requires ≥50% diversity AND ≥50% profitable rate", () => {
        const report = buildTimingEdgeReport({ runs: [makeStabilityRun({
            createdAt: 1,
            verdicts: [
                { asset: "DIV_PROFIT", verdict: "LONG", timingEdgeScore: 30, medianDiversity: 0.8 },
                { asset: "LOW_DIV", verdict: "LONG", timingEdgeScore: 30, medianDiversity: 0.2 },
                { asset: "DIV_ZERO", verdict: "LONG", timingEdgeScore: 0, medianDiversity: 0.8 },
            ],
        })] });
        // DIV_PROFIT: div 0.8 ≥ 0.5 AND score 30 > 0 → profitable rate 1.0 → included
        // LOW_DIV: div 0.2 < 0.5 → excluded
        // DIV_ZERO: score 0 → profitable rate 0 → excluded
        const diverse = report.diverseStable.map((r) => r.asset);
        expect(diverse).to.include("DIV_PROFIT");
        expect(diverse).to.not.include("LOW_DIV");
        expect(diverse).to.not.include("DIV_ZERO");
    });

    it("Rising/Falling require appearances > RECENT_WINDOW_RUNS so a non-empty previous window exists", () => {
        // Intent: with `previousWindow = sorted.slice(0, length - RECENT_WINDOW_RUNS)`,
        // any row with appearances ≤ RECENT_WINDOW_RUNS has an EMPTY previous
        // window, so previousAvg = 0, so scoreChange = recentAvg ≥ 0 and every
        // positive-scoring row trends "up" from a zero baseline. That puts the
        // same rows in both Rising and Falling (just sorted differently) — noise.
        // The gate `appearances > RECENT_WINDOW_RUNS` ensures the previous
        // window is non-empty so scoreChange reflects a real transition.
        //
        // This test would have FAILED at HEAD before the fix: with the old
        // `appearances >= 2` gate, ONCE (2 appearances) would have appeared in
        // Rising despite there being no real previous window to compare to.
        const fewRuns = Array.from({ length: 3 }, (_, i) =>
            makeStabilityRun({ createdAt: i + 1, verdicts: [{ asset: "FEW", verdict: "LONG", timingEdgeScore: 30 + i }] })
        );
        const fewReport = buildTimingEdgeReport({ runs: fewRuns });
        // FEW has 3 appearances — less than RECENT_WINDOW_RUNS (6) — so no
        // previous window exists. Must NOT appear in either trend section.
        expect(fewReport.risingEdge.find((r) => r.asset === "FEW")).to.equal(undefined);
        expect(fewReport.fallingEdge.find((r) => r.asset === "FEW")).to.equal(undefined);
    });

    it("Rising and Falling are sign-exclusive — same asset never in both, and trend reflects actual score direction", () => {
        // 8 runs so previous window (length - 6 = 2 runs) is non-empty.
        // RISING: scores go 10 → 20 → 30 → 40 → 50 → 60 → 70 → 80 (recentAvg=75, prevAvg=15, Δ=+60).
        // FALLING: scores go 80 → 70 → 60 → 50 → 40 → 30 → 20 → 10 (recentAvg=15, prevAvg=75, Δ=-60).
        const risingRuns = Array.from({ length: 8 }, (_, i) =>
            makeStabilityRun({ createdAt: i + 1, verdicts: [{ asset: "UP", verdict: "LONG", timingEdgeScore: 10 + i * 10 }] })
        );
        const fallingRuns = Array.from({ length: 8 }, (_, i) =>
            makeStabilityRun({ createdAt: i + 1, verdicts: [{ asset: "DOWN", verdict: "LONG", timingEdgeScore: 80 - i * 10 }] })
        );
        const report = buildTimingEdgeReport({ runs: [...risingRuns, ...fallingRuns] });
        const risingAssets = report.risingEdge.map((r) => r.asset);
        const fallingAssets = report.fallingEdge.map((r) => r.asset);
        expect(risingAssets).to.include("UP");
        expect(risingAssets).to.not.include("DOWN");
        expect(fallingAssets).to.include("DOWN");
        expect(fallingAssets).to.not.include("UP");
    });

    it("accumulates per-asset metrics across multiple runs (appearances, avgLift, strongestPair)", () => {
        const report = buildTimingEdgeReport({ runs: [
            makeStabilityRun({
                createdAt: 1,
                verdicts: [{ asset: "X", verdict: "LONG", timingEdgeScore: 10, medianLiftPct: 2, dominantPair: "X+BTC" }],
            }),
            makeStabilityRun({
                createdAt: 2,
                verdicts: [{ asset: "X", verdict: "LONG", timingEdgeScore: 20, medianLiftPct: 4, dominantPair: "X+ETH" }],
            }),
            makeStabilityRun({
                createdAt: 3,
                verdicts: [{ asset: "X", verdict: "LONG", timingEdgeScore: 30, medianLiftPct: 6, dominantPair: "X+BTC" }],
            }),
        ] });
        const x = report.topTimingEdge.find((r) => r.asset === "X");
        expect(x).to.not.equal(undefined);
        expect(x!.appearances).to.equal(3);
        expect(x!.avgLiftPct).to.equal(4); // (2+4+6)/3
        expect(x!.strongestPair).to.equal("X+BTC"); // appeared 2x vs X+ETH 1x
        expect(x!.score).to.equal(30); // latest
    });

    it("tracks first seen, age, and direction-aware move since the first signal", () => {
        // Intent: a timing edge can be real but no longer tradable if price
        // already moved most of the expected edge after the first signal.
        // The Assets report must surface that lateness instead of showing only
        // the latest score.
        const report = buildTimingEdgeReport({ runs: [
            makeStabilityRun({
                createdAt: 1,
                verdicts: [{ asset: "ZEC", verdict: "LONG", timingEdgeScore: 20, medianLiftPct: 20, close: 100, asOfTimeKey: "2026-07-10T00:00:00Z" }],
            }),
            makeStabilityRun({
                createdAt: 2,
                verdicts: [{ asset: "ZEC", verdict: "LONG", timingEdgeScore: 50, medianLiftPct: 20, close: 112, asOfTimeKey: "2026-07-10T04:00:00Z" }],
            }),
        ] });
        const zec = report.topTimingEdge[0]!;
        expect(zec.asset).to.equal("ZEC");
        expect(zec.firstAsOfTimeKey).to.equal("2026-07-10T00:00:00Z");
        expect(zec.latestAsOfTimeKey).to.equal("2026-07-10T04:00:00Z");
        expect(zec.ageRuns).to.equal(1);
        expect(zec.moveSinceFirstPct).to.be.closeTo(12, 1e-9);
        expect(zec.freshness).to.equal("LATE");
    });

    it("marks stale rows when the edge did not appear in the latest loaded run", () => {
        const report = buildTimingEdgeReport({ runs: [
            makeStabilityRun({
                createdAt: 1,
                verdicts: [{ asset: "OLD", verdict: "LONG", timingEdgeScore: 30, medianLiftPct: 10, close: 100 }],
            }),
            makeStabilityRun({
                createdAt: 2,
                verdicts: [{ asset: "NEW", verdict: "LONG", timingEdgeScore: 20, medianLiftPct: 10, close: 100 }],
            }),
        ] });
        const old = report.topTimingEdge.find((r) => r.asset === "OLD")!;
        expect(old.freshness).to.equal("STALE");
    });

    it("uses an empty latest run to expire prior timing edges", () => {
        const report = buildTimingEdgeReport({ runs: [
            makeStabilityRun({
                createdAt: 1,
                verdicts: [{ asset: "OLD", verdict: "LONG", timingEdgeScore: 30, medianLiftPct: 10, close: 100 }],
            }),
            makeStabilityRun({ createdAt: 2, verdicts: [] }),
        ] });
        expect(report.topTimingEdge[0]!.asset).to.equal("OLD");
        expect(report.topTimingEdge[0]!.freshness).to.equal("STALE");
    });

    it("uses runId ordering when two runs share the same millisecond", () => {
        const first = makeStabilityRun({
            createdAt: 1,
            verdicts: [{ asset: "OLD", verdict: "LONG", timingEdgeScore: 30, medianLiftPct: 10, close: 100 }],
        });
        first.runId = "a";
        const second = makeStabilityRun({ createdAt: 1, verdicts: [] });
        second.runId = "b";
        const report = buildTimingEdgeReport({ runs: [second, first] });
        expect(report.topTimingEdge[0]!.freshness).to.equal("STALE");
    });

    it("buildTimingEdgeReport never mutates input runs (sorts a copy)", () => {
        const runs = [
            makeStabilityRun({ createdAt: 200, verdicts: [{ asset: "A", verdict: "LONG", timingEdgeScore: 1 }] }),
            makeStabilityRun({ createdAt: 100, verdicts: [{ asset: "A", verdict: "LONG", timingEdgeScore: 1 }] }),
        ];
        const original = runs.map((r) => r.createdAt);
        buildTimingEdgeReport({ runs });
        expect(runs.map((r) => r.createdAt)).to.deep.equal(original);
    });

    it("scopes freshness history to the latest strategy and interval", () => {
        const report = buildTimingEdgeReport({ runs: [
            makeStabilityRun({
                createdAt: 1,
                strategyKey: "old_strategy",
                verdicts: [{ asset: "WLD", verdict: "LONG", timingEdgeScore: 60, close: 100 }],
            }),
            makeStabilityRun({
                createdAt: 2,
                strategyKey: "new_strategy",
                verdicts: [{ asset: "WLD", verdict: "LONG", timingEdgeScore: 30, close: 120 }],
            }),
        ] });
        expect(report.overview.totalRuns).to.equal(1);
        expect(report.topTimingEdge[0]!.appearances).to.equal(1);
        expect(report.topTimingEdge[0]!.firstClose).to.equal(120);
        expect(report.topTimingEdge[0]!.moveSinceFirstPct).to.equal(0);
    });

    it("flags active LONG/SHORT conflicts on the same asset in the latest run", () => {
        // Intent: per-direction rows are correct for research, but a trading
        // decision needs a loud warning when both directions are live now.
        const report = buildTimingEdgeReport({ runs: [
            makeStabilityRun({ createdAt: 1, verdicts: [
                { asset: "SUI", verdict: "LONG", timingEdgeScore: 20, medianLiftPct: 5, close: 100 },
                { asset: "SUI", verdict: "SHORT", timingEdgeScore: 25, medianLiftPct: 5, close: 100 },
            ] }),
        ] });
        const suiRows = report.topTimingEdge.filter((r) => r.asset === "SUI");
        expect(suiRows.length).to.equal(2);
        expect(suiRows.every((row) => row.hasActiveConflict)).to.equal(true);
        expect(formatTimingEdgeReportRow(suiRows[0]!)).to.include("Fresh CONFLICT");
    });

    describe("per-direction keying (the 'asset flips direction across runs' fix)", () => {
        // Intent being locked (AGENTS.md rule 8): when the user runs many
        // different strategy libs and one produces WLD-LONG while another
        // produces WLD-SHORT, those are INDEPENDENT edges — not "WLD has a
        // mixed-direction average edge". The reducer MUST keep them as two
        // separate rows so:
        //   1. each can independently appear in Long Triggers / Short Triggers
        //   2. avgLiftPct / avgRr / score never average across opposite
        //      directions (a +5% long lift and a +5% short lift cancel, they
        //      don't aggregate to "+5%")
        //   3. the user can see both edges and judge which strategy libs agree
        // Without this test the original bug (silent averaging + latest-wins
        // direction) would silently come back if someone re-keys the reducer
        // by asset-only "for simplicity".
        it("splits an asset that appears as LONG in one run and SHORT in another into two rows", () => {
            const report = buildTimingEdgeReport({ runs: [
                makeStabilityRun({ createdAt: 1, verdicts: [
                    { asset: "WLD", verdict: "SHORT", timingEdgeScore: 67, medianLiftPct: 8 },
                ] }),
                makeStabilityRun({ createdAt: 2, verdicts: [
                    { asset: "WLD", verdict: "LONG", timingEdgeScore: 30, medianLiftPct: 4 },
                ] }),
            ] });
            // Two rows for WLD, one per direction — neither absorbed the other.
            const wldRows = report.topTimingEdge.filter((r) => r.asset === "WLD");
            expect(wldRows.length).to.equal(2);
            const directions = wldRows.map((r) => r.latestDirection).sort();
            expect(directions).to.deep.equal(["LONG", "SHORT"]);
        });

        it("each direction row lands in its own Triggers section (WLD-LONG in Long Triggers, WLD-SHORT in Short Triggers)", () => {
            const report = buildTimingEdgeReport({ runs: [
                makeStabilityRun({ createdAt: 1, verdicts: [
                    { asset: "WLD", verdict: "SHORT", timingEdgeScore: 67 },
                ] }),
                makeStabilityRun({ createdAt: 2, verdicts: [
                    { asset: "WLD", verdict: "LONG", timingEdgeScore: 30 },
                ] }),
            ] });
            expect(report.longTriggers.find((r) => r.asset === "WLD" && r.latestDirection === "LONG")).to.not.equal(undefined);
            expect(report.shortTriggers.find((r) => r.asset === "WLD" && r.latestDirection === "SHORT")).to.not.equal(undefined);
        });

        it("never averages metrics across opposite directions", () => {
            // WLD-SHORT has lift +8 (run 1). WLD-LONG has lift +4 (run 2).
            // If the reducer were still keyed by asset-only, avgLiftPct would
            // be 6 (= (8+4)/2). The fix keeps each row's avg at its own
            // direction's value: SHORT avg=8, LONG avg=4.
            const report = buildTimingEdgeReport({ runs: [
                makeStabilityRun({ createdAt: 1, verdicts: [
                    { asset: "WLD", verdict: "SHORT", timingEdgeScore: 67, medianLiftPct: 8 },
                ] }),
                makeStabilityRun({ createdAt: 2, verdicts: [
                    { asset: "WLD", verdict: "LONG", timingEdgeScore: 30, medianLiftPct: 4 },
                ] }),
            ] });
            const wldShort = report.topTimingEdge.find((r) => r.asset === "WLD" && r.latestDirection === "SHORT");
            const wldLong = report.topTimingEdge.find((r) => r.asset === "WLD" && r.latestDirection === "LONG");
            expect(wldShort!.avgLiftPct).to.equal(8);
            expect(wldLong!.avgLiftPct).to.equal(4);
        });

        it("appearances count is per-direction, not per-asset", () => {
            // WLD appears 3x as SHORT (across 3 runs) and 1x as LONG.
            // Per-direction keying: SHORT appr=3, LONG appr=1.
            const report = buildTimingEdgeReport({ runs: [
                makeStabilityRun({ createdAt: 1, verdicts: [{ asset: "WLD", verdict: "SHORT", timingEdgeScore: 50 }] }),
                makeStabilityRun({ createdAt: 2, verdicts: [{ asset: "WLD", verdict: "SHORT", timingEdgeScore: 55 }] }),
                makeStabilityRun({ createdAt: 3, verdicts: [{ asset: "WLD", verdict: "SHORT", timingEdgeScore: 60 }] }),
                makeStabilityRun({ createdAt: 4, verdicts: [{ asset: "WLD", verdict: "LONG", timingEdgeScore: 20 }] }),
            ] });
            const wldShort = report.topTimingEdge.find((r) => r.asset === "WLD" && r.latestDirection === "SHORT");
            const wldLong = report.topTimingEdge.find((r) => r.asset === "WLD" && r.latestDirection === "LONG");
            expect(wldShort!.appearances).to.equal(3);
            expect(wldLong!.appearances).to.equal(1);
        });

        it("overview.totalUniqueAssets counts the asset name once even when it appears in both directions", () => {
            // WLD in both directions + a long-only asset X.
            // totalAssets (rows) = 3 (WLD-SHORT, WLD-LONG, X-LONG)
            // totalUniqueAssets (names) = 2 (WLD, X)
            const report = buildTimingEdgeReport({ runs: [
                makeStabilityRun({ createdAt: 1, verdicts: [
                    { asset: "WLD", verdict: "SHORT", timingEdgeScore: 50 },
                    { asset: "X", verdict: "LONG", timingEdgeScore: 30 },
                ] }),
                makeStabilityRun({ createdAt: 2, verdicts: [
                    { asset: "WLD", verdict: "LONG", timingEdgeScore: 20 },
                ] }),
            ] });
            expect(report.overview.totalAssets).to.equal(3);
            expect(report.overview.totalUniqueAssets).to.equal(2);
        });

        it("topAsset chip is direction-qualified when the top row is WLD-SHORT", () => {
            const report = buildTimingEdgeReport({ runs: [
                makeStabilityRun({ createdAt: 1, verdicts: [
                    { asset: "WLD", verdict: "SHORT", timingEdgeScore: 67 },
                    { asset: "OTHER", verdict: "LONG", timingEdgeScore: 10 },
                ] }),
            ] });
            expect(report.overview.topAsset).to.equal("WLD SHORT");
        });

        it("same-strategy same-direction appearances aggregate into one row", () => {
            // Per-direction keying should not split repeated same-direction
            // appearances within the currently scoped workflow.
            const report = buildTimingEdgeReport({ runs: [
                makeStabilityRun({ createdAt: 1, verdicts: [{ asset: "WLD", verdict: "LONG", timingEdgeScore: 30, medianLiftPct: 4 }] }),
                makeStabilityRun({ createdAt: 2, verdicts: [{ asset: "WLD", verdict: "LONG", timingEdgeScore: 40, medianLiftPct: 6 }] }),
            ] });
            const wldRows = report.topTimingEdge.filter((r) => r.asset === "WLD");
            expect(wldRows.length).to.equal(1);
            expect(wldRows[0]!.appearances).to.equal(2);
            expect(wldRows[0]!.avgLiftPct).to.equal(5); // (4+6)/2 — same-direction avg IS valid
        });
    });
});

describe("formatTimingEdgeReportRow", () => {
    it("renders all key fields with pipe separation", () => {
        const report = buildTimingEdgeReport({ runs: [makeStabilityRun({
            createdAt: 1,
            verdicts: [{ asset: "WLD", verdict: "SHORT", confidence: "high", timingEdgeScore: 67, medianLiftPct: 8.21, medianDiversity: 0.77, dominantPair: "WLD+HYPE", hits: 6, pairWarnings: 0 }],
        })] });
        const line = formatTimingEdgeReportRow(report.topTimingEdge[0]!);
        expect(line).to.be.a("string");
        expect(line).to.include("WLD");
        expect(line).to.include("Dir SHORT");
        expect(line).to.include("Score 67.0");
        expect(line).to.include("Pair WLD+HYPE");
        expect(line).to.include("Warn 0/6");
    });

    it("renders '--' for missing numeric fields (no NaN propagation)", () => {
        const report = buildTimingEdgeReport({ runs: [makeStabilityRun({
            createdAt: 1,
            verdicts: [{ asset: "X", verdict: "LONG", timingEdgeScore: 0, medianLiftPct: undefined, dominantPair: undefined }],
        })] });
        const line = formatTimingEdgeReportRow(report.topTimingEdge[0]!);
        expect(line).to.not.include("NaN");
    });
});
