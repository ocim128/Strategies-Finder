/**
 * SP500 TOP_MEAN Vite server routes, split out of the core Batch plugin
 * (audit Finding 9).
 *
 * Core Batch (run/stop/status/open-score-usd + artifact store) and SP500
 * TOP_MEAN (run/stop/status/result + coordinator wiring) previously shared
 * one ~2.4k-line plugin file. TOP_MEAN already has dedicated modules
 * (sp500-top-mean-coordinator-engine, sp500-top-mean-artifact-store, the
 * stability/worker leaves); only the HTTP registration stayed in the Batch
 * plugin. This file owns that registration so the Batch reliability work has
 * a smaller review surface and TOP_MEAN request-limit changes have a clear
 * owner.
 *
 * Coupling note: `handleSp500TopMeanRunRequest` shares the Batch plugin's
 * owner-lock counters (`runOwner` / `minerOwner`) so a TOP_MEAN run and a
 * Batch run cannot execute simultaneously. The locks live in the Batch plugin
 * (they predate this split and are touched by ~20 sites there); this file
 * consumes them through the {@link BatchOwnerLocks} adapter so no mutable
 * `let` bindings cross module boundaries and no circular import is created.
 *
 * Leaf-safe: imports only from vite-http-utils (auth wrapper + stream), the
 * strategy library, the TOP_MEAN engine/artifact-store/limits leaves, and the
 * adapter interface. No transitive `lightweight-charts` reach, so this file
 * is safe to import from `vite.config.ts` (the documented bundle trap).
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import {
    createDisconnectSafeStream,
    HttpStatusError,
    registerLocalJsonRoute,
    sendJson,
    type LocalRouteMiddlewareStack,
    type ViteHttpResponse,
} from "../vite-http-utils";
import { strategies } from "../strategies/library";
import {
    TopMeanCoordinatorEngine,
    getActiveTopMeanCoordinatorEngine,
    type TopMeanCoordinatorRunRequest,
    type TopMeanStatusResponse,
} from "./sp500-top-mean-coordinator-engine";
import { getRunDir, isValidRunId, loadManifest } from "./sp500-top-mean-artifact-store";
import { validateTopMeanRequestLimits } from "./sp500-top-mean-request-limits";

/**
 * Adapter over the Batch plugin's owner-lock counters. The TOP_MEAN run handler
 * must participate in the same single-flight guarantee as Batch/OPEN_SCORE USD
 * (only one of batch / analysis / TOP_MEAN may run at a time), and it must
 * release its reservation if it still owns it when the run ends. The locks
 * themselves stay in the Batch plugin; this interface exposes only the three
 * operations the TOP_MEAN path needs.
 */
export interface BatchOwnerLocks {
    /** True when any of batch / analysis / TOP_MEAN is currently running. */
    isBusy(): boolean;
    /**
     * Reserve both the run and analysis locks for `runId`. Returns a token the
     * caller passes to {@link releaseIfStillOwner} on completion.
     */
    acquire(runId: string): BatchOwnerToken;
    /**
     * Release the run + analysis locks iff this caller still owns them (a
     * concurrent Stop or release-last-results may have already cleared them).
     */
    releaseIfStillOwner(token: BatchOwnerToken): void;
}

/** Opaque ownership token returned by {@link BatchOwnerLocks.acquire}. */
export interface BatchOwnerToken {
    readonly runOwner: number;
    readonly minerOwner: number;
}

/**
 * Shared dependencies the Batch plugin injects when registering TOP_MEAN routes.
 * Kept as a single object so the registration signature stays stable as new
 * shared helpers are added.
 */
export interface Sp500TopMeanRouteDeps {
    /** Body-size cap forwarded to `readJsonBody` on POST routes. */
    maxBodyBytes: number;
    /**
     * Loopback-origin capture, run after the auth gate passes on the mutating
     * /run route. Mirrors `rememberLocalApiOriginFromRequest` in the Batch
     * plugin (which derives the origin from the server's bound socket, not the
     * spoofable Host header).
     */
    rememberLocalApiOriginFromRequest: (req: { headers?: Record<string, unknown>; socket?: { localAddress?: string; localPort?: number } | null }) => void;
    /** Owner-lock adapter (see {@link BatchOwnerLocks}). */
    ownerLocks: BatchOwnerLocks;
}

