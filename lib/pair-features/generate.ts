import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { lstat, readFile, readdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { availableParallelism } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { createGunzip, gunzipSync } from "node:zlib";
import { iterateJsonlLines } from "../batch-backtest/trade-ledger-replay-loader";
import {
    canonicalJson,
    decodeFloat64LeUncompressed,
    decodeUint32LeUncompressed,
    decodeUint8Uncompressed,
    encodeFloat64Le,
    encodeUint32Le,
    encodeUint8,
    hashBytes,
    hashFile,
    prepareArtifactDirectory,
    publishArtifactIfMissing,
    safeArtifactPath,
} from "./artifact-io";
import { getPairFeatureCatalogEntryForRelease, getPairFeatureRelease, type PairFeatureCatalogEntry } from "./catalog";
import type {
    PairFeatureColumnArtifact,
    PairFeatureColumnPairManifest,
    PairFeatureDefinition,
    PairFeatureEvaluationContext,
    PairFeatureFamilyFeatureManifest,
    PairFeatureFamilyManifest,
    PairFeaturePackManifest,
    PairFeatureRelease,
    PairFeatureSnapshotBar,
    PairFeatureSnapshotEntry,
    PairFeatureSnapshotManifest,
    PairFeatureSnapshotPairManifest,
    PairFeatureSnapshotRuntimeFingerprint,
    PairFeatureSnapshotTrade,
    PairFeatureSnapshotWarmupEntry,
} from "./types";

const SOURCE_MANIFEST_PATH = "source-snapshot/manifest.json";
const LEDGER_PATH = "ledger.jsonl";
const SOURCE_PAIR_READ_CONCURRENCY = 8;
const FEATURE_PAIR_GENERATION_CONCURRENCY = 8;
const FEATURE_GENERATION_WORKER_THRESHOLD_ROWS = 100_000;
const FEATURE_GENERATION_MAX_WORKERS = 20;
const pairGenerationTails = new Map<string, Promise<void>>();
export const SOURCE_REQUIRED_MESSAGE = "source snapshot required; this folder is unchanged";

export interface PairFeatureGenerationOptions {
    signal?: AbortSignal;
    onProgress?: (progress: PairFeatureGenerationProgress) => void;
    /** Reuse the caller's already validated immutable source snapshot. */
    validatedSnapshot?: ValidatedPairFeatureSnapshot;
}

export interface PairFeatureSnapshotValidationOptions {
    /** Skip JSONL record decoding when existing feature packs are complete. */
    verifySourceRecords?: boolean;
}

export interface PairFeatureGenerationProgress {
    familyId: string;
    featureIds: readonly string[];
    computedColumns: number;
    reusedColumns: number;
    compressedBytes: number;
    allNullFeatureIds: readonly string[];
}

export interface ValidatedPairFeatureSnapshot {
    folder: string;
    manifest: PairFeatureSnapshotManifest;
    sourceSnapshotSha256: string;
}

interface PairData {
    bars: PairFeatureSnapshotBar[];
    trades: PairFeatureSnapshotTrade[];
    entries: PairFeatureSnapshotEntry[];
    warmupEntries: PairFeatureSnapshotWarmupEntry[];
}

interface RequestedFeature {
    entry: PairFeatureCatalogEntry;
    requestedIds: readonly string[];
}

interface ExistingFamilyManifest {
    path: string;
    manifest: PairFeatureFamilyManifest;
}

export interface PairFeatureFamilyGenerationSummary {
    familyId: string;
    featureIds: readonly string[];
    pairCount: number;
    computedColumns: number;
    reusedColumns: number;
    compressedBytes: number;
    columnCoverage: readonly PairFeatureColumnCoverage[];
}

export interface PairFeatureColumnCoverage {
    featureId: string;
    rowCount: number;
    nullCount: number;
    nullShare: number;
    observationMin: number;
    observationMax: number;
}

export interface PairFeaturePackResult {
    packDigest: string;
    packPath: string;
    releasePath: string;
    releaseSha256: string;
    sourceSnapshotSha256: string;
    ledgerSha256: string;
    familyManifests: readonly string[];
    computedColumns: number;
    reusedColumns: number;
    families: readonly PairFeatureFamilyGenerationSummary[];
    allNullFeatureIds: readonly string[];
    workersUsed: number;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Pair-feature preparation cancelled.");
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function compareCodeUnits(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function requireFinite(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) throw new Error(`${label} must be finite.`);
    return Object.is(value, -0) ? 0 : value;
}

function requireInteger(value: unknown, label: string): number {
    const number = requireFinite(value, label);
    if (!Number.isInteger(number)) throw new Error(`${label} must be an integer.`);
    return number;
}

function pairKey(pair: PairFeatureSnapshotPairManifest): string {
    return hashBytes(Buffer.from(canonicalJson([pair.pair, pair.baseSymbol, pair.quoteSymbol]), "utf8"));
}

function runtimeFingerprint(): PairFeatureSnapshotRuntimeFingerprint {
    return {
        node: process.version,
        v8: process.versions.v8,
        zlib: process.versions.zlib ?? "unknown",
        platform: process.platform,
        arch: process.arch,
    };
}

function sameRuntime(left: PairFeatureSnapshotRuntimeFingerprint, right: PairFeatureSnapshotRuntimeFingerprint): boolean {
    return left.node === right.node
        && left.v8 === right.v8
        && left.zlib === right.zlib
        && left.platform === right.platform
        && left.arch === right.arch;
}

async function readGzipJsonl<T>(filePath: string, label: string): Promise<{
    values: T[];
    bytes: number;
    sha256: string;
    compressedBytes: number;
    compressedSha256: string;
}> {
    const source = createReadStream(filePath);
    const gunzip = createGunzip();
    const digest = createHash("sha256");
    const compressedDigest = createHash("sha256");
    let bytes = 0;
    let compressedBytes = 0;
    source.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        compressedDigest.update(buffer);
        compressedBytes += buffer.length;
    });
    source.pipe(gunzip);
    gunzip.on("data", (chunk: Buffer | string) => {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        digest.update(buffer);
        bytes += buffer.length;
    });
    const reader = createInterface({ input: gunzip, crlfDelay: Infinity });
    const values: T[] = [];
    let firstLine = true;
    try {
        for await (const rawLine of reader) {
            let line = rawLine;
            if (firstLine) {
                if (line.startsWith("\uFEFF")) line = line.slice(1);
                firstLine = false;
            }
            if (line.length > 0 && (line.charCodeAt(0) <= 32 || line.charCodeAt(line.length - 1) <= 32)) line = line.trim();
            if (!line) continue;
            try {
                values.push(JSON.parse(line) as T);
            } catch (error) {
                throw new Error(`${label} has invalid JSONL: ${errorMessage(error)}.`);
            }
        }
    } finally {
        reader.close();
        source.destroy();
        gunzip.destroy();
    }
    return {
        values,
        bytes,
        sha256: digest.digest("hex"),
        compressedBytes,
        compressedSha256: compressedDigest.digest("hex"),
    };
}

