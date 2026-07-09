import { expect } from "chai";
import { describe, it } from "node:test";
import {
    RustMinerClient,
    buildFileManifestMineRequest,
    buildFileManifestStabilityRequest,
    type RustMinerCapability,
    type RustMinerResult,
    type RustStabilityMineRequest,
    type RustStabilityMineResponse,
} from "../lib/batch-backtest/batch-rust-miner-client";
import { COMPACT_MINER_ARTIFACT_SCHEMA_VERSION } from "../lib/batch-backtest/batch-miner-artifact";

/**
 * Rust miner client unit tests.
 *
 * Intent being locked (per AGENTS.md rule 8): the Phase 4 router MUST never
 * crash the server-side Stability path when the Rust backend is absent,
 * schema-incompatible, slow, or malformed. The client's contract is "return
 * { ok: false, reason } on any failure" — if it ever throws instead, the
 * plugin's fallback routing breaks and a missing Rust binary takes down
 * Stability Mine entirely. These tests stub `fetch` to exercise every gate.
 */

const HEALTHY: RustMinerCapability = {
    available: true,
    minerApiVersion: "0.1.0",
    compactArtifactSchemaVersion: COMPACT_MINER_ARTIFACT_SCHEMA_VERSION,
    supportsMine: true,
    supportsStability: true,
    transports: ["file_manifest", "binary"],
    backendVersion: "test",
};

function withFetch<T>(impl: typeof globalThis.fetch, run: () => Promise<T>): Promise<T> {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    return run().finally(() => {
        globalThis.fetch = original;
    });
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { "Content-Type": "application/json" },
    });
}

