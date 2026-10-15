import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { atomicWriteJson, isValidRunId } from "./sp500-top-mean-artifact-store";
import { TOP_RAW_SCAN_MAX_ASSETS, TOP_RAW_SCAN_MAX_PAIRS, TOP_RAW_SCAN_MAX_SOURCES_PER_ASSET, TOP_RAW_SCAN_SHARD_SIZE, type ScanRequest, type ScanResult, type ScanStatus, type ScanVote } from "./top-raw-scan-contract";
import { normalizeScanFailureDiagnostics } from "./top-raw-scan-diagnostics";

const MAX_SHARDS = Math.ceil(TOP_RAW_SCAN_MAX_PAIRS / TOP_RAW_SCAN_SHARD_SIZE) + 1;

export interface ScanManifest {
    schema: "top_raw_scan.manifest.v1"; request: ScanRequest; requestHash: string; implementationHash: string;
    cutoff: number; asOf: number; evaluationCutoff: number; assets: string[];
    sources: Array<{ asset: string; path: string; revision: string }>;
    result: ScanResult; completedShards: number[]; status: ScanStatus;
}
export interface ScanReservation { schema: "top_raw_scan.reservation.v1"; requestHash: string; cutoff: number; status: ScanStatus }
export function scanHash(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
        ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item)).digest("hex");
}
export async function scanFileRevision(path: string): Promise<string> {
    try { const s = await stat(path); return `${s.size}:${s.mtimeMs}:${s.ctimeMs}`; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
}
export class ScanStore {
    constructor(private readonly baseDir = process.cwd()) {}
    path(runId: string, name: string): string {
        if (!isValidRunId(runId)) throw new Error("Invalid runId.");
        return join(resolve(this.baseDir, "artifacts", "top-raw-scan"), runId, name);
    }
    async readManifest(runId: string): Promise<ScanManifest | null> {
        try {
            const value = JSON.parse(await readFile(this.path(runId, "manifest.json"), "utf8")) as ScanManifest;
            if (!value || value.schema !== "top_raw_scan.manifest.v1" || value.request?.runId !== runId || !Array.isArray(value.completedShards)
                || value.completedShards.length > MAX_SHARDS || value.completedShards.some(index => !Number.isInteger(index) || index < 0 || index >= MAX_SHARDS)
                || !Array.isArray(value.assets) || value.assets.length < 2 || value.assets.length > TOP_RAW_SCAN_MAX_ASSETS || value.assets.some(asset => typeof asset !== "string")
                || new Set(value.assets).size !== value.assets.length
                || !Array.isArray(value.sources) || value.sources.length > 1 + value.assets.length * TOP_RAW_SCAN_MAX_SOURCES_PER_ASSET
                || !value.status || value.result?.schema !== "top_raw_scan.result.v1") throw new Error("Invalid scan manifest.");
            const slots = new Map<string, Set<string>>(), assets = new Set([...value.assets, "catalog"]);
            for (const source of value.sources) {
                if (!source || !assets.has(source.asset) || typeof source.path !== "string" || !source.path || typeof source.revision !== "string") throw new Error("Invalid scan manifest sources.");
                const paths = slots.get(source.asset) ?? new Set<string>();
                if (paths.has(source.path) || paths.size >= (source.asset === "catalog" ? 1 : TOP_RAW_SCAN_MAX_SOURCES_PER_ASSET)) throw new Error("Invalid scan manifest source layout.");
                paths.add(source.path); slots.set(source.asset, paths);
            }
            if (slots.size !== assets.size) throw new Error("Invalid scan manifest source coverage.");
            value.result.failureDiagnostics = normalizeScanFailureDiagnostics(value.result.failureDiagnostics, value.result.pairCounts.failed);
            return value;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }
    saveManifest(manifest: ScanManifest): Promise<void> { return atomicWriteJson(this.path(manifest.request.runId, "manifest.json"), manifest); }
    saveReservation(runId: string, data: ScanReservation): Promise<void> { return atomicWriteJson(this.path(runId, "reservation.json"), data); }
    async readReservation(runId: string): Promise<ScanReservation | null> {
        try {
            const value = JSON.parse(await readFile(this.path(runId, "reservation.json"), "utf8")) as ScanReservation;
            if (value.schema !== "top_raw_scan.reservation.v1" || value.status.runId !== runId) throw new Error("Invalid scan reservation.");
            return value;
        } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }
    saveResult(result: ScanResult): Promise<void> { return atomicWriteJson(this.path(result.runId, "result.json"), result); }
    async readResult(runId: string): Promise<ScanResult | null> {
        try {
            const result = JSON.parse(await readFile(this.path(runId, "result.json"), "utf8")) as ScanResult;
            result.failureDiagnostics = normalizeScanFailureDiagnostics(result.failureDiagnostics, result.pairCounts.failed);
            return result;
        }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
    }
    saveShard(runId: string, index: number, fingerprint: string, votes: ScanVote[]): Promise<void> {
        return atomicWriteJson(this.path(runId, `shard-${index}.json`), { schema: "top_raw_scan.votes.v1", fingerprint, votes });
    }
    async readShard(runId: string, index: number, fingerprint: string): Promise<ScanVote[] | null> {
        let text: string;
        try { text = await readFile(this.path(runId, `shard-${index}.json`), "utf8"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
        const value = JSON.parse(text);
        if (value.schema !== "top_raw_scan.votes.v1" || value.fingerprint !== fingerprint || !Array.isArray(value.votes)) throw new Error(`Invalid scan shard ${index}.`);
        return value.votes;
    }
}