/**
 * Install the four `/api/batch-backtest/sp500-top-mean/*` routes on the Vite
 * middleware stack. Each route uses `registerLocalJsonRoute` (audit Finding 8)
 * so the loopback-auth gate is structurally enforced — a `--host`ed / tunneled
 * dev server cannot drive a CPU-heavy TOP_MEAN run, cancel one, or read its
 * results from a remote caller.
 */
export function registerSp500TopMeanRoutes(
    middlewares: LocalRouteMiddlewareStack,
    deps: Sp500TopMeanRouteDeps,
): void {
    const unauthorizedMessage = "Unauthorized: batch routes are local-only.";

    registerLocalJsonRoute(middlewares, "/api/batch-backtest/sp500-top-mean/run", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: deps.maxBodyBytes,
        onAuthorizedRequest: (req) => deps.rememberLocalApiOriginFromRequest(req),
        unauthorizedMessage,
        onAuthorized: async ({ res, body }) => {
            await handleSp500TopMeanRunRequest(res, body, deps.ownerLocks);
        },
    });

    registerLocalJsonRoute(middlewares, "/api/batch-backtest/sp500-top-mean/stop", {
        methods: ["POST"],
        readBody: true,
        maxBodyBytes: deps.maxBodyBytes,
        unauthorizedMessage,
        onAuthorized: async ({ res, body }) => {
            const result = await handleSp500TopMeanStopRequest((body as { runId?: unknown })?.runId);
            sendJson(res, 200, result);
        },
    });

    registerLocalJsonRoute(middlewares, "/api/batch-backtest/sp500-top-mean/status", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: async ({ res, url }) => {
            const runIdParam = url.searchParams.get("runId");
            const runId = runIdParam && runIdParam.trim() ? runIdParam.trim() : undefined;
            const status = await handleSp500TopMeanStatusRequest(runId);
            const statusCode = "ok" in status && !status.ok ? 404 : 200;
            sendJson(res, statusCode, status);
        },
    });

    registerLocalJsonRoute(middlewares, "/api/batch-backtest/sp500-top-mean/result", {
        methods: ["GET"],
        unauthorizedMessage,
        onAuthorized: async ({ res, url }) => {
            const runIdParam = url.searchParams.get("runId");
            if (!runIdParam || !runIdParam.trim()) {
                sendJson(res, 400, { ok: false, error: "Missing required runId parameter" });
                return;
            }
            const result = await handleSp500TopMeanResultRequest(runIdParam.trim());
            sendJson(res, 200, result);
        },
    });
}

