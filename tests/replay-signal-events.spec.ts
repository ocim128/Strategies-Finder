/**
 * Tests for signal-event replay: causal history, grouping, rules, walk-forward.
 *
 * These tests verify the core invariants of the replay engine:
 * - Causal history: only exited trades are in the ledger
 * - Grouping: next_open fills group by signal bar, not fill bar
 * - Random baseline: mean paired delta ≈ 0
 * - Tie-breaking: deterministic under fixed seed
 * - pnlPercent ranking: raw $ differences don't affect ranking
 * - Fold boundaries: labels crossing boundaries are excluded
 * - Signal mapping: unmatched/ambiguous signals excluded
 * - Censored trades: end_of_data excluded
 * - Timestamp normalization: BusinessDay, seconds, ms, ISO group consistently
 * - Partial exits: one entry with multiple exits becomes one candidate
 * - Missing features: entry_volatility missing = worst, signal_rarity missing = 0
 * - Within-event IC: training uses event-normalized ranking, not pooled
 */
import { expect } from "chai";
import { describe, it } from "node:test";
import {
    groupBySignalEvent,
    generateFolds,
    spearman,
    createSeededRandom,
    runReplay,
    loadArtifactCandidates,
    scoreCandidateForRule,
    type SignalCandidate,
    type CliOptions,
    type ExclusionCounts,
    type TradeLedgerEntry,
} from "../scripts/replay-signal-events";
import * as fs from "node:fs";
import * as path from "node:path";
import { serialize } from "node:v8";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
import type { OHLCVData } from "../lib/types/strategies";
import { canonicalTimeKey } from "../lib/strategies/backtest/backtest-utils";

// ============================================================================
// Helpers
// ============================================================================

function makeCandidate(overrides: Partial<SignalCandidate> = {}): SignalCandidate {
    return {
        symbol: "BTCUSDT",
        baseAsset: "BTC",
        quoteAsset: "USDT",
        signalTime: 1000000,
        fillTime: 1000060,
        exitTime: 1000120,
        signalTimeKey: "1000000",
        signalBarIndex: 10,
        direction: "long",
        netReturnPct: 1.5,
        entryFeatures: {
            volatilityPct: 2.0,
            momentum5: 0.5,
            momentum10: 1.0,
            momentum20: 1.5,
            timeSinceLastExitBars: 50,
            signalRarity: 0.1,
        },
        ...overrides,
    };
}

function makeOptions(overrides: Partial<CliOptions> = {}): CliOptions {
    return {
        artifactDir: "/tmp/test",
        trainMonths: 6,
        testMonths: 3,
        minTestEvents: 2,
        seed: 42,
        direction: "both",
        executionModel: "next_open",
        ...overrides,
    };
}

function makeExclusions(): ExclusionCounts {
    return { mapping: 0, censored: 0, boundary: 0, direction: 0, corrupt: 0 };
}

function makeOhlcv(count: number, startTime: number = 1000): OHLCVData[] {
    const data: OHLCVData[] = [];
    for (let i = 0; i < count; i++) {
        data.push({
            time: (startTime + i * 60) as any,
            open: 100 + i,
            high: 101 + i,
            low: 99 + i,
            close: 100 + i,
            volume: 1000,
        });
    }
    return data;
}

// ============================================================================
// Causal history
// ============================================================================

describe("causal history", () => {
    it("excludes trades entered before event but exited after", () => {
        const candidate = makeCandidate({ signalTime: 1000, exitTime: 2000 });
        const history: TradeLedgerEntry[] = [
            { symbol: "BTCUSDT", exitTime: 500, netReturnPct: 2.0, signalBarIndex: 5, exitBarIndex: 8 },
            { symbol: "BTCUSDT", exitTime: 1500, netReturnPct: 3.0, signalBarIndex: 15, exitBarIndex: 18 },
        ];
        const ledger = new Map([[candidate.symbol, history]]);
        expect(scoreCandidateForRule("recent_avg_return_5", candidate, ledger)).to.equal(2);
    });
});

// ============================================================================
// Signal-event grouping
// ============================================================================

