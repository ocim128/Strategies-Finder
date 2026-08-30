/** Vite-side controller for the isolated Ledger Rule Sweep worker. */

import { createRequire } from "node:module";
import { spawn } from "node:child_process";
import { performance } from "node:perf_hooks";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    buildTradeLedgerSweepSummary,
    createTradeLedgerSweepArtifacts,
} from "./trade-ledger-sweep-artifacts";
import type {
    LedgerSweepDiagnosticsV1,
    LedgerSweepDiagnosticEntry,
    LedgerSweepMode,
    LedgerSweepPhase,
} from "./trade-ledger-sweep-diagnostics";
import { createEmptyLedgerSweepDiagnostics } from "./trade-ledger-sweep-diagnostics";
import type { LedgerSweepFolderCatalogEntry, LedgerSweepRuleCatalogEntry } from "./trade-ledger-sweep-catalog";
import type { LedgerSweepPreflightDecision } from "./trade-ledger-sweep-preflight";
import {
    assertLedgerSweepWireEventIsScalar,
    isLedgerSweepTerminalEvent,
    type LedgerSweepRuleResult,
    type LedgerSweepStatusRun,
    type LedgerSweepStreamEvent,
} from "./trade-ledger-sweep-stream-types";

const CHILD_HEAP_LIMIT_MIB = 12_288;
const STDERR_TAIL_BYTES = 64 * 1024;

export interface TradeLedgerSweepJobArgs {
    runId: string;
    folder: LedgerSweepFolderCatalogEntry;
    rules: LedgerSweepRuleCatalogEntry[];
    mode: LedgerSweepMode;
    modeReason: string;
    preflight: LedgerSweepPreflightDecision;
    folderAbsolutePath: string;
    rulesAbsolutePath: string;
    outputAbsolutePath: string;
    outputDir: string;
    signal: AbortSignal;
    emit: (event: LedgerSweepStreamEvent) => void;
    update: (patch: Partial<LedgerSweepStatusRun>) => void;
    workerAbsolutePath?: string;
}

interface WorkerRunResult {
    terminal: Extract<LedgerSweepStreamEvent, { type: "done" | "fatal" | "cancelled" }>;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function tailPush(current: string, chunk: string): string {
    const next = current + chunk;
    return next.length <= STDERR_TAIL_BYTES ? next : next.slice(-STDERR_TAIL_BYTES);
}

function childPath(args: TradeLedgerSweepJobArgs): string {
    return args.workerAbsolutePath ?? path.resolve(process.cwd(), "scripts", "trade-ledger-sweep-worker.ts");
}

function displayEvent(event: LedgerSweepStreamEvent, outputDir: string): LedgerSweepStreamEvent {
    if (event.type === "start" || event.type === "done" || event.type === "cancelled" || event.type === "fatal") return { ...event, outputDir };
    return event;
}

function runWorkerChild(
    args: TradeLedgerSweepJobArgs,
    mode: "load_once" | "isolated_rule",
    ruleId: string | undefined,
    onEvent: (event: LedgerSweepStreamEvent) => Promise<void>,
): Promise<WorkerRunResult> {
    const require = createRequire(import.meta.url);
    const tsxLoader = require.resolve("tsx");
    const childArgs = [
        `--max-old-space-size=${CHILD_HEAP_LIMIT_MIB}`,
        "--import", pathToFileURL(tsxLoader).href,
        childPath(args),
        "--mode", mode,
        "--ledger-folder", args.folderAbsolutePath,
        "--rules-root", args.rulesAbsolutePath,
        "--output-dir", args.outputAbsolutePath,
        "--run-id", args.runId,
        ...(ruleId ? ["--rule-id", ruleId] : []),
    ];
    const child = spawn(process.execPath, childArgs, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let stdoutBuffer = "";
    let stderrTail = "";
    let terminal: WorkerRunResult["terminal"] | null = null;
    let callbackError: Error | null = null;
    let settled = false;
    let eventChain = Promise.resolve();
    const parseLine = (raw: string): void => {
        const line = raw.trim();
        if (!line) return;
        try {
            const parsed = JSON.parse(line) as LedgerSweepStreamEvent;
            assertLedgerSweepWireEventIsScalar(parsed);
            if (parsed.runId !== args.runId) throw new Error("Worker event runId does not match the active sweep.");
            if (isLedgerSweepTerminalEvent(parsed)) terminal = parsed;
            eventChain = eventChain.then(() => onEvent(parsed)).catch((error) => { callbackError = error instanceof Error ? error : new Error(String(error)); child.kill(); });
        } catch (error) {
            callbackError = error instanceof Error ? error : new Error(String(error));
            child.kill();
        }
    };
    return new Promise<WorkerRunResult>((resolve, reject) => {
        const abort = (): void => { child.kill(); };
        args.signal.addEventListener("abort", abort, { once: true });
        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk: string) => {
            stdoutBuffer += chunk;
            let newline: number;
            while ((newline = stdoutBuffer.indexOf("\n")) >= 0) {
                const line = stdoutBuffer.slice(0, newline);
                stdoutBuffer = stdoutBuffer.slice(newline + 1);
                parseLine(line);
            }
        });
        child.stderr?.on("data", (chunk: string) => { stderrTail = tailPush(stderrTail, chunk); });
        child.once("error", (error) => { callbackError = error; });
        child.once("close", (code, signal) => {
            if (settled) return;
            settled = true;
            if (stdoutBuffer.trim()) parseLine(stdoutBuffer);
            void eventChain.then(() => {
                args.signal.removeEventListener("abort", abort);
                const suffix = stderrTail.trim() ? `\nworker stderr tail:\n${stderrTail.trim()}` : "";
                if (args.signal.aborted) { reject(new Error("Ledger Sweep worker cancelled.")); return; }
                if (callbackError) { reject(new Error(`${callbackError.message}${suffix}`)); return; }
                if (!terminal) { reject(new Error(`Ledger Sweep worker exited without a terminal event (code=${String(code)}, signal=${String(signal)}).${suffix}`)); return; }
                if (terminal.type === "fatal") { reject(new Error(`${terminal.error}${suffix}`)); return; }
                resolve({ terminal });
            });
        });
    });
}

