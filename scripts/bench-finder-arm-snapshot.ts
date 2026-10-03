/** Replay a saved /api/finder/status snapshot in an isolated CLI job. Never controls the live server. */
import { readFileSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { runFinderArmPerformance } from "../lib/finder/finder-arm-performance-runner";
import { enumerateSp500Pairs } from "../lib/batch-backtest/sp500-pair-enumerator";
import { loadBuiltInStrategyByKey } from "../strategyRegistry";
import type { FinderRunStatusSnapshot } from "../lib/finder/server/finder-stream-types";
import type { FinderArmPerformanceCandidateDiagnostic } from "../lib/finder/finder-arm-performance-diagnostics";

async function main() {
    const [snapshotPath, label, baselinePath] = process.argv.slice(2);
    if (!snapshotPath || !label || !/^[a-zA-Z0-9_-]+$/.test(label)) throw new Error("Usage: esno scripts/bench-finder-arm-snapshot.ts <status.json> <label> [baseline.json]");
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as FinderRunStatusSnapshot;
    const context = snapshot.armPerformanceRunContext;
    const rows = snapshot.terminalArmPerformanceResults;
    if (!snapshot.terminal || snapshot.phase !== "done" || !context || !rows?.length) throw new Error("Snapshot must contain a completed Arm run and its frozen context.");
    if (context.searchOptions.exitStrategyOverrideEnabled || rows.some((row) => row.exitStrategyKey)) {
        throw new Error("Snapshot benchmark currently supports runs without exit overrides.");
    }
    const selectedStrategies = await Promise.all(context.strategyKeys.map(async (key) => {
        const strategy = await loadBuiltInStrategyByKey(key);
        if (!strategy) throw new Error(`Strategy missing: ${key}`);
        return { key, name: strategy.name, strategy };
    }));
    const enumeration = enumerateSp500Pairs({ interval: context.interval, pairListText: context.pairs.join("\n"), maxPairs: context.pairs.length });
    if (enumeration.canonicalPairs.length !== context.pairs.length) throw new Error(`Pair inventory changed: ${enumeration.canonicalPairs.length}/${context.pairs.length}; skipped=${enumeration.skippedPairTokens.slice(0, 3)}; rejected=${enumeration.rejectedPairTokens.slice(0, 3)}`);
    const diagnostics: FinderArmPerformanceCandidateDiagnostic[] = [];
    let phase = "";
    const started = performance.now();
    const results = await runFinderArmPerformance({
        runId: `bench-${label}-${Date.now()}`, interval: context.interval, options: context.searchOptions,
        settings: context.backtestSettings, capitalSettings: context.capitalSettings,
        useRustEnginePreference: context.requestedEngineMode === "rust", evaluationCutoffSec: context.evaluationCutoffSec,
        sampleFromSec: context.sampleFromSec, sampleToSec: context.sampleToSec,
        enumeration, selectedStrategies, exitStrategyCandidates: [], baseDir: process.cwd(),
        signal: new AbortController().signal, isCancelled: () => false, enableWorkerReuse: true,
        plans: rows.map((row) => ({
            strategyKey: row.strategyKey, strategyName: row.strategyName, candidateOrdinal: row.candidateOrdinal,
            params: row.params,
            ...(row.exitStrategyKey ? { exitStrategyKey: row.exitStrategyKey, exitStrategyParams: row.exitStrategyParams } : {}),
        })),
    }, {
        onProgress: (progress) => {
            if (progress.childPhase !== phase) { phase = progress.childPhase; console.log(`[bench] ${phase} at ${Math.round(performance.now() - started)}ms`); }
        },
        onCandidate: () => {},
        onCandidateDiagnostic: (diagnostic) => { diagnostics.push(diagnostic); },
        setActiveCoordinator: () => {},
    });
    const comparable = (items: typeof results) => items.map(({ candidateId: _id, ...row }) => row);
    const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value, (_key, item) =>
        item && typeof item === "object" && !Array.isArray(item)
            ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item)).digest("hex");
    const output = { wallMs: performance.now() - started, resultHash: hash(comparable(results)),
        capturedResultHash: hash(comparable(rows)), diagnostics, results };
    const directory = resolve("artifacts/arm-replay-eff-bench");
    mkdirSync(directory, { recursive: true });
    const destination = resolve(directory, `${label}.json`);
    writeFileSync(destination, JSON.stringify(output, null, 2));
    const matchesBaseline = baselinePath ? output.resultHash === hash(comparable(JSON.parse(readFileSync(baselinePath, "utf8")).results)) : undefined;
    console.log(JSON.stringify({ wallMs: output.wallMs, resultHash: output.resultHash,
        matchesCapturedRun: output.resultHash === output.capturedResultHash, matchesBaseline, destination }));
    if (matchesBaseline === false || output.resultHash !== output.capturedResultHash) process.exitCode = 1;
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