async function assertFileHash(filePath: string, expectedSha256: string, label: string): Promise<void> {
    const actual = await hashFile(filePath);
    if (actual.sha256 !== expectedSha256) throw new Error(`${label} hash mismatch.`);
}

async function validateSourceArtifactHashes(
    runDir: string,
    pairs: readonly PairFeatureSnapshotPairManifest[],
): Promise<void> {
    const artifacts = pairs.flatMap((pair) => Object.values(pair.files));
    for (let start = 0; start < artifacts.length; start += SOURCE_PAIR_READ_CONCURRENCY) {
        const batch = artifacts.slice(start, start + SOURCE_PAIR_READ_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(async (artifact) => {
            const actual = await hashFile(await safeArtifactPath(runDir, artifact.path));
            if (actual.bytes !== artifact.compressedBytes || actual.sha256 !== artifact.compressedSha256) {
                throw new Error(`${artifact.path} compressed bytes or hash do not match source-snapshot/manifest.json.`);
            }
        }));
        for (const result of settled) if (result.status === "rejected") throw result.reason;
    }
}

async function readSourceArtifact<T>(
    folder: string,
    artifact: PairFeatureSnapshotPairManifest["files"]["bars"],
    label: string,
): Promise<T[]> {
    const filePath = await safeArtifactPath(folder, artifact.path);
    const decoded = await readGzipJsonl<T>(filePath, label);
    if (decoded.compressedBytes !== artifact.compressedBytes || decoded.compressedSha256 !== artifact.compressedSha256
        || decoded.values.length !== artifact.recordCount
        || decoded.bytes !== artifact.uncompressedBytes
        || decoded.sha256 !== artifact.uncompressedSha256) {
        throw new Error(`${label} compressed bytes, record count, or hash does not match source-snapshot/manifest.json.`);
    }
    return decoded.values;
}

function validateBars(records: readonly unknown[], label: string): PairFeatureSnapshotBar[] {
    const bars: PairFeatureSnapshotBar[] = [];
    let previousTime = -Infinity;
    for (const [index, value] of records.entries()) {
        if (!Array.isArray(value) || value.length !== 6) throw new Error(`${label} bar ${index} is malformed.`);
        const bar: PairFeatureSnapshotBar = [
            requireFinite(value[0], `${label} bar ${index} time`),
            requireFinite(value[1], `${label} bar ${index} open`),
            requireFinite(value[2], `${label} bar ${index} high`),
            requireFinite(value[3], `${label} bar ${index} low`),
            requireFinite(value[4], `${label} bar ${index} close`),
            requireFinite(value[5], `${label} bar ${index} volume`),
        ];
        if (bar[0] <= previousTime) throw new Error(`${label} bars are not strictly increasing at index ${index}.`);
        previousTime = bar[0];
        bars.push(bar);
    }
    return bars;
}

