import { expect } from "chai";
import { describe, it } from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { runChecker } from "../scripts/trade-ledger-checker";
import { discoverLedgerSweepCatalog, resolveLedgerSweepFolder } from "../lib/batch-backtest/trade-ledger-sweep-catalog";
import {
    isLedgerSweepRuntimeHeapGuardTripped,
    ledgerSweepRuntimeHeapGuardLimitBytes,
    resolveLedgerSweepPreflight,
    TRADE_LEDGER_SWEEP_RUNTIME_HEAP_GUARD_FRACTION,
} from "../lib/batch-backtest/trade-ledger-sweep-preflight";
import { runTradeLedgerSweepJob, type TradeLedgerSweepJobArgs } from "../lib/batch-backtest/trade-ledger-sweep-job";
import { classifyTradeLedgerVerdict } from "../lib/batch-backtest/trade-ledger-verdict";
import { buildTradeLedgerSweepDiagnosticsFooter } from "../lib/batch-backtest/trade-ledger-sweep-artifacts";
import { createEmptyLedgerSweepDiagnostics } from "../lib/batch-backtest/trade-ledger-sweep-diagnostics";
import { buildTradeLedgerSweepDiagnosticsSummary } from "../lib/batch-backtest/trade-ledger-sweep-diagnostics-summary";
import type { LedgerSweepStreamEvent } from "../lib/batch-backtest/trade-ledger-sweep-stream-types";

const ROOT = process.cwd();
const FOLDER_ID = "2026-08-29_1851_batch-smoke-v2";
const RULE_IDS = ["smoke-restrictive-rule", "smoke-trivial-rule"];