describe("batch rust miner client gating + fallback", () => {
    it("runStabilityMine returns ok with the backend's result when healthy", async () => {
        const client = new RustMinerClient("http://127.0.0.1:9999");
        const fakeResult = { rows: [{ asset: "A" }], processingTimeMs: 7, reruns: 1, subsetSize: 1, seed: 1, totalPairs: 1, targetAssets: 1, hitEvents: 1 };
        const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.endsWith("/api/miner/health")) {
                return Promise.resolve(jsonResponse({
                    status: "healthy",
                    minerApiVersion: "0.1.0",
                    compactArtifactSchemaVersion: COMPACT_MINER_ARTIFACT_SCHEMA_VERSION,
                    supportsMine: true,
                    supportsStability: true,
                    transports: ["file_manifest"],
                    version: "test",
                }));
            }
            if (u.endsWith("/api/miner/stability") && init?.method === "POST") {
                return Promise.resolve(jsonResponse(fakeResult));
            }
            return Promise.resolve(jsonResponse({ error: "unexpected" }, 404));
        }) as typeof globalThis.fetch;

        const result = await withFetch(fetchImpl, async () => {
            return client.runStabilityMine({
                interval: "5m", options: {}, transport: "file_manifest",
                manifest: { pairArtifactFiles: ["/tmp/a.bin"], targetArtifactFiles: ["/tmp/t.bin"], artifactDirectory: "/tmp" },
                targets: [{ asset: "A", symbol: "A" }],
                subsetSize: 1, reruns: 1, seed: 1,
            });
        });

        if (!result.ok) throw new Error("expected ok");
        expect(result.value.rows.length).to.equal(1);
        expect(result.value.processingTimeMs).to.equal(7);
    });

    it("returns rust_unavailable when the backend is down", async () => {
        const client = new RustMinerClient("http://127.0.0.1:9999");
        const fetchImpl = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof globalThis.fetch;
        const result = await withFetch(fetchImpl, async () => {
            return client.runStabilityMine({
                interval: "5m", options: {}, transport: "file_manifest",
                manifest: { pairArtifactFiles: ["/tmp/a.bin"], targetArtifactFiles: [], artifactDirectory: null },
                targets: [], subsetSize: 1, reruns: 1, seed: 1,
            });
        });
        expect(result.ok).to.equal(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).to.equal("rust_unavailable");
    });

    it("returns schema_mismatch when the backend expects a different compact schema", async () => {
        const client = new RustMinerClient("http://127.0.0.1:9999");
        const fetchImpl = ((url: string | URL | Request) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.endsWith("/api/miner/health")) {
                // Backend expects a future schema version (e.g. v2).
                return Promise.resolve(jsonResponse({
                    status: "healthy",
                    minerApiVersion: "0.2.0",
                    compactArtifactSchemaVersion: 999,
                    supportsStability: true,
                    transports: ["file_manifest"],
                }));
            }
            return Promise.resolve(jsonResponse({}, 404));
        }) as typeof globalThis.fetch;
        const result = await withFetch(fetchImpl, async () => {
            return client.runStabilityMine({
                interval: "5m", options: {}, transport: "file_manifest",
                manifest: { pairArtifactFiles: [], targetArtifactFiles: [], artifactDirectory: null },
                targets: [], subsetSize: 1, reruns: 1, seed: 1,
            });
        });
        expect(result.ok).to.equal(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).to.equal("schema_mismatch");
        expect(result.message).to.contain("schema mismatch");
    });

    it("returns schema_mismatch when a healthy backend omits the compact schema", async () => {
        const client = new RustMinerClient("http://127.0.0.1:9999");
        const fetchImpl = ((url: string | URL | Request) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.endsWith("/api/miner/health")) {
                return Promise.resolve(jsonResponse({
                    status: "healthy",
                    minerApiVersion: "0.1.0",
                    supportsStability: true,
                    transports: ["file_manifest"],
                }));
            }
            return Promise.resolve(jsonResponse({}, 404));
        }) as typeof globalThis.fetch;
        const result = await withFetch(fetchImpl, async () => {
            return client.runStabilityMine({
                interval: "5m", options: {}, transport: "file_manifest",
                manifest: { pairArtifactFiles: [], targetArtifactFiles: [], artifactDirectory: null },
                targets: [], subsetSize: 1, reruns: 1, seed: 1,
            });
        });
        expect(result.ok).to.equal(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).to.equal("schema_mismatch");
    });

    it("returns transport_unsupported when the backend lacks the requested transport", async () => {
        const client = new RustMinerClient("http://127.0.0.1:9999");
        const fetchImpl = ((url: string | URL | Request) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.endsWith("/api/miner/health")) {
                return Promise.resolve(jsonResponse({
                    status: "healthy",
                    minerApiVersion: "0.1.0",
                    compactArtifactSchemaVersion: COMPACT_MINER_ARTIFACT_SCHEMA_VERSION,
                    supportsStability: true,
                    // Backend only supports binary, but the request asks for file_manifest.
                    transports: ["binary"],
                }));
            }
            return Promise.resolve(jsonResponse({}, 404));
        }) as typeof globalThis.fetch;
        const result = await withFetch(fetchImpl, async () => {
            return client.runStabilityMine({
                interval: "5m", options: {}, transport: "file_manifest",
                manifest: { pairArtifactFiles: [], targetArtifactFiles: [], artifactDirectory: null },
                targets: [], subsetSize: 1, reruns: 1, seed: 1,
            });
        });
        expect(result.ok).to.equal(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).to.equal("transport_unsupported");
    });

    it("returns decode_error when the response is missing rows", async () => {
        const client = new RustMinerClient("http://127.0.0.1:9999");
        // Prime the capability cache with HEALTHY so the gate passes, then
        // return a malformed stability body.
        client.invalidateCapabilityCache();
        const fetchImpl = ((url: string | URL | Request, init?: RequestInit) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.endsWith("/api/miner/health")) {
                return Promise.resolve(jsonResponse({
                    status: "healthy",
                    minerApiVersion: "0.1.0",
                    compactArtifactSchemaVersion: COMPACT_MINER_ARTIFACT_SCHEMA_VERSION,
                    supportsStability: true,
                    transports: ["file_manifest"],
                }));
            }
            if (u.endsWith("/api/miner/stability") && init?.method === "POST") {
                return Promise.resolve(jsonResponse({ noRowsHere: true }));
            }
            return Promise.resolve(jsonResponse({}, 404));
        }) as typeof globalThis.fetch;
        const result = await withFetch(fetchImpl, async () => {
            return client.runStabilityMine({
                interval: "5m", options: {}, transport: "file_manifest",
                manifest: { pairArtifactFiles: [], targetArtifactFiles: [], artifactDirectory: null },
                targets: [], subsetSize: 1, reruns: 1, seed: 1,
            });
        });
        expect(result.ok).to.equal(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).to.equal("decode_error");
    });

    it("returns timeout on an aborted request", async () => {
        const client = new RustMinerClient("http://127.0.0.1:9999");
        const fetchImpl = ((url: string | URL | Request) => {
            const u = typeof url === "string" ? url : url.toString();
            if (u.endsWith("/api/miner/health")) {
                return Promise.resolve(jsonResponse({
                    status: "healthy",
                    minerApiVersion: "0.1.0",
                    compactArtifactSchemaVersion: COMPACT_MINER_ARTIFACT_SCHEMA_VERSION,
                    supportsStability: true,
                    transports: ["file_manifest"],
                }));
            }
            // Simulate a timeout-style abort.
            return Promise.reject(new DOMException("The operation was aborted due to timeout", "AbortError"));
        }) as typeof globalThis.fetch;
        const result = await withFetch(fetchImpl, async () => {
            return client.runStabilityMine({
                interval: "5m", options: {}, transport: "file_manifest",
                manifest: { pairArtifactFiles: [], targetArtifactFiles: [], artifactDirectory: null },
                targets: [], subsetSize: 1, reruns: 1, seed: 1,
            });
        });
        expect(result.ok).to.equal(false);
        if (result.ok) throw new Error("unreachable");
        expect(result.reason).to.equal("timeout");
    });
});

describe("batch rust miner request builders", () => {
    it("buildFileManifestStabilityRequest carries subset/reruns/seed and transport=file_manifest", () => {
        const req = buildFileManifestStabilityRequest({
            interval: "4h", options: { lagBars: 3 },
            manifest: { pairArtifactFiles: ["/tmp/0.bin"], targetArtifactFiles: ["/tmp/t.bin"], artifactDirectory: "/tmp" },
            targets: [{ asset: "BTC", symbol: "BTCUSDT" }],
            subsetSize: 200, reruns: 50, seed: 1,
        });
        expect(req.transport).to.equal("file_manifest");
        expect(req.subsetSize).to.equal(200);
        expect(req.reruns).to.equal(50);
        expect(req.seed).to.equal(1);
        expect(req.manifest.pairArtifactFiles).to.deep.equal(["/tmp/0.bin"]);
        expect(req.manifest.targetArtifactFiles).to.deep.equal(["/tmp/t.bin"]);
        expect(req.targets).to.deep.equal([{ asset: "BTC", symbol: "BTCUSDT" }]);
    });

    it("buildFileManifestMineRequest is the one-shot shape (no subset/reruns/seed)", () => {
        const req = buildFileManifestMineRequest({
            interval: "1m", options: {},
            manifest: { pairArtifactFiles: [], targetArtifactFiles: [], artifactDirectory: null },
            targets: [],
        });
        expect(req.transport).to.equal("file_manifest");
        expect((req as Partial<RustStabilityMineRequest>).subsetSize).to.equal(undefined);
    });
});
