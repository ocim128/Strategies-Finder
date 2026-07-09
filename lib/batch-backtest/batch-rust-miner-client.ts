/**
 * Rust miner client (Phase 4 acceleration).
 *
 * Narrow HTTP integration layer for a Rust/Rayon miner backend. Kept COMPLETELY
 * SEPARATE from `lib/rust-engine-client.ts` (the backtest engine client)
 * because:
 *   - the backtest engine lives at `http://127.0.0.1:3030` and consumes JSON
 *     OHLCV payloads; the miner backend may live elsewhere and MUST NOT receive
 *     multi-GB JSON artifact payloads (Phase 4 risk: "JSON arrays for full
 *     OHLCV/state payloads on large runs" is explicitly forbidden).
 *   - the miner backend reads compact artifacts from a server-controlled temp
 *     directory (file-manifest handoff), which is a different transport than
 *     the backtest engine's inline JSON.
 *
 * This module is a leaf: it imports only `debugLogger` and types. It does NOT
 * import from `lightweight-charts`, `finder-manager`, `data-manager`, or
 * anything that would pull browser-bound singletons into the Vite config
 * bundle path (see AGENTS.md "Server-side import hygiene").
 *
 * Fallback contract (plan §"Failure Handling"): every entrypoint returns a
 * structured `{ ok: false, reason }` on unavailable backend, schema mismatch,
 * timeout, or non-OK response. The server plugin (`batch-backtest-vite-plugin`)
 * routes to the TypeScript miner on any `ok: false` result.
 */

import { debugLogger } from "../debug-logger";
import type {
    BatchSyntheticAssetVerdict,
    BatchSyntheticMinerOptions,
} from "./batch-synthetic-state-miner";
import type { BatchStabilityMineResult } from "./batch-stability-mine";
import { COMPACT_MINER_ARTIFACT_SCHEMA_VERSION } from "./batch-miner-artifact";

// ---------------------------------------------------------------------------
// Transport + capability contract
// ---------------------------------------------------------------------------

/**
 * Transport strategies the Rust backend may support. The client prefers
 * `file_manifest` (Rust reads compact artifacts from the server temp dir) and
 * falls back to `binary` only when the backend reports no file access.
 *
 *   - `file_manifest`: request body lists artifact file paths + target payload.
 *     Rust reads local files and returns compact verdict/result payloads. Only
 *     enabled when the backend is local and trusted (plan §"Security").
 *   - `binary`: request body carries compact artifact bytes inline. Slower for
 *     large runs; used when file-manifest handoff is unavailable.
 */
export type RustMinerTransport = "file_manifest" | "binary";

/**
 * Health/capability response. Mirrors the plan's §"API And Contracts":
 * backend available, miner API version, supported compact artifact schema
 * version, supports Mine, supports Stability, supported transport(s).
 */
export interface RustMinerCapability {
    available: boolean;
    /** Miner API version (independent of the backtest engine's version). */
    minerApiVersion: string | null;
    /** Compact artifact schema version the backend understands. */
    compactArtifactSchemaVersion: number | null;
    supportsMine: boolean;
    supportsStability: boolean;
    transports: RustMinerTransport[];
    /** Raw version string from /health, if any. */
    backendVersion: string | null;
}

/**
 * A read-only view of where the compact artifacts live on disk. Built by the
 * server plugin from its temp artifact directory; passed to file-manifest
 * requests so Rust reads files directly instead of receiving inline bytes.
 */
export interface RustMinerFileManifest {
    /** Absolute paths to compact pair-artifact files the backend may read. */
    pairArtifactFiles: string[];
    /** Absolute paths to compact target OHLCV artifact files the backend must read. */
    targetArtifactFiles: string[];
    /** Optional directory containing the pair-artifact files. */
    artifactDirectory: string | null;
}

