/**
 * Trade-ledger scale benchmark (audit W7 — throwaway/manual tool, NOT a spec).
 *
 * Generates a synthetic ~2M-row ledger v2 folder (fake pairs, valid row shape
 * including asIf) and runs the offline checker over it once, reporting:
 *   - generation time + folder size
 *   - checker load (provenance/summary/ledger/ranks parse) duration
 *   - full replay + report duration
 *   - diagnostics.v1 (load/parse/ranks/prepare/replay/controls/memory/CPU)
 *
 * Usage:
 *   NODE_OPTIONS=--max-old-space-size=8192 ..\..\..\node_modules\.bin\esno scripts/bench-trade-ledger-scale.ts [rowsPerPair] [pairCount] [load_once|isolated_per_rule]
 *
 * Defaults: 4000 rows/pair x 500 pairs = 2,000,000 rows. The generated folder
 * lands in archive/trade-ledger-scale-bench (gitignored) — delete it after use.
 */

import { createWriteStream, statSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import path from "node:path";
import {
    TRADE_LEDGER_VERSION,
    type TradeLedgerRow,
} from "../lib/batch-backtest/trade-ledger-exporter";
import {
    buildCheckerReportLines,
    evaluateTradeLedgerRule,
    prepareTradeLedgerReplay,
    type LedgerRule,
} from "../lib/batch-backtest/trade-ledger-replay-core";
import { loadLedgerForReplay } from "../lib/batch-backtest/trade-ledger-replay-loader";
import { createEmptyLedgerSweepDiagnostics, type LedgerSweepMemorySample } from "../lib/batch-backtest/trade-ledger-sweep-diagnostics";
import { resolveLedgerSweepPreflight } from "../lib/batch-backtest/trade-ledger-sweep-preflight";
import { classifyTradeLedgerVerdict } from "../lib/batch-backtest/trade-ledger-verdict";

const REPO_ROOT = process.cwd();
const OUT_DIR = path.join(REPO_ROOT, "archive", "trade-ledger-scale-bench");

function synthRow(pair: string, i: number, pairIndex: number): TradeLedgerRow {
    const entry = 100 + i * 0.01;
    const exit = entry * (1 + ((i % 7) - 3) * 0.001);
    return {
        ledgerVersion: TRADE_LEDGER_VERSION,
        pair,
        direction: "long",
        signalTime: 1_600_000_000 + i * 3600 + pairIndex,
        signalBarIndex: i,
        fillTime: 1_600_000_000 + (i + 1) * 3600 + pairIndex,
        fillPrice: entry,
        executed: i % 8 === 0,
        notExecutedReason: i % 8 === 0 ? null : "position_open",
        feat_entryRangePosition: 50,
        feat_atrPct: 1 + (i % 5) * 0.1,
        feat_return20: 0.5,
        feat_gapPct: 0.01,
        feat_dow: 1,
        feat_hour: 12,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 0,
        feat_rank: null,
        feat_candidatesAtTime: null,
        asIf: {
            fillTime: 1_600_000_000 + (i + 1) * 3600 + pairIndex,
            fillPrice: entry,
            exitTime: 1_600_000_000 + (i + 2) * 3600 + pairIndex,
            exitPrice: exit,
            pnlPercent: ((exit - entry) / entry) * 100,
            barsHeld: 1,
            exitReason: "signal",
        },
        asIfReason: null,
        ...(i % 8 === 0
            ? { exitTime: 1_600_000_000 + (i + 2) * 3600 + pairIndex, exitPrice: exit, pnlPercent: ((exit - entry) / entry) * 100, fees: 0.01, exitReason: "signal" as const }
            : {}),
    };
}

async function generate(rowsPerPair: number, pairCount: number): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true });
    const ledgerPath = path.join(OUT_DIR, "ledger.jsonl");
    const ranksPath = path.join(OUT_DIR, "signal-ranks.jsonl");
    const started = Date.now();
    for (const [filePath, header] of [[ledgerPath, ""], [ranksPath, ""]] as const) {
        // truncate
        const ws = createWriteStream(filePath);
        await new Promise<void>((resolve) => ws.end(header, resolve));
    }
    for (let pairIndex = 0; pairIndex < pairCount; pairIndex += 1) {
        const pair = `SYN${String(pairIndex).padStart(4, "0")}+USD`;
        const ledgerWs = createWriteStream(ledgerPath, { flags: "a" });
        const ranksWs = createWriteStream(ranksPath, { flags: "a" });
        const ledgerChunks: string[] = [];
        const rankChunks: string[] = [];
        for (let i = 0; i < rowsPerPair; i += 1) {
            ledgerChunks.push(JSON.stringify(synthRow(pair, i, pairIndex)));
            // ranks: one entry per row (1 candidate at a time keeps the file small)
            rankChunks.push(JSON.stringify({ signalTime: 1_600_000_000 + i * 3600 + pairIndex, pair, rank: 1, candidatesAtTime: 1 }));
        }
        ledgerWs.end(ledgerChunks.join("\n") + "\n");
        ranksWs.end(rankChunks.join("\n") + "\n");
        await Promise.all([
            new Promise<void>((resolve, reject) => { ledgerWs.on("error", reject); ledgerWs.on("finish", resolve); }),
            new Promise<void>((resolve, reject) => { ranksWs.on("error", reject); ranksWs.on("finish", resolve); }),
        ]);
    }
    // summary + provenance (certified complete)
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(OUT_DIR, "provenance.json"), JSON.stringify({
        ledgerVersion: TRADE_LEDGER_VERSION, featureVersion: 2, runId: "bench", startedAt: new Date().toISOString(),
        interval: "4h", strategyKey: "bench", strategyParams: {}, backtestSettings: {}, capitalSettings: {},
        engineMode: "typescript", executionModel: "next_open", tradeDirection: "long", riskMode: "percentage",
        fees: { commissionPercent: 0, slippageBps: 0 }, pairCount, symbols: [], replay: {
            replayEligible: true, replayBlockers: [], maxOpenTrades: 1, cooldownBars: 0,
            executionModel: "next_open", tradeDirection: "long", allowSameBarExit: false,
            disableSignalExits: true, slippageRate: 0, commissionRate: 0,
        },
    }));
    await writeFile(path.join(OUT_DIR, "summary.json"), JSON.stringify({
        ledgerVersion: TRADE_LEDGER_VERSION, featureVersion: 2, runId: "bench",
        startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(),
        cancelled: false, ledgerComplete: true, failedWrites: 0, lastError: null,
        totals: { pairs: pairCount, signals: rowsPerPair * pairCount, executed: 0, notExecuted: 0 },
        suppressionRate: 0, rightCensored: 0, duplicateSignalsCollapsed: 0,
        submittedPairs: pairCount, loadedPairs: pairCount, rowBearingPairs: pairCount,
        emptyPairs: 0, failedPairs: [],
        perPairSuppression: [], topSuppressedPairs: [],
    }));
    const bytes = statSync(ledgerPath).size + statSync(ranksPath).size;
    console.log(`generated ${pairCount * rowsPerPair} rows for ${pairCount} pairs in ${((Date.now() - started) / 1000).toFixed(1)}s (${(bytes / 1024 / 1024).toFixed(1)} MB on disk)`);
}