function mergeDiagnostics(current: LedgerSweepDiagnosticsV1, next: LedgerSweepDiagnosticsV1): LedgerSweepDiagnosticsV1 {
    return {
        ...next,
        phases: [...current.phases, ...next.phases],
        memory: {
            samples: [...current.memory.samples, ...next.memory.samples],
            workerPeak: !current.memory.workerPeak || (next.memory.workerPeak && next.memory.workerPeak.maxRss > current.memory.workerPeak.maxRss) ? next.memory.workerPeak : current.memory.workerPeak,
            controllerPeak: current.memory.controllerPeak,
            runtimeGuard: next.memory.runtimeGuard.tripped ? next.memory.runtimeGuard : current.memory.runtimeGuard,
        },
        cpu: [...current.cpu, ...next.cpu],
        perRule: [...current.perRule, ...next.perRule.filter((row) => !current.perRule.some((existing) => existing.ruleId === row.ruleId))],
        errors: [...current.errors, ...next.errors],
    };
}

function controllerMemoryEntry(phase: LedgerSweepPhase, ruleId: string | null): LedgerSweepDiagnosticEntry {
    const memory = process.memoryUsage();
    const usage = process.resourceUsage();
    const maxRss = usage.maxRSS * 1024;
    return {
        at: Date.now(),
        group: "memory",
        phase,
        ruleId,
        metrics: {
            sample: { at: Date.now(), source: "controller", phase, ruleId, heapUsed: memory.heapUsed, heapTotal: memory.heapTotal, rss: memory.rss, external: memory.external, arrayBuffers: memory.arrayBuffers, maxRss: Math.max(memory.rss, maxRss) },
            controllerHeapUsed: memory.heapUsed,
            controllerRss: memory.rss,
        },
    };
}

function completedResults(results: readonly LedgerSweepRuleResult[], frozenRules: readonly LedgerSweepRuleCatalogEntry[]): LedgerSweepRuleResult[] {
    const byId = new Map(results.map((result) => [result.ruleId, result]));
    return frozenRules.flatMap((rule) => {
        const result = byId.get(rule.ruleId);
        return result ? [result] : [];
    });
}