/**
 * Request for a one-shot Mine. The server plugin writes compact pair and
 * target artifacts to disk, so file-manifest handoff is the default transport.
 * Target metadata is inlined only for asset/symbol identity; candle payloads
 * stay in `manifest.targetArtifactFiles`.
 */
export interface RustMineRequest {
    interval: string;
    options: Partial<BatchSyntheticMinerOptions>;
    transport: RustMinerTransport;
    manifest: RustMinerFileManifest;
    /** Asset -> target symbol map. Candle payloads are in manifest.targetArtifactFiles. */
    targets: { asset: string; symbol: string }[];
}

export interface RustMineResponse {
    verdicts: BatchSyntheticAssetVerdict[];
    processingTimeMs: number;
}

/**
 * Request for a Stability Mine. Same transport options as one-shot Mine.
 * `subsetSize`, `reruns`, `seed` mirror the TypeScript Stability contract.
 */
export interface RustStabilityMineRequest extends RustMineRequest {
    subsetSize: number;
    reruns: number;
    seed: number;
}

export type RustStabilityMineResponse = BatchStabilityMineResult & {
    processingTimeMs: number;
};

// ---------------------------------------------------------------------------
// Result envelope (ok | fallback)
// ---------------------------------------------------------------------------

export type RustMinerFallbackReason =
    | "rust_unavailable"
    | "schema_mismatch"
    | "transport_unsupported"
    | "mine_not_supported"
    | "stability_not_supported"
    | "timeout"
    | "non_ok_response"
    | "decode_error";

export interface RustMinerOk<T> {
    ok: true;
    value: T;
}

export interface RustMinerFallback {
    ok: false;
    reason: RustMinerFallbackReason;
    message: string;
}

export type RustMinerResult<T> = RustMinerOk<T> | RustMinerFallback;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const DEFAULT_MINER_BASE_URL = "http://127.0.0.1:3031";
const HEALTH_TIMEOUT_MS = 2000;
const MINE_TIMEOUT_MS = 60_000;
const STABILITY_TIMEOUT_MS = 300_000;

/**
 * Client for the Rust miner backend. Construction is cheap; health checks are
 * cached for `healthCacheMs` to avoid hammering a down backend. All methods
 * resolve to a `RustMinerResult<T>` — they never throw on backend problems,
 * so the server plugin's fallback routing is a plain `if (!result.ok)`.
 */
export class RustMinerClient {
    private readonly baseUrl: string;
    private cachedCapability: RustMinerCapability | null = null;
    private capabilityExpiresAt = 0;
    private readonly healthCacheMs = 30_000;
    private readonly healthFailureBackoffMs = 5_000;

    constructor(baseUrl: string = DEFAULT_MINER_BASE_URL) {
        this.baseUrl = baseUrl.replace(/\/+$/, "");
    }

    /**
     * Probe the backend's health + capabilities. Cached for `healthCacheMs`
     * when healthy and for `healthFailureBackoffMs` when not, so a Stability
     * run with 50 reruns does not issue 50 health probes.
     */
    async checkCapability(): Promise<RustMinerCapability> {
        const now = Date.now();
        if (this.cachedCapability && now < this.capabilityExpiresAt) {
            return this.cachedCapability;
        }
        try {
            const response = await fetch(`${this.baseUrl}/api/miner/health`, {
                method: "GET",
                signal: AbortSignal.timeout(HEALTH_TIMEOUT_MS),
            });
            if (!response.ok) {
                return this.recordFailure(`health responded ${response.status}`);
            }
            const body = (await response.json()) as Partial<{
                status: string;
                minerApiVersion: unknown;
                compactArtifactSchemaVersion: unknown;
                supportsMine: unknown;
                supportsStability: unknown;
                transports: unknown;
                version: unknown;
            }>;
            if (body.status !== "healthy") {
                return this.recordFailure(`health status "${body.status}"`);
            }
            const capability: RustMinerCapability = {
                available: true,
                minerApiVersion: typeof body.minerApiVersion === "string" ? body.minerApiVersion : null,
                compactArtifactSchemaVersion: typeof body.compactArtifactSchemaVersion === "number" ? body.compactArtifactSchemaVersion : null,
                supportsMine: body.supportsMine === true,
                supportsStability: body.supportsStability === true,
                transports: parseTransports(body.transports),
                backendVersion: typeof body.version === "string" ? body.version : null,
            };
            this.cachedCapability = capability;
            this.capabilityExpiresAt = now + this.healthCacheMs;
            return capability;
        } catch (error) {
            return this.recordFailure(error instanceof Error ? error.message : String(error));
        }
    }

