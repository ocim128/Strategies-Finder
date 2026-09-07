import type { Plugin } from "vite";
import path from "node:path";
import { createDisconnectSafeStream, HttpStatusError, registerLocalJsonRoute, sendJson, type LocalRouteMiddlewareStack, type ViteHttpResponse } from "../vite-http-utils";
import { discoverSelectionRulesCatalog, resolveSelectionRulesFolder } from "./catalog";
import { pairSelectionRuleRegistry } from "../pair-selection/registry";
import {
    createSelectionRulesCancelledEvent,
    createSelectionRulesFatalEvent,
    runSelectionRulesJob,
    type SelectionRulesJobArgs,
} from "./job";
import {
    assertSelectionRulesWireEventIsScalar,
    type SelectionRuleResult,
    type SelectionRulesStatusResponse,
    type SelectionRulesStatusRun,
    type SelectionRulesStreamEvent,
} from "./stream-types";

export const SELECTION_RULES_MAX_BODY_BYTES = 8 * 1024;

const RUN_OWNER_NONE = 0;
let runOwner = RUN_OWNER_NONE;
let runOwnerGeneration = 0;
let runOwnerRunId: string | null = null;
let activeAbortController: AbortController | null = null;
let runState: SelectionRulesStatusRun | null = null;
let pendingStopRunId: string | null = null;
let serverRoot: string | null = null;
let jobRunner: (args: SelectionRulesJobArgs) => Promise<void> = runSelectionRulesJob;
let archiveLoaderOverride: SelectionRulesJobArgs["loadArchive"] | null = null;

function parseRunId(raw: unknown): string {
    if (typeof raw !== "string" || !raw.trim()) throw new HttpStatusError(400, "runId must be a non-empty string.");
    const value = raw.trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(value)) throw new HttpStatusError(400, "runId contains invalid characters.");
    return value;
}

function assertExactBody(body: Record<string, unknown>, keys: readonly string[]): void {
    const allowed = new Set(keys);
    for (const key of Object.keys(body)) {
        if (!allowed.has(key)) throw new HttpStatusError(400, `Unknown request property: ${key}.`);
    }
}

function parseRuleKeys(raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length === 0) {
        throw new HttpStatusError(400, "ruleKeys must be a non-empty array.");
    }
    const keys = raw.map((value, index) => {
        if (typeof value !== "string" || !value.trim()) {
            throw new HttpStatusError(400, `ruleKeys[${index}] must be a non-empty string.`);
        }
        return value.trim();
    });
    if (new Set(keys).size !== keys.length) throw new HttpStatusError(400, "ruleKeys must not contain duplicates.");
    const unknown = keys.filter((key) => !pairSelectionRuleRegistry.has(key));
    if (unknown.length > 0) throw new HttpStatusError(400, `Unknown pair-selection rule: ${unknown[0]}.`);
    return keys;
}

function initialRun(runId: string, folderPath: string, totalRules: number): SelectionRulesStatusRun {
    return {
        runId,
        folderPath,
        startedAt: Date.now(),
        finishedAt: null,
        phase: "loading",
        totalRules,
        completedRules: 0,
        currentRuleKey: null,
        currentHorizonBars: null,
        results: [],
        reportLines: [],
        diagnosticsLines: [],
        summary: null,
        error: null,
    };
}

function updateState(generation: number, patch: Partial<SelectionRulesStatusRun>): void {
    if (runOwner !== generation || !runState) return;
    Object.assign(runState, patch);
}

function resultKey(result: SelectionRuleResult): string {
    return `${result.ruleKey}|${result.horizonBars}`;
}

function upsertResult(results: SelectionRuleResult[], result: SelectionRuleResult): void {
    const index = results.findIndex((current) => resultKey(current) === resultKey(result));
    if (index >= 0) results[index] = result;
    else results.push(result);
}

function acceptJobEvent(generation: number, event: SelectionRulesStreamEvent): void {
    if (runOwner !== generation || !runState || event.runId !== runState.runId) return;
    assertSelectionRulesWireEventIsScalar(event);
    if (event.type === "start") {
        updateState(generation, { totalRules: event.totalRules, phase: "loading" });
        return;
    }
    if (event.type === "phase") {
        updateState(generation, {
            phase: event.phase,
            completedRules: event.completedRules,
            currentRuleKey: event.currentRuleKey,
            currentHorizonBars: event.currentHorizonBars,
        });
        return;
    }
    if (event.type === "rule_result") {
        upsertResult(runState.results, event.result);
        updateState(generation, {
            phase: "tallying",
            completedRules: event.completedRules,
            currentRuleKey: event.result.ruleKey,
            currentHorizonBars: event.result.horizonBars,
            reportLines: runState.results.flatMap((result) => result.reportLines),
        });
        return;
    }
    updateState(generation, {
        phase: event.type,
        finishedAt: event.finishedAt,
        completedRules: event.summary?.completedRules ?? runState.completedRules,
        currentRuleKey: null,
        currentHorizonBars: null,
        results: [...event.results],
        reportLines: [...event.reportLines],
        diagnosticsLines: [...event.diagnosticsLines],
        summary: event.summary,
        error: event.type === "fatal" ? event.error : null,
    });
}

