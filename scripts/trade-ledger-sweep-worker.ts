/**
 * Node-only Ledger Rule Sweep child. It is launched by trade-ledger-sweep-job
 * through the resolved tsx loader; no browser/Vite module may be imported here.
 */

import { createHash } from "node:crypto";
import { appendFile, lstat, readFile, rename, realpath, stat, writeFile } from "node:fs/promises";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    evaluateTradeLedgerRuleWithReportAsync,
    prepareTradeLedgerReplay,
    type LedgerRule,
} from "../lib/batch-backtest/trade-ledger-replay-core";
import { createTradeLedgerControlPool, type TradeLedgerControlPool } from "../lib/batch-backtest/trade-ledger-control-pool";
import { loadLedgerForReplay } from "../lib/batch-backtest/trade-ledger-replay-loader";
import { classifyTradeLedgerVerdict } from "../lib/batch-backtest/trade-ledger-verdict";
import {
    assertTradeLedgerSweepInputSnapshot,
    type TradeLedgerSweepInputSnapshot,
    type TradeLedgerSweepManifest,
} from "../lib/batch-backtest/trade-ledger-sweep-artifacts";
import {
    createEmptyLedgerSweepDiagnostics,
    type LedgerSweepDiagnosticEntry,
    type LedgerSweepMemorySample,
    type LedgerSweepPhase,
} from "../lib/batch-backtest/trade-ledger-sweep-diagnostics";
import {
    isLedgerSweepRuntimeHeapGuardTripped,
    ledgerSweepRuntimeHeapGuardLimitBytes,
    TRADE_LEDGER_SWEEP_RUNTIME_HEAP_GUARD_MESSAGE,
} from "../lib/batch-backtest/trade-ledger-sweep-preflight";
import type {
    LedgerSweepRuleResult,
    LedgerSweepStreamEvent,
} from "../lib/batch-backtest/trade-ledger-sweep-stream-types";

interface WorkerOptions {
    mode: "load_once" | "isolated_rule";
    ledgerFolder: string;
    rulesRoot: string;
    outputDir: string;
    runId: string;
    ruleId?: string;
}

function fail(message: string): never {
    throw new Error(message);
}

function parseArgs(argv: readonly string[]): WorkerOptions {
    const values = new Map<string, string>();
    for (let i = 0; i < argv.length; i += 2) {
        const key = argv[i];
        const value = argv[i + 1];
        if (!key?.startsWith("--") || value === undefined || value.startsWith("--")) fail("Malformed worker arguments.");
        if (values.has(key)) fail(`Duplicate worker argument: ${key}`);
        values.set(key, value);
    }
    const mode = values.get("--mode");
    if (mode !== "load_once" && mode !== "isolated_rule") fail("Worker mode must be load_once or isolated_rule.");
    const ledgerFolder = values.get("--ledger-folder");
    const rulesRoot = values.get("--rules-root");
    const outputDir = values.get("--output-dir");
    const runId = values.get("--run-id");
    if (!ledgerFolder || !rulesRoot || !outputDir || !runId) fail("Worker requires ledger folder, rules root, output dir, and run id.");
    const ruleId = values.get("--rule-id");
    if (mode === "isolated_rule" && !ruleId) fail("isolated_rule requires --rule-id.");
    if (mode === "load_once" && ruleId) fail("load_once does not accept --rule-id.");
    return { mode, ledgerFolder, rulesRoot, outputDir, runId, ...(ruleId ? { ruleId } : {}) };
}

