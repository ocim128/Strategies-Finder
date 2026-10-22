import { readFile, stat } from "node:fs/promises";
import type { BigIntStats } from "node:fs";
import type { TopMeanRunManifest } from "./compact-pair-artifact";
import { normalizePersistedTopMeanResult } from "./sp500-top-mean-persisted-result";
import { toWireSafeTopMeanResultSummary, type TopMeanResultSummary } from "./sp500-top-mean-coordinator-engine";
import { serializeJsonPreservingNonFinite } from "../json-utils";

type ReadText = (path: string) => Promise<string>;

export class StoredTopMeanResultError extends Error {
    constructor(readonly failureKind: "invalid_json" | "invalid_shape", cause: unknown) {
        super(cause instanceof Error ? cause.message : String(cause), { cause });
    }
}

export function resultFileVersion(info: BigIntStats): string {
    return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
}

export async function readWireTopMeanResult(
    path: string,
    manifest: TopMeanRunManifest,
    readText: ReadText = (file) => readFile(file, "utf8"),
): Promise<TopMeanResultSummary> {
    const text = await readText(path);
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch (error) { throw new StoredTopMeanResultError("invalid_json", error); }
    try {
        const result = normalizePersistedTopMeanResult(parsed, manifest);
        if (!result) throw new Error("Stored result has an invalid shape.");
        return toWireSafeTopMeanResultSummary(result);
    } catch (error) { throw new StoredTopMeanResultError("invalid_shape", error); }
}

/** Only wire-safe summaries survive reads; raw replay objects are never cached. */
export class TopMeanResultReader {
    private readonly cache = new Map<string, { key: string; result: TopMeanResultSummary; bytes: number }>();
    private readonly pending = new Map<string, Promise<TopMeanResultSummary>>();
    private readonly validated = new Map<string, string>();
    private readonly generations = new Map<string, number>();
    private generation = 0;
    private bytes = 0;

    constructor(
        private readonly readText: ReadText = (path) => readFile(path, "utf8"),
        private readonly maxEntries = 4,
        private readonly maxJsonBytes = 16 * 1024 * 1024,
    ) {}

    private forget(path: string): void {
        const entry = this.cache.get(path);
        if (entry) this.bytes -= entry.bytes;
        this.cache.delete(path);
        this.validated.delete(path);
    }

    private rememberValidated(path: string, version: string): void {
        this.validated.delete(path);
        this.validated.set(path, version);
        while (this.validated.size > 128) this.validated.delete(this.validated.keys().next().value!);
    }

    async validateDownload(path: string, version: string, readText: () => Promise<string>): Promise<void> {
        if (this.validated.get(path) === version) return;
        // Preserve the download API's malformed-file error, without retaining
        // its parsed graph or reserializing the original disk bytes.
        JSON.parse(await readText());
        this.rememberValidated(path, version);
    }

    async load(path: string, manifest: TopMeanRunManifest): Promise<TopMeanResultSummary> {
        let version: string;
        try { version = resultFileVersion(await stat(path, { bigint: true })); }
        catch (error) { this.forget(path); throw error; }
        // Normalization falls back to manifest fields, so its revision matters
        // even when the result file has not changed (e.g. completion checkpoint).
        const key = `${path}\u0000${version}\u0000${JSON.stringify(manifest)}`;
        const cached = this.cache.get(path);
        if (cached?.key === key) {
            this.cache.delete(path);
            this.cache.set(path, cached);
            return cached.result;
        }
        if (cached) this.forget(path);
        const joined = this.pending.get(key);
        if (joined) return joined;
        const generation = ++this.generation;
        this.generations.delete(path);
        this.generations.set(path, generation);
        while (this.generations.size > 128) this.generations.delete(this.generations.keys().next().value!);
        const production = (async () => {
            const result = await readWireTopMeanResult(path, manifest, this.readText);
            // An atomic replacement during the read must never publish under
            // the old version. A failed stat still permits this response only.
            const current = await stat(path, { bigint: true }).catch(() => null);
            if (current && resultFileVersion(current) === version && this.generations.get(path) === generation) {
                this.rememberValidated(path, version);
                let bytes = this.maxJsonBytes + 1;
                try { bytes = Buffer.byteLength(serializeJsonPreservingNonFinite(result)); }
                catch (error) {
                    // Oversized JSON can still use the HTTP chunked serializer;
                    // cache accounting must not turn that valid result into 500.
                    if (!(error instanceof RangeError)) throw error;
                }
                if (this.maxEntries > 0 && bytes <= this.maxJsonBytes) {
                    this.forget(path);
                    this.rememberValidated(path, version);
                    while (this.cache.size >= this.maxEntries || this.bytes + bytes > this.maxJsonBytes) {
                        this.forget(this.cache.keys().next().value!);
                    }
                    this.cache.set(path, { key, result, bytes });
                    this.bytes += bytes;
                }
            }
            return result;
        })();
        // Bound pending bookkeeping as well; overflow reads simply bypass it.
        if (this.pending.size < this.maxEntries) this.pending.set(key, production);
        try { return await production; }
        finally { if (this.pending.get(key) === production) this.pending.delete(key); }
    }
}