function validateTrades(records: readonly unknown[], bars: readonly PairFeatureSnapshotBar[], label: string): PairFeatureSnapshotTrade[] {
    const trades: PairFeatureSnapshotTrade[] = [];
    for (const [index, value] of records.entries()) {
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} trade ${index} is malformed.`);
        const trade = value as Record<string, unknown>;
        if (trade.direction !== "long" && trade.direction !== "short") throw new Error(`${label} trade ${index} has an invalid direction.`);
        const entryBarIndex = requireInteger(trade.entryBarIndex, `${label} trade ${index} entryBarIndex`);
        const exitBarIndex = requireInteger(trade.exitBarIndex, `${label} trade ${index} exitBarIndex`);
        if (entryBarIndex < 0 || exitBarIndex < 0 || entryBarIndex >= bars.length || exitBarIndex >= bars.length) {
            throw new Error(`${label} trade ${index} has an out-of-range bar index.`);
        }
        const fees = trade.fees === null ? null : requireFinite(trade.fees, `${label} trade ${index} fees`);
        if (trade.exitReason !== null && typeof trade.exitReason !== "string") throw new Error(`${label} trade ${index} exitReason is malformed.`);
        trades.push({
            tradeOrdinal: requireInteger(trade.tradeOrdinal, `${label} trade ${index} tradeOrdinal`),
            id: requireFinite(trade.id, `${label} trade ${index} id`),
            direction: trade.direction,
            entryTimeSec: requireFinite(trade.entryTimeSec, `${label} trade ${index} entryTimeSec`),
            exitTimeSec: requireFinite(trade.exitTimeSec, `${label} trade ${index} exitTimeSec`),
            entryBarIndex,
            exitBarIndex,
            entryPrice: requireFinite(trade.entryPrice, `${label} trade ${index} entryPrice`),
            exitPrice: requireFinite(trade.exitPrice, `${label} trade ${index} exitPrice`),
            pnl: requireFinite(trade.pnl, `${label} trade ${index} pnl`),
            pnlPercent: requireFinite(trade.pnlPercent, `${label} trade ${index} pnlPercent`),
            size: requireFinite(trade.size, `${label} trade ${index} size`),
            fees,
            exitReason: trade.exitReason as PairFeatureSnapshotTrade["exitReason"],
        });
    }
    if (trades.some((trade, index) => trade.tradeOrdinal !== index)) throw new Error(`${label} trade ordinals are not contiguous.`);
    return trades;
}

function validateEntries(
    records: readonly unknown[],
    pair: PairFeatureSnapshotPairManifest,
    bars: readonly PairFeatureSnapshotBar[],
    label: string,
): PairFeatureSnapshotEntry[] {
    const entries: PairFeatureSnapshotEntry[] = [];
    let previousSignalBarIndex = -1;
    for (const [index, value] of records.entries()) {
        if (!Array.isArray(value) || value.length !== 4) throw new Error(`${label} entry ${index} is malformed.`);
        const rowOrdinal = requireInteger(value[0], `${label} entry ${index} rowOrdinal`);
        const signalBarIndex = requireInteger(value[1], `${label} entry ${index} signalBarIndex`);
        if (rowOrdinal !== pair.rowStart + index || signalBarIndex < 0 || signalBarIndex >= bars.length) {
            throw new Error(`${label} entry ${index} has an invalid ordinal or bar index.`);
        }
        if (signalBarIndex < previousSignalBarIndex) throw new Error(`${label} signal-bar history is not monotonic.`);
        previousSignalBarIndex = signalBarIndex;
        if (value[2] !== "long" && value[2] !== "short") throw new Error(`${label} entry ${index} has an invalid direction.`);
        const signalTimeSec = requireFinite(value[3], `${label} entry ${index} signalTimeSec`);
        if (bars[signalBarIndex]![0] !== signalTimeSec) throw new Error(`${label} entry ${index} time does not match its signal bar.`);
        entries.push([rowOrdinal, signalBarIndex, value[2], signalTimeSec]);
    }
    return entries;
}

function validateWarmupEntries(
    records: readonly unknown[],
    bars: readonly PairFeatureSnapshotBar[],
    label: string,
): PairFeatureSnapshotWarmupEntry[] {
    const entries: PairFeatureSnapshotWarmupEntry[] = [];
    let previousSignalBarIndex = -1;
    for (const [index, value] of records.entries()) {
        if (!Array.isArray(value) || value.length !== 3) throw new Error(`${label} entry ${index} is malformed.`);
        const signalBarIndex = requireInteger(value[0], `${label} entry ${index} signalBarIndex`);
        if (signalBarIndex < 0 || signalBarIndex >= bars.length || signalBarIndex < previousSignalBarIndex) {
            throw new Error(`${label} entry ${index} has an invalid or non-monotonic bar index.`);
        }
        previousSignalBarIndex = signalBarIndex;
        if (value[1] !== "long" && value[1] !== "short") throw new Error(`${label} entry ${index} has an invalid direction.`);
        const signalTimeSec = requireFinite(value[2], `${label} entry ${index} signalTimeSec`);
        if (bars[signalBarIndex]![0] !== signalTimeSec) throw new Error(`${label} entry ${index} time does not match its signal bar.`);
        entries.push([signalBarIndex, value[1], signalTimeSec]);
    }
    return entries;
}

async function readPairData(folder: string, pair: PairFeatureSnapshotPairManifest): Promise<PairData> {
    const prefix = `source-snapshot/pairs/${pair.pairKey}/`;
    const expectedPaths = {
        bars: `${prefix}bars.jsonl.gz`,
        trades: `${prefix}trades.jsonl.gz`,
        entries: `${prefix}entries.jsonl.gz`,
    } as const;
    for (const [name, expectedPath] of Object.entries(expectedPaths)) {
        if (pair.files[name as keyof typeof expectedPaths].path !== expectedPath) {
            throw new Error(`${pair.pairKey} ${name} path does not match its pair mapping.`);
        }
    }
    const bars = validateBars(await readSourceArtifact<unknown>(folder, pair.files.bars, `${pair.pairKey}/bars`), `${pair.pairKey}/bars`);
    const trades = validateTrades(
        await readSourceArtifact<unknown>(folder, pair.files.trades, `${pair.pairKey}/trades`),
        bars,
        `${pair.pairKey}/trades`,
    );
    const entries = validateEntries(
        await readSourceArtifact<unknown>(folder, pair.files.entries, `${pair.pairKey}/entries`),
        pair,
        bars,
        `${pair.pairKey}/entries`,
    );
    const warmupArtifact = pair.files.entriesWarmup;
    if (warmupArtifact && warmupArtifact.path !== `${prefix}entries-warmup.jsonl.gz`) {
        throw new Error(`${pair.pairKey} entriesWarmup path does not match its pair mapping.`);
    }
    const warmupEntries = warmupArtifact
        ? validateWarmupEntries(
            await readSourceArtifact<unknown>(folder, warmupArtifact, `${pair.pairKey}/entriesWarmup`),
            bars,
            `${pair.pairKey}/entriesWarmup`,
        )
        : [];
    if (entries[0] && warmupEntries.some((entry) => entry[0] >= entries[0]![1])) {
        throw new Error(`${pair.pairKey} warmup entries must precede the first in-window entry.`);
    }
    if (bars.length !== pair.barCount || trades.length !== pair.tradeCount || entries.length !== pair.rowCount) {
        throw new Error(`${pair.pairKey} source record counts do not match source-snapshot/manifest.json.`);
    }
    return { bars, trades, entries, warmupEntries };
}

function validateLedgerRow(value: unknown, pair: PairFeatureSnapshotPairManifest, entry: PairFeatureSnapshotEntry): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ledger.jsonl contains a malformed row.");
    const row = value as Record<string, unknown>;
    if (row.pair !== pair.pair || row.baseSymbol !== pair.baseSymbol || row.quoteSymbol !== pair.quoteSymbol) {
        throw new Error(`ledger.jsonl row does not match source pair ${pair.pairKey}.`);
    }
    if (row.signalBarIndex !== entry[1] || row.direction !== entry[2] || row.signalTime !== entry[3]) {
        throw new Error(`ledger.jsonl row does not match source entry ordinal ${entry[0]}.`);
    }
}

export async function validatePairFeatureSnapshot(
    folder: string,
    options: PairFeatureSnapshotValidationOptions = {},
): Promise<ValidatedPairFeatureSnapshot> {
    const runDir = resolve(folder);
    const manifestPath = await safeArtifactPath(runDir, SOURCE_MANIFEST_PATH);
    let rawManifest: Buffer;
    try {
        rawManifest = await readFile(manifestPath);
    } catch (error) {
        if (isMissing(error)) throw new Error(SOURCE_REQUIRED_MESSAGE);
        throw error;
    }
    let manifest: PairFeatureSnapshotManifest;
    try {
        manifest = JSON.parse(rawManifest.toString("utf8")) as PairFeatureSnapshotManifest;
    } catch (error) {
        throw new Error(`source-snapshot/manifest.json is not valid JSON: ${errorMessage(error)}.`);
    }
    if (manifest.complete !== true) throw new Error(SOURCE_REQUIRED_MESSAGE);
    if (manifest.formatVersion !== 1 || manifest.writerRevision !== 1) throw new Error("Unsupported source snapshot format.");
    const manifestHash = hashBytes(rawManifest);
    const ledgerPath = await safeArtifactPath(runDir, LEDGER_PATH);
    const ledgerHash = await hashFile(ledgerPath);
    if (ledgerHash.sha256 !== manifest.ledgerSha256 || ledgerHash.bytes !== manifest.ledgerBytes) {
        throw new Error("ledger.jsonl hash or byte count does not match source-snapshot/manifest.json.");
    }
    if (!Number.isSafeInteger(manifest.ledgerRowCount) || manifest.ledgerRowCount < 0) throw new Error("source snapshot ledgerRowCount is invalid.");
    await assertFileHash(join(runDir, "provenance.json"), manifest.provenanceSha256, "provenance.json");
    await assertFileHash(join(runDir, "summary.json"), manifest.summarySha256, "summary.json");
    if (manifest.ranksSha256 !== null) await assertFileHash(join(runDir, "signal-ranks.jsonl"), manifest.ranksSha256, "signal-ranks.jsonl");
    if (!Array.isArray(manifest.pairs)) throw new Error("source snapshot pairs is not an array.");

    let expectedRowStart = 0;
    let previousPair: PairFeatureSnapshotPairManifest | null = null;
    const validatePairMetadata = (pair: PairFeatureSnapshotPairManifest): void => {
        if (pair.pairKey !== pairKey(pair)) throw new Error(`source snapshot pair key does not match ${pair.pair}.`);
        if (!Number.isSafeInteger(pair.rowStart) || !Number.isSafeInteger(pair.rowCount) || pair.rowStart !== expectedRowStart || pair.rowCount < 0) {
            throw new Error(`source snapshot row partitions are not contiguous at ${pair.pairKey}.`);
        }
        if (previousPair && (previousPair.rowStart > pair.rowStart
            || (previousPair.rowStart === pair.rowStart && compareCodeUnits(previousPair.pairKey, pair.pairKey) > 0))) {
            throw new Error("source snapshot pairs are not sorted by rowStart and pairKey.");
        }
        previousPair = pair;
        expectedRowStart += pair.rowCount;
    };

    if (options.verifySourceRecords === false) {
        for (const pair of manifest.pairs) validatePairMetadata(pair);
        if (expectedRowStart !== manifest.ledgerRowCount) throw new Error("source snapshot row count does not cover ledger.jsonl.");
        await validateSourceArtifactHashes(runDir, manifest.pairs);
        return { folder: runDir, manifest, sourceSnapshotSha256: manifestHash };
    }

    const ledgerIterator = iterateJsonlLines(ledgerPath)[Symbol.asyncIterator]();
    try {
        for (let batchStart = 0; batchStart < manifest.pairs.length; batchStart += SOURCE_PAIR_READ_CONCURRENCY) {
            const batch = manifest.pairs.slice(batchStart, batchStart + SOURCE_PAIR_READ_CONCURRENCY);
            for (const pair of batch) {
                validatePairMetadata(pair);
            }
            const pairDataBatch = await Promise.all(batch.map((pair) => readPairData(runDir, pair)));
            for (let batchIndex = 0; batchIndex < batch.length; batchIndex += 1) {
                const pair = batch[batchIndex]!;
                const pairData = pairDataBatch[batchIndex]!;
                for (const entry of pairData.entries) {
                    const next = await ledgerIterator.next();
                    if (next.done) throw new Error(`ledger.jsonl ended before source entry ordinal ${entry[0]}.`);
                    let row: unknown;
                    try {
                        row = JSON.parse(next.value);
                    } catch (error) {
                        throw new Error(`ledger.jsonl contains invalid JSON: ${errorMessage(error)}.`);
                    }
                    validateLedgerRow(row, pair, entry);
                }
            }
        }
        const extra = await ledgerIterator.next();
        if (!extra.done) throw new Error("ledger.jsonl contains rows without source-snapshot entries.");
    } finally {
        await ledgerIterator.return?.(undefined);
    }
    if (expectedRowStart !== manifest.ledgerRowCount) throw new Error("source snapshot row count does not cover ledger.jsonl.");
    return { folder: runDir, manifest, sourceSnapshotSha256: manifestHash };
}

export async function validatePairFeatureSnapshotForGeneration(folder: string): Promise<ValidatedPairFeatureSnapshot> {
    const snapshot = await validatePairFeatureSnapshot(folder);
    if (!sameRuntime(snapshot.manifest.runtime, runtimeFingerprint())) {
        throw new Error("source snapshot runtime fingerprint does not match the current runtime.");
    }
    return snapshot;
}

function definitionWithoutDigest(definition: PairFeatureDefinition): Record<string, unknown> {
    const result: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(definition)) if (key !== "definitionDigest") result[key] = value;
    return result;
}

export async function validatePairFeatureLibraryRelease(libraryRelease: string): Promise<{ release: PairFeatureRelease; bytes: Buffer; sha256: string }> {
    const release = getPairFeatureRelease(libraryRelease);
    if (!release) throw new Error(`Unknown feature library release: ${libraryRelease}.`);
    if (release.catalogFormatVersion !== 1 || release.definitions.length === 0) throw new Error(`Invalid ${libraryRelease} feature release inventory.`);
    const currentRuntime = runtimeFingerprint();
    if (!sameRuntime(release.runtime, currentRuntime)) throw new Error("feature library release runtime fingerprint does not match the current runtime.");
    const sortedDefinitions = [...release.definitions].sort((left, right) => compareCodeUnits(left.id, right.id));
    if (sortedDefinitions.some((definition, index) => definition !== release.definitions[index])) throw new Error("Feature release definitions are not sorted.");
    for (const definition of release.definitions) {
        const digest = hashBytes(Buffer.from(canonicalJson(definitionWithoutDigest(definition)), "utf8"));
        if (digest !== definition.definitionDigest) throw new Error(`Definition digest mismatch for ${definition.id}.`);
        const catalogEntry = getPairFeatureCatalogEntryForRelease(libraryRelease, definition.id);
        if (!catalogEntry) throw new Error(`No evaluator exists for ${definition.id}.`);
        for (const implementation of definition.implementationFiles) {
            const implementationPath = await safeArtifactPath(process.cwd(), implementation.path);
            const actual = await hashFile(implementationPath);
            if (actual.sha256 !== implementation.sha256) throw new Error(`Implementation digest mismatch for ${implementation.path}.`);
        }
        for (const dependency of definition.dependencies) {
            const dependencyDefinition = release.definitions.find((candidate) => candidate.id === dependency.id);
            if (!dependencyDefinition || dependencyDefinition.definitionDigest !== dependency.definitionDigest) {
                throw new Error(`Definition dependency mismatch for ${definition.id}.`);
            }
        }
    }
    const bytes = Buffer.from(canonicalJson(release), "utf8");
    return { release, bytes, sha256: hashBytes(bytes) };
}

function resolveRequestedFeatures(featureIds: readonly string[], libraryRelease: string): RequestedFeature[] {
    if (featureIds.length === 0) throw new Error("At least one feature ID is required.");
    const seen = new Set<string>();
    const resolved = new Map<string, RequestedFeature>();
    for (const featureId of featureIds) {
        if (seen.has(featureId)) throw new Error(`Duplicate feature ID: ${featureId}.`);
        seen.add(featureId);
        const isObservationAccessor = featureId.endsWith("_n");
        const parentId = isObservationAccessor ? featureId.slice(0, -2) : featureId;
        if (!parentId) throw new Error(`Unknown feature ID: ${featureId}.`);
        const entry = getPairFeatureCatalogEntryForRelease(libraryRelease, parentId);
        if (!entry) throw new Error(`Unknown feature ID: ${featureId}.`);
        const existing = resolved.get(parentId);
        if (existing) {
            resolved.set(parentId, { entry, requestedIds: [...existing.requestedIds, featureId].sort(compareCodeUnits) });
        } else {
            resolved.set(parentId, { entry, requestedIds: [featureId] });
        }
    }
    return [...resolved.values()].sort((left, right) => compareCodeUnits(left.entry.definition.id, right.entry.definition.id));
}

function expectedColumnPaths(definition: PairFeatureDefinition, pairKeyValue: string): {
    values: string;
    valid: string;
    observations: string;
} {
    const prefix = `feature-packs/columns/${definition.definitionDigest}/${pairKeyValue}`;
    return {
        values: `${prefix}/values.f64le.gz`,
        valid: `${prefix}/valid.u8.gz`,
        observations: `${prefix}/observations.u32le.gz`,
    };
}

async function loadExistingFamilyManifests(folder: string, familyId: string): Promise<ExistingFamilyManifest[]> {
    const relativeDir = `feature-packs/families/${familyId}`;
    const absoluteDir = await safeArtifactPath(folder, relativeDir);
    let names;
    try {
        names = await readdir(absoluteDir);
    } catch (error) {
        if (isMissing(error)) return [];
        throw error;
    }
    const manifests: ExistingFamilyManifest[] = [];
    for (const name of names) {
        if (!name.endsWith(".json")) continue;
        const relativePath = `${relativeDir}/${name}`;
        const filePath = await safeArtifactPath(folder, relativePath);
        const stats = await lstat(filePath);
        if (!stats.isFile() || stats.isSymbolicLink() || (stats as { isReparsePoint?: () => boolean }).isReparsePoint?.()) throw new Error(`Invalid existing family manifest: ${relativePath}.`);
        const raw = await readFile(filePath);
        const manifest = JSON.parse(raw.toString("utf8")) as PairFeatureFamilyManifest;
        const digest = basename(name, ".json");
        if (hashBytes(Buffer.from(canonicalJson(manifest), "utf8")) !== digest) throw new Error(`Existing family manifest digest mismatch: ${relativePath}.`);
        manifests.push({ path: relativePath, manifest });
    }
    return manifests;
}

async function validateExistingColumnFile(
    folder: string,
    artifact: PairFeatureColumnArtifact,
    expectedPath: string,
    rowCount: number,
    kind: "values" | "valid" | "observations",
): Promise<number[]> {
    if (artifact.path !== expectedPath) throw new Error(`Existing ${kind} column path does not match its definition mapping.`);
    const filePath = await safeArtifactPath(folder, artifact.path);
    const compressed = await readFile(filePath);
    if (compressed.length !== artifact.bytes || hashBytes(compressed) !== artifact.sha256) throw new Error(`Existing ${kind} column hash mismatch: ${artifact.path}.`);
    const uncompressed = gunzipSync(compressed);
    if (uncompressed.length !== artifact.uncompressedBytes || hashBytes(uncompressed) !== artifact.uncompressedSha256) {
        throw new Error(`Existing ${kind} column uncompressed hash mismatch: ${artifact.path}.`);
    }
    const values = kind === "values"
        ? decodeFloat64LeUncompressed(uncompressed)
        : kind === "valid"
            ? decodeUint8Uncompressed(uncompressed)
            : decodeUint32LeUncompressed(uncompressed);
    if (values.length !== rowCount) throw new Error(`Existing ${kind} column length mismatch: ${artifact.path}.`);
    return values;
}

async function existingColumnPair(
    folder: string,
    definition: PairFeatureDefinition,
    pair: PairFeatureSnapshotPairManifest,
    familyManifests: readonly ExistingFamilyManifest[],
    ledgerSha256: string,
    ledgerRowCount: number,
    sourceSnapshotSha256: string,
): Promise<PairFeatureColumnPairManifest | null> {
    const paths = expectedColumnPaths(definition, pair.pairKey);
    const states = await Promise.all(Object.values(paths).map(async (relativePath) => {
        try {
            await lstat(await safeArtifactPath(folder, relativePath));
            return true;
        } catch (error) {
            if (isMissing(error)) return false;
            throw error;
        }
    }));
    const anyExisting = states.some(Boolean);
    if (!anyExisting) return null;
    if (!states.every(Boolean)) throw new Error(`Existing feature column partition is incomplete for ${pair.pairKey}.`);

    for (const family of familyManifests) {
        if (family.manifest.ledgerSha256 !== ledgerSha256
            || family.manifest.ledgerRowCount !== ledgerRowCount
            || family.manifest.sourceSnapshotSha256 !== sourceSnapshotSha256) continue;
        const feature = family.manifest.features.find((candidate) => candidate.id === definition.id && candidate.definitionDigest === definition.definitionDigest);
        const columnPair = feature?.pairs.find((candidate) => candidate.pairKey === pair.pairKey);
        if (!columnPair) continue;
        const values = await validateExistingColumnFile(folder, columnPair.values, paths.values, pair.rowCount, "values");
        const valid = await validateExistingColumnFile(folder, columnPair.valid, paths.valid, pair.rowCount, "valid");
        const observations = await validateExistingColumnFile(folder, columnPair.observations, paths.observations, pair.rowCount, "observations");
        let nullCount = 0;
        let observationMin = Number.POSITIVE_INFINITY;
        let observationMax = 0;
        for (let index = 0; index < pair.rowCount; index += 1) {
            if (valid[index] === 0) {
                nullCount += 1;
                if (values[index] !== 0) throw new Error(`Existing invalid ${definition.id} value is not canonical +0.`);
            }
            observationMin = Math.min(observationMin, observations[index]!);
            observationMax = Math.max(observationMax, observations[index]!);
        }
        if (pair.rowCount === 0) observationMin = 0;
        if (columnPair.nullCount !== nullCount || columnPair.observationMin !== observationMin || columnPair.observationMax !== observationMax) {
            throw new Error(`Existing ${definition.id} column summary does not match its bytes.`);
        }
        return columnPair;
    }
    // A duplicate generator may have published these deterministic files
    // before its family manifest. Recompute and byte-check them through the
    // no-overwrite publisher; never trust an unverified partition here.
    return null;
}

function columnArtifact(path: string, encoded: { compressed: Buffer; uncompressed: Buffer; compressedSha256: string; uncompressedSha256: string }): PairFeatureColumnArtifact {
    return {
        path,
        bytes: encoded.compressed.length,
        sha256: encoded.compressedSha256,
        uncompressedBytes: encoded.uncompressed.length,
        uncompressedSha256: encoded.uncompressedSha256,
    };
}

async function writeColumn(
    folder: string,
    relativePath: string,
    encoded: { compressed: Buffer },
): Promise<boolean> {
    await prepareArtifactDirectory(folder, dirname(relativePath).replaceAll("\\", "/"));
    return publishArtifactIfMissing(await safeArtifactPath(folder, relativePath), encoded.compressed);
}

function buildColumnPair(
    pairKeyValue: string,
    pair: PairFeatureSnapshotPairManifest,
    definition: PairFeatureDefinition,
    values: readonly number[],
    valid: readonly number[],
    observations: readonly number[],
): { pair: PairFeatureColumnPairManifest; encoded: { values: ReturnType<typeof encodeFloat64Le>; valid: ReturnType<typeof encodeUint8>; observations: ReturnType<typeof encodeUint32Le> } } {
    const paths = expectedColumnPaths(definition, pairKeyValue);
    let nullCount = 0;
    let observationMin = Number.POSITIVE_INFINITY;
    let observationMax = 0;
    for (let index = 0; index < pair.rowCount; index += 1) {
        if (valid[index] === 0) nullCount += 1;
        observationMin = Math.min(observationMin, observations[index]!);
        observationMax = Math.max(observationMax, observations[index]!);
    }
    if (pair.rowCount === 0) observationMin = 0;
    const encoded = {
        values: encodeFloat64Le(values),
        valid: encodeUint8(valid),
        observations: encodeUint32Le(observations),
    };
    return {
        pair: {
            pairKey: pairKeyValue,
            values: columnArtifact(paths.values, encoded.values),
            valid: columnArtifact(paths.valid, encoded.valid),
            observations: columnArtifact(paths.observations, encoded.observations),
            rowCount: pair.rowCount,
            nullCount,
            observationMin,
            observationMax,
        },
        encoded,
    };
}

async function generateMissingPairColumns(
    folder: string,
    pair: PairFeatureSnapshotPairManifest,
    pairData: PairData,
    missing: readonly RequestedFeature[],
    signal?: AbortSignal,
): Promise<Map<string, PairFeatureColumnPairManifest>> {
    const values = new Map<string, number[]>();
    const valid = new Map<string, number[]>();
    const observations = new Map<string, number[]>();
    for (const requested of missing) {
        values.set(requested.entry.definition.id, Array<number>(pair.rowCount).fill(0));
        valid.set(requested.entry.definition.id, Array<number>(pair.rowCount).fill(0));
        observations.set(requested.entry.definition.id, Array<number>(pair.rowCount).fill(0));
    }

    const orderedTrades = pairData.trades.slice().sort((left, right) => left.exitBarIndex - right.exitBarIndex || left.tradeOrdinal - right.tradeOrdinal);
    const historicalTrades: PairFeatureSnapshotTrade[] = [];
    const historicalEntries: (PairFeatureSnapshotEntry | PairFeatureSnapshotWarmupEntry)[] = [...pairData.warmupEntries];
    let tradeCursor = 0;
    let entryIndex = 0;
    let previousSignalBarIndex = -1;
    while (entryIndex < pairData.entries.length) {
        throwIfAborted(signal);
        const signalBarIndex = pairData.entries[entryIndex]![1];
        if (signalBarIndex < previousSignalBarIndex) throw new Error(`Historical boundary regressed for ${pair.pairKey}.`);
        previousSignalBarIndex = signalBarIndex;
        while (tradeCursor < orderedTrades.length && orderedTrades[tradeCursor]!.exitBarIndex < signalBarIndex) {
            historicalTrades.push(orderedTrades[tradeCursor]!);
            tradeCursor += 1;
        }
        let endIndex = entryIndex + 1;
        while (endIndex < pairData.entries.length && pairData.entries[endIndex]![1] === signalBarIndex) endIndex += 1;
        const context: PairFeatureEvaluationContext = { bars: pairData.bars, signalBarIndex, historicalTrades, historicalEntries };
        for (let index = entryIndex; index < endIndex; index += 1) {
            for (const requested of missing) {
                throwIfAborted(signal);
                const result = requested.entry.evaluate(context);
                const featureId = requested.entry.definition.id;
                observations.get(featureId)![index] = result.observations;
                if (result.value !== null) {
                    if (!Number.isFinite(result.value)) throw new Error(`${featureId} produced a non-finite value.`);
                    values.get(featureId)![index] = Object.is(result.value, -0) ? 0 : result.value;
                    valid.get(featureId)![index] = 1;
                }
            }
        }
        for (let index = entryIndex; index < endIndex; index += 1) historicalEntries.push(pairData.entries[index]!);
        entryIndex = endIndex;
    }

    const generated = new Map<string, PairFeatureColumnPairManifest>();
    for (const requested of missing) {
        throwIfAborted(signal);
        const featureId = requested.entry.definition.id;
        const built = buildColumnPair(
            pair.pairKey,
            pair,
            requested.entry.definition,
            values.get(featureId)!,
            valid.get(featureId)!,
            observations.get(featureId)!,
        );
        await writeColumn(folder, built.pair.values.path, built.encoded.values);
        await writeColumn(folder, built.pair.valid.path, built.encoded.valid);
        await writeColumn(folder, built.pair.observations.path, built.encoded.observations);
        generated.set(featureId, built.pair);
    }
    return generated;
}

/**
 * Generate one pair's missing columns in a worker thread. The caller has
 * already validated the immutable snapshot; the worker still validates the
 * pair records while reading them before it writes any column bytes.
 */
export async function generatePairFeatureColumnsForWorker(
    folder: string,
    libraryRelease: string,
    pair: PairFeatureSnapshotPairManifest,
    featureIds: readonly string[],
): Promise<readonly [string, PairFeatureColumnPairManifest][]> {
    const requested = resolveRequestedFeatures([...featureIds].sort(compareCodeUnits), libraryRelease);
    if (requested.length === 0) return [];
    const generated = await generateMissingPairColumns(folder, pair, await readPairData(folder, pair), requested);
    return [...generated.entries()];
}

interface PairFeatureWorkerTask {
    taskId: string;
    folder: string;
    libraryRelease: string;
    pair: PairFeatureSnapshotPairManifest;
    featureIds: readonly string[];
}

interface PairFeaturePairInspection {
    pair: PairFeatureSnapshotPairManifest;
    missing: readonly RequestedFeature[];
    columnsForPair: Map<string, PairFeatureColumnPairManifest>;
    computedForFamily: Map<string, number>;
    reusedForFamily: Map<string, number>;
}

interface PairFeatureWorkerDoneMessage {
    type: "done";
    taskId: string;
    generated: readonly [string, PairFeatureColumnPairManifest][];
}

interface PairFeatureWorkerErrorMessage {
    type: "error";
    taskId: string;
    error: string;
}

interface PairFeatureWorkerReadyMessage {
    type: "ready";
}

type PairFeatureWorkerMessage =
    | PairFeatureWorkerReadyMessage
    | PairFeatureWorkerDoneMessage
    | PairFeatureWorkerErrorMessage;

function pairFeatureWorkerCount(taskCount: number): number {
    const configured = Number(process.env.PAIR_FEATURE_GENERATION_WORKERS);
    const requested = Number.isFinite(configured) && configured >= 1
        ? Math.floor(configured)
        : Math.max(1, Math.min(FEATURE_GENERATION_MAX_WORKERS, availableParallelism() - 1));
    return Math.max(1, Math.min(requested, taskCount));
}

function pairFeatureWorkerPath(): string {
    return resolve(dirname(fileURLToPath(import.meta.url)), "../../scripts/pair-feature-generation-worker.cjs");
}

async function generateMissingPairColumnsInWorkers(
    tasks: readonly PairFeatureWorkerTask[],
    signal?: AbortSignal,
): Promise<readonly PairFeatureWorkerDoneMessage[]> {
    if (tasks.length === 0) return [];
    throwIfAborted(signal);
    const workerCount = pairFeatureWorkerCount(tasks.length);
    const workers = Array.from({ length: workerCount }, () => new Worker(pairFeatureWorkerPath()));
    const pending = new Map<string, { resolve: (message: PairFeatureWorkerDoneMessage) => void; reject: (error: Error) => void }>();
    let readyCount = 0;
    let readyResolve!: () => void;
    let readyReject!: (error: Error) => void;
    const ready = new Promise<void>((resolveReady, rejectReady) => {
        readyResolve = resolveReady;
        readyReject = rejectReady;
    });
    let closed = false;
    let fatalError: Error | null = null;
    const fail = (error: Error): void => {
        if (fatalError) return;
        fatalError = error;
        readyReject(error);
        for (const entry of pending.values()) entry.reject(error);
        pending.clear();
    };
    const onMessage = (message: PairFeatureWorkerMessage): void => {
        if (message.type === "ready") {
            readyCount += 1;
            if (readyCount === workers.length) readyResolve();
            return;
        }
        if (message.type === "error") {
            fail(new Error(message.error));
            return;
        }
        const entry = pending.get(message.taskId);
        if (!entry) return;
        pending.delete(message.taskId);
        entry.resolve(message);
    };
    for (const worker of workers) {
        worker.on("message", onMessage);
        worker.on("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
        worker.on("exit", (code) => {
            if (!closed && code !== 0) fail(new Error(`Pair feature worker exited with code ${code}.`));
        });
    }
    const abort = (): void => fail(new Error("Pair-feature preparation cancelled."));
    signal?.addEventListener("abort", abort, { once: true });
    try {
        await ready;
        if (fatalError) throw fatalError;
        const messages = tasks.map((task, index) => new Promise<PairFeatureWorkerDoneMessage>((resolveDone, rejectDone) => {
            const taskId = `${index}`;
            pending.set(taskId, { resolve: resolveDone, reject: rejectDone });
            const message: PairFeatureWorkerTask = { ...task, taskId };
            workers[index % workers.length]!.postMessage(message);
        }));
        return await Promise.all(messages);
    } finally {
        signal?.removeEventListener("abort", abort);
        closed = true;
        for (const entry of pending.values()) entry.reject(fatalError ?? new Error("Pair feature workers closed."));
        pending.clear();
        await Promise.all(workers.map((worker) => worker.terminate()));
    }
}

async function withPairGenerationLock<T>(folder: string, operation: () => Promise<T>): Promise<T> {
    const previous = pairGenerationTails.get(folder) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    pairGenerationTails.set(folder, current);
    await previous;
    try {
        return await operation();
    } finally {
        release();
        if (pairGenerationTails.get(folder) === current) pairGenerationTails.delete(folder);
    }
}

export async function generatePairFeaturePack(
    folderPath: string,
    libraryRelease: string,
    featureIds: readonly string[],
    options: PairFeatureGenerationOptions = {},
): Promise<PairFeaturePackResult> {
    return withPairGenerationLock(folderPath, () => generatePairFeaturePackUnlocked(folderPath, libraryRelease, featureIds, options));
}

async function generatePairFeaturePackUnlocked(
    folderPath: string,
    libraryRelease: string,
    featureIds: readonly string[],
    options: PairFeatureGenerationOptions = {},
): Promise<PairFeaturePackResult> {
    throwIfAborted(options.signal);
    const snapshot = options.validatedSnapshot ?? await validatePairFeatureSnapshotForGeneration(folderPath);
    if (options.validatedSnapshot && !sameRuntime(snapshot.manifest.runtime, runtimeFingerprint())) {
        throw new Error("source snapshot runtime fingerprint does not match the current runtime.");
    }
    const release = await validatePairFeatureLibraryRelease(libraryRelease);
    const requestedIds = [...featureIds].sort(compareCodeUnits);
    const requested = resolveRequestedFeatures(requestedIds, libraryRelease);
    const capabilities = new Set<string>(snapshot.manifest.capabilities);
    for (const item of requested) {
        for (const capability of item.entry.definition.requiredCapabilities) {
            if (!capabilities.has(capability)) throw new Error(`source snapshot missing capability ${capability}.`);
        }
    }
    const releaseRelativePath = `feature-packs/releases/${libraryRelease}.json`;
    const releasePath = await safeArtifactPath(snapshot.folder, releaseRelativePath);
    await prepareArtifactDirectory(snapshot.folder, "feature-packs/releases");
    await publishArtifactIfMissing(releasePath, release.bytes);

    const familiesById = new Map<string, RequestedFeature[]>();
    for (const item of requested) {
        const familyId = item.entry.definition.family;
        const family = familiesById.get(familyId) ?? [];
        family.push(item);
        familiesById.set(familyId, family);
    }
    const existingByFamily = new Map<string, ExistingFamilyManifest[]>();
    for (const familyId of [...familiesById.keys()].sort(compareCodeUnits)) {
        existingByFamily.set(familyId, await loadExistingFamilyManifests(snapshot.folder, familyId));
    }
    const pairColumns = new Map<string, Map<string, PairFeatureColumnPairManifest[]>>();
    for (const item of requested) pairColumns.set(item.entry.definition.id, new Map());
    const computedByFamily = new Map<string, number>();
    const reusedByFamily = new Map<string, number>();
    let computedColumns = 0;
    let reusedColumns = 0;
    const allNullFeatureIds = new Set<string>();
    const inspections: PairFeaturePairInspection[] = [];
    for (let batchStart = 0; batchStart < snapshot.manifest.pairs.length; batchStart += FEATURE_PAIR_GENERATION_CONCURRENCY) {
        const batch = snapshot.manifest.pairs.slice(batchStart, batchStart + FEATURE_PAIR_GENERATION_CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(async (pair): Promise<PairFeaturePairInspection> => {
            throwIfAborted(options.signal);
            const missing: RequestedFeature[] = [];
            const columnsForPair = new Map<string, PairFeatureColumnPairManifest>();
            const computedForFamily = new Map<string, number>();
            const reusedForFamily = new Map<string, number>();
            for (const item of requested) {
                const familyManifests = existingByFamily.get(item.entry.definition.family)!;
                const existing = await existingColumnPair(
                    snapshot.folder,
                    item.entry.definition,
                    pair,
                    familyManifests,
                    snapshot.manifest.ledgerSha256,
                    snapshot.manifest.ledgerRowCount,
                    snapshot.sourceSnapshotSha256,
                );
                if (existing) {
                    columnsForPair.set(item.entry.definition.id, existing);
                    reusedForFamily.set(item.entry.definition.family, (reusedForFamily.get(item.entry.definition.family) ?? 0) + 3);
                } else {
                    missing.push(item);
                }
            }
            return { pair, missing, columnsForPair, computedForFamily, reusedForFamily };
        }));
        for (const result of settled) if (result.status === "rejected") throw result.reason;
        for (const result of settled) if (result.status === "fulfilled") inspections.push(result.value);
    }

    const missingInspections = inspections.filter((inspection) => inspection.missing.length > 0);
    const totalRowsToGenerate = missingInspections.reduce((sum, inspection) => sum + inspection.pair.rowCount, 0);
    const generatedByPair = new Map<string, ReadonlyMap<string, PairFeatureColumnPairManifest>>();
    let workersUsed = 0;
    if (totalRowsToGenerate >= FEATURE_GENERATION_WORKER_THRESHOLD_ROWS && missingInspections.length > 1) {
        const workerTasks = missingInspections.map((inspection, index): PairFeatureWorkerTask => ({
            taskId: `${index}`,
            folder: snapshot.folder,
            libraryRelease,
            pair: inspection.pair,
            featureIds: inspection.missing.map((item) => item.entry.definition.id),
        }));
        workersUsed = pairFeatureWorkerCount(workerTasks.length);
        const generated = await generateMissingPairColumnsInWorkers(workerTasks, options.signal);
        for (const result of generated) {
            const task = workerTasks[Number(result.taskId)];
            if (!task) throw new Error(`Pair feature worker returned an unknown task ${result.taskId}.`);
            generatedByPair.set(task.pair.pairKey, new Map(result.generated));
        }
    } else {
        for (const inspection of missingInspections) {
            throwIfAborted(options.signal);
            generatedByPair.set(inspection.pair.pairKey, await generateMissingPairColumns(
                snapshot.folder,
                inspection.pair,
                await readPairData(snapshot.folder, inspection.pair),
                inspection.missing,
                options.signal,
            ));
        }
    }

    for (const inspection of inspections) {
        const generated = generatedByPair.get(inspection.pair.pairKey);
        for (const item of inspection.missing) {
            const column = generated?.get(item.entry.definition.id);
            if (!column) throw new Error(`Pair feature generation did not return ${item.entry.definition.id} for ${inspection.pair.pairKey}.`);
            inspection.columnsForPair.set(item.entry.definition.id, column);
            inspection.computedForFamily.set(item.entry.definition.family, (inspection.computedForFamily.get(item.entry.definition.family) ?? 0) + 3);
        }
        for (const item of requested) {
            pairColumns.get(item.entry.definition.id)!.set(inspection.pair.pairKey, [inspection.columnsForPair.get(item.entry.definition.id)!]);
        }
        for (const [familyId, count] of inspection.computedForFamily) {
            computedColumns += count;
            computedByFamily.set(familyId, (computedByFamily.get(familyId) ?? 0) + count);
        }
        for (const [familyId, count] of inspection.reusedForFamily) {
            reusedColumns += count;
            reusedByFamily.set(familyId, (reusedByFamily.get(familyId) ?? 0) + count);
        }
    }

    const familyManifests: string[] = [];
    const familyReferences: { path: string; sha256: string }[] = [];
    const familySummaries: PairFeatureFamilyGenerationSummary[] = [];
    for (const familyId of [...familiesById.keys()].sort(compareCodeUnits)) {
        throwIfAborted(options.signal);
        const features: PairFeatureFamilyFeatureManifest[] = familiesById.get(familyId)!
            .slice()
            .sort((left, right) => compareCodeUnits(left.entry.definition.id, right.entry.definition.id))
            .map((item) => ({
                id: item.entry.definition.id,
                definitionDigest: item.entry.definition.definitionDigest,
                pairs: snapshot.manifest.pairs.map((pair) => pairColumns.get(item.entry.definition.id)!.get(pair.pairKey)![0]!),
            }));
        const familyManifest: PairFeatureFamilyManifest = {
            formatVersion: 1,
            familyId,
            ledgerSha256: snapshot.manifest.ledgerSha256,
            ledgerRowCount: snapshot.manifest.ledgerRowCount,
            sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
            features,
        };
        const familyBytes = Buffer.from(canonicalJson(familyManifest), "utf8");
        const familyDigest = hashBytes(familyBytes);
        const familyPath = `feature-packs/families/${familyId}/${familyDigest}.json`;
        await prepareArtifactDirectory(snapshot.folder, `feature-packs/families/${familyId}`);
        await publishArtifactIfMissing(await safeArtifactPath(snapshot.folder, familyPath), familyBytes);
        familyManifests.push(familyPath);
        familyReferences.push({ path: familyPath, sha256: familyDigest });
        let compressedBytes = 0;
        for (const feature of features) for (const pair of feature.pairs) compressedBytes += pair.values.bytes + pair.valid.bytes + pair.observations.bytes;
        const columnCoverage = features.map((feature): PairFeatureColumnCoverage => {
            const rowCount = feature.pairs.reduce((sum, pair) => sum + pair.rowCount, 0);
            const nullCount = feature.pairs.reduce((sum, pair) => sum + pair.nullCount, 0);
            const observationMin = feature.pairs.length === 0 ? 0 : Math.min(...feature.pairs.map((pair) => pair.observationMin));
            const observationMax = feature.pairs.length === 0 ? 0 : Math.max(...feature.pairs.map((pair) => pair.observationMax));
            const coverage = {
                featureId: feature.id,
                rowCount,
                nullCount,
                nullShare: rowCount > 0 ? nullCount / rowCount : 0,
                observationMin,
                observationMax,
            };
            if (rowCount > 0 && nullCount === rowCount) allNullFeatureIds.add(feature.id);
            return coverage;
        });
        familySummaries.push({
            familyId,
            featureIds: features.map((feature) => feature.id),
            pairCount: snapshot.manifest.pairs.length,
            computedColumns: computedByFamily.get(familyId) ?? 0,
            reusedColumns: reusedByFamily.get(familyId) ?? 0,
            compressedBytes,
            columnCoverage,
        });
        options.onProgress?.({
            familyId,
            featureIds: familySummaries.at(-1)!.featureIds,
            computedColumns: computedByFamily.get(familyId) ?? 0,
            reusedColumns: reusedByFamily.get(familyId) ?? 0,
            compressedBytes,
            allNullFeatureIds: features.filter((feature) => feature.pairs.length > 0
                && feature.pairs.every((pair) => pair.rowCount === 0 || pair.nullCount === pair.rowCount)).map((feature) => feature.id),
        });
        throwIfAborted(options.signal);
    }
    familyManifests.sort(compareCodeUnits);
    familyReferences.sort((left, right) => compareCodeUnits(left.path, right.path));
    const packManifest: PairFeaturePackManifest = {
        formatVersion: 1,
        libraryRelease,
        libraryReleaseSha256: release.sha256,
        ledgerSha256: snapshot.manifest.ledgerSha256,
        ledgerRowCount: snapshot.manifest.ledgerRowCount,
        sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
        requestedFeatureIds: requestedIds,
        familyManifests: familyReferences,
    };
    const packBytes = Buffer.from(canonicalJson(packManifest), "utf8");
    const packDigest = hashBytes(packBytes);
    const packPath = `feature-packs/manifests/${packDigest}.json`;
    await prepareArtifactDirectory(snapshot.folder, "feature-packs/manifests");
    await publishArtifactIfMissing(await safeArtifactPath(snapshot.folder, packPath), packBytes);
    return {
        packDigest,
        packPath,
        releasePath: releaseRelativePath,
        releaseSha256: release.sha256,
        sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
        ledgerSha256: snapshot.manifest.ledgerSha256,
        familyManifests,
        computedColumns,
        reusedColumns,
        families: familySummaries,
        allNullFeatureIds: [...allNullFeatureIds].sort(compareCodeUnits),
        workersUsed,
    };
}
