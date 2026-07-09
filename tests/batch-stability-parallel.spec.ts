import { expect } from "chai";
import { describe, it } from "node:test";
import {
    mergeStabilityAccumulators,
    partitionRerunRange,
    resolveStabilityWorkerCount,
    runParallelStability,
} from "../lib/batch-backtest/batch-stability-parallel";
import { runStabilityRerunRange } from "../lib/batch-backtest/batch-stability-worker";
import { finalizeStabilityAggregate } from "../lib/batch-backtest/batch-stability-mine";
import type { BatchSyntheticPairArtifact } from "../lib/batch-backtest/batch-synthetic-state-miner";
import type { BatchStabilityMineResult } from "../lib/batch-backtest/batch-stability-mine";
import type { BacktestResult, OHLCVData, Signal, Time } from "../lib/types/strategies";
import { writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serialize } from "node:v8";

/**
 * Phase 3 parallel-Stability parity tests.
 *
 * Intent being locked (per AGENTS.md rule 8 + plan §"Phase 3 Exit Criteria"):
 * parallel and sequential outputs MUST match for a fixed seed. The
 * acceleration is worthless if it ever changes a verdict, a hit count, a
 * median, or a Jaccard diversity score. These tests run the SAME rerun set as
 * (a) one sequential range and (b) two parallel ranges, merge the parallel
 * partials, and assert the finalized results are deep-equal. If the merge ever
 * reorders a contributing array or double-counts a hit, the deep-equal fails.
 */

function makeCandles(length: number, seed: number): OHLCVData[] {
    return Array.from({ length }, (_, i) => {
        // Deterministic pseudo-random walk so signals produce varied states.
        const close = 100 + Math.sin((i + seed) * 0.3) * 5 + (i * 0.05);
        return {
            time: (1_700_000_000_000 + i * 300_000) as Time,
            open: close,
            high: close + 0.5,
            low: close - 0.5,
            close,
            volume: 1000,
        };
    });
}

function makeResult(): BacktestResult {
    return {
        trades: [], netProfit: 0, netProfitPercent: 0, winRate: 0, expectancy: 0,
        avgTrade: 0, profitFactor: 0, maxDrawdown: 0, maxDrawdownPercent: 0,
        totalTrades: 0, winningTrades: 0, losingTrades: 0, avgWin: 0, avgLoss: 0,
        sharpeRatio: 0, equityCurve: [],
    };
}