    /**
     * Run a one-shot Mine on the Rust backend. Returns `ok: false` with a
     * fallback reason if the backend is unavailable, does not support Mine,
     * rejects the compact schema version, or times out. The server plugin
     * routes to the TypeScript miner on any fallback.
     */
    async runMine(request: RustMineRequest): Promise<RustMinerResult<RustMineResponse>> {
        const gate = await this.gate("mine", request.transport);
        if (!gate.ok) return gate;
        try {
            const startedAt = Date.now();
            const response = await fetch(`${this.baseUrl}/api/miner/run`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(MINE_TIMEOUT_MS),
            });
            if (!response.ok) {
                return fallback("non_ok_response", `mine responded ${response.status} ${response.statusText}`);
            }
            const body = (await response.json()) as Partial<RustMineResponse>;
            if (!body || !Array.isArray(body.verdicts)) {
                return fallback("decode_error", "mine response missing verdicts array");
            }
            return ok({
                verdicts: body.verdicts as BatchSyntheticAssetVerdict[],
                processingTimeMs: typeof body.processingTimeMs === "number" ? body.processingTimeMs : (Date.now() - startedAt),
            });
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            // AbortError / timeout get the dedicated timeout reason so the
            // benchmark can distinguish "slow" from "broken".
            if (/timeout|abort/i.test(message)) {
                return fallback("timeout", `mine timed out: ${message}`);
            }
            return fallback("non_ok_response", `mine threw: ${message}`);
        }
    }

    /**
     * Run a Stability Mine on the Rust backend. The backend is expected to
     * return a full `BatchStabilityMineResult` (rows + scoring already
     * finalized) plus a `processingTimeMs` scalar. The server plugin passes
     * the result straight through to the browser on `ok`.
     */
    async runStabilityMine(request: RustStabilityMineRequest): Promise<RustMinerResult<RustStabilityMineResponse>> {
        const gate = await this.gate("stability", request.transport);
        if (!gate.ok) return gate;
        try {
            const response = await fetch(`${this.baseUrl}/api/miner/stability`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(request),
                signal: AbortSignal.timeout(STABILITY_TIMEOUT_MS),
            });
            if (!response.ok) {
                return fallback("non_ok_response", `stability responded ${response.status} ${response.statusText}`);
            }
            const body = (await response.json()) as Partial<RustStabilityMineResponse>;
            if (!body || !Array.isArray(body.rows)) {
                return fallback("decode_error", "stability response missing rows array");
            }
            return ok(body as RustStabilityMineResponse);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (/timeout|abort/i.test(message)) {
                return fallback("timeout", `stability timed out: ${message}`);
            }
            return fallback("non_ok_response", `stability threw: ${message}`);
        }
    }

    /**
     * Clear the cached capability so the next call re-probes. Used by tests
     * and by the server plugin when a run starts (so a backend that came up
     * after the last failure is picked up immediately).
     */
    invalidateCapabilityCache(): void {
        this.cachedCapability = null;
        this.capabilityExpiresAt = 0;
    }

    // -----------------------------------------------------------------------
    // Internal
    // -----------------------------------------------------------------------

    private async gate(
        kind: "mine" | "stability",
        transport: RustMinerTransport,
    ): Promise<RustMinerResult<never>> {
        const capability = await this.checkCapability();
        if (!capability.available) {
            return fallback("rust_unavailable", "rust miner backend not available");
        }
        if (capability.compactArtifactSchemaVersion !== COMPACT_MINER_ARTIFACT_SCHEMA_VERSION) {
            return fallback(
                "schema_mismatch",
                `compact schema mismatch: backend expects ${capability.compactArtifactSchemaVersion}, client has ${COMPACT_MINER_ARTIFACT_SCHEMA_VERSION}`,
            );
        }
        if (kind === "mine" && !capability.supportsMine) {
            return fallback("mine_not_supported", "backend does not support one-shot Mine");
        }
        if (kind === "stability" && !capability.supportsStability) {
            return fallback("stability_not_supported", "backend does not support Stability Mine");
        }
        if (!capability.transports.includes(transport)) {
            return fallback(
                "transport_unsupported",
                `backend does not support "${transport}" transport (supports ${capability.transports.join(", ") || "none"})`,
            );
        }
        // `never`-typed positive gate — callers ignore value on ok.
        return ok(undefined as never) as unknown as RustMinerResult<never>;
    }

    private recordFailure(message: string): RustMinerCapability {
        const capability: RustMinerCapability = {
            available: false,
            minerApiVersion: null,
            compactArtifactSchemaVersion: null,
            supportsMine: false,
            supportsStability: false,
            transports: [],
            backendVersion: null,
        };
        this.cachedCapability = capability;
        // Negative-cache for a shorter window so a backend that comes up
        // mid-session is picked up without a long delay.
        this.capabilityExpiresAt = Date.now() + this.healthFailureBackoffMs;
        debugLogger.warn("batch.rust_miner.unavailable", { message });
        return capability;
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function parseTransports(raw: unknown): RustMinerTransport[] {
    if (!Array.isArray(raw)) return [];
    const out: RustMinerTransport[] = [];
    for (const item of raw) {
        if (item === "file_manifest" || item === "binary") out.push(item);
    }
    return out;
}

function ok<T>(value: T): RustMinerOk<T> {
    return { ok: true, value };
}

function fallback(reason: RustMinerFallbackReason, message: string): RustMinerFallback {
    debugLogger.warn("batch.rust_miner.fallback", { reason, message });
    return { ok: false, reason, message };
}

// ---------------------------------------------------------------------------
// Singleton + convenience
// ---------------------------------------------------------------------------

/**
 * Global Rust miner client instance. The server plugin constructs its own
 * instance when it needs to inject a mock for tests, but the default singleton
 * is what production code uses.
 */
export const rustMiner = new RustMinerClient();

/**
 * Build a file-manifest request for the server plugin. The plugin owns the
 * artifact directory and the target loader; this helper just shapes the
 * request envelope so the plugin does not need to know the wire contract.
 */
export function buildFileManifestMineRequest(args: {
    interval: string;
    options: Partial<BatchSyntheticMinerOptions>;
    manifest: RustMinerFileManifest;
    targets: { asset: string; symbol: string }[];
}): RustMineRequest {
    return {
        interval: args.interval,
        options: args.options,
        transport: "file_manifest",
        manifest: args.manifest,
        targets: args.targets,
    };
}

/**
 * Build a file-manifest Stability request. Adds the subset/reruns/seed scalars
 * the backend needs to reproduce the TypeScript Stability sampling.
 */
export function buildFileManifestStabilityRequest(args: {
    interval: string;
    options: Partial<BatchSyntheticMinerOptions>;
    manifest: RustMinerFileManifest;
    targets: { asset: string; symbol: string }[];
    subsetSize: number;
    reruns: number;
    seed: number;
}): RustStabilityMineRequest {
    return {
        ...buildFileManifestMineRequest(args),
        subsetSize: args.subsetSize,
        reruns: args.reruns,
        seed: args.seed,
    };
}