async function handleSp500TopMeanRunRequest(
    res: ViteHttpResponse,
    body: unknown,
    ownerLocks: BatchOwnerLocks,
): Promise<void> {
    if (!body || typeof body !== "object") {
        throw new HttpStatusError(400, "Request body must be a JSON object.");
    }
    const req = body as Partial<TopMeanCoordinatorRunRequest>;
    if (!req.runId || typeof req.runId !== "string") {
        throw new HttpStatusError(400, "Missing required string property: runId.");
    }
    if (!req.strategyKey || typeof req.strategyKey !== "string") {
        throw new HttpStatusError(400, "Missing required string property: strategyKey.");
    }
    if (!req.interval || typeof req.interval !== "string") {
        throw new HttpStatusError(400, "Missing required string property: interval.");
    }
    if (!req.pairListText?.trim() && req.interval !== "4h") {
        throw new HttpStatusError(400, "The default S&P 500 TOP_MEAN universe requires the 4h interval.");
    }
    // Semantic workload caps (shared leaf validator). Body-size alone is not a
    // substitute for rejecting huge horizon arrays / zero-or-fractional values /
    // pathological workerCount or maxPairs from direct callers or proxies.
    const limitCheck = validateTopMeanRequestLimits({
        horizons: req.horizons,
        workerCount: req.workerCount,
        maxPairs: req.maxPairs,
        stabilityStartDates: req.stabilityStartDates,
    });
    if (!limitCheck.ok) {
        throw new HttpStatusError(400, limitCheck.error);
    }
    req.horizons = limitCheck.value.horizons;
    if (limitCheck.value.workerCount !== undefined) {
        req.workerCount = limitCheck.value.workerCount;
    }
    if (limitCheck.value.maxPairs !== undefined) {
        req.maxPairs = limitCheck.value.maxPairs;
    }
    if (limitCheck.value.stabilityStartDates !== undefined) {
        req.stabilityStartDates = limitCheck.value.stabilityStartDates;
    }

    const strategy = strategies[req.strategyKey];
    if (!strategy) {
        throw new HttpStatusError(
            400,
            `Strategy "${req.strategyKey}" is not a built-in strategy. Worker pool execution requires built-in strategies registered in the manifest.`,
        );
    }

    if (ownerLocks.isBusy() || getActiveTopMeanCoordinatorEngine() !== null) {
        throw new HttpStatusError(409, "A batch, analysis, or TOP_MEAN operation is already running.");
    }

    // Optional decision-event date window for the phase-3 OPEN_SCORE USD
    // replay. Mirrors handleOpenScoreUsdRequest's parseBodyDateSec: YYYY-MM-DD
    // parses as UTC midnight; sampleTo adds 24h-1s so the whole end day is
    // inclusive. Malformed/blank -> null (no filter, full history).
    const parseBodyDateSec = (key: "sampleFrom" | "sampleTo", endOfDay = false): number | undefined => {
        const raw = (body as Record<string, unknown>)[key];
        if (typeof raw !== "string" || raw.trim() === "") return undefined;
        const ms = Date.parse(raw);
        if (!Number.isFinite(ms)) return undefined;
        return Math.floor(ms / 1000) + (endOfDay ? 24 * 3600 - 1 : 0);
    };
    const sampleFromSec = parseBodyDateSec("sampleFrom", false);
    const sampleToSec = parseBodyDateSec("sampleTo", true);

    const token = ownerLocks.acquire(req.runId);

    const stream = createDisconnectSafeStream(res);

    try {
        const engine = new TopMeanCoordinatorEngine({
            ...(req as TopMeanCoordinatorRunRequest),
            ...(sampleFromSec !== undefined ? { sampleFromSec } : {}),
            ...(sampleToSec !== undefined ? { sampleToSec } : {}),
        });
        await engine.run((event) => stream.write(event));
    } finally {
        ownerLocks.releaseIfStillOwner(token);
        stream.end();
    }
}

async function handleSp500TopMeanStopRequest(runId?: unknown): Promise<{ ok: boolean; stopped: boolean; runId?: string }> {
    const activeEngine = getActiveTopMeanCoordinatorEngine();
    if (!activeEngine) {
        return { ok: true, stopped: false };
    }
    if (typeof runId === "string" && runId.trim() && activeEngine.request.runId !== runId.trim()) {
        return { ok: true, stopped: false };
    }
    activeEngine.stop();
    return { ok: true, stopped: true, runId: activeEngine.request.runId };
}