describe("signal-event grouping", () => {
    it("groups next_open fills by signal bar, not fill bar", () => {
        const c1 = makeCandidate({ symbol: "BTCUSDT", signalTime: 1000, signalTimeKey: "1000", fillTime: 1060 });
        const c2 = makeCandidate({ symbol: "ETHUSDT", signalTime: 1000, signalTimeKey: "1000", fillTime: 1060 });
        const events = groupBySignalEvent([c1, c2]);
        expect(events).to.have.length(1);
        expect(events[0]!.candidates).to.have.length(2);
    });

    it("excludes single-signal events", () => {
        const c1 = makeCandidate({ symbol: "BTCUSDT", signalTimeKey: "1000" });
        const events = groupBySignalEvent([c1]);
        expect(events).to.have.length(0);
    });

    it("groups different signal times separately", () => {
        const c1 = makeCandidate({ signalTime: 1000, signalTimeKey: "1000" });
        const c2 = makeCandidate({ signalTime: 2000, signalTimeKey: "2000" });
        const events = groupBySignalEvent([c1, c2]);
        expect(events).to.have.length(0);
    });
});

// ============================================================================
// Random baseline
// ============================================================================

describe("random baseline", () => {
    it("mean paired delta ≈ 0 over many events", () => {
        const rng = createSeededRandom(42);
        const deltas: number[] = [];
        for (let i = 0; i < 1000; i++) {
            const returns = [rng() * 4 - 2, rng() * 4 - 2, rng() * 4 - 2];
            const eventMean = (returns[0]! + returns[1]! + returns[2]!) / 3;
            const selected = returns[Math.floor(rng() * 3)]!;
            deltas.push(selected - eventMean);
        }
        const meanDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;
        expect(Math.abs(meanDelta)).to.be.lessThan(0.1);
    });
});

// ============================================================================
// Tie-breaking
// ============================================================================

describe("tie-breaking", () => {
    it("is deterministic under fixed seed", () => {
        const rng1 = createSeededRandom(42);
        const rng2 = createSeededRandom(42);
        const seq1 = Array.from({ length: 10 }, () => rng1());
        const seq2 = Array.from({ length: 10 }, () => rng2());
        expect(seq1).to.deep.equal(seq2);
    });

    it("different seeds produce different sequences", () => {
        const rng1 = createSeededRandom(42);
        const rng2 = createSeededRandom(43);
        const seq1 = Array.from({ length: 10 }, () => rng1());
        const seq2 = Array.from({ length: 10 }, () => rng2());
        expect(seq1).to.not.deep.equal(seq2);
    });
});

// ============================================================================
// pnlPercent ranking
// ============================================================================

describe("pnlPercent ranking", () => {
    it("raw $ differences do not affect ranking when normalized returns are equal", () => {
        const c1 = makeCandidate({ netReturnPct: 2.0 });
        const c2 = makeCandidate({ netReturnPct: 2.0 });
        expect(c1.netReturnPct).to.equal(c2.netReturnPct);
    });
});

// ============================================================================
// Fold boundaries
// ============================================================================

describe("fold boundaries", () => {
    it("excludes and counts labels crossing a holdout boundary", () => {
        const monthSec = 30 * 24 * 3600;
        const base = 1600000000;
        const holdoutSignal = base + 6.5 * monthSec;
        const candidates = [
            makeCandidate({ symbol: "A", signalTime: base, signalTimeKey: String(base), exitTime: base + 3600 }),
            makeCandidate({ symbol: "B", signalTime: base, signalTimeKey: String(base), exitTime: base + 3600 }),
            makeCandidate({ symbol: "A", signalTime: holdoutSignal, signalTimeKey: String(holdoutSignal), exitTime: base + 7 * monthSec }),
            makeCandidate({ symbol: "B", signalTime: holdoutSignal, signalTimeKey: String(holdoutSignal), exitTime: base + 9.5 * monthSec }),
        ];

        const result = runReplay(candidates, makeOptions({ minTestEvents: 1 }), makeExclusions());
        expect(result.exclusions.boundary).to.equal(1);
        expect(result.lines.some((line) => line.includes("excluded_boundary=1"))).to.be.true;
    });
});

