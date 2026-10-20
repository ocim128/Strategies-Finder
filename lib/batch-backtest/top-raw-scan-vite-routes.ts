import { createDisconnectSafeStream, HttpStatusError, registerLocalJsonRoute, sendJson, type LocalRouteMiddlewareStack } from "../vite-http-utils";
import { strategies } from "../strategies/library";
import { parseIntervalSeconds } from "../interval-utils";
import { isValidRunId } from "./sp500-top-mean-artifact-store";
import type { Sp500TopMeanRouteDeps } from "./sp500-top-mean-vite-routes";
import { TopRawScanEngine } from "./top-raw-scan-engine";
import { ScanStore } from "./top-raw-scan-store";
import { parseScanAssets, scanBudget, validateScanOptions, TOP_RAW_SCAN_MAX_BYTES, type ScanRequest, type ScanStatus } from "./top-raw-scan-contract";
import { validateScanArm } from "./top-raw-scan-arms";

let active: TopRawScanEngine | null = null;
const terminalStatuses = new Map<string, ScanStatus>();
// A Stop can arrive while the run body is still uploading, i.e. before any
// owner exists. The marker below cancels exactly that one admission. It only
// ever stands for a request that is in flight, so it must not survive the
// window: Resume reuses the saved runId by design, and a marker left over from
// an earlier attempt would answer a legitimate Resume with 409.
const PENDING_STOP_TTL_MS = 60_000;
let pendingStop: { runId: string; armedAt: number } | null = null;
function armPendingStop(runId: string): void { pendingStop = { runId, armedAt: Date.now() }; }
function consumePendingStop(runId: string): boolean {
    if (!pendingStop) return false;
    const armed = pendingStop;
    if (armed.runId !== runId) return false;
    pendingStop = null;
    return Date.now() - armed.armedAt <= PENDING_STOP_TTL_MS;
}
export function stopActiveTopRawScan(runId: string | null): boolean {
    if (!runId || active?.request.runId !== runId) return false;
    active.stop(); return true;
}
export function validateScanRequest(body: unknown): ScanRequest {
    if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Expected a JSON request object.");
    const input = body as Record<string, unknown>;
    const allowed = new Set(["runId", "strategyKey", "strategyParams", "backtestSettings", "capitalSettings", "interval", "assetListText", "opponentsPerAsset", "finalistCount", "seed", "workerCount", "useRustEnginePreference", "resume", "arm"]);
    for (const key of Object.keys(input)) if (!allowed.has(key)) throw new Error(`Unsupported scan option: ${key}. Historical replay and cap tilt are unavailable.`);
    validateScanArm(input.arm);
    if (typeof input.runId !== "string" || !isValidRunId(input.runId)) throw new Error("Invalid runId.");
    if (typeof input.strategyKey !== "string" || !Object.hasOwn(strategies, input.strategyKey) || !strategies[input.strategyKey]) throw new Error("A built-in strategy is required.");
    if (typeof input.interval !== "string" || !parseIntervalSeconds(input.interval)) throw new Error("Invalid interval.");
    if (typeof input.assetListText !== "string") throw new Error("assetListText is required.");
    const assets = parseScanAssets(input.assetListText);
    const options = validateScanOptions(input); scanBudget(assets.assets.length, options);
    for (const key of ["strategyParams", "backtestSettings", "capitalSettings"]) {
        if (!input[key] || typeof input[key] !== "object" || Array.isArray(input[key])) throw new Error(`${key} must be an object.`);
    }
    if (input.workerCount !== undefined && (typeof input.workerCount !== "number" || !Number.isInteger(input.workerCount) || input.workerCount < 1 || input.workerCount > 32)) throw new Error("workerCount must be an integer in 1..32.");
    for (const key of ["resume", "useRustEnginePreference"]) if (input[key] !== undefined && typeof input[key] !== "boolean") throw new Error(`${key} must be boolean.`);
    return { ...input, ...options } as unknown as ScanRequest;
}
export async function readScanStatus(runId: string, store = new ScanStore()): Promise<ScanStatus | null> {
    if (active?.request.runId === runId) return active.getStatus();
    if (terminalStatuses.has(runId)) return terminalStatuses.get(runId)!;
    let manifest;
    try { manifest = await store.readManifest(runId); }
    catch (error) { return active?.request.runId === runId ? active.getStatus() : { runId, phase: "failed", completed: 0, total: 0, message: `Saved scan could not be restored: ${error instanceof Error ? error.message : String(error)}` }; }
    // Admission may have happened while the saved manifest was being read.
    if (active?.request.runId === runId) return active.getStatus();
    if (!manifest) {
        try {
            const reservation = await store.readReservation(runId);
            if (active?.request.runId === runId) return active.getStatus();
            if (!reservation) return null;
            return ["completed", "interrupted", "failed"].includes(reservation.status.phase) ? reservation.status
                : { ...reservation.status, phase: "interrupted", message: "Preflight interrupted. Resume with the saved cutoff and request." };
        } catch (error) { return active?.request.runId === runId ? active.getStatus() : { runId, phase: "failed", completed: 0, total: 0, message: `Saved preflight could not be restored: ${error instanceof Error ? error.message : String(error)}` }; }
    }
    if (!["completed", "interrupted", "failed"].includes(manifest.status.phase)) {
        manifest.status = { ...manifest.status, phase: "interrupted", message: "Server restarted. Resume the exact saved scan." };
        manifest.result.status = "interrupted"; manifest.result.globalRankingExact = false; manifest.result.bestVerifiedCandidates = [];
        // Status restoration is read-only: a concurrent Resume must never have
        // its checkpoint overwritten by this older disk snapshot.
    }
    return { ...manifest.status, result: manifest.result };
}
export function registerTopRawScanRoutes(middlewares: LocalRouteMiddlewareStack, deps: Sp500TopMeanRouteDeps): void {
    const prefix = "/api/batch-backtest/top-raw-scan/", unauthorizedMessage = "Unauthorized: batch routes are local-only.";
    registerLocalJsonRoute(middlewares, prefix + "run", {
        methods: ["POST"], readBody: true, maxBodyBytes: TOP_RAW_SCAN_MAX_BYTES + 64 * 1024, unauthorizedMessage,
        onAuthorizedRequest: req => deps.rememberLocalApiOriginFromRequest(req),
        onAuthorized: async ({ res, body }) => {
            let request: ScanRequest;
            try { request = validateScanRequest(body); } catch (error) { throw new HttpStatusError(400, error instanceof Error ? error.message : String(error)); }
            if (consumePendingStop(request.runId)) throw new HttpStatusError(409, "Scan stopped before ownership was acquired.");
            if (active || deps.ownerLocks.isBusy()) throw new HttpStatusError(409, "A Batch, TOP_MEAN, scan or Finder sweep is already running.");
            const token = deps.ownerLocks.acquire(request.runId);
            active = new TopRawScanEngine(request);
            const engine = active, stream = createDisconnectSafeStream(res);
            let released = false;
            const release = () => {
                if (released) return;
                released = true;
                if (active === engine) active = null;
                deps.ownerLocks.releaseIfStillOwner(token);
            };
            const settled = (status: ScanStatus) => {
                terminalStatuses.set(request.runId, status);
                while (terminalStatuses.size > 16) terminalStatuses.delete(terminalStatuses.keys().next().value!);
                release();
            };
            try {
                const status = await engine.run(value => stream.write({ type: "status", ...value }), settled);
                if (!released) settled(status);
                stream.write({ type: "done", ...status });
            } finally {
                release(); stream.end();
            }
        },
    });
    registerLocalJsonRoute(middlewares, prefix + "stop", {
        methods: ["POST"], readBody: true, maxBodyBytes: 4096, unauthorizedMessage,
        onAuthorized: ({ res, body }) => {
            const runId = (body as { runId?: unknown })?.runId;
            if (typeof runId !== "string" || !isValidRunId(runId)) throw new HttpStatusError(400, "A valid runId is required.");
            const stopped = stopActiveTopRawScan(runId);
            // Only an admission that has not taken ownership yet can be
            // pre-empted. A run that already settled has nothing left to
            // cancel, and arming it would block the next Resume of that id.
            if (!active && !terminalStatuses.has(runId)) armPendingStop(runId);
            sendJson(res, 200, { ok: true, stopped });
        },
    });
    for (const route of ["status", "result"] as const) registerLocalJsonRoute(middlewares, prefix + route, {
        methods: ["GET"], unauthorizedMessage,
        onAuthorized: async ({ res, url }) => {
            const runId = url.searchParams.get("runId");
            if (!runId || !isValidRunId(runId)) throw new HttpStatusError(400, "A valid runId is required.");
            // The atomic terminal manifest is authoritative. A staged result file
            // must not announce success before the final status write succeeds.
            const saved = await readScanStatus(runId);
            const status = active?.request.runId === runId ? active.getStatus() : saved;
            const value = route === "status" ? status : status && ["completed", "interrupted", "failed"].includes(status.phase) ? status.result : null;
            if (route === "result") res.setHeader("Content-Disposition", `attachment; filename="top_raw_scan_${runId}.json"`);
            sendJson(res, value ? 200 : 404, value ?? { error: "Scan not found." });
        },
    });
}