async function handleSp500TopMeanStatusRequest(runId?: string): Promise<TopMeanStatusResponse | { ok: false; error: string }> {
    const activeEngine = getActiveTopMeanCoordinatorEngine();
    if (activeEngine && (!runId || activeEngine.request.runId === runId)) {
        return activeEngine.getStatus();
    }
    if (runId) {
        // Reject path-traversal / escape attempts before they reach the
        // filesystem. `getRunDir` defends this structurally too; this turns
        // it into a clean 404 (run not found) for malformed ids.
        if (!isValidRunId(runId)) {
            return { ok: false, error: "Run not found" };
        }
        const manifest = loadManifest(runId);
        if (manifest) {
            // Audit: read multi-MB result files ASYNC. The prior
            // `existsSync` + `readFileSync` blocked the Vite event loop on
            // every reattach poll (this route is hit every ~2s during a
            // TOP_MEAN stability run). A single multi-MB read stalled every
            // concurrent request. Mirrors the plugin's own audit comments
            // that moved artifact I/O to fs/promises for the same reason.
            // Drop `existsSync` (TOCTOU); distinguish missing via ENOENT.
            let result: unknown = undefined;
            const resultPath = join(getRunDir(runId), "result.json");
            try {
                const txt = await readFile(resultPath, "utf8");
                try { result = JSON.parse(txt); } catch { /* malformed JSON */ }
            } catch (err: unknown) {
                const code = (err as { code?: string })?.code;
                if (code !== "ENOENT") { /* unexpected I/O — surface elsewhere */ }
            }
            // Stability runs persist the comparison to stability_result.json
            // (no top-level result.json). Surface it as stabilityResult so the
            // browser reattach path renders the comparison table.
            let stabilityResult: unknown = undefined;
            const stabilityResultPath = join(getRunDir(runId), "stability_result.json");
            try {
                const txt = await readFile(stabilityResultPath, "utf8");
                try { stabilityResult = JSON.parse(txt); } catch { /* malformed JSON */ }
            } catch (err: unknown) {
                const code = (err as { code?: string })?.code;
                if (code !== "ENOENT") { /* unexpected I/O — surface elsewhere */ }
            }
            return {
                runId: manifest.runId,
                status: manifest.status,
                phase: manifest.status === "completed"
                    ? "completed"
                    : manifest.status === "interrupted"
                        ? "interrupted"
                        : "failed",
                fingerprint: manifest.fingerprint,
                pairTotals: manifest.pairCount,
                completedPairs: manifest.completedPairsCount,
                failedPairs: manifest.failedPairsCount,
                progressText: manifest.status === "completed" ? "Completed" : manifest.error || "Interrupted",
                workerCount: manifest.workerCount ?? 8,
                requestedEngineMode: manifest.requestedEngineMode ?? "auto",
                actualEngineMode: manifest.actualEngineMode ?? "auto",
                engineUsage: manifest.engineUsage ?? { rust: 0, typescript: 0 },
                error: manifest.error,
                // `result` / `stabilityResult` are untrusted JSON read from
                // disk; cast at the boundary rather than widening the parsed
                // locals, so the disk-read stays `unknown` and the response
                // shape stays the typed contract.
                result: result as TopMeanStatusResponse["result"],
                ...(stabilityResult !== undefined ? { stabilityResult: stabilityResult as NonNullable<TopMeanStatusResponse["stabilityResult"]> } : {}),
            };
        }
    }
    return { ok: false, error: "Run not found" };
}

async function handleSp500TopMeanResultRequest(runId: string): Promise<unknown> {
    if (!runId || typeof runId !== "string") {
        throw new HttpStatusError(400, "Missing runId parameter.");
    }
    // Reject path-traversal / escape attempts before they reach the filesystem.
    // `getRunDir` defends this structurally too; this turns it into a clean 400.
    if (!isValidRunId(runId)) {
        throw new HttpStatusError(400, "Invalid runId.");
    }
    const resultPath = join(getRunDir(runId), "result.json");
    let txt: string;
    try {
        txt = await readFile(resultPath, "utf8");
    } catch (err: unknown) {
        // TOCTOU-safe: distinguish "missing" (404) from "I/O error" (500).
        if ((err as { code?: string })?.code === "ENOENT") {
            throw new HttpStatusError(404, `Result for runId "${runId}" not found.`);
        }
        throw new HttpStatusError(500, "Failed to read result file.");
    }
    try {
        return JSON.parse(txt);
    } catch {
        throw new HttpStatusError(500, "Failed to read result file.");
    }
}