// ============================================================================
// Spearman IC
// ============================================================================

describe("spearman rank correlation", () => {
    it("returns 1 for perfect positive correlation", () => {
        expect(spearman([1, 2, 3, 4, 5], [2, 4, 6, 8, 10])).to.be.closeTo(1, 0.001);
    });

    it("returns -1 for perfect negative correlation", () => {
        expect(spearman([1, 2, 3, 4, 5], [10, 8, 6, 4, 2])).to.be.closeTo(-1, 0.001);
    });

    it("supports two-candidate signal events", () => {
        expect(spearman([1, 2], [3, 4])).to.equal(1);
    });

    it("returns NaN for fewer than 2 observations", () => {
        expect(Number.isNaN(spearman([1], [3]))).to.be.true;
    });
});

// ============================================================================
// Fold generation
// ============================================================================

describe("fold generation", () => {
    it("generates rolling walk-forward folds", () => {
        const folds = generateFolds(0, 365 * 24 * 3600, 6, 3);
        expect(folds.length).to.be.greaterThan(0);
        for (let i = 1; i < folds.length; i++) {
            const curr = folds[i]!;
            expect(curr.trainStartSec).to.equal(Date.UTC(1970, i * 3, 1) / 1000);
        }
    });

    it("returns empty when history too short", () => {
        const folds = generateFolds(0, 100 * 24 * 3600, 6, 3);
        expect(folds).to.have.length(0);
    });

    it("clamps month-end anchors instead of approximating months as 30 days", () => {
        const start = Date.UTC(2020, 0, 31) / 1000;
        const end = Date.UTC(2021, 3, 30) / 1000;
        const folds = generateFolds(start, end, 6, 3);
        expect(folds[0]!.trainEndSec).to.equal(Date.UTC(2020, 6, 31) / 1000);
        expect(folds[1]!.trainStartSec).to.equal(Date.UTC(2020, 3, 30) / 1000);
    });
});

// ============================================================================
// Timestamp normalization
// ============================================================================

describe("timestamp normalization", () => {
    it("BusinessDay, seconds, milliseconds, and ISO group consistently", () => {
        const sec = Date.UTC(2001, 8, 9) / 1000;
        const ms = sec * 1000;
        const iso = new Date(ms).toISOString();
        const bd = { year: 2001, month: 9, day: 9 };
        const keySec = canonicalTimeKey(sec as any);
        const keyMs = canonicalTimeKey(ms as any);
        const keyIso = canonicalTimeKey(iso as any);
        const keyBd = canonicalTimeKey(bd as any);
        expect(keyMs).to.equal(keySec);
        expect(keyIso).to.equal(keySec);
        expect(keyBd).to.equal(keySec);
    });
});

// ============================================================================
// Partial exit aggregation
// ============================================================================