function isStrictChild(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== ""
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

async function assertWorkerPaths(options: WorkerOptions): Promise<void> {
    const [folder, rulesRoot, output] = await Promise.all([
        realpath(options.ledgerFolder),
        realpath(options.rulesRoot),
        realpath(options.outputDir),
    ]);
    if (!isStrictChild(folder, output)) fail("Worker output directory escaped the ledger folder.");
    const folderStats = await stat(folder);
    const rulesStats = await stat(rulesRoot);
    if (!folderStats.isDirectory() || !rulesStats.isDirectory()) fail("Worker ledger or rules path is not a directory.");
}

function emit(event: LedgerSweepStreamEvent): void {
    process.stdout.write(`${JSON.stringify(event)}\n`);
}

function captureMemory(phase: LedgerSweepPhase, ruleId: string | null): LedgerSweepMemorySample {
    const memory = process.memoryUsage();
    const resource = process.resourceUsage();
    const maxRss = resource.maxRSS * 1024;
    return {
        at: Date.now(),
        source: "worker",
        phase,
        ruleId,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        rss: memory.rss,
        external: memory.external,
        arrayBuffers: memory.arrayBuffers,
        maxRss: Math.max(memory.rss, maxRss),
    };
}

function addPeak(current: LedgerSweepMemorySample | null, sample: LedgerSweepMemorySample): LedgerSweepMemorySample {
    return !current || sample.maxRss > current.maxRss ? sample : current;
}

function errorText(error: unknown): string {
    const raw = error instanceof Error
        ? `${error.message}${error.stack ? `\n${error.stack}` : ""}`
        : String(error);
    return raw.slice(0, 16 * 1024);
}

async function atomicWrite(filePath: string, text: string): Promise<void> {
    const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(temporary, text, "utf8");
    await rename(temporary, filePath);
}

async function loadManifest(outputDir: string): Promise<TradeLedgerSweepManifest> {
    return JSON.parse(await readFile(path.join(outputDir, "manifest.json"), "utf8")) as TradeLedgerSweepManifest;
}

async function sourceHash(filePath: string): Promise<string> {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

interface InputFileSnapshot {
    bytes: number;
    modifiedAt: number;
}

async function inputFileSnapshot(filePath: string, required: boolean): Promise<InputFileSnapshot | null> {
    try {
        const info = await stat(filePath);
        if (!info.isFile()) fail(`Ledger input is not a regular file: ${filePath}`);
        return { bytes: info.size, modifiedAt: info.mtimeMs };
    } catch (error) {
        if (!required && error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

async function optionalSourceHash(filePath: string): Promise<string | null> {
    try {
        return await sourceHash(filePath);
    } catch (error) {
        if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
        throw error;
    }
}

async function assertInputSnapshot(manifest: TradeLedgerSweepManifest, folder: string): Promise<void> {
    const [ledger, rank, provenanceSha256, summarySha256] = await Promise.all([
        inputFileSnapshot(path.join(folder, "ledger.jsonl"), true),
        inputFileSnapshot(path.join(folder, "signal-ranks.jsonl"), false),
        optionalSourceHash(path.join(folder, "provenance.json")),
        optionalSourceHash(path.join(folder, "summary.json")),
    ]);
    if (!ledger) fail("Ledger input is missing.");
    const snapshot: TradeLedgerSweepInputSnapshot = {
        ledgerBytes: ledger.bytes,
        ledgerModifiedAt: ledger.modifiedAt,
        rankBytes: rank?.bytes ?? 0,
        rankModifiedAt: rank?.modifiedAt ?? null,
        provenanceSha256,
        summarySha256,
    };
    assertTradeLedgerSweepInputSnapshot(manifest, snapshot);
}

async function resolveRule(options: WorkerOptions, manifest: TradeLedgerSweepManifest, ruleId: string): Promise<{
    ruleId: string;
    ruleName: string;
    sourceHash: string;
    filePath: string;
    rule: LedgerRule;
}> {
    const catalogRule = manifest.rules.find((item) => item.ruleId === ruleId);
    if (!catalogRule) fail(`Rule ${ruleId} is not in the frozen sweep manifest.`);
    if (ruleId.includes("/") || ruleId.includes("\\") || ruleId === "." || ruleId === "..") fail("Unsafe rule id.");
    const filePath = path.join(options.rulesRoot, `${ruleId}.ts`);
    const [canonicalRoot, canonicalFile] = await Promise.all([realpath(options.rulesRoot), realpath(filePath)]);
    const info = await lstat(filePath);
    if (!info.isFile() || info.isSymbolicLink() || !isStrictChild(canonicalRoot, canonicalFile) || path.basename(canonicalFile) !== `${ruleId}.ts`) {
        fail(`Rule ${ruleId} is missing or unsafe.`);
    }
    const hash = await sourceHash(canonicalFile);
    if (hash !== catalogRule.sourceHash) fail(`Rule ${ruleId} changed after the sweep catalog was frozen.`);
    const loaded = await import(`${pathToFileURL(canonicalFile).href}?v=${hash}`) as { default?: unknown };
    if (typeof loaded.default !== "function") fail(`Rule ${catalogRule.ruleName} must default-export (row) => boolean.`);
    return { ...catalogRule, filePath: canonicalFile, rule: loaded.default as LedgerRule };
}

type ResolvedRule = Awaited<ReturnType<typeof resolveRule>>;

interface RuleLoadResult {
    entry: TradeLedgerSweepManifest["rules"][number];
    loadedRule: ResolvedRule | null;
    error: unknown | null;
}

async function preloadRules(
    options: WorkerOptions,
    manifest: TradeLedgerSweepManifest,
    ruleEntries: readonly TradeLedgerSweepManifest["rules"][number][],
): Promise<RuleLoadResult[]> {
    return Promise.all(ruleEntries.map(async (entry) => {
        try {
            return { entry, loadedRule: await resolveRule(options, manifest, entry.ruleId), error: null };
        } catch (error) {
            return { entry, loadedRule: null, error };
        }
    }));
}

async function writeRuleReport(outputDir: string, ruleId: string, text: string): Promise<string> {
    const reportPath = path.join(outputDir, "reports", `${ruleId}.txt`);
    await atomicWrite(reportPath, `${text}\n`);
    await appendFile(path.join(outputDir, "full-report.txt"), `===== ${ruleId} =====\n${text}\n\n`, "utf8");
    return path.posix.join("reports", `${ruleId}.txt`);
}

function errorResult(rule: { ruleId: string; ruleName: string; sourceHash: string }, error: unknown, candidates: number): LedgerSweepRuleResult {
    const message = errorText(error);
    const verdict = classifyTradeLedgerVerdict({
        ruleName: rule.ruleName,
        keptPct: null,
        isMeanPnlDeltaPp: null,
        isMedianPnlDeltaPp: null,
        holdoutMeanPnlDeltaPp: null,
        holdoutMedianPnlDeltaPp: null,
        error: message,
    });
    return {
        ruleId: rule.ruleId,
        ruleName: rule.ruleName,
        sourceHash: rule.sourceHash,
        verdict: verdict.verdict,
        weak: verdict.weak,
        note: verdict.note || null,
        candidates,
        kept: 0,
        keptPct: null,
        isMeanPnlDeltaPp: null,
        isMedianPnlDeltaPp: null,
        holdoutMeanPnlDeltaPp: null,
        holdoutMedianPnlDeltaPp: null,
        ruleReplayMs: 0,
        controlReplayMs: 0,
        totalMs: 0,
        reportPath: path.posix.join("reports", `${rule.ruleId}.txt`),
        error: message,
    };
}

async function runWorker(options: WorkerOptions): Promise<void> {
    const manifest = await loadManifest(options.outputDir);
    if (manifest.runId !== options.runId) fail("Worker run id does not match the manifest.");
    await assertWorkerPaths(options);
    await assertInputSnapshot(manifest, options.ledgerFolder);
    const totalRules = manifest.rules.length;
    const startedAt = Date.now();
    const diagnostics = createEmptyLedgerSweepDiagnostics({
        runId: options.runId,
        mode: manifest.mode,
        preflight: manifest.preflight,
        input: { folderId: manifest.folderId, ruleCount: totalRules },
    });
    const startedPerf = performance.now();
    const cpuStarted = process.resourceUsage();
    const eventLoopStarted = performance.eventLoopUtilization();
    const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
    eventLoopDelay.enable();
    let currentPhase: LedgerSweepPhase = "starting_worker";
    let currentRuleId: string | null = null;
    let runtimeGuardError: Error | null = null;
    let controlPool: TradeLedgerControlPool | null = null;
    const addEntry = (entry: LedgerSweepDiagnosticEntry): void => {
        if (entry.group === "memory") {
            const sample = entry.metrics.sample as LedgerSweepMemorySample | undefined;
            if (sample) {
                diagnostics.memory.samples.push(sample);
                diagnostics.memory.workerPeak = addPeak(diagnostics.memory.workerPeak, sample);
            }
        }
        if (entry.group === "rule_replay" || entry.group === "controls" || entry.group === "persistence") {
            const existing = diagnostics.perRule.find((row) => row.ruleId === entry.ruleId);
            const metrics = entry.metrics as Record<string, unknown>;
            if (existing) Object.assign(existing, metrics);
            else if (entry.ruleId) diagnostics.perRule.push({
                ruleId: entry.ruleId,
                ruleName: String(metrics.ruleName ?? entry.ruleId),
                sourceHash: String(metrics.sourceHash ?? ""),
                ruleReplayMs: Number(metrics.ruleReplayMs ?? 0),
                ledgerRows: Number(metrics.ledgerRows ?? 0),
                eligibleCandidates: Number(metrics.eligibleCandidates ?? 0),
                predicateCalls: Number(metrics.predicateCalls ?? 0),
                admitted: Number(metrics.admitted ?? 0),
                rejectedByRule: Number(metrics.rejectedByRule ?? 0),
                blocked: Number(metrics.blocked ?? 0),
                rightCensored: Number(metrics.rightCensored ?? 0),
                controlReplayMs: Number(metrics.controlReplayMs ?? 0),
                controlRuns: Number(metrics.controlRuns ?? 0),
                calibrationReplays: Number(metrics.calibrationReplays ?? 0),
                controlCandidateVisits: Number(metrics.controlCandidateVisits ?? 0),
                controlsPerSecond: Number(metrics.controlsPerSecond ?? 0),
                candidateVisitsPerSecond: Number(metrics.candidateVisitsPerSecond ?? 0),
                reportFormatMs: Number(metrics.reportFormatMs ?? 0),
                reportWriteMs: Number(metrics.reportWriteMs ?? 0),
                reportBytes: Number(metrics.reportBytes ?? 0),
            });
        }
        emit({ type: "diagnostics", runId: options.runId, entry });
    };
    const observeRuntimeHeap = (sample: LedgerSweepMemorySample): void => {
        if (runtimeGuardError || !isLedgerSweepRuntimeHeapGuardTripped(sample.heapUsed, manifest.preflight.childHeapLimitBytes, manifest.mode)) return;
        const thresholdBytes = ledgerSweepRuntimeHeapGuardLimitBytes(manifest.preflight.childHeapLimitBytes);
        const message = `${TRADE_LEDGER_SWEEP_RUNTIME_HEAP_GUARD_MESSAGE} (heapUsed=${sample.heapUsed}; threshold=${thresholdBytes})`;
        diagnostics.memory.runtimeGuard = {
            tripped: true,
            thresholdBytes,
            observedHeapBytes: sample.heapUsed,
            phase: sample.phase,
            ruleId: sample.ruleId,
            message,
        };
        runtimeGuardError = new Error(message);
        addEntry({
            at: Date.now(),
            group: "memory",
            phase: sample.phase,
            ruleId: sample.ruleId,
            metrics: { sample, runtimeGuardTripped: true, thresholdBytes, observedHeapBytes: sample.heapUsed, message },
        });
    };
    const assertRuntimeHeapSafe = (): void => {
        if (runtimeGuardError) throw runtimeGuardError;
    };
    const phase = (name: LedgerSweepPhase, detail: string, ruleId: string | null, completedRules: number): void => {
        const now = Date.now();
        currentPhase = name;
        currentRuleId = ruleId;
        const sample = captureMemory(name, ruleId);
        observeRuntimeHeap(sample);
        assertRuntimeHeapSafe();
        emit({
            type: "phase",
            runId: options.runId,
            phase: name,
            detail,
            elapsedMs: performance.now() - startedPerf,
            completedRules,
            totalRules,
            memory: sample,
        });
        addEntry({ at: now, group: "memory", phase: name, ruleId, metrics: { sample } });
    };
    const memorySampler = setInterval(() => {
        const sample = captureMemory(currentPhase, currentRuleId);
        observeRuntimeHeap(sample);
        addEntry({ at: Date.now(), group: "memory", phase: currentPhase, ruleId: currentRuleId, metrics: { sample } });
    }, 1_000);
    const recordCpu = (scope: string): void => {
        const usage = process.resourceUsage();
        const elu = performance.eventLoopUtilization(eventLoopStarted);
        diagnostics.cpu.push({
            scope,
            userCpuMs: Math.max(0, (usage.userCPUTime - cpuStarted.userCPUTime) / 1000),
            systemCpuMs: Math.max(0, (usage.systemCPUTime - cpuStarted.systemCPUTime) / 1000),
            eventLoopUtilization: Number.isFinite(elu.utilization) ? elu.utilization : 0,
            eventLoopDelayP50Ms: eventLoopDelay.percentile(50) / 1e6,
            eventLoopDelayP99Ms: eventLoopDelay.percentile(99) / 1e6,
        });
        eventLoopDelay.disable();
    };
    emit({
        type: "start",
        runId: options.runId,
        folderId: manifest.folderId,
        folderName: manifest.folderName,
        mode: manifest.mode,
        modeReason: manifest.preflight.reason,
        totalRules,
        ledgerRows: manifest.preflight.rows,
        ledgerBytes: manifest.ledgerBytes,
        rankBytes: manifest.rankBytes,
        outputDir: ".",
        startedAt,
    });

    try {
        phase("starting_worker", "worker started", null, 0);
        phase("loading_ledger", "loading ledger.jsonl", null, 0);
        const loadStartedAt = Date.now();
        const loaded = await loadLedgerForReplay(options.ledgerFolder);
        await assertInputSnapshot(manifest, options.ledgerFolder);
        assertRuntimeHeapSafe();
        const loadFinishedAt = Date.now();
        diagnostics.input = {
            ...diagnostics.input,
            folderId: manifest.folderId,
            rankRows: loaded.diagnostics.ranks.rowsParsed,
        };
        addEntry({ at: Date.now(), group: "ledger_load", phase: "loading_ledger", ruleId: null, metrics: {
            ledgerStreamWallMs: loaded.diagnostics.ledger.streamWallMs,
            ledgerJsonParseMs: loaded.diagnostics.ledger.jsonParseMs,
            ledgerRowsParsed: loaded.diagnostics.ledger.rowsParsed,
            ledgerBytesRead: loaded.diagnostics.ledger.bytesRead,
            ledgerReadResidualMs: loaded.diagnostics.ledger.readResidualMs,
        } });
        phase("loading_ranks", "loading signal-ranks.jsonl", null, 0);
        addEntry({ at: Date.now(), group: "ranks", phase: "loading_ranks", ruleId: null, metrics: {
            ranksStreamWallMs: loaded.diagnostics.ranks.streamWallMs,
            ranksJsonParseMs: loaded.diagnostics.ranks.jsonParseMs,
            rankRowsParsed: loaded.diagnostics.ranks.rowsParsed,
            rankBytesRead: loaded.diagnostics.ranks.bytesRead,
            rankReadResidualMs: loaded.diagnostics.ranks.readResidualMs,
            rankJoinMs: loaded.diagnostics.rankJoinMs,
            joinedRows: loaded.diagnostics.joinedRows,
            unmatchedRows: loaded.diagnostics.unmatchedRows,
        } });
        if (loaded.rows.length !== manifest.preflight.rows) fail(`Ledger row count changed during sweep: expected ${manifest.preflight.rows}, got ${loaded.rows.length}.`);
        phase("joining_ranks", "rank join complete", null, 0);
        phase("preparing", "building sorted pair buckets and guarded views", null, 0);
        const prepareStartedAt = performance.now();
        const prepared = prepareTradeLedgerReplay({ rows: loaded.rows, joinedRankCount: loaded.joinedRankCount, replayParams: loaded.replayParams });
        controlPool = createTradeLedgerControlPool(prepared);
        diagnostics.input = {
            ...diagnostics.input,
            controlExecution: "server_worker_threads",
            controlWorkers: controlPool.workerCount,
        };
        const prepareMs = performance.now() - prepareStartedAt;
        observeRuntimeHeap(captureMemory("preparing", null));
        assertRuntimeHeapSafe();
        diagnostics.phases.push(
            { phase: "loading_ledger", startedAt: loadStartedAt, finishedAt: loadFinishedAt, elapsedMs: loaded.diagnostics.ledger.streamWallMs },
            { phase: "loading_ranks", startedAt: loadStartedAt, finishedAt: loadFinishedAt, elapsedMs: loaded.diagnostics.ranks.streamWallMs },
            { phase: "joining_ranks", startedAt: loadFinishedAt, finishedAt: loadFinishedAt + loaded.diagnostics.rankJoinMs, elapsedMs: loaded.diagnostics.rankJoinMs },
            { phase: "preparing", startedAt: Date.now() - Math.round(prepareMs), finishedAt: Date.now(), elapsedMs: prepareMs },
        );
        addEntry({ at: Date.now(), group: "prepare", phase: "preparing", ruleId: null, metrics: {
            prepareMs,
            candidateRows: prepared.candidateRows,
            rightCensoredRows: prepared.rightCensoredRows,
            pairBuckets: prepared.pairBuckets,
            sortedRows: prepared.sortedRows,
            proxyCount: prepared.proxyCount,
            controlExecution: "server_worker_threads",
            controlWorkers: controlPool.workerCount,
        } });
        const isolatedRule = options.mode === "isolated_rule"
            ? manifest.rules.find((rule) => rule.ruleId === options.ruleId)
            : undefined;
        if (options.mode === "isolated_rule" && !isolatedRule) fail(`Missing frozen rule ${options.ruleId}.`);
        const ruleEntries = isolatedRule ? [isolatedRule] : manifest.rules;
        phase("loading_rules", `loading ${ruleEntries.length} rule modules`, null, 0);
        const ruleLoadingStartedAt = Date.now();
        const ruleLoadingPerfStartedAt = performance.now();
        const loadedRuleResults = await preloadRules(options, manifest, ruleEntries);
        const ruleLoadingMs = performance.now() - ruleLoadingPerfStartedAt;
        const ruleLoadingFinishedAt = Date.now();
        const loadedRules = new Map(loadedRuleResults.map((result) => [result.entry.ruleId, result]));
        diagnostics.input = {
            ...diagnostics.input,
            ruleLoading: "parallel",
            ruleLoadMs: ruleLoadingMs,
            rulesLoaded: loadedRuleResults.filter((result) => result.loadedRule !== null).length,
        };
        diagnostics.phases.push({ phase: "loading_rules", startedAt: ruleLoadingStartedAt, finishedAt: ruleLoadingFinishedAt, elapsedMs: ruleLoadingMs });
        addEntry({ at: ruleLoadingFinishedAt, group: "rule_loading", phase: "loading_rules", ruleId: null, metrics: {
            ruleLoadMs: ruleLoadingMs,
            rulesRequested: ruleEntries.length,
            rulesLoaded: loadedRuleResults.filter((result) => result.loadedRule !== null).length,
            execution: "parallel",
        } });
        const results: LedgerSweepRuleResult[] = [];
        for (const [ruleIndex, entry] of ruleEntries.entries()) {
            if (!entry) fail(`Missing frozen rule ${options.ruleId}.`);
            currentRuleId = entry.ruleId;
            const ruleStartedAt = Date.now();
            emit({ type: "rule_start", runId: options.runId, ruleIndex, totalRules, ruleId: entry.ruleId, ruleName: entry.ruleName, sourceHash: entry.sourceHash, startedAt: ruleStartedAt });
            phase("rule_replay", `replaying ${entry.ruleName}`, entry.ruleId, results.length);
            let ruleResult: LedgerSweepRuleResult;
            try {
                const loadedRuleResult = loadedRules.get(entry.ruleId);
                if (!loadedRuleResult) fail(`Rule ${entry.ruleId} was not preloaded.`);
                if (loadedRuleResult.error) throw loadedRuleResult.error;
                const loadedRule = loadedRuleResult.loadedRule;
                if (!loadedRule) fail(`Rule ${entry.ruleId} was not loaded.`);
                const evaluated = await evaluateTradeLedgerRuleWithReportAsync({
                    folder: manifest.ledgerFolder,
                    ledgerVersion: loaded.provenance.ledgerVersion,
                    featureVersion: loaded.provenance.featureVersion,
                    ruleName: entry.ruleName,
                    rows: loaded.rows,
                    joinedRankCount: loaded.joinedRankCount,
                    rule: loadedRule.rule,
                    replay: loaded.replayParams,
                    prepared,
                }, controlPool!.run);
                const resultInput = evaluated.resultInput;
                const classified = classifyTradeLedgerVerdict({
                    ruleName: entry.ruleName,
                    keptPct: resultInput.keptPct,
                    isMeanPnlDeltaPp: resultInput.isMeanPnlDeltaPp,
                    isMedianPnlDeltaPp: resultInput.isMedianPnlDeltaPp,
                    holdoutMeanPnlDeltaPp: resultInput.holdoutMeanPnlDeltaPp,
                    holdoutMedianPnlDeltaPp: resultInput.holdoutMedianPnlDeltaPp,
                });
                phase("random_controls", `controls complete for ${entry.ruleName}`, entry.ruleId, results.length);
                const reportStartedAt = performance.now();
                const reportText = evaluated.reportLines.join("\n");
                const reportFormatMs = performance.now() - reportStartedAt;
                const writeStartedAt = performance.now();
                const reportPath = await writeRuleReport(options.outputDir, entry.ruleId, reportText);
                const reportWriteMs = performance.now() - writeStartedAt;
                ruleResult = {
                    ruleId: entry.ruleId,
                    ruleName: entry.ruleName,
                    sourceHash: entry.sourceHash,
                    verdict: classified.verdict,
                    weak: classified.weak,
                    note: classified.note || null,
                    ...resultInput,
                    ruleReplayMs: evaluated.evaluation.ruleReplayMs,
                    controlReplayMs: evaluated.evaluation.controlReplayMs,
                    totalMs: Date.now() - ruleStartedAt,
                    reportPath,
                    error: null,
                };
                addEntry({ at: Date.now(), group: "rule_replay", phase: "rule_replay", ruleId: entry.ruleId, metrics: {
                    ruleName: entry.ruleName,
                    sourceHash: entry.sourceHash,
                    ruleReplayMs: evaluated.evaluation.ruleReplayMs,
                    ledgerRows: loaded.rows.length,
                    eligibleCandidates: resultInput.candidates,
                    predicateCalls: evaluated.evaluation.pairResults.reduce((sum, pair) => sum + pair.admitted + pair.rejectedByRule, 0),
                    admitted: resultInput.kept,
                    rejectedByRule: evaluated.evaluation.pairResults.reduce((sum, pair) => sum + pair.rejectedByRule, 0),
                    blocked: evaluated.evaluation.pairResults.reduce((sum, pair) => sum + pair.blocked, 0),
                    rightCensored: evaluated.evaluation.rightCensored,
                } });
                addEntry({ at: Date.now(), group: "controls", phase: "random_controls", ruleId: entry.ruleId, metrics: {
                    ruleName: entry.ruleName,
                    controlReplayMs: evaluated.evaluation.controlReplayMs,
                    controlRuns: evaluated.evaluation.controlRuns,
                    calibrationReplays: evaluated.evaluation.calibrationReplays,
                    controlCandidateVisits: evaluated.evaluation.controlCandidateVisits,
                    controlsPerSecond: evaluated.evaluation.controlReplayMs > 0 ? evaluated.evaluation.controlRuns / (evaluated.evaluation.controlReplayMs / 1000) : 0,
                    candidateVisitsPerSecond: evaluated.evaluation.controlReplayMs > 0 ? evaluated.evaluation.controlCandidateVisits / (evaluated.evaluation.controlReplayMs / 1000) : 0,
                } });
                addEntry({ at: Date.now(), group: "persistence", phase: "writing_report", ruleId: entry.ruleId, metrics: {
                    reportFormatMs,
                    reportWriteMs,
                    reportBytes: Buffer.byteLength(reportText),
                } });
                const replayFinishedAt = ruleStartedAt + evaluated.evaluation.ruleReplayMs;
                const controlsFinishedAt = replayFinishedAt + evaluated.evaluation.controlReplayMs;
                diagnostics.phases.push(
                    { phase: "rule_replay", startedAt: ruleStartedAt, finishedAt: replayFinishedAt, elapsedMs: evaluated.evaluation.ruleReplayMs },
                    { phase: "random_controls", startedAt: replayFinishedAt, finishedAt: controlsFinishedAt, elapsedMs: evaluated.evaluation.controlReplayMs },
                    { phase: "writing_report", startedAt: controlsFinishedAt, finishedAt: controlsFinishedAt + reportFormatMs + reportWriteMs, elapsedMs: reportFormatMs + reportWriteMs },
                );
            } catch (error) {
                if (runtimeGuardError) throw runtimeGuardError;
                const reportPath = await writeRuleReport(options.outputDir, entry.ruleId, `trade-ledger-checker failed: ${errorText(error)}`);
                ruleResult = { ...errorResult(entry, error, prepared.candidateRows), reportPath };
                addEntry({ at: Date.now(), group: "rule_replay", phase: "rule_replay", ruleId: entry.ruleId, metrics: {
                    ruleName: entry.ruleName,
                    sourceHash: entry.sourceHash,
                    ruleReplayMs: 0,
                    ledgerRows: loaded.rows.length,
                    eligibleCandidates: prepared.candidateRows,
                    predicateCalls: 0,
                    admitted: 0,
                    rejectedByRule: 0,
                    blocked: prepared.rows.length,
                    rightCensored: prepared.rightCensoredRows,
                    controlReplayMs: 0,
                    controlRuns: 0,
                    calibrationReplays: 0,
                    controlCandidateVisits: 0,
                    controlsPerSecond: 0,
                    candidateVisitsPerSecond: 0,
                    reportFormatMs: 0,
                    reportWriteMs: 0,
                    reportBytes: 0,
                } });
                diagnostics.errors.push(`${entry.ruleId}: ${ruleResult.error ?? "rule failed"}`);
            }
            results.push(ruleResult);
            emit({ type: "rule_result", runId: options.runId, result: ruleResult });
            emit({ type: "progress", runId: options.runId, phase: "rule_replay", percent: (results.length / ruleEntries.length) * 100, detail: `${results.length}/${ruleEntries.length} rules`, completedRules: results.length, totalRules, currentRuleId: null, elapsedMs: performance.now() - startedPerf, controlCompleted: null, controlRuns: null, rulesPerHour: performance.now() > startedPerf ? results.length / ((performance.now() - startedPerf) / 3_600_000) : 0 });
        }
        diagnostics.verdictCounts = Object.fromEntries(results.reduce((counts, result) => counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1), new Map<string, number>()));
        recordCpu("whole_job");
        const finalizingStartedAt = Date.now();
        phase("finalizing", "worker evaluation complete", null, results.length);
        diagnostics.phases.push({ phase: "finalizing", startedAt: finalizingStartedAt, finishedAt: Date.now(), elapsedMs: 0 });
        emit({ type: "done", runId: options.runId, ok: true, cancelled: false, finishedAt: Date.now(), summary: `Completed ${results.length} of ${ruleEntries.length} rules.`, results, diagnostics, outputDir: "." });
    } catch (error) {
        const message = errorText(error);
        recordCpu("whole_job");
        diagnostics.errors.push(message);
        emit({ type: "fatal", runId: options.runId, ok: false, cancelled: false, finishedAt: Date.now(), error: message, summary: null, results: [], diagnostics, outputDir: "." });
    } finally {
        clearInterval(memorySampler);
        eventLoopDelay.disable();
        await controlPool?.close();
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    await runWorker(options);
}

void main().catch((error) => {
    console.error(`trade-ledger-sweep-worker failed: ${errorText(error)}`);
    process.exitCode = 1;
});