function buildFixtures(): {
    artifactFiles: string[];
    targets: { asset: string; symbol: string; data: OHLCVData[] }[];
    cleanup: () => void;
} {
    const dir = mkdtempSync(join(tmpdir(), "stability-parity-"));
    const mkPair = (sym: string, base: string, quote: string, seed: number): BatchSyntheticPairArtifact => {
        const data = makeCandles(120, seed);
        const signals: Signal[] = [];
        for (let i = 10; i < 110; i += 4) {
            signals.push({ time: data[i]!.time, type: "buy", price: data[i]!.close, barIndex: i });
        }
        return { symbol: sym, baseAsset: base, quoteAsset: quote, data, signals, result: makeResult() };
    };
    const pairs = [
        mkPair("BTC+ETH", "BTC", "ETH", 1),
        mkPair("BTC+SOL", "BTC", "SOL", 2),
        mkPair("ETH+SOL", "ETH", "SOL", 3),
        mkPair("BTC+AVAX", "BTC", "AVAX", 4),
    ];
    const artifactFiles: string[] = [];
    pairs.forEach((pair, index) => {
        // Write the raw shape the server plugin stores on disk (v8-serialized).
        const file = join(dir, `${String(index).padStart(6, "0")}.bin`);
        writeFileSync(file, serialize(pair));
        artifactFiles.push(file);
    });
    const targets = [
        { asset: "BTC", symbol: "BTCUSDT", data: makeCandles(120, 11) },
        { asset: "ETH", symbol: "ETHUSDT", data: makeCandles(120, 12) },
        { asset: "SOL", symbol: "SOLUSDT", data: makeCandles(120, 13) },
    ];
    return { artifactFiles, targets, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

describe("batch stability parallel partition + merge", () => {
    it("partitionRerunRange covers [0, total) exactly with no gaps or overlaps", () => {
        const ranges = partitionRerunRange(50, 4);
        expect(ranges.length).to.equal(4);
        // Contiguous, no overlap, full coverage.
        expect(ranges[0]!.start).to.equal(0);
        expect(ranges[ranges.length - 1]!.end).to.equal(50);
        for (let i = 1; i < ranges.length; i += 1) {
            expect(ranges[i]!.start).to.equal(ranges[i - 1]!.end);
        }
        // Total reruns summed across ranges equals the input total.
        const sum = ranges.reduce((acc, r) => acc + (r.end - r.start), 0);
        expect(sum).to.equal(50);
    });

    it("partitionRerunRange is deterministic for the same inputs (order-stable)", () => {
        const a = partitionRerunRange(13, 3);
        const b = partitionRerunRange(13, 3);
        expect(a).to.deep.equal(b);
    });

    it("resolveStabilityWorkerCount clamps to [2, 8]", () => {
        const n = resolveStabilityWorkerCount();
        expect(n).to.be.at.least(2);
        expect(n).to.be.at.most(8);
        // Explicit override is respected.
        expect(resolveStabilityWorkerCount(1)).to.equal(1);
    });

    it("runParallelStability fails fast when already cancelled", async () => {
        const outcome = await runParallelStability({
            artifactFiles: ["unused.bin"],
            targets: [],
            interval: "5m",
            subsetSize: 1,
            reruns: 2,
            seed: 1,
            workerCount: 2,
            isCancelled: () => true,
        });
        expect(outcome.ok).to.equal(false);
        if (outcome.ok) throw new Error("unreachable");
        expect(outcome.reason).to.equal("worker_error");
        expect(outcome.message).to.equal("cancelled");
    });
});

describe("batch stability parallel vs sequential parity", () => {
    it("merged parallel partials deep-equal the single-range sequential run for fixed seed", () => {
        const fixtures = buildFixtures();
        try {
            const reruns = 8;
            const subsetSize = 3;
            const seed = 7;

            // Sequential reference: one range [0, reruns).
            const sequentialRange = runStabilityRerunRange({
                artifactFiles: fixtures.artifactFiles,
                targets: fixtures.targets,
                interval: "5m",
                subsetSize,
                startRerun: 0,
                endRerun: reruns,
                seed,
                totalPairs: fixtures.artifactFiles.length,
            });

            // Parallel: split [0, reruns) into two contiguous ranges, run each,
            // then merge in ascending rerun-order.
            const ranges = partitionRerunRange(reruns, 2);
            const partials = ranges.map((range) =>
                runStabilityRerunRange({
                    artifactFiles: fixtures.artifactFiles,
                    targets: fixtures.targets,
                    interval: "5m",
                    subsetSize,
                    startRerun: range.start,
                    endRerun: range.end,
                    seed,
                    totalPairs: fixtures.artifactFiles.length,
                }),
            );
            const merged = mergeStabilityAccumulators(
                partials,
                reruns, subsetSize, seed,
                fixtures.artifactFiles.length,
                fixtures.targets.length,
            );

            const sequentialFinal: BatchStabilityMineResult = finalizeStabilityAggregate(sequentialRange.accumulator);
            const parallelFinal: BatchStabilityMineResult = finalizeStabilityAggregate(merged.accumulator);

            // The finalized results (rows + scoring) MUST be deep-equal. This
            // is the plan's Phase 3 exit criterion. Any divergence here means
            // the merge reordered a contributing array, dropped a hit, or
            // double-counted a pair-warning.
            expect(parallelFinal.rows).to.deep.equal(sequentialFinal.rows);
            expect(parallelFinal.hitEvents).to.equal(sequentialFinal.hitEvents);
            expect(parallelFinal.reruns).to.equal(sequentialFinal.reruns);
            expect(parallelFinal.subsetSize).to.equal(sequentialFinal.subsetSize);
        } finally {
            fixtures.cleanup();
        }
    });

    it("worker loads only the sampled artifact union when selected indexes are provided", () => {
        const fixtures = buildFixtures();
        try {
            // Corrupt an artifact that is intentionally NOT sampled. If the
            // worker regresses to loading the full universe, deserialize will
            // throw and the test fails. With selectedIndexesByRerun, only
            // indexes 0 and 1 are loaded.
            writeFileSync(fixtures.artifactFiles[3]!, Buffer.from("not a v8 serialized artifact"));
            const result = runStabilityRerunRange({
                artifactFiles: fixtures.artifactFiles,
                selectedIndexesByRerun: [[0, 1]],
                targets: fixtures.targets,
                interval: "5m",
                subsetSize: 2,
                startRerun: 0,
                endRerun: 1,
                seed: 123,
                totalPairs: fixtures.artifactFiles.length,
            });
            expect(result.rerunsExecuted).to.equal(1);
        } finally {
            fixtures.cleanup();
        }
    });
});

describe("batch stability parallel worker spawn (end-to-end)", () => {
    // Intent being locked: the parallel path MUST actually spawn real
    // worker_threads under the test runner, not just merge in-process. This
    // catches the failure mode where the worker entrypoint can't be loaded
    // (e.g. unbundled .ts under plain Node, or a broken esbuild bundle) — the
    // orchestrator would silently fall back to sequential every time and the
    // acceleration would be dead code. The esbuild bundling in
    // `resolveWorkerPath()` is what makes the worker loadable; this test
    // proves it.

    it("runParallelStability spawns workers and merges results matching the sequential reference", async () => {
        // Raw v8-serialized artifacts: matches the production on-disk shape.
        const fixtures = buildFixtures();
        try {
            const reruns = 6;
            const subsetSize = 3;
            const seed = 11;

            // Sequential reference (in-process).
            const sequential = runStabilityRerunRange({
                artifactFiles: fixtures.artifactFiles,
                targets: fixtures.targets,
                interval: "5m",
                subsetSize,
                startRerun: 0,
                endRerun: reruns,
                seed,
                totalPairs: fixtures.artifactFiles.length,
            });
            const sequentialFinal = finalizeStabilityAggregate(sequential.accumulator);

            // End-to-end parallel: spawns real workers via the esbuild-bundled .js.
            const outcome = await runParallelStability({
                artifactFiles: fixtures.artifactFiles,
                targets: fixtures.targets,
                interval: "5m",
                subsetSize,
                reruns,
                seed,
                workerCount: 3,
            });
            // The spawn MUST succeed. If this fails with reason "spawn_failed"
            // or "worker_error", the worker bundling/loading is broken and the
            // parallel path is dead code in production.
            expect(outcome.ok, `parallel spawn failed: ${outcome.ok ? "" : outcome.reason + " — " + outcome.message}`).to.equal(true);
            if (!outcome.ok) throw new Error("unreachable");

            const merged = mergeStabilityAccumulators(
                outcome.result,
                reruns, subsetSize, seed,
                fixtures.artifactFiles.length,
                fixtures.targets.length,
            );
            const parallelFinal = finalizeStabilityAggregate(merged.accumulator);

            // End-to-end parity: workers + merge must reproduce the sequential
            // reference exactly. This is the real Phase 3 exit criterion.
            expect(parallelFinal.rows).to.deep.equal(sequentialFinal.rows);
            expect(parallelFinal.hitEvents).to.equal(sequentialFinal.hitEvents);
            // Worker count is honored (3 workers for 6 reruns = 2 each).
            expect(outcome.workerCount).to.equal(3);
        } finally {
            fixtures.cleanup();
        }
    });
});