function currentResults(): SelectionRuleResult[] {
    return runState ? [...runState.results] : [];
}

function currentReportLines(): string[] {
    return runState ? [...runState.reportLines] : [];
}

function currentDiagnosticsLines(): string[] {
    return runState ? [...runState.diagnosticsLines] : [];
}

function statusResponse(runId: string): SelectionRulesStatusResponse {
    if (!runState || runState.runId !== runId) {
        return { ok: true, runMismatch: true, running: false, run: null, lastRun: null };
    }
    const running = runOwner !== RUN_OWNER_NONE && runOwnerRunId === runId;
    const snapshot = {
        ...runState,
        results: [...runState.results],
        reportLines: [...runState.reportLines],
        diagnosticsLines: [...runState.diagnosticsLines],
        summary: runState.summary
            ? { ...runState.summary, results: [...runState.summary.results], reportLines: [...runState.summary.reportLines] }
            : null,
    };
    return { ok: true, runMismatch: false, running, run: running ? snapshot : null, lastRun: running ? null : snapshot };
}

async function handleCatalogRequest(res: ViteHttpResponse): Promise<void> {
    const root = serverRoot ?? process.cwd();
    const catalog = await discoverSelectionRulesCatalog(root);
    sendJson(res, 200, {
        ok: true,
        catalogRoot: path.relative(root, catalog.catalogRoot).replace(/\\/g, "/"),
        generatedAt: Date.now(),
        folders: catalog.folders,
        rules: [...pairSelectionRuleRegistry.values()].map((rule) => ({
            key: rule.key,
            name: rule.name,
            description: rule.description,
        })),
    });
}

function orderedRules(ruleKeys: readonly string[]) {
    const selected = new Set(ruleKeys);
    return [...pairSelectionRuleRegistry.values()].filter((rule) => selected.has(rule.key));
}

async function handleRunRequest(res: ViteHttpResponse, body: Record<string, unknown>): Promise<void> {
    assertExactBody(body, ["runId", "folderPath", "ruleKeys", "horizonBars"]);
    const runId = parseRunId(body.runId);
    if (typeof body.folderPath !== "string" || !body.folderPath.trim()) {
        throw new HttpStatusError(400, "folderPath must be a non-empty string.");
    }
    let horizonBars: number | undefined;
    if (body.horizonBars !== undefined) {
        if (typeof body.horizonBars !== "number" || !Number.isInteger(body.horizonBars) || body.horizonBars <= 0) {
            throw new HttpStatusError(400, "horizonBars must be a positive integer.");
        }
        horizonBars = body.horizonBars;
    }
    const ruleKeys = parseRuleKeys(body.ruleKeys);
    const rules = orderedRules(ruleKeys);
    const root = serverRoot ?? process.cwd();
    const folder = await resolveSelectionRulesFolder(root, body.folderPath.trim());
    if (!folder) throw new HttpStatusError(400, "Unknown or unsafe selection-rules archive folder.");
    if (horizonBars !== undefined && !folder.entry.ledgerHorizons.includes(horizonBars)) {
        throw new HttpStatusError(400, `horizonBars ${horizonBars} is not present in folder provenance (available: ${folder.entry.ledgerHorizons.join(", ")}).`);
    }
    if (runOwner !== RUN_OWNER_NONE) throw new HttpStatusError(409, "Selection Rules is already running. Use Stop first.");

    const generation = ++runOwnerGeneration;
    runOwner = generation;
    runOwnerRunId = runId;
    runState = initialRun(runId, body.folderPath.trim(), rules.length);
    const abortController = new AbortController();
    activeAbortController = abortController;
    if (pendingStopRunId === runId) {
        pendingStopRunId = null;
        abortController.abort();
    }

    const stream = createDisconnectSafeStream(res);
    let terminal = false;
    const emit = (event: SelectionRulesStreamEvent): void => {
        if (runOwner !== generation || runOwnerRunId !== runId) return;
        acceptJobEvent(generation, event);
        if (event.type === "done" || event.type === "cancelled" || event.type === "fatal") terminal = true;
        stream.write(event);
    };
    const jobArgs: SelectionRulesJobArgs = {
        runId,
        folderPath: body.folderPath.trim(),
        archiveFolderPath: folder.absolutePath,
        horizonBars,
        rules,
        signal: abortController.signal,
        loadArchive: archiveLoaderOverride ?? undefined,
        emit,
        update: (patch) => updateState(generation, patch),
    };

    try {
        emit({
            type: "start",
            runId,
            folderPath: body.folderPath.trim(),
            totalRules: rules.length,
            startedAt: runState.startedAt,
        });
        await jobRunner(jobArgs);
        if (!terminal) {
            const event = abortController.signal.aborted
                ? createSelectionRulesCancelledEvent(jobArgs, currentResults(), currentReportLines(), currentDiagnosticsLines())
                : createSelectionRulesFatalEvent(jobArgs, currentResults(), currentReportLines(), "Selection Rules job ended without a terminal event.", currentDiagnosticsLines());
            emit(event);
        }
    } catch (error) {
        const event = abortController.signal.aborted
            ? createSelectionRulesCancelledEvent(jobArgs, currentResults(), currentReportLines(), currentDiagnosticsLines())
            : createSelectionRulesFatalEvent(jobArgs, currentResults(), currentReportLines(), error instanceof Error ? error.message : String(error), currentDiagnosticsLines());
        if (!terminal) emit(event);
    } finally {
        // Keep this teardown synchronous and generation-scoped. A future run
        // can install its own owner/state without an old finally clobbering it.
        stream.end();
        if (runOwner !== generation) return;
        if (activeAbortController === abortController) activeAbortController = null;
        runOwner = RUN_OWNER_NONE;
        runOwnerRunId = null;
    }
}

