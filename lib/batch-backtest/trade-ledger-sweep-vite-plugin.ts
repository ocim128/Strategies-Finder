import type { Plugin } from "vite";
import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { isValidRunId } from "./sp500-top-mean-artifact-store";
import {
    createDisconnectSafeStream,
    HttpStatusError,
    registerLocalJsonRoute,
    sendJson,
    type LocalRouteMiddlewareStack,
    type ViteHttpResponse,
} from "../vite-http-utils";
import {
    discoverLedgerSweepCatalog,
    resolveLedgerSweepFolder,
    type LedgerSweepFolderCatalogEntry,
    type LedgerSweepRuleCatalogEntry,
} from "./trade-ledger-sweep-catalog";
import { resolveLedgerSweepPreflight, type LedgerSweepPreflightDecision } from "./trade-ledger-sweep-preflight";
import {
    createEmptyLedgerSweepDiagnostics,
    type LedgerSweepMode,
} from "./trade-ledger-sweep-diagnostics";
import {
    assertLedgerSweepWireEventIsScalar,
    type LedgerSweepStatusResponse,
    type LedgerSweepStatusRun,
    type LedgerSweepStreamEvent,
} from "./trade-ledger-sweep-stream-types";
import {
    runTradeLedgerSweepJob,
    type TradeLedgerSweepJobArgs,
} from "./trade-ledger-sweep-job";
import {
    getActiveWorkloads,
    releaseIfOwner,
    tryAcquire,
    type ResearchWorkloadToken,
} from "../server-research-job-coordinator";

export const TRADE_LEDGER_SWEEP_MAX_BODY_BYTES = 8 * 1024;

const RUN_OWNER_NONE = 0;
let runOwner = RUN_OWNER_NONE;
let runOwnerGeneration = 0;
let runOwnerRunId: string | null = null;
let activeAbortController: AbortController | null = null;
let activeCoordinatorToken: ResearchWorkloadToken | null = null;
let runState: LedgerSweepStatusRun | null = null;
let pendingStopRunId: string | null = null;
let serverRoot: string | null = null;
let jobRunner: (args: TradeLedgerSweepJobArgs) => Promise<void> = runTradeLedgerSweepJob;

function parseSweepRunId(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) throw new HttpStatusError(400, "runId must be a non-empty string.");
    const value = raw.trim();
    if (!isValidRunId(value)) throw new HttpStatusError(400, "runId contains invalid characters.");
    return value;
}

function assertExactBody(body: Record<string, unknown>, keys: readonly string[]): void {
    const allowed = new Set(keys);
    for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new HttpStatusError(400, `Unknown request property: ${key}.`);
    }
}

function relativeToServerRoot(absolutePath: string): string {
    const root = path.resolve(serverRoot ?? process.cwd());
    return path.relative(root, absolutePath).replace(/\\/g, "/");
}