async function runInjectedWorker(source: string): Promise<{ outputAbsolutePath: string; events: LedgerSweepStreamEvent[] }> {
    const catalog = await discoverLedgerSweepCatalog(ROOT);
    const folder = await resolveLedgerSweepFolder(ROOT, FOLDER_ID);
    if (!folder) throw new Error("fixture folder is unavailable");
    const rule = catalog.rules.find((entry) => entry.ruleId === "smoke-trivial-rule") ?? catalog.rules[0];
    if (!rule) throw new Error("no rule fixture is available");
    const workerDir = await mkdtemp(path.join(ROOT, "artifacts", "test-logs", "trade-ledger-sweep-worker-"));
    const workerPath = path.join(workerDir, "injected-worker.js");
    await writeFile(workerPath, source, "utf8");
    const runId = `phase2audit-w3-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const outputAbsolutePath = path.join(folder.absolutePath, "sweeps", `20260830_000000_${runId}`);
    const outputDir = path.relative(ROOT, outputAbsolutePath).replace(/\\/g, "/");
    const preflight = resolveLedgerSweepPreflight(folder.entry.rows!, Number.MAX_SAFE_INTEGER);
    const events: LedgerSweepStreamEvent[] = [];
    try {
        await runTradeLedgerSweepJob({
            runId,
            folder: folder.entry,
            rules: [rule],
            mode: "load_once",
            modeReason: preflight.reason,
            preflight,
            folderAbsolutePath: folder.absolutePath,
            rulesAbsolutePath: path.join(ROOT, "archive", "mining-ledger", "rules"),
            outputAbsolutePath,
            outputDir,
            signal: new AbortController().signal,
            emit: (event) => events.push(event),
            update: () => undefined,
            workerAbsolutePath: workerPath,
        });
        return { outputAbsolutePath, events };
    } finally {
        await rm(workerDir, { recursive: true, force: true });
    }
}

function injectedWorkerSource(kind: "shared-failure" | "partial-rule"): string {
    return `const runId = process.argv[process.argv.indexOf("--run-id") + 1];
const result = { ruleId: "smoke-trivial-rule", ruleName: "smoke-trivial-rule.ts", sourceHash: "injected", verdict: "NO-EDGE", weak: false, note: "injected", candidates: 1, kept: 0, keptPct: 0, isMeanPnlDeltaPp: null, isMedianPnlDeltaPp: null, holdoutMeanPnlDeltaPp: null, holdoutMedianPnlDeltaPp: null, ruleReplayMs: 1, controlReplayMs: 1, totalMs: 2, reportPath: "reports/smoke-trivial-rule.txt", error: null };
if (${JSON.stringify(kind)} === "partial-rule") {
  process.stdout.write(JSON.stringify({ type: "start", runId, folderId: "${FOLDER_ID}", folderName: "${FOLDER_ID}", mode: "load_once", modeReason: "injected", totalRules: 1, ledgerRows: 1, ledgerBytes: 1, rankBytes: 0, outputDir: ".", startedAt: Date.now() }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "rule_result", runId, result }) + "\\n");
}
setTimeout(() => process.exit(1), 25);`;
}

async function runMode(mode: "load_once" | "isolated_per_rule", suffix: string): Promise<{ events: LedgerSweepStreamEvent[]; outputDir: string }> {
    const catalog = await discoverLedgerSweepCatalog(ROOT, { freeSystemMemoryBytes: mode === "load_once" ? Number.MAX_SAFE_INTEGER : 1_500_000_000 });
    const folder = await resolveLedgerSweepFolder(ROOT, FOLDER_ID);
    if (!folder) throw new Error("fixture folder is unavailable");
    const rules = catalog.rules.filter((rule) => RULE_IDS.includes(rule.ruleId));
    const runId = `phase3-${suffix}-${Date.now()}`;
    const outputAbsolutePath = path.join(folder.absolutePath, "sweeps", `20260830_000000_${runId}`);
    const outputDir = path.relative(ROOT, outputAbsolutePath).replace(/\\/g, "/");
    const preflight = resolveLedgerSweepPreflight(folder.entry.rows!, mode === "load_once" ? Number.MAX_SAFE_INTEGER : 1_500_000_000);
    if (preflight.decision !== mode) throw new Error(`fixture preflight selected ${preflight.decision}`);
    const events: LedgerSweepStreamEvent[] = [];
    const controller = new AbortController();
    const args: TradeLedgerSweepJobArgs = {
        runId,
        folder: folder.entry,
        rules,
        mode,
        modeReason: preflight.reason,
        preflight,
        folderAbsolutePath: folder.absolutePath,
        rulesAbsolutePath: path.join(ROOT, "archive", "mining-ledger", "rules"),
        outputAbsolutePath,
        outputDir,
        signal: controller.signal,
        emit: (event) => events.push(event),
        update: () => undefined,
        workerAbsolutePath: path.join(ROOT, "scripts", "trade-ledger-sweep-worker.ts"),
    };
    await runTradeLedgerSweepJob(args);
    return { events, outputDir };
}

describe("trade-ledger sweep engine", () => {
    it("selects every fixed preflight branch at the documented boundaries", () => {
        const loadOnce = resolveLedgerSweepPreflight(1, Number.MAX_SAFE_INTEGER);
        expect(loadOnce.decision).to.equal("load_once");
        const isolated = resolveLedgerSweepPreflight(3_000_000, Number.MAX_SAFE_INTEGER);
        expect(isolated.decision).to.equal("isolated_per_rule");
        const refused = resolveLedgerSweepPreflight(10_000_000, 1_000_000_000);
        expect(refused.decision).to.equal("refuse");
    });

    it("recalibrates the heap estimate above the measured F3 peak", () => {
        const f3Rows = 5_412_528;
        const f3ObservedHeapBytes = 9.01 * 1024 * 1024 * 1024;
        const preflight = resolveLedgerSweepPreflight(f3Rows, Number.MAX_SAFE_INTEGER);
        expect(preflight.estimatedHeapBytes).to.be.at.least(f3ObservedHeapBytes);
        expect(preflight.decision).to.equal("refuse");
        expect(preflight.estimatedHeapBytes).to.be.below(preflight.childHeapLimitBytes);
    });

    it("trips the runtime guard at the injected fixed heap limit", () => {
        const injectedChildHeapLimit = 1_000;
        const threshold = ledgerSweepRuntimeHeapGuardLimitBytes(injectedChildHeapLimit);
        expect(threshold).to.equal(injectedChildHeapLimit * TRADE_LEDGER_SWEEP_RUNTIME_HEAP_GUARD_FRACTION);
        expect(isLedgerSweepRuntimeHeapGuardTripped(threshold - 1, injectedChildHeapLimit, "load_once")).to.equal(false);
        expect(isLedgerSweepRuntimeHeapGuardTripped(threshold, injectedChildHeapLimit, "load_once")).to.equal(true);
        expect(isLedgerSweepRuntimeHeapGuardTripped(threshold, injectedChildHeapLimit, "isolated_per_rule")).to.equal(false);
    });

    it("fails a load-once worker with the clear fatal guard message at an injected low limit", async () => {
        const catalog = await discoverLedgerSweepCatalog(ROOT);
        const folder = await resolveLedgerSweepFolder(ROOT, FOLDER_ID);
        if (!folder) throw new Error("fixture folder is unavailable");
        const rule = catalog.rules.find((entry) => entry.ruleId === "smoke-trivial-rule") ?? catalog.rules[0];
        if (!rule) throw new Error("no rule fixture is available");
        const basePreflight = resolveLedgerSweepPreflight(folder.entry.rows!, Number.MAX_SAFE_INTEGER);
        const preflight = { ...basePreflight, decision: "load_once" as const, childHeapLimitBytes: 1_000 };
        const runId = `phase2audit-w1-guard-${Date.now()}`;
        const outputAbsolutePath = path.join(folder.absolutePath, "sweeps", `20260830_000000_${runId}`);
        const events: LedgerSweepStreamEvent[] = [];
        await runTradeLedgerSweepJob({ runId, folder: folder.entry, rules: [rule], mode: "load_once", modeReason: "injected low-heap runtime guard", preflight, folderAbsolutePath: folder.absolutePath, rulesAbsolutePath: path.join(ROOT, "archive", "mining-ledger", "rules"), outputAbsolutePath, outputDir: path.relative(ROOT, outputAbsolutePath).replace(/\\/g, "/"), signal: new AbortController().signal, emit: (event) => events.push(event), update: () => undefined, workerAbsolutePath: path.join(ROOT, "scripts", "trade-ledger-sweep-worker.ts") });
        const fatal = events.at(-1);
        expect(fatal?.type).to.equal("fatal");
        if (!fatal || fatal.type !== "fatal") return;
        expect(fatal.error).to.contain("runtime memory guard tripped - preflight underestimated; run refused");
        expect(fatal.diagnostics.memory.runtimeGuard.tripped).to.equal(true);
        expect(fatal.diagnostics.memory.runtimeGuard.observedHeapBytes).to.be.at.least(850);
    });

    it("classifies a valid zero-admit rule as NO-EDGE, while a missing result stays ERROR", () => {
        const zeroAdmit = classifyTradeLedgerVerdict({ ruleName: "zero.ts", keptPct: 0, isMeanPnlDeltaPp: null, isMedianPnlDeltaPp: null, holdoutMeanPnlDeltaPp: null, holdoutMedianPnlDeltaPp: null });
        expect(zeroAdmit.verdict).to.equal("NO-EDGE");
        expect(zeroAdmit.note).to.equal("no candidates admitted");
        const missing = classifyTradeLedgerVerdict({ ruleName: "missing.ts", keptPct: null, isMeanPnlDeltaPp: null, isMedianPnlDeltaPp: null, holdoutMeanPnlDeltaPp: null, holdoutMedianPnlDeltaPp: null });
        expect(missing.verdict).to.equal("ERROR");
    });

    it("reports the controls bottleneck against replay-plus-controls and total wall", () => {
        const preflight = resolveLedgerSweepPreflight(1, Number.MAX_SAFE_INTEGER);
        const diagnostics = createEmptyLedgerSweepDiagnostics({ runId: "footer", mode: "load_once", preflight });
        diagnostics.perRule.push({ ruleId: "r", ruleName: "r.ts", sourceHash: "", ruleReplayMs: 100, ledgerRows: 1, eligibleCandidates: 1, predicateCalls: 1, admitted: 1, rejectedByRule: 0, blocked: 0, rightCensored: 0, controlReplayMs: 900, controlRuns: 200, calibrationReplays: 200, controlCandidateVisits: 1, controlsPerSecond: 1, candidateVisitsPerSecond: 1, reportFormatMs: 0, reportWriteMs: 0, reportBytes: 0 });
        diagnostics.throughput = { elapsedMs: 1000 };
        expect(buildTradeLedgerSweepDiagnosticsFooter(diagnostics)).to.contain("random controls = 90.000% of aggregate replay+controls and 90.000% of total wall");
        expect(buildTradeLedgerSweepDiagnosticsFooter(diagnostics)).to.contain("trade-ledger-replay-core.ts:replayRandomControlRows");
    });

    it("builds a bounded summary from the existing diagnostics aggregate", () => {
        const preflight = resolveLedgerSweepPreflight(1, Number.MAX_SAFE_INTEGER);
        const diagnostics = createEmptyLedgerSweepDiagnostics({ runId: "summary", mode: "load_once", preflight });
        diagnostics.input = { controlExecution: "server_worker_threads", controlWorkers: 4 };
        diagnostics.phases = [
            { phase: "loading_ledger", startedAt: 0, finishedAt: 10, elapsedMs: 10 },
            { phase: "loading_ranks", startedAt: 10, finishedAt: 20, elapsedMs: 10 },
            { phase: "joining_ranks", startedAt: 20, finishedAt: 25, elapsedMs: 5 },
            { phase: "preparing", startedAt: 25, finishedAt: 35, elapsedMs: 10 },
        ];
        diagnostics.perRule = Array.from({ length: 200 }, (_, index) => ({
            ruleId: `q${index}`,
            ruleName: `rule-${index}.ts`,
            sourceHash: "hash",
            ruleReplayMs: index + 1,
            ledgerRows: 100,
            eligibleCandidates: index + 2,
            predicateCalls: 1,
            admitted: index % 3,
            rejectedByRule: 0,
            blocked: 0,
            rightCensored: 0,
            controlReplayMs: index * 10,
            controlRuns: 200,
            calibrationReplays: 200,
            controlCandidateVisits: 1_000,
            controlsPerSecond: 1,
            candidateVisitsPerSecond: 1,
            reportFormatMs: 1,
            reportWriteMs: 2,
            reportBytes: 3,
        }));
        diagnostics.throughput = {
            elapsedMs: 10_000,
            rulesCompleted: 200,
            rulesPerHour: 72_000,
            rowsLoadedPerSecond: 10,
            aggregateRuleRowsPerSecond: 20,
            aggregateControlRowsPerSecond: 30,
        };
        diagnostics.memory.samples = [
            { at: 1, source: "worker", phase: "preparing", ruleId: null, heapUsed: 100, heapTotal: 200, rss: 300, external: 0, arrayBuffers: 0, maxRss: 350 },
            { at: 2, source: "worker", phase: "random_controls", ruleId: "q1", heapUsed: 400, heapTotal: 500, rss: 600, external: 0, arrayBuffers: 0, maxRss: 700 },
        ];
        diagnostics.verdictCounts = { "NO-EDGE": 199, ERROR: 1 };
        diagnostics.errors = Array.from({ length: 25 }, (_, index) => `error-${index}`);

        const summary = buildTradeLedgerSweepDiagnosticsSummary(diagnostics, "done");
        expect(summary.controlExecution).to.equal("server_worker_threads");
        expect(summary.controlWorkers).to.equal(4);
        expect(summary.phases.load).to.deep.equal({ ledgerMs: 10, ranksMs: 10, joinMs: 5, totalMs: 25 });
        expect(summary.phases.ruleReplay.totalMs).to.equal(20_100);
        expect(summary.phases.controls.totalMs).to.equal(199_000);
        expect(summary.controlsShareOfCompute).to.equal(199_000 / 219_100 * 100);
        expect(summary.memory).to.deep.equal({ peakHeapUsed: 400, peakRss: 600, maxRss: 700 });
        expect(summary.topSlowestRules).to.have.length(10);
        expect(summary.topSlowestRules[0]).to.deep.include({ ruleId: "q199", name: "rule-199.ts", candidates: 201, kept: 1, controlReplayMs: 1_990 });
        expect(summary.errors).to.deep.equal({ count: 25, samples: Array.from({ length: 10 }, (_, index) => `error-${index}`), omitted: 15 });
        expect(JSON.stringify(summary, null, 2).split(/\r?\n/)).to.have.length.at.most(150);
    });

    it("keeps load-once and isolated-per-rule report/result parity with the checker", async () => {
        const loadOnce = await runMode("load_once", "once");
        const isolated = await runMode("isolated_per_rule", "isolated");
        const loadResults = loadOnce.events.filter((event) => event.type === "rule_result").map((event) => event.result);
        const isolatedResults = isolated.events.filter((event) => event.type === "rule_result").map((event) => event.result);
        expect(loadResults.map((result) => ({ ...result, ruleReplayMs: 0, controlReplayMs: 0, totalMs: 0 }))).to.deep.equal(isolatedResults.map((result) => ({ ...result, ruleReplayMs: 0, controlReplayMs: 0, totalMs: 0 })));
        for (const ruleId of RULE_IDS) {
            const legacy = await runChecker(`archive/mining-ledger/${FOLDER_ID}`, `archive/mining-ledger/rules/${ruleId}.ts`);
            const report = await readFile(path.join(ROOT, loadOnce.outputDir, "reports", `${ruleId}.txt`), "utf8");
            expect(report).to.equal(`${legacy}\n`);
        }
        const diagnosticsSummary = JSON.parse(await readFile(path.join(ROOT, loadOnce.outputDir, "diagnostics-summary.json"), "utf8")) as { schema: string; topSlowestRules: unknown[] };
        expect(diagnosticsSummary.schema).to.equal("trade_ledger_sweep.diagnostics-summary.v1");
        expect(diagnosticsSummary.topSlowestRules).to.have.length(2);
        expect(loadOnce.events.at(-1)?.type).to.equal("done");
        expect(isolated.events.at(-1)?.type).to.equal("done");
    });

    it("continues after an ordinary rule error and leaves scalar durable evidence", async () => {
        const catalog = await discoverLedgerSweepCatalog(ROOT);
        const folder = await resolveLedgerSweepFolder(ROOT, FOLDER_ID);
        if (!folder) throw new Error("fixture folder is unavailable");
        const rules = [
            catalog.rules.find((rule) => rule.ruleId === "smoke-trivial-rule")!,
            { ...catalog.rules.find((rule) => rule.ruleId === "smoke-trivial-rule")!, ruleId: "missing-rule", ruleName: "missing-rule.ts" },
        ];
        const runId = `phase3-error-${Date.now()}`;
        const outputAbsolutePath = path.join(folder.absolutePath, "sweeps", `20260830_000000_${runId}`);
        const outputDir = path.relative(ROOT, outputAbsolutePath).replace(/\\/g, "/");
        const preflight = resolveLedgerSweepPreflight(folder.entry.rows!, Number.MAX_SAFE_INTEGER);
        const events: LedgerSweepStreamEvent[] = [];
        await runTradeLedgerSweepJob({ runId, folder: folder.entry, rules, mode: "load_once", modeReason: preflight.reason, preflight, folderAbsolutePath: folder.absolutePath, rulesAbsolutePath: path.join(ROOT, "archive", "mining-ledger", "rules"), outputAbsolutePath, outputDir, signal: new AbortController().signal, emit: (event) => events.push(event), update: () => undefined, workerAbsolutePath: path.join(ROOT, "scripts", "trade-ledger-sweep-worker.ts") });
        const results = events.filter((event) => event.type === "rule_result").map((event) => event.result);
        expect(results).to.have.length(2);
        expect(results[1]!.verdict).to.equal("ERROR");
        expect(events.at(-1)?.type).to.equal("done");
        expect((await readFile(path.join(outputAbsolutePath, "rule-results.jsonl"), "utf8")).trim().split(/\r?\n/)).to.have.length(2);
    });

    it("fails shared-input worker errors fatally without inventing rule results", async () => {
        const run = await runInjectedWorker(injectedWorkerSource("shared-failure"));
        const manifest = JSON.parse(await readFile(path.join(run.outputAbsolutePath, "manifest.json"), "utf8")) as { terminalPhase: string; complete: boolean };
        const ruleResults = (await readFile(path.join(run.outputAbsolutePath, "rule-results.jsonl"), "utf8")).trim();
        expect(manifest.terminalPhase).to.equal("fatal");
        expect(manifest.complete).to.equal(false);
        expect(ruleResults).to.equal("");
        expect(run.events.at(-1)?.type).to.equal("fatal");
    });

    it("retains partial rule-results.jsonl and marks a killed sweep incomplete", async () => {
        const run = await runInjectedWorker(injectedWorkerSource("partial-rule"));
        const manifest = JSON.parse(await readFile(path.join(run.outputAbsolutePath, "manifest.json"), "utf8")) as { terminalPhase: string; complete: boolean };
        const ruleResults = (await readFile(path.join(run.outputAbsolutePath, "rule-results.jsonl"), "utf8")).trim().split(/\r?\n/).filter(Boolean);
        const summary = JSON.parse(await readFile(path.join(run.outputAbsolutePath, "summary.json"), "utf8")) as { complete: boolean; artifactVsIdeaLogVerdictDifferences: unknown[] };
        expect(ruleResults).to.have.length(1);
        expect(manifest.terminalPhase).to.equal("fatal");
        expect(manifest.complete).to.equal(false);
        expect(summary.complete).to.equal(false);
        expect(summary.artifactVsIdeaLogVerdictDifferences).to.deep.equal([]);
    });

    if (process.env.TRADE_LEDGER_SWEEP_F3_VALIDATION === "1") {
        it("runs the first two F3 rules through the validation-only guarded path", async () => {
            const folder = await resolveLedgerSweepFolder(ROOT, "2026-08-30_0940_batch-mtf7c0sj-armf8vch");
            if (!folder) throw new Error("F3 folder is unavailable");
            const catalog = await discoverLedgerSweepCatalog(ROOT);
            const rules = catalog.rules.slice(0, 2);
            const measuredPreflight = resolveLedgerSweepPreflight(folder.entry.rows!, Number.MAX_SAFE_INTEGER);
            expect(measuredPreflight.estimatedHeapBytes).to.be.at.least(9.01 * 1024 * 1024 * 1024);
            expect(measuredPreflight.decision).to.equal("refuse");
            const validationPreflight = {
                ...measuredPreflight,
                decision: "load_once" as const,
                reason: "validation-only forced load_once; production preflight refuses this ledger",
            };
            const runId = `phase2audit-w1-${Date.now()}`;
            const outputAbsolutePath = path.join(folder.absolutePath, "sweeps", runId);
            const outputDir = path.relative(ROOT, outputAbsolutePath).replace(/\\/g, "/");
            const events: LedgerSweepStreamEvent[] = [];
            await runTradeLedgerSweepJob({
                runId,
                folder: folder.entry,
                rules,
                mode: "load_once",
                modeReason: validationPreflight.reason,
                preflight: validationPreflight,
                folderAbsolutePath: folder.absolutePath,
                rulesAbsolutePath: path.join(ROOT, "archive", "mining-ledger", "rules"),
                outputAbsolutePath,
                outputDir,
                signal: new AbortController().signal,
                emit: (event) => events.push(event),
                update: () => undefined,
                workerAbsolutePath: path.join(ROOT, "scripts", "trade-ledger-sweep-worker.ts"),
            });
            const terminal = events.at(-1);
            expect(terminal?.type).to.equal("done");
            if (!terminal || terminal.type !== "done") return;
            expect(terminal.diagnostics.memory.runtimeGuard.tripped).to.equal(false);
            expect(terminal.diagnostics.memory.workerPeak?.heapUsed ?? 0).to.be.lessThan(terminal.diagnostics.memory.runtimeGuard.thresholdBytes);
            console.log(JSON.stringify({
                outputDir,
                estimatedHeapBytes: measuredPreflight.estimatedHeapBytes,
                observedHeapBytes: terminal.diagnostics.memory.workerPeak?.heapUsed ?? null,
                runtimeGuardThresholdBytes: terminal.diagnostics.memory.runtimeGuard.thresholdBytes,
            }));
        });
    }
});