async function handleStopRequest(rawRunId: unknown): Promise<{ ok: boolean; stopped: boolean }> {
    const requestedRunId = parseRunId(rawRunId);
    const active = runOwner !== RUN_OWNER_NONE;
    if (active && runOwnerRunId !== requestedRunId) return { ok: false, stopped: false };
    if (active) {
        activeAbortController?.abort();
        return { ok: true, stopped: true };
    }
    if (runState?.runId !== requestedRunId) pendingStopRunId = requestedRunId;
    return { ok: true, stopped: false };
}

function handleStatusRequest(rawRunId: unknown): SelectionRulesStatusResponse {
    return statusResponse(parseRunId(rawRunId));
}

export function selectionRulesVitePlugin(): Plugin {
    return {
        name: "selection-rules",
        configureServer(server) {
            serverRoot = server.config.root ?? process.cwd();
            registerSelectionRulesRoutes(server.middlewares);
        },
        configurePreviewServer(server) {
            serverRoot = server.config.root ?? process.cwd();
            registerSelectionRulesRoutes(server.middlewares);
        },
    };
}

export function registerSelectionRulesRoutes(middlewares: LocalRouteMiddlewareStack): void {
    const unauthorizedMessage = "Unauthorized: selection-rules routes are local-only.";
    registerLocalJsonRoute(middlewares, "/api/selection-rules/catalog", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: async ({ res }) => handleCatalogRequest(res),
    });
    registerLocalJsonRoute(middlewares, "/api/selection-rules/run", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: SELECTION_RULES_MAX_BODY_BYTES,
        unauthorizedMessage,
        onAuthorized: async ({ res, body }) => handleRunRequest(res, body),
    });
    registerLocalJsonRoute(middlewares, "/api/selection-rules/stop", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: SELECTION_RULES_MAX_BODY_BYTES,
        unauthorizedMessage,
        onAuthorized: async ({ res, body }) => {
            assertExactBody(body, ["runId"]);
            sendJson(res, 200, await handleStopRequest(body.runId));
        },
    });
    registerLocalJsonRoute(middlewares, "/api/selection-rules/status", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: ({ res, url }) => sendJson(res, 200, handleStatusRequest(url.searchParams.get("runId"))),
    });
}

export const __testInternals = {
    registerSelectionRulesRoutesForTests: registerSelectionRulesRoutes,
    handleCatalogRequest,
    handleRunRequest,
    handleStopRequest,
    handleStatusRequest,
    parseRunId,
    consumePendingStopForRun(runId: string): boolean {
        if (pendingStopRunId !== runId) return false;
        pendingStopRunId = null;
        return true;
    },
    setServerRootForTests(root: string | null): void { serverRoot = root; },
    setJobRunnerForTests(runner: typeof jobRunner): void { jobRunner = runner; },
    setArchiveLoaderForTests(loader: SelectionRulesJobArgs["loadArchive"] | null): void { archiveLoaderOverride = loader; },
    resetForTests(): void {
        runOwner = RUN_OWNER_NONE;
        runOwnerRunId = null;
        activeAbortController = null;
        runState = null;
        pendingStopRunId = null;
        jobRunner = runSelectionRulesJob;
        archiveLoaderOverride = null;
    },
    getRunStateForTests(): SelectionRulesStatusRun | null { return runState; },
    getPendingStopRunIdForTests(): string | null { return pendingStopRunId; },
    getRunOwnerForTests(): number { return runOwner; },
    acceptJobEventForTests: acceptJobEvent,
};
