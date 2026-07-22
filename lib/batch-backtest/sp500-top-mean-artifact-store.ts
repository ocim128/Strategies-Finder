import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import type { CompactPairArtifact, TopMeanRunManifest, BatchSyntheticPairArtifactAdapter } from "./compact-pair-artifact";
import { toBatchSyntheticPairAdapter } from "./compact-pair-artifact";

const DEFAULT_RETENTION_MS = 24 * 60 * 60 * 1000; // 24 hours

export function getArtifactsRootDir(baseDir?: string): string {
    const root = baseDir || process.cwd();
    return resolve(root, "artifacts", "sp500-top-mean");
}

export function getRunDir(runId: string, baseDir?: string): string {
    return join(getArtifactsRootDir(baseDir), runId);
}

export function getManifestPath(runId: string, baseDir?: string): string {
    return join(getRunDir(runId, baseDir), "manifest.json");
}

export function getShardsDir(runId: string, baseDir?: string): string {
    return join(getRunDir(runId, baseDir), "shards");
}

export function getShardPath(runId: string, shardIndex: number, baseDir?: string): string {
    const shardFileName = `${String(shardIndex).padStart(6, "0")}.json`;
    return join(getShardsDir(runId, baseDir), shardFileName);
}

export function computeRunFingerprint(payload: {
    strategyKey: string;
    strategyParams: unknown;
    backtestSettings: unknown;
    capitalSettings: unknown;
    interval: string;
    useRustEnginePreference?: boolean;
    canonicalAssets: string[];
}): string {
    const jsonStr = JSON.stringify(payload);
    return createHash("sha256").update(jsonStr).digest("hex");
}

export function atomicWriteJsonSync(targetPath: string, data: unknown): void {
    const dir = dirname(targetPath);
    if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
    }
    const tempPath = `${targetPath}.${Date.now()}.${Math.random().toString(36).substring(2, 8)}.tmp`;
    writeFileSync(tempPath, JSON.stringify(data), "utf8");
    renameSync(tempPath, targetPath);
}

export function saveManifest(manifest: TopMeanRunManifest, baseDir?: string): void {
    manifest.updatedAt = Date.now();
    const manifestPath = getManifestPath(manifest.runId, baseDir);
    atomicWriteJsonSync(manifestPath, manifest);
}

export function loadManifest(runId: string, baseDir?: string): TopMeanRunManifest | null {
    const manifestPath = getManifestPath(runId, baseDir);
    if (!existsSync(manifestPath)) return null;
    try {
        const content = readFileSync(manifestPath, "utf8");
        return JSON.parse(content) as TopMeanRunManifest;
    } catch {
        return null;
    }
}

export function writeShardArtifacts(
    runId: string,
    shardIndex: number,
    artifacts: CompactPairArtifact[],
    baseDir?: string,
): void {
    const shardPath = getShardPath(runId, shardIndex, baseDir);
    atomicWriteJsonSync(shardPath, artifacts);
}

export function readShardArtifacts(
    runId: string,
    shardIndex: number,
    baseDir?: string,
): CompactPairArtifact[] | null {
    const shardPath = getShardPath(runId, shardIndex, baseDir);
    if (!existsSync(shardPath)) return null;
    try {
        const content = readFileSync(shardPath, "utf8");
        return JSON.parse(content) as CompactPairArtifact[];
    } catch {
        return null;
    }
}

export async function* iterateRunCompactArtifacts(
    runId: string,
    baseDir?: string,
): AsyncGenerator<BatchSyntheticPairArtifactAdapter> {
    const manifest = loadManifest(runId, baseDir);
    if (!manifest) return;

    for (const shardIndex of manifest.completedShards) {
        const shardArtifacts = readShardArtifacts(runId, shardIndex, baseDir);
        if (!shardArtifacts) continue;
        for (const artifact of shardArtifacts) {
            yield toBatchSyntheticPairAdapter(artifact);
        }
    }
}

export function cleanOldArtifacts(baseDir?: string, maxAgeMs = DEFAULT_RETENTION_MS): void {
    const rootDir = getArtifactsRootDir(baseDir);
    if (!existsSync(rootDir)) return;

    try {
        const entries = readdirSync(rootDir);
        const now = Date.now();

        for (const entry of entries) {
            const entryPath = join(rootDir, entry);
            try {
                const stat = statSync(entryPath);
                if (stat.isDirectory() && now - stat.mtimeMs > maxAgeMs) {
                    rmSync(entryPath, { recursive: true, force: true });
                }
            } catch {
                // Ignore per-entry cleanup errors
            }
        }
    } catch {
        // Ignore root scan cleanup errors
    }
}

export function reconcileInterruptedManifestsOnStartup(baseDir?: string): void {
    const rootDir = getArtifactsRootDir(baseDir);
    if (!existsSync(rootDir)) return;

    try {
        const entries = readdirSync(rootDir);
        for (const runId of entries) {
            const manifest = loadManifest(runId, baseDir);
            if (manifest && manifest.status === "running") {
                manifest.status = "interrupted";
                saveManifest(manifest, baseDir);
            }
        }
    } catch {
        // Ignore startup reconciliation errors
    }
}