export async function runTradeLedgerSweepJob(args: TradeLedgerSweepJobArgs): Promise<void> {
    const startedAt = Date.now();
    const artifacts = await createTradeLedgerSweepArtifacts({ outputAbsolutePath: args.outputAbsolutePath, outputDir: args.outputDir, runId: args.runId, folder: args.folder, folderAbsolutePath: args.folderAbsolutePath, rules: args.rules, mode: args.mode, preflight: args.preflight, startedAt });
    let diagnostics = createEmptyLedgerSweepDiagnostics({ runId: args.runId, mode: args.mode, preflight: args.preflight, input: { folderId: args.folder.folderId, folderName: args.folder.name, ruleCount: args.rules.length } });
    const results: LedgerSweepRuleResult[] = [];
    let firstStart = true;
    let terminalFailure: string | null = null;
    const controllerStart = performance.now();
    const accept = async (rawEvent: LedgerSweepStreamEvent): Promise<void> => {
        const event = displayEvent(rawEvent, args.outputDir);
        if (event.type === "start") {
            if (!firstStart) return;
            firstStart = false;
            args.emit(event);
            args.update({ phase: "loading_ledger", startedAt: event.startedAt, totalRules: event.totalRules });
            return;
        }
        if (event.type === "diagnostics") {
            try { await artifacts.appendDiagnostic(event.entry); } catch (error) { diagnostics.errors.push(`diagnostic append failed: ${errorMessage(error)}`); }
            if (event.entry.group === "memory") {
                const sample = event.entry.metrics.sample;
                if (sample && typeof sample === "object") {
                    const typedSample = sample as LedgerSweepDiagnosticsV1["memory"]["samples"][number];
                    diagnostics.memory.samples.push(typedSample);
                    diagnostics.memory.workerPeak = !diagnostics.memory.workerPeak || typedSample.maxRss > diagnostics.memory.workerPeak.maxRss ? typedSample : diagnostics.memory.workerPeak;
                }
            }
            args.emit(event);
            return;
        }
        if (event.type === "rule_result") {
            await artifacts.appendRuleResult(event.result);
            const index = results.findIndex((result) => result.ruleId === event.result.ruleId);
            if (index >= 0) results[index] = event.result; else results.push(event.result);
            args.update({ completedRules: results.length, currentRuleId: null });
            args.emit(event);
            return;
        }
        if (event.type === "done" || event.type === "cancelled" || event.type === "fatal") {
            diagnostics = mergeDiagnostics(diagnostics, event.diagnostics);
            terminalFailure = event.type === "fatal" ? event.error : terminalFailure;
            return;
        }
        if (event.type === "phase" || event.type === "progress" || event.type === "rule_start") {
            if (event.type === "phase" || event.type === "progress") args.update({ phase: event.phase, elapsedMs: event.elapsedMs, completedRules: event.completedRules, currentRuleId: event.type === "progress" ? event.currentRuleId : null, percent: event.type === "progress" ? event.percent : undefined });
            if (event.type === "rule_start") args.update({ phase: "rule_replay", currentRuleId: event.ruleId });
            args.emit(event);
        }
    };
    const appendControllerMemory = async (phase: LedgerSweepPhase): Promise<void> => {
        const entry = controllerMemoryEntry(phase, null);
        try { await artifacts.appendDiagnostic(entry); } catch (error) { diagnostics.errors.push(`controller diagnostic append failed: ${errorMessage(error)}`); }
        const sample = entry.metrics.sample as LedgerSweepDiagnosticsV1["memory"]["samples"][number];
        diagnostics.memory.samples.push(sample);
        diagnostics.memory.controllerPeak = !diagnostics.memory.controllerPeak || sample.maxRss > diagnostics.memory.controllerPeak.maxRss ? sample : diagnostics.memory.controllerPeak;
    };
    try {
        const preflightEntry: LedgerSweepDiagnosticEntry = {
            at: Date.now(),
            group: "catalog_preflight",
            phase: "preflight",
            ruleId: null,
            metrics: {
                catalogMs: 0,
                preflightMs: 0,
                ledgerBytes: args.folder.ledgerBytes,
                rankBytes: args.folder.rankBytes,
                ledgerRows: args.folder.rows ?? 0,
                pairCount: args.folder.pairs ?? 0,
                ruleCount: args.rules.length,
                selectedMode: args.mode,
                modeReason: args.modeReason,
                estimatedHeapBytes: args.preflight.estimatedHeapBytes,
                estimatedRssBytes: args.preflight.estimatedRssBytes,
                childHeapLimitBytes: args.preflight.childHeapLimitBytes,
                freeSystemMemoryBytes: args.preflight.freeSystemMemoryBytes,
            },
        };
        try { await artifacts.appendDiagnostic(preflightEntry); } catch (error) { diagnostics.errors.push(`catalog diagnostic append failed: ${errorMessage(error)}`); }
        args.emit({ type: "diagnostics", runId: args.runId, entry: preflightEntry });
        await appendControllerMemory("starting_worker");
        if (args.signal.aborted) throw new Error("Ledger Sweep worker cancelled.");
        if (args.mode === "load_once") {
            const worker = await runWorkerChild(args, "load_once", undefined, accept);
            if (worker.terminal.type !== "done") throw new Error(worker.terminal.type === "fatal" ? worker.terminal.error : worker.terminal.summary);
        } else {
            for (const rule of args.rules) {
                if (args.signal.aborted) throw new Error("Ledger Sweep worker cancelled.");
                const worker = await runWorkerChild(args, "isolated_rule", rule.ruleId, accept);
                if (worker.terminal.type !== "done") throw new Error(worker.terminal.type === "fatal" ? worker.terminal.error : worker.terminal.summary);
            }
        }
        if (terminalFailure) throw new Error(terminalFailure);
        const finalResults = completedResults(results, args.rules);
        diagnostics.verdictCounts = Object.fromEntries(finalResults.reduce((counts, result) => counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1), new Map<string, number>()));
        const elapsedMs = performance.now() - controllerStart;
        const aggregateRuleRows = diagnostics.perRule.reduce((sum, row) => sum + row.ledgerRows, 0);
        const aggregateRuleMs = diagnostics.perRule.reduce((sum, row) => sum + row.ruleReplayMs, 0);
        const aggregateControlVisits = diagnostics.perRule.reduce((sum, row) => sum + row.controlCandidateVisits, 0);
        const aggregateControlMs = diagnostics.perRule.reduce((sum, row) => sum + row.controlReplayMs, 0);
        diagnostics.throughput = { elapsedMs, rulesCompleted: finalResults.length, rulesPerHour: elapsedMs > 0 ? finalResults.length / (elapsedMs / 3_600_000) : 0, rowsLoadedPerSecond: elapsedMs > 0 ? (args.folder.rows ?? 0) / (elapsedMs / 1000) : 0, aggregateRuleRowsPerSecond: aggregateRuleMs > 0 ? aggregateRuleRows / (aggregateRuleMs / 1000) : 0, aggregateControlRowsPerSecond: aggregateControlMs > 0 ? aggregateControlVisits / (aggregateControlMs / 1000) : 0, verdictCounts: diagnostics.verdictCounts, errors: diagnostics.errors };
        const summary = buildTradeLedgerSweepSummary(finalResults, undefined, diagnostics);
        try { await artifacts.appendDiagnostic({ at: Date.now(), group: "progress", phase: "done", ruleId: null, metrics: { elapsedMs, rulesCompleted: finalResults.length, rulesPerHour: diagnostics.throughput.rulesPerHour, rowsLoadedPerSecond: diagnostics.throughput.rowsLoadedPerSecond, aggregateRuleRowsPerSecond: diagnostics.throughput.aggregateRuleRowsPerSecond, aggregateControlRowsPerSecond: diagnostics.throughput.aggregateControlRowsPerSecond, verdictCounts: diagnostics.verdictCounts, errors: diagnostics.errors } }); } catch (diagnosticError) { diagnostics.errors.push(`terminal diagnostic append failed: ${errorMessage(diagnosticError)}`); }
        await artifacts.finalize({ terminalPhase: "done", finishedAt: Date.now(), results: finalResults, diagnostics, summary, error: null });
        args.emit({ type: "done", runId: args.runId, ok: true, cancelled: false, finishedAt: Date.now(), summary, results: finalResults, diagnostics, outputDir: args.outputDir });
    } catch (error) {
        const message = errorMessage(error);
        const cancelled = args.signal.aborted || message.includes("cancelled");
        diagnostics.errors.push(message);
        const finalResults = completedResults(results, args.rules);
        diagnostics.verdictCounts = Object.fromEntries(finalResults.reduce((counts, result) => counts.set(result.verdict, (counts.get(result.verdict) ?? 0) + 1), new Map<string, number>()));
        const terminalPhase = cancelled ? "cancelled" : "fatal";
        const summary = cancelled ? `Cancelled after ${finalResults.length} of ${args.rules.length} rules.` : null;
        try { await artifacts.appendDiagnostic({ at: Date.now(), group: "progress", phase: terminalPhase, ruleId: null, metrics: { elapsedMs: performance.now() - controllerStart, rulesCompleted: finalResults.length, rulesPerHour: 0, rowsLoadedPerSecond: 0, aggregateRuleRowsPerSecond: 0, aggregateControlRowsPerSecond: 0, verdictCounts: diagnostics.verdictCounts, errors: diagnostics.errors } }); } catch (diagnosticError) { diagnostics.errors.push(`terminal diagnostic append failed: ${errorMessage(diagnosticError)}`); }
        try { await artifacts.finalize({ terminalPhase, finishedAt: Date.now(), results: finalResults, diagnostics, summary, error: cancelled ? null : message }); } catch (finalizeError) { diagnostics.errors.push(`terminal artifact finalization failed: ${errorMessage(finalizeError)}`); }
        if (cancelled) args.emit({ type: "cancelled", runId: args.runId, ok: false, cancelled: true, finishedAt: Date.now(), summary: summary!, results: finalResults, diagnostics, outputDir: args.outputDir });
        else args.emit({ type: "fatal", runId: args.runId, ok: false, cancelled: false, finishedAt: Date.now(), error: message, summary: null, results: finalResults, diagnostics, outputDir: args.outputDir });
    }
}