async function main(): Promise<void> {
    const rowsPerPair = Math.max(1, Math.floor(Number(process.argv[2] ?? 4000)));
    const pairCount = Math.max(1, Math.floor(Number(process.argv[3] ?? 500)));
    const requestedMode = process.argv[4] ?? "load_once";
    if (requestedMode !== "load_once" && requestedMode !== "isolated_per_rule") {
        throw new Error("mode must be load_once or isolated_per_rule");
    }
    await generate(rowsPerPair, pairCount);

    const rowCount = rowsPerPair * pairCount;
    const preflight = resolveLedgerSweepPreflight(rowCount);
    const diagnostics = createEmptyLedgerSweepDiagnostics({
        runId: "bench",
        mode: requestedMode,
        preflight: { ...preflight, decision: requestedMode },
        input: { rowsPerPair, pairCount, requestedMode },
    });
    const cpuStarted = process.resourceUsage();
    const eventLoopStarted = performance.eventLoopUtilization();
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelay.enable();
    const memorySamples: LedgerSweepMemorySample[] = [];
    const sampleMemory = (phase: LedgerSweepMemorySample["phase"]): void => {
        const memory = process.memoryUsage();
        const resource = process.resourceUsage();
        const maxRss = resource.maxRSS * 1024;
        memorySamples.push({ at: Date.now(), source: "controller", phase, ruleId: null, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, rss: memory.rss, external: memory.external, arrayBuffers: memory.arrayBuffers, maxRss: Math.max(memory.rss, maxRss) });
    };
    const phaseStartedAt = Date.now();
    const sampler = setInterval(() => {
        sampleMemory("rule_replay");
    }, 100);
    const totalStarted = Date.now();
    const loadStarted = Date.now();
    const loaded = await loadLedgerForReplay(OUT_DIR);
    const loadMs = Date.now() - loadStarted;
    const rule: LedgerRule = (row) => row.feat_atrPct !== null && row.feat_atrPct > 1.2;
    const prepareStarted = Date.now();
    const prepared = prepareTradeLedgerReplay({ rows: loaded.rows, joinedRankCount: loaded.joinedRankCount, replayParams: loaded.replayParams });
    const prepareMs = Date.now() - prepareStarted;
    const evaluated = evaluateTradeLedgerRule({
        folder: OUT_DIR,
        ruleName: "bench-rule",
        rows: loaded.rows,
        joinedRankCount: loaded.joinedRankCount,
        rule,
        replay: loaded.replayParams,
        prepared,
        controlRuns: 20,
    });
    const reportStarted = Date.now();
    const report = buildCheckerReportLines({
        folder: OUT_DIR,
        ruleName: "bench-rule",
        rows: loaded.rows,
        joinedRankCount: loaded.joinedRankCount,
        rule,
        replay: loaded.replayParams,
        prepared,
        controlRuns: 20,
    }, evaluated).join("\n");
    const reportFormatMs = Date.now() - reportStarted;
    const totalMs = Date.now() - totalStarted;
    clearInterval(sampler);
    sampleMemory("finalizing");
    const controllerPeak = memorySamples.reduce<LedgerSweepMemorySample | null>((peak, sample) => !peak || sample.maxRss > peak.maxRss ? sample : peak, null);
    const maxRss = process.resourceUsage().maxRSS * 1024;
    diagnostics.phases = [
        { phase: "loading_ledger", startedAt: phaseStartedAt, finishedAt: phaseStartedAt + loadMs, elapsedMs: loadMs },
        { phase: "preparing", startedAt: phaseStartedAt + loadMs, finishedAt: phaseStartedAt + loadMs + prepareMs, elapsedMs: prepareMs },
        { phase: "rule_replay", startedAt: phaseStartedAt + loadMs + prepareMs, finishedAt: phaseStartedAt + loadMs + prepareMs + evaluated.ruleReplayMs, elapsedMs: evaluated.ruleReplayMs },
        { phase: "random_controls", startedAt: phaseStartedAt + loadMs + prepareMs + evaluated.ruleReplayMs, finishedAt: phaseStartedAt + loadMs + prepareMs + evaluated.ruleReplayMs + evaluated.controlReplayMs, elapsedMs: evaluated.controlReplayMs },
        { phase: "writing_report", startedAt: phaseStartedAt + loadMs + prepareMs + evaluated.ruleReplayMs + evaluated.controlReplayMs, finishedAt: phaseStartedAt + loadMs + prepareMs + evaluated.ruleReplayMs + evaluated.controlReplayMs + reportFormatMs, elapsedMs: reportFormatMs },
    ];
    diagnostics.memory.samples = memorySamples;
    diagnostics.memory.controllerPeak = controllerPeak;
    const cpuFinished = process.resourceUsage();
    const eventLoop = performance.eventLoopUtilization(eventLoopStarted);
    diagnostics.cpu = [{ scope: "whole_job", userCpuMs: Math.max(0, (cpuFinished.userCPUTime - cpuStarted.userCPUTime) / 1000), systemCpuMs: Math.max(0, (cpuFinished.systemCPUTime - cpuStarted.systemCPUTime) / 1000), eventLoopUtilization: Number.isFinite(eventLoop.utilization) ? eventLoop.utilization : 0, eventLoopDelayP50Ms: eventLoopDelay.percentile(50) / 1e6, eventLoopDelayP99Ms: eventLoopDelay.percentile(99) / 1e6 }];
    eventLoopDelay.disable();
    diagnostics.perRule = [{
        ruleId: "bench-rule",
        ruleName: "bench-rule",
        sourceHash: "synthetic",
        ruleReplayMs: evaluated.ruleReplayMs,
        ledgerRows: loaded.rows.length,
        eligibleCandidates: evaluated.resultInput.candidates,
        predicateCalls: evaluated.pairResults.reduce((sum, pair) => sum + pair.admitted + pair.rejectedByRule, 0),
        admitted: evaluated.resultInput.kept,
        rejectedByRule: evaluated.pairResults.reduce((sum, pair) => sum + pair.rejectedByRule, 0),
        blocked: evaluated.pairResults.reduce((sum, pair) => sum + pair.blocked, 0),
        rightCensored: evaluated.rightCensored,
        controlReplayMs: evaluated.controlReplayMs,
        controlRuns: evaluated.controlRuns,
        calibrationReplays: evaluated.calibrationReplays,
        controlCandidateVisits: evaluated.controlCandidateVisits,
        controlsPerSecond: evaluated.controlReplayMs > 0 ? evaluated.controlRuns / (evaluated.controlReplayMs / 1000) : 0,
        candidateVisitsPerSecond: evaluated.controlReplayMs > 0 ? evaluated.controlCandidateVisits / (evaluated.controlReplayMs / 1000) : 0,
        reportFormatMs,
        reportWriteMs: 0,
        reportBytes: Buffer.byteLength(report),
    }];
    const classified = classifyTradeLedgerVerdict({
        ruleName: "bench-rule",
        keptPct: evaluated.resultInput.keptPct,
        isMeanPnlDeltaPp: evaluated.resultInput.isMeanPnlDeltaPp,
        isMedianPnlDeltaPp: evaluated.resultInput.isMedianPnlDeltaPp,
        holdoutMeanPnlDeltaPp: evaluated.resultInput.holdoutMeanPnlDeltaPp,
        holdoutMedianPnlDeltaPp: evaluated.resultInput.holdoutMedianPnlDeltaPp,
    });
    diagnostics.verdictCounts = { [classified.verdict]: 1 };
    diagnostics.throughput = { elapsedMs: totalMs, rulesCompleted: 1, rulesPerHour: 3_600_000 / Math.max(1, totalMs), rowsLoadedPerSecond: loaded.rows.length / Math.max(1, loadMs) * 1000, aggregateRuleRowsPerSecond: loaded.rows.length / Math.max(1, evaluated.ruleReplayMs) * 1000, aggregateControlRowsPerSecond: evaluated.controlCandidateVisits / Math.max(1, evaluated.controlReplayMs) * 1000, verdictCounts: diagnostics.verdictCounts, errors: [] };
    const firstLines = report.split("\n").slice(0, 8).join("\n");
    console.log(`load: ${loadMs}ms | replay+report: ${totalMs - loadMs}ms | total: ${totalMs}ms`);
    console.log(`preflight: ${preflight.decision} | requested mode: ${requestedMode} | estimated heap: ${(preflight.estimatedHeapBytes / 1024 / 1024).toFixed(0)} MB | estimated RSS: ${(preflight.estimatedRssBytes / 1024 / 1024).toFixed(0)} MB`);
    console.log(`peak heapUsed (100ms sampling): ${((controllerPeak?.heapUsed ?? 0) / 1024 / 1024).toFixed(0)} MB | maxRSS: ${(maxRss / 1024 / 1024).toFixed(0)} MB`);
    console.log("--- report header ---");
    console.log(firstLines);
    const kept = report.split("\n").find((l) => l.startsWith("kept:"));
    console.log(kept ?? "(kept line missing)");
    console.log("--- diagnostics.v1 ---");
    console.log(JSON.stringify(diagnostics, null, 2));
}

void main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