function formatSweepStamp(ms: number): string {
    const date = new Date(ms);
    const pad = (value: number) => String(value).padStart(2, "0");
    return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function isStrictChild(parent: string, child: string): boolean {
    const relative = path.relative(parent, child);
    return relative !== ""
        && relative !== ".."
        && !relative.startsWith(`..${path.sep}`)
        && !path.isAbsolute(relative);
}

async function buildOutputPaths(folderPath: string, runId: string): Promise<{ absolutePath: string; outputDir: string }> {
    const canonicalFolder = await realpath(folderPath);
    const sweepsPath = path.resolve(canonicalFolder, "sweeps");
    if (existsSync(sweepsPath)) {
        const canonicalSweeps = await realpath(sweepsPath);
        if (!isStrictChild(canonicalFolder, canonicalSweeps)) {
            throw new HttpStatusError(400, "Sweep output path escaped the selected ledger folder.");
        }
    }
    const outputPath = path.resolve(sweepsPath, `${formatSweepStamp(Date.now())}_${runId}`);
    if (!isStrictChild(canonicalFolder, sweepsPath) || !isStrictChild(canonicalFolder, outputPath)) {
        throw new HttpStatusError(400, "Sweep output path escaped the selected ledger folder.");
    }
    if (existsSync(outputPath)) throw new HttpStatusError(409, "A sweep output directory already exists for this run.");
    return { absolutePath: outputPath, outputDir: relativeToServerRoot(outputPath) };
}

function createInitialRun(args: {
    runId: string;
    folder: LedgerSweepFolderCatalogEntry;
    mode: LedgerSweepMode;
    modeReason: string;
    preflight: LedgerSweepPreflightDecision;
    outputDir: string;
    rules: LedgerSweepRuleCatalogEntry[];
}): LedgerSweepStatusRun {
    const diagnostics = createEmptyLedgerSweepDiagnostics({
        runId: args.runId,
        mode: args.mode,
        preflight: args.preflight,
        input: {
            folderId: args.folder.folderId,
            folderName: args.folder.name,
            ledgerBytes: args.folder.ledgerBytes,
            rankBytes: args.folder.rankBytes,
            ruleCount: args.rules.length,
        },
    });
    return {
        runId: args.runId,
        folderId: args.folder.folderId,
        folderName: args.folder.name,
        mode: args.mode,
        modeReason: args.modeReason,
        phase: "preflight",
        startedAt: Date.now(),
        finishedAt: null,
        totalRules: args.rules.length,
        completedRules: 0,
        currentRuleId: null,
        elapsedMs: 0,
        percent: 0,
        results: [],
        diagnostics,
        summary: null,
        outputDir: args.outputDir,
        error: null,
    };
}

function updateState(generation: number, patch: Partial<LedgerSweepStatusRun>): void {
    if (runOwner !== generation || !runState) return;
    Object.assign(runState, patch);
}

function upsertResult(results: LedgerSweepStatusRun["results"], result: LedgerSweepStatusRun["results"][number]): void {
    const index = results.findIndex((current) => current.ruleId === result.ruleId);
    if (index >= 0) results[index] = result;
    else results.push(result);
}

function acceptJobEvent(generation: number, event: LedgerSweepStreamEvent): void {
    if (runOwner !== generation || !runState || event.runId !== runState.runId) return;
    assertLedgerSweepWireEventIsScalar(event);
    if (event.type === "phase") {
        updateState(generation, { phase: event.phase, elapsedMs: event.elapsedMs, completedRules: event.completedRules });
    } else if (event.type === "progress") {
        updateState(generation, {
            phase: event.phase,
            percent: event.percent,
            elapsedMs: event.elapsedMs,
            completedRules: event.completedRules,
            currentRuleId: event.currentRuleId,
        });
    } else if (event.type === "rule_start") {
        updateState(generation, { phase: "rule_replay", currentRuleId: event.ruleId });
    } else if (event.type === "rule_result") {
        upsertResult(runState.results, event.result);
        updateState(generation, { completedRules: runState.results.length, currentRuleId: null });
    } else if (event.type === "diagnostics") {
        const sample = event.entry.metrics.sample;
        if (sample && typeof sample === "object") {
            const typedSample = sample as typeof runState.diagnostics.memory.samples[number];
            runState.diagnostics.memory.samples.push(typedSample);
            if (event.entry.group === "memory"
                && (!runState.diagnostics.memory.workerPeak || typedSample.maxRss > runState.diagnostics.memory.workerPeak.maxRss)) {
                runState.diagnostics.memory.workerPeak = typedSample;
            }
        }
        if (event.entry.group === "progress" && Array.isArray(event.entry.metrics.errors)) {
            runState.diagnostics.errors.push(...event.entry.metrics.errors as string[]);
        }
    } else if (event.type === "done" || event.type === "cancelled" || event.type === "fatal") {
        updateState(generation, {
            phase: event.type,
            finishedAt: event.finishedAt,
            elapsedMs: Math.max(0, event.finishedAt - runState.startedAt),
            percent: event.type === "done" ? 100 : runState.percent,
            completedRules: event.results.length,
            currentRuleId: null,
            results: [...event.results],
            diagnostics: event.diagnostics,
            summary: event.summary,
            error: event.type === "fatal" ? event.error : null,
        });
    }
}

async function handleCatalogRequest(res: ViteHttpResponse): Promise<void> {
    const root = serverRoot ?? process.cwd();
    const catalog = await discoverLedgerSweepCatalog(root);
    sendJson(res, 200, {
        ok: true,
        catalogRoot: catalog.catalogRoot,
        generatedAt: Date.now(),
        folders: catalog.folders,
        rules: catalog.rules,
        activeWorkloads: getActiveWorkloads(),
    });
}

async function handleRunRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    assertExactBody(body, ["runId", "folderId"]);
    const runId = parseSweepRunId(body.runId);
    if (typeof body.folderId !== "string" || !body.folderId.trim()) {
        throw new HttpStatusError(400, "folderId must be a non-empty string.");
    }
    const root = serverRoot ?? process.cwd();
    const catalog = await discoverLedgerSweepCatalog(root);
    const folder = await resolveLedgerSweepFolder(root, body.folderId.trim(), catalog);
    if (!folder) throw new HttpStatusError(400, "Unknown or unsafe ledger folder.");
    if (!folder.entry.runnable) throw new HttpStatusError(400, folder.entry.refusalReason ?? "Ledger folder is not runnable.");
    if (catalog.rules.length === 0) throw new HttpStatusError(400, "No valid TypeScript rules were discovered.");
    const output = await buildOutputPaths(folder.absolutePath, runId);

    if (runOwner !== RUN_OWNER_NONE) throw new HttpStatusError(409, "A Ledger Sweep is already running. Use Stop first.");
    const coordinatorToken = tryAcquire("ledger_sweep", runId);
    if (!coordinatorToken) throw new HttpStatusError(409, "A Batch, Finder, or Ledger Sweep operation is already running.");

    const generation = ++runOwnerGeneration;
    runOwner = generation;
    runOwnerRunId = runId;
    activeCoordinatorToken = coordinatorToken;
    const preflight = resolveLedgerSweepPreflight(folder.entry.rows ?? 0);
    if (preflight.decision === "refuse") {
        runOwner = RUN_OWNER_NONE;
        runOwnerRunId = null;
        activeCoordinatorToken = null;
        releaseIfOwner(coordinatorToken);
        throw new HttpStatusError(507, preflight.reason);
    }
    const startedAt = Date.now();
    runState = createInitialRun({
        runId,
        folder: folder.entry,
        mode: preflight.decision,
        modeReason: preflight.reason,
        preflight,
        outputDir: output.outputDir,
        rules: catalog.rules,
    });
    runState.startedAt = startedAt;
    const abortController = new AbortController();
    activeAbortController = abortController;
    if (pendingStopRunId === runId) {
        pendingStopRunId = null;
        abortController.abort();
    }
    const stream = createDisconnectSafeStream(res);
    let terminal = false;
    try {
        await jobRunner({
            runId,
            folder: folder.entry,
            rules: catalog.rules,
            mode: preflight.decision,
            modeReason: preflight.reason,
            preflight,
            folderAbsolutePath: folder.absolutePath,
            rulesAbsolutePath: path.join(root, "archive", "mining-ledger", "rules"),
            outputAbsolutePath: output.absolutePath,
            outputDir: output.outputDir,
            workerAbsolutePath: path.resolve(root, "scripts", "trade-ledger-sweep-worker.ts"),
            signal: abortController.signal,
            emit: (event) => {
                acceptJobEvent(generation, event);
                if (event.type === "done" || event.type === "cancelled" || event.type === "fatal") terminal = true;
                stream.write(event);
            },
            update: (patch) => updateState(generation, patch),
        });
        if (!terminal) {
            const finishedAt = Date.now();
            const error = "Ledger Sweep job ended without a terminal event.";
            const fatal: LedgerSweepStreamEvent = {
                type: "fatal",
                runId,
                ok: false,
                cancelled: false,
                finishedAt,
                error,
                summary: null,
                results: runState?.results ?? [],
                diagnostics: runState?.diagnostics ?? createEmptyLedgerSweepDiagnostics({ runId, mode: preflight.decision, preflight }),
                outputDir: output.outputDir,
            };
            acceptJobEvent(generation, fatal);
            stream.write(fatal);
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const finishedAt = Date.now();
        const fatal: LedgerSweepStreamEvent = {
            type: "fatal",
            runId,
            ok: false,
            cancelled: false,
            finishedAt,
            error: message,
            summary: null,
            results: runState?.results ?? [],
            diagnostics: runState?.diagnostics ?? createEmptyLedgerSweepDiagnostics({ runId, mode: preflight.decision, preflight }),
            outputDir: output.outputDir,
        };
        acceptJobEvent(generation, fatal);
        stream.write(fatal);
    } finally {
        stream.end();
        if (activeAbortController === abortController) activeAbortController = null;
        if (runOwner === generation) {
            runOwner = RUN_OWNER_NONE;
            runOwnerRunId = null;
        }
        if (activeCoordinatorToken === coordinatorToken) {
            activeCoordinatorToken = null;
            releaseIfOwner(coordinatorToken);
        }
    }
}

async function handleStopRequest(rawRunId: unknown): Promise<{ ok: boolean; stopped: boolean }> {
    const runId = parseSweepRunId(rawRunId);
    if (runOwner !== RUN_OWNER_NONE) {
        if (runOwnerRunId !== runId) return { ok: false, stopped: false };
        activeAbortController?.abort();
        return { ok: true, stopped: true };
    }
    pendingStopRunId = runId;
    return { ok: true, stopped: false };
}

function handleStatusRequest(rawRunId: unknown): LedgerSweepStatusResponse {
    const runId = parseSweepRunId(rawRunId);
    if (!runState || runState.runId !== runId) {
        return { ok: true, runMismatch: true, running: false, activeWorkloads: getActiveWorkloads(), run: null, lastRun: null };
    }
    const running = runOwner !== RUN_OWNER_NONE && runOwnerRunId === runId;
    return {
        ok: true,
        runMismatch: false,
        running,
        activeWorkloads: getActiveWorkloads(),
        run: running ? runState : null,
        lastRun: running ? null : runState,
    };
}

export function tradeLedgerSweepVitePlugin(): Plugin {
    return {
        name: "trade-ledger-sweep",
        configureServer(server) {
            serverRoot = server.config.root ?? process.cwd();
            registerTradeLedgerSweepRoutes(server.middlewares);
        },
        configurePreviewServer(server) {
            serverRoot = server.config.root ?? process.cwd();
            registerTradeLedgerSweepRoutes(server.middlewares);
        },
    };
}

export function registerTradeLedgerSweepRoutes(middlewares: LocalRouteMiddlewareStack): void {
    const unauthorizedMessage = "Unauthorized: trade-ledger sweep routes are local-only.";
    registerLocalJsonRoute(middlewares, "/api/trade-ledger-sweep/catalog", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: async ({ res }) => handleCatalogRequest(res),
    });
    registerLocalJsonRoute(middlewares, "/api/trade-ledger-sweep/run", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: TRADE_LEDGER_SWEEP_MAX_BODY_BYTES,
        unauthorizedMessage,
        onAuthorized: async ({ res, body }) => handleRunRequest(res, body),
    });
    registerLocalJsonRoute(middlewares, "/api/trade-ledger-sweep/stop", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: TRADE_LEDGER_SWEEP_MAX_BODY_BYTES,
        unauthorizedMessage,
        onAuthorized: async ({ res, body }) => {
            assertExactBody(body, ["runId"]);
            sendJson(res, 200, await handleStopRequest(body.runId));
        },
    });
    registerLocalJsonRoute(middlewares, "/api/trade-ledger-sweep/status", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: ({ res, url }) => sendJson(res, 200, handleStatusRequest(url.searchParams.get("runId"))),
    });
}

export const __testInternals = {
    registerTradeLedgerSweepRoutesForTests: registerTradeLedgerSweepRoutes,
    handleCatalogRequest,
    handleRunRequest,
    handleStopRequest,
    handleStatusRequest,
    acceptJobEventForTests: acceptJobEvent,
    parseSweepRunId,
    setServerRootForTests(root: string | null): void { serverRoot = root; },
    setJobRunnerForTests(runner: typeof jobRunner): void { jobRunner = runner; },
    resetForTests(): void {
        runOwner = RUN_OWNER_NONE;
        runOwnerRunId = null;
        activeAbortController = null;
        activeCoordinatorToken = null;
        runState = null;
        pendingStopRunId = null;
        jobRunner = runTradeLedgerSweepJob;
    },
    getRunStateForTests(): LedgerSweepStatusRun | null { return runState; },
    getPendingStopRunIdForTests(): string | null { return pendingStopRunId; },
    getRunOwnerForTests(): number { return runOwner; },
};