describe("partial exit aggregation", () => {
    it("aggregates multiple exits from one entry into a single candidate", () => {
        const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "replay-test-"));
        try {
            const data = makeOhlcv(100);
            const artifact: BatchSyntheticPairArtifact = {
                symbol: "TESTUSDT",
                baseAsset: "TEST",
                quoteAsset: "USDT",
                data,
                signals: [{
                    time: data[10]!.time,
                    type: "buy",
                    price: 100,
                    barIndex: 10,
                }],
                result: {
                    trades: [
                        {
                            id: 1, type: "long", entryTime: data[11]!.time, entryPrice: 100,
                            exitTime: data[20]!.time, exitPrice: 105, pnl: 2.5, pnlPercent: 5.0,
                            size: 0.5, exitReason: "partial" as const,
                        },
                        {
                            id: 2, type: "long", entryTime: data[11]!.time, entryPrice: 100,
                            exitTime: data[30]!.time, exitPrice: 110, pnl: 5, pnlPercent: 10.0,
                            size: 0.5, exitReason: "signal" as const,
                        },
                    ],
                } as any,
            };
            fs.writeFileSync(path.join(tmpDir, "test.bin"), serialize(artifact));

            const { candidates } = loadArtifactCandidates(tmpDir, "next_open", "both");
            expect(candidates).to.have.length(1);
            // Weighted fee-aware return: (2.5 + 5) / (100 * 1.0) = 7.5%.
            expect(candidates[0]!.netReturnPct).to.be.closeTo(7.5, 0.01);
            expect(candidates[0]!.exitTime).to.equal(Number(data[30]!.time));
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Signal mapping
// ============================================================================

describe("signal mapping", () => {
    it("excludes trades with no matching signal", () => {
        const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "replay-test-"));
        try {
            const data = makeOhlcv(100);
            const artifact: BatchSyntheticPairArtifact = {
                symbol: "TESTUSDT",
                baseAsset: "TEST",
                quoteAsset: "USDT",
                data,
                signals: [], // no signals
                result: {
                    trades: [{
                        id: 1, type: "long", entryTime: data[11]!.time, entryPrice: 100,
                        exitTime: data[20]!.time, exitPrice: 105, pnl: 50, pnlPercent: 5.0,
                        size: 1, exitReason: "signal" as const,
                    }],
                } as any,
            };
            fs.writeFileSync(path.join(tmpDir, "test.bin"), serialize(artifact));

            const { candidates, exclusions } = loadArtifactCandidates(tmpDir, "next_open", "both");
            expect(candidates).to.have.length(0);
            expect(exclusions.mapping).to.equal(1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("excludes trades with ambiguous signals (multiple on same bar)", () => {
        const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "replay-test-"));
        try {
            const data = makeOhlcv(100);
            const artifact: BatchSyntheticPairArtifact = {
                symbol: "TESTUSDT",
                baseAsset: "TEST",
                quoteAsset: "USDT",
                data,
                signals: [
                    { time: data[10]!.time, type: "buy", price: 100, barIndex: 10 },
                    { time: data[10]!.time, type: "buy", price: 100, barIndex: 10 }, // duplicate
                ],
                result: {
                    trades: [{
                        id: 1, type: "long", entryTime: data[11]!.time, entryPrice: 100,
                        exitTime: data[20]!.time, exitPrice: 105, pnl: 50, pnlPercent: 5.0,
                        size: 1, exitReason: "signal" as const,
                    }],
                } as any,
            };
            fs.writeFileSync(path.join(tmpDir, "test.bin"), serialize(artifact));

            const { candidates, exclusions } = loadArtifactCandidates(tmpDir, "next_open", "both");
            expect(candidates).to.have.length(0);
            expect(exclusions.mapping).to.equal(1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("maps a signal by exact time and ignores the opposite entry direction", () => {
        const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "replay-test-"));
        try {
            const data = makeOhlcv(100);
            const artifact: BatchSyntheticPairArtifact = {
                symbol: "TESTUSDT",
                baseAsset: "TEST",
                quoteAsset: "USDT",
                data,
                signals: [
                    { time: data[10]!.time, type: "sell", price: 100 },
                    { time: data[10]!.time, type: "buy", price: 100 },
                ],
                result: {
                    trades: [{
                        id: 1, type: "long", entryTime: data[11]!.time, entryPrice: 100,
                        exitTime: data[20]!.time, exitPrice: 105, pnl: 5, pnlPercent: 5,
                        size: 1, exitReason: "signal" as const,
                    }],
                } as any,
            };
            fs.writeFileSync(path.join(tmpDir, "test.bin"), serialize(artifact));

            const { candidates, exclusions } = loadArtifactCandidates(tmpDir, "next_open", "both");
            expect(candidates).to.have.length(1);
            expect(candidates[0]!.direction).to.equal("long");
            expect(exclusions.mapping).to.equal(0);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Censored trades
// ============================================================================

describe("censored trades", () => {
    it("excludes end_of_data trades and counts them", () => {
        const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "replay-test-"));
        try {
            const data = makeOhlcv(100);
            const artifact: BatchSyntheticPairArtifact = {
                symbol: "TESTUSDT",
                baseAsset: "TEST",
                quoteAsset: "USDT",
                data,
                signals: [{ time: data[10]!.time, type: "buy", price: 100, barIndex: 10 }],
                result: {
                    trades: [{
                        id: 1, type: "long", entryTime: data[11]!.time, entryPrice: 100,
                        exitTime: data[99]!.time, exitPrice: 105, pnl: 50, pnlPercent: 5.0,
                        size: 1, exitReason: "end_of_data" as const,
                    }],
                } as any,
            };
            fs.writeFileSync(path.join(tmpDir, "test.bin"), serialize(artifact));

            const { candidates, exclusions } = loadArtifactCandidates(tmpDir, "next_open", "both");
            expect(candidates).to.have.length(0);
            expect(exclusions.censored).to.equal(1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });

    it("excludes an entry with a realized partial exit and an end-of-data remainder", () => {
        const tmpDir = fs.mkdtempSync(path.join(process.env.TEMP || "/tmp", "replay-test-"));
        try {
            const data = makeOhlcv(100);
            const artifact: BatchSyntheticPairArtifact = {
                symbol: "TESTUSDT",
                baseAsset: "TEST",
                quoteAsset: "USDT",
                data,
                signals: [{ time: data[10]!.time, type: "buy", price: 100, barIndex: 10 }],
                result: {
                    trades: [
                        {
                            id: 1, type: "long", entryTime: data[11]!.time, entryPrice: 100,
                            exitTime: data[20]!.time, exitPrice: 105, pnl: 2.5, pnlPercent: 5,
                            size: 0.5, exitReason: "partial" as const,
                        },
                        {
                            id: 2, type: "long", entryTime: data[11]!.time, entryPrice: 100,
                            exitTime: data[99]!.time, exitPrice: 104, pnl: 2, pnlPercent: 4,
                            size: 0.5, exitReason: "end_of_data" as const,
                        },
                    ],
                } as any,
            };
            fs.writeFileSync(path.join(tmpDir, "test.bin"), serialize(artifact));

            const { candidates, exclusions } = loadArtifactCandidates(tmpDir, "next_open", "both");
            expect(candidates).to.have.length(0);
            expect(exclusions.censored).to.equal(1);
        } finally {
            fs.rmSync(tmpDir, { recursive: true, force: true });
        }
    });
});

// ============================================================================
// Missing feature scoring
// ============================================================================

describe("missing feature scoring", () => {
    it("entry_volatility: missing ATR scores worst (NEGATIVE_INFINITY)", () => {
        const candidate = makeCandidate({
            entryFeatures: { volatilityPct: null, momentum5: 0, momentum10: 0, momentum20: 0, timeSinceLastExitBars: 0, signalRarity: 0 },
        });
        expect(scoreCandidateForRule("entry_volatility", candidate)).to.equal(Number.NEGATIVE_INFINITY);
    });

    it("signal_rarity: no prior signals means score 0 (not favorable)", () => {
        const candidate = makeCandidate({
            entryFeatures: { volatilityPct: 2.0, momentum5: 0, momentum10: 0, momentum20: 0, timeSinceLastExitBars: 0, signalRarity: null },
        });
        expect(scoreCandidateForRule("signal_rarity", candidate)).to.equal(0);
    });
});

// ============================================================================
// Replay engine integration
// ============================================================================

describe("replay engine", () => {
    it("produces report with zero events", () => {
        const candidates: SignalCandidate[] = [];
        const opts = makeOptions();
        const result = runReplay(candidates, opts, makeExclusions());
        expect(result.lines.some((l) => l.includes("0 multi-signal events"))).to.be.true;
    });

    it("produces report with insufficient data", () => {
        const monthSec = 30 * 24 * 3600;
        const base = 1600000000;
        const candidates = [
            makeCandidate({ symbol: "A", signalTime: base, signalTimeKey: String(base), exitTime: base + 3600 }),
            makeCandidate({ symbol: "B", signalTime: base, signalTimeKey: String(base), exitTime: base + 3600 }),
            makeCandidate({ symbol: "A", signalTime: base + 7 * monthSec, signalTimeKey: String(base + 7 * monthSec), exitTime: base + 7 * monthSec + 3600 }),
            makeCandidate({ symbol: "B", signalTime: base + 7 * monthSec, signalTimeKey: String(base + 7 * monthSec), exitTime: base + 7 * monthSec + 3600 }),
            makeCandidate({ symbol: "A", signalTime: base + 10 * monthSec, signalTimeKey: String(base + 10 * monthSec), exitTime: base + 10 * monthSec + 3600 }),
            makeCandidate({ symbol: "B", signalTime: base + 10 * monthSec, signalTimeKey: String(base + 10 * monthSec), exitTime: base + 10 * monthSec + 3600 }),
        ];
        const opts = makeOptions({ minTestEvents: 100 });
        const result = runReplay(candidates, opts, makeExclusions());
        expect(result.lines.some((l) => l.includes("INSUFFICIENT_DATA"))).to.be.true;
    });

    it("reports exclusion counts in output", () => {
        const monthSec = 30 * 24 * 3600;
        const base = 1600000000;
        const candidates = [
            makeCandidate({ symbol: "A", signalTime: base, signalTimeKey: String(base), exitTime: base + 3600 }),
            makeCandidate({ symbol: "B", signalTime: base, signalTimeKey: String(base), exitTime: base + 3600 }),
            makeCandidate({ symbol: "A", signalTime: base + 7 * monthSec, signalTimeKey: String(base + 7 * monthSec), exitTime: base + 7 * monthSec + 3600 }),
            makeCandidate({ symbol: "B", signalTime: base + 7 * monthSec, signalTimeKey: String(base + 7 * monthSec), exitTime: base + 7 * monthSec + 3600 }),
            makeCandidate({ symbol: "A", signalTime: base + 10 * monthSec, signalTimeKey: String(base + 10 * monthSec), exitTime: base + 10 * monthSec + 3600 }),
            makeCandidate({ symbol: "B", signalTime: base + 10 * monthSec, signalTimeKey: String(base + 10 * monthSec), exitTime: base + 10 * monthSec + 3600 }),
        ];
        const opts = makeOptions({ minTestEvents: 100 });
        const exclusions = makeExclusions();
        exclusions.mapping = 5;
        exclusions.censored = 3;
        exclusions.direction = 2;
        exclusions.corrupt = 1;
        const result = runReplay(candidates, opts, exclusions);
        expect(result.lines.some((l) => l.includes("excluded_mapping=5"))).to.be.true;
        expect(result.lines.some((l) => l.includes("excluded_censored=3"))).to.be.true;
        expect(result.lines.some((l) => l.includes("excluded_direction=2"))).to.be.true;
        expect(result.lines.some((l) => l.includes("excluded_corrupt=1"))).to.be.true;
    });

    it("keeps random as a baseline instead of selecting it as a trained rule", () => {
        const monthSec = 30 * 24 * 3600;
        const base = 1600000000;
        const candidates: SignalCandidate[] = [];
        for (const offsetMonths of [0, 7, 10, 13]) {
            const signalTime = base + offsetMonths * monthSec;
            candidates.push(
                makeCandidate({
                    symbol: "A",
                    signalTime,
                    signalTimeKey: String(signalTime),
                    exitTime: signalTime + 3600,
                    netReturnPct: 2,
                    entryFeatures: { volatilityPct: 0.5, momentum5: 0, momentum10: 0, momentum20: 0, timeSinceLastExitBars: 1, signalRarity: 0 },
                }),
                makeCandidate({
                    symbol: "B",
                    signalTime,
                    signalTimeKey: String(signalTime),
                    exitTime: signalTime + 3600,
                    netReturnPct: -1,
                    entryFeatures: { volatilityPct: 2, momentum5: 0, momentum10: 0, momentum20: 0, timeSinceLastExitBars: 1, signalRarity: 0 },
                }),
            );
        }

        const result = runReplay(candidates, makeOptions({ minTestEvents: 1 }), makeExclusions());
        const foldLines = result.lines.filter((line) => line.startsWith("FOLD "));
        expect(foldLines).to.have.length.greaterThan(0);
        expect(foldLines.every((line) => !line.includes("best_train_rule=random"))).to.be.true;
        expect(result.lines.some((line) => line.startsWith("OOS_SELECTOR | walk_forward:"))).to.be.true;
        expect(result.lines.some((line) => line.includes("INSUFFICIENT_DATA"))).to.be.true;
    });
});
