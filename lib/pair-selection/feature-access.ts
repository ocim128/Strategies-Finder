import { Buffer } from "node:buffer";
import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import {
    canonicalJson,
    decodeFloat64Le,
    decodeUint32Le,
    decodeUint8,
    hashBytes,
    hashFile,
    prepareArtifactDirectory,
    publishArtifactIfMissing,
    safeArtifactPath,
} from "../pair-features/artifact-io";
import {
    getPairFeatureCatalogEntryForRelease,
} from "../pair-features/catalog";
import {
    generatePairFeaturePack,
    type PairFeatureGenerationProgress,
    validatePairFeatureLibraryRelease,
    validatePairFeatureSnapshot,
} from "../pair-features/generate";
import type {
    PairFeatureColumnPairManifest,
    PairFeatureDefinition,
    PairFeatureFamilyManifest,
    PairFeaturePackManifest,
} from "../pair-features/types";
import type { PairSelectionResult } from "./tally";
import type { PairSelectionRule } from "./types";
import { gunzipSync } from "node:zlib";

const FEATURE_PACK_MANIFEST_DIR = "feature-packs/manifests";
const FEATURE_PACK_CHECK_DIR = "feature-packs/checks";

interface RequirementKey {
    libraryRelease: string;
    parentId: string;
}

interface PreparedColumn {
    definition: PairFeatureDefinition;
    pairs: readonly PairFeatureColumnPairManifest[];
    rowStarts: ReadonlyMap<string, number>;
}

interface PreparedPack {
    path: string;
    sha256: string;
    manifest: PairFeaturePackManifest;
    families: readonly PairFeatureFamilyManifest[];
}

export interface PreparedPairFeatures {
    readonly folderPath: string;
    readonly ledgerSha256: string | null;
    readonly sourceSnapshotSha256: string | null;
    readonly ledgerRowCount: number;
    readonly columns: ReadonlyMap<string, PreparedColumn>;
    readonly packs: readonly PreparedPack[];
    active: ActivePairFeatures | null;
}

export interface ActivePairFeatures {
    readonly ruleKey: string;
    readonly requestedColumns: readonly string[];
    readCandidateFeatures(rowOrdinal: number): Readonly<Record<string, number | null>>;
    release(): void;
}

interface ResolvedRequirement extends RequirementKey {
    requestedIds: string[];
    definition: PairFeatureDefinition;
}

interface ReceiptRule {
    key: string;
    sourceFiles: readonly { path: string; sha256: string }[];
    parameters: Readonly<Record<string, number>>;
}

export interface PairSelectionCheckReceiptInput {
    prepared: PreparedPairFeatures;
    rules: readonly PairSelectionRule[];
    horizons: readonly number[];
    results: readonly PairSelectionResult[];
    fromSec?: number | null;
    toSec?: number | null;
}

export interface PairSelectionCheckReceipt {
    formatVersion: 1;
    ledgerSha256: string;
    sourceSnapshotSha256: string;
    libraryRelease: string | null;
    libraryReleases: readonly string[];
    libraryReleaseDigests: readonly { release: string; sha256: string }[];
    definitionDigests: readonly { id: string; sha256: string }[];
    packDigests: readonly { path: string; sha256: string }[];
    rules: readonly ReceiptRule[];
    horizons: readonly number[];
    dateBoundaries: { fromSec: number | null; toSec: number | null };
    resultsSha256: string;
    receiptDigest: string;
}

export type PairFeaturePreparationProgress = PairFeatureGenerationProgress;

function compare(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function isMissing(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}

function throwIfAborted(signal?: AbortSignal): void {
    if (signal?.aborted) throw new Error("Pair-feature preparation cancelled.");
}

function requirementKey(libraryRelease: string, parentId: string): string {
    return `${libraryRelease}\u0000${parentId}`;
}

function parentFeatureId(featureId: string): string {
    return featureId.endsWith("_n") ? featureId.slice(0, -2) : featureId;
}

function resolveRequirements(rules: readonly PairSelectionRule[]): ResolvedRequirement[] {
    const resolved = new Map<string, ResolvedRequirement>();
    for (const rule of rules) {
        const requirement = rule.metadata?.featureRequirements;
        if (!requirement || requirement.columns.length === 0) continue;
        if (!requirement.libraryRelease.trim()) throw new Error(`Pair-selection rule ${rule.key} has an empty feature library release.`);
        for (const requestedId of requirement.columns) {
            const parentId = parentFeatureId(requestedId);
            const entry = getPairFeatureCatalogEntryForRelease(requirement.libraryRelease, parentId);
            if (!entry) throw new Error(`Unknown pair feature ID: ${requestedId}.`);
            const key = requirementKey(requirement.libraryRelease, parentId);
            const existing = resolved.get(key);
            if (existing) {
                if (!existing.requestedIds.includes(requestedId)) {
                    existing.requestedIds = [...existing.requestedIds, requestedId].sort(compare);
                }
            } else {
                resolved.set(key, {
                    libraryRelease: requirement.libraryRelease,
                    parentId,
                    requestedIds: [requestedId],
                    definition: entry.definition,
                });
            }
        }
    }
    return [...resolved.values()].sort((left, right) =>
        compare(requirementKey(left.libraryRelease, left.parentId), requirementKey(right.libraryRelease, right.parentId)));
}

function missingPackCommand(folderPath: string, missing: readonly ResolvedRequirement[]): string {
    const byRelease = new Map<string, string[]>();
    for (const item of missing) {
        const ids = byRelease.get(item.libraryRelease) ?? [];
        ids.push(...item.requestedIds);
        byRelease.set(item.libraryRelease, ids);
    }
    const commands = [...byRelease.entries()]
        .sort(([left], [right]) => compare(left, right))
        .map(([release, ids]) => `esno scripts/pair-feature-pack.ts ${folderPath} ${release} ${[...new Set(ids)].sort(compare).join(" ")}`);
    return commands.join("\n");
}

function assertRegularFile(stats: { isFile(): boolean; isSymbolicLink(): boolean; isReparsePoint?: () => boolean }, label: string): void {
    if (!stats.isFile() || stats.isSymbolicLink() || stats.isReparsePoint?.() === true) throw new Error(`${label} is not a regular file.`);
}

async function readJsonFile<T>(folder: string, relativePath: string, label: string): Promise<{ value: T; bytes: Buffer; sha256: string }> {
    const filePath = await safeArtifactPath(folder, relativePath);
    const stats = await lstat(filePath);
    assertRegularFile(stats, label);
    const bytes = await readFile(filePath);
    let value: T;
    try {
        value = JSON.parse(bytes.toString("utf8")) as T;
    } catch (error) {
        throw new Error(`${label} is not valid JSON: ${errorMessage(error)}.`);
    }
    return { value, bytes, sha256: hashBytes(bytes) };
}

function expectedColumnPath(definition: PairFeatureDefinition, pairKey: string, kind: "values" | "valid" | "observations"): string {
    return `feature-packs/columns/${definition.definitionDigest}/${pairKey}/${kind === "values" ? "values.f64le.gz" : kind === "valid" ? "valid.u8.gz" : "observations.u32le.gz"}`;
}

async function validateColumnPresence(
    folder: string,
    definition: PairFeatureDefinition,
    pair: PairFeatureColumnPairManifest,
): Promise<void> {
    if (pair.pairKey.length === 0 || pair.rowCount < 0 || !Number.isSafeInteger(pair.rowCount)) throw new Error(`Invalid ${definition.id} pair column row count.`);
    const expected = {
        values: expectedColumnPath(definition, pair.pairKey, "values"),
        valid: expectedColumnPath(definition, pair.pairKey, "valid"),
        observations: expectedColumnPath(definition, pair.pairKey, "observations"),
    } as const;
    for (const kind of ["values", "valid", "observations"] as const) {
        const artifact = pair[kind];
        if (artifact.path !== expected[kind] || artifact.bytes < 0 || artifact.uncompressedBytes < 0) throw new Error(`Invalid ${definition.id} ${kind} column mapping.`);
        const stats = await lstat(await safeArtifactPath(folder, artifact.path));
        assertRegularFile(stats, artifact.path);
    }
}

function validatePairRows(
    snapshotPairs: readonly { pairKey: string; rowStart: number; rowCount: number }[],
    definition: PairFeatureDefinition,
    pairs: readonly PairFeatureColumnPairManifest[],
): void {
    if (pairs.length !== snapshotPairs.length) throw new Error(`Feature ${definition.id} pair partition count does not match the source snapshot.`);
    const expected = new Map(snapshotPairs.map((pair) => [pair.pairKey, pair] as const));
    const seen = new Set<string>();
    for (const pair of pairs) {
        const source = expected.get(pair.pairKey);
        if (!source || seen.has(pair.pairKey) || pair.rowCount !== source.rowCount) {
            throw new Error(`Feature ${definition.id} pair partition does not match the source snapshot.`);
        }
        seen.add(pair.pairKey);
    }
}

async function readPack(
    folder: string,
    relativePath: string,
    snapshot: Awaited<ReturnType<typeof validatePairFeatureSnapshot>>,
    requirements: readonly ResolvedRequirement[],
    releaseById: ReadonlyMap<string, Awaited<ReturnType<typeof validatePairFeatureLibraryRelease>>>,
    signal?: AbortSignal,
): Promise<PreparedPack | null> {
    throwIfAborted(signal);
    const packFile = await readJsonFile<PairFeaturePackManifest>(folder, relativePath, relativePath);
    const digest = path.basename(relativePath, ".json");
    if (packFile.sha256 !== digest || hashBytes(Buffer.from(canonicalJson(packFile.value), "utf8")) !== digest) {
        throw new Error(`Feature pack manifest digest mismatch: ${relativePath}.`);
    }
    const manifest = packFile.value;
    const relevant = requirements.filter((item) => item.libraryRelease === manifest.libraryRelease);
    if (relevant.length === 0) return null;
    if (manifest.formatVersion !== 1
        || manifest.ledgerSha256 !== snapshot.manifest.ledgerSha256
        || manifest.ledgerRowCount !== snapshot.manifest.ledgerRowCount
        || manifest.sourceSnapshotSha256 !== snapshot.sourceSnapshotSha256) {
        throw new Error(`Feature pack binding mismatch: ${relativePath}.`);
    }
    const release = releaseById.get(manifest.libraryRelease);
    if (!release || manifest.libraryReleaseSha256 !== release.sha256) throw new Error(`Feature pack release mismatch: ${relativePath}.`);
    const releaseRelativePath = `feature-packs/releases/${manifest.libraryRelease}.json`;
    let releaseFile: Awaited<ReturnType<typeof readJsonFile<unknown>>>;
    try {
        releaseFile = await readJsonFile<unknown>(folder, releaseRelativePath, releaseRelativePath);
    } catch (error) {
        if (isMissing(error)) throw new Error(missingPackCommand(folder, relevant));
        throw error;
    }
    if (releaseFile.sha256 !== release.sha256 || canonicalJson(releaseFile.value) !== canonicalJson(release.release)) {
        throw new Error(`Feature pack release bytes mismatch: ${releaseRelativePath}.`);
    }
    const families: PairFeatureFamilyManifest[] = [];
    for (const familyReference of manifest.familyManifests) {
        throwIfAborted(signal);
        let familyFile: Awaited<ReturnType<typeof readJsonFile<PairFeatureFamilyManifest>>>;
        try {
            familyFile = await readJsonFile<PairFeatureFamilyManifest>(folder, familyReference.path, familyReference.path);
        } catch (error) {
            if (isMissing(error)) throw new Error(missingPackCommand(folder, relevant));
            throw error;
        }
        if (familyFile.sha256 !== familyReference.sha256
            || path.basename(familyReference.path, ".json") !== familyReference.sha256
            || hashBytes(Buffer.from(canonicalJson(familyFile.value), "utf8")) !== familyReference.sha256) {
            throw new Error(`Feature family manifest digest mismatch: ${familyReference.path}.`);
        }
        const family = familyFile.value;
        if (family.formatVersion !== 1
            || family.ledgerSha256 !== snapshot.manifest.ledgerSha256
            || family.ledgerRowCount !== snapshot.manifest.ledgerRowCount
            || family.sourceSnapshotSha256 !== snapshot.sourceSnapshotSha256) {
            throw new Error(`Feature family binding mismatch: ${familyReference.path}.`);
        }
        for (const feature of family.features) {
            const definition = release.release.definitions.find((candidate) => candidate.id === feature.id);
            if (!definition || feature.definitionDigest !== definition.definitionDigest) throw new Error(`Feature definition mismatch for ${feature.id}.`);
            const relevantFeature = relevant.some((item) => item.parentId === feature.id);
            if (!relevantFeature) continue;
            validatePairRows(snapshot.manifest.pairs, definition, feature.pairs);
            for (const pair of feature.pairs) {
                throwIfAborted(signal);
                try {
                    await validateColumnPresence(folder, definition, pair);
                } catch (error) {
                    if (isMissing(error)) {
                        throw new Error(missingPackCommand(folder, relevant.filter((item) => item.parentId === feature.id)));
                    }
                    throw error;
                }
            }
        }
        families.push(family);
    }
    return { path: relativePath, sha256: digest, manifest, families };
}

function findPreparedColumns(
    packs: readonly PreparedPack[],
    requirements: readonly ResolvedRequirement[],
    snapshotPairs: readonly { pairKey: string; rowStart: number }[],
): Map<string, PreparedColumn> {
    const columns = new Map<string, PreparedColumn>();
    for (const pack of packs) {
        for (const family of pack.families) {
            for (const feature of family.features) {
                const requirement = requirements.find((item) => item.libraryRelease === pack.manifest.libraryRelease && item.parentId === feature.id);
                if (!requirement) continue;
                const key = requirementKey(requirement.libraryRelease, requirement.parentId);
                if (!columns.has(key)) columns.set(key, {
                    definition: requirement.definition,
                    pairs: feature.pairs,
                    rowStarts: new Map(snapshotPairs.map((pair) => [pair.pairKey, pair.rowStart] as const)),
                });
            }
        }
    }
    return columns;
}

export async function ensurePairFeatures(
    folderPath: string,
    rules: readonly PairSelectionRule[],
    signal?: AbortSignal,
    onProgress?: (progress: PairFeaturePreparationProgress) => void,
): Promise<PreparedPairFeatures> {
    const requirements = resolveRequirements(rules);
    if (requirements.length === 0) {
        return { folderPath, ledgerSha256: null, sourceSnapshotSha256: null, ledgerRowCount: 0, columns: new Map(), packs: [], active: null };
    }
    throwIfAborted(signal);
    const snapshot = await validatePairFeatureSnapshot(folderPath);
    const releases = new Map<string, Awaited<ReturnType<typeof validatePairFeatureLibraryRelease>>>();
    for (const libraryRelease of [...new Set(requirements.map((item) => item.libraryRelease))].sort(compare)) {
        throwIfAborted(signal);
        releases.set(libraryRelease, await validatePairFeatureLibraryRelease(libraryRelease));
    }
    const packs: PreparedPack[] = [];
    const columns = new Map<string, PreparedColumn>();
    async function readAvailablePacks(): Promise<void> {
        let names: string[];
        try {
            names = await readdir(await safeArtifactPath(folderPath, FEATURE_PACK_MANIFEST_DIR));
        } catch (error) {
            if (isMissing(error)) names = [];
            else throw error;
        }
        packs.splice(0, packs.length);
        for (const packPath of names.filter((name) => name.endsWith(".json")).sort(compare).map((name) => `${FEATURE_PACK_MANIFEST_DIR}/${name}`)) {
            const pack = await readPack(folderPath, packPath, snapshot, requirements, releases, signal);
            if (pack) packs.push(pack);
        }
        columns.clear();
        for (const [key, value] of findPreparedColumns(packs, requirements, snapshot.manifest.pairs)) columns.set(key, value);
    }
    await readAvailablePacks();
    let missing = requirements.filter((item) => !columns.has(requirementKey(item.libraryRelease, item.parentId)));
    if (missing.length > 0) {
        const byRelease = new Map<string, string[]>();
        for (const item of missing) {
            const featureIds = byRelease.get(item.libraryRelease) ?? [];
            featureIds.push(item.parentId);
            byRelease.set(item.libraryRelease, featureIds);
        }
        for (const [libraryRelease, featureIds] of [...byRelease.entries()].sort(([left], [right]) => compare(left, right))) {
            throwIfAborted(signal);
            await generatePairFeaturePack(folderPath, libraryRelease, [...new Set(featureIds)].sort(compare), {
                signal,
                onProgress,
            });
        }
        await readAvailablePacks();
        missing = requirements.filter((item) => !columns.has(requirementKey(item.libraryRelease, item.parentId)));
    }
    if (missing.length > 0) throw new Error(missingPackCommand(folderPath, missing));
    return {
        folderPath,
        ledgerSha256: snapshot.manifest.ledgerSha256,
        sourceSnapshotSha256: snapshot.sourceSnapshotSha256,
        ledgerRowCount: snapshot.manifest.ledgerRowCount,
        columns,
        packs,
        active: null,
    };
}

async function readColumn(
    folder: string,
    artifact: { path: string; bytes: number; sha256: string; uncompressedBytes: number; uncompressedSha256: string },
    kind: "values" | "valid" | "observations",
    rowCount: number,
): Promise<number[]> {
    const compressed = await readFile(await safeArtifactPath(folder, artifact.path));
    if (compressed.length !== artifact.bytes || hashBytes(compressed) !== artifact.sha256) throw new Error(`Feature ${kind} column hash mismatch: ${artifact.path}.`);
    const uncompressed = gunzipSync(compressed);
    const uncompressedLength = kind === "values" ? rowCount * 8 : kind === "valid" ? rowCount : rowCount * 4;
    if (artifact.uncompressedBytes !== uncompressedLength
        || uncompressed.length !== artifact.uncompressedBytes
        || hashBytes(uncompressed) !== artifact.uncompressedSha256) throw new Error(`Feature ${kind} column uncompressed bytes mismatch: ${artifact.path}.`);
    const decoded = kind === "values" ? decodeFloat64Le(compressed) : kind === "valid" ? decodeUint8(compressed) : decodeUint32Le(compressed);
    if (decoded.length !== rowCount) {
        throw new Error(`Feature ${kind} column row count mismatch: ${artifact.path}.`);
    }
    return decoded;
}

export async function activatePairFeatures(prepared: PreparedPairFeatures, rule: PairSelectionRule, signal?: AbortSignal): Promise<ActivePairFeatures | null> {
    prepared.active?.release();
    prepared.active = null;
    const requirement = rule.metadata?.featureRequirements;
    if (!requirement || requirement.columns.length === 0) return null;
    const requestedColumns = [...new Set(requirement.columns)].sort(compare);
    const requestedParents = [...new Set(requestedColumns.map(parentFeatureId))];
    const arrays = new Map<string, { values?: Float64Array; valid?: Uint8Array; observations?: Uint32Array }>();
    for (const parentId of requestedParents) {
        throwIfAborted(signal);
        const column = prepared.columns.get(requirementKey(requirement.libraryRelease, parentId));
        if (!column) throw new Error(`Pair feature ${parentId} was not prepared for rule ${rule.key}.`);
        const values = requestedColumns.includes(parentId) ? new Float64Array(prepared.ledgerRowCount) : undefined;
        const valid = requestedColumns.includes(parentId) ? new Uint8Array(prepared.ledgerRowCount) : undefined;
        const observations = requestedColumns.includes(`${parentId}_n`) ? new Uint32Array(prepared.ledgerRowCount) : undefined;
        for (const pair of column.pairs) {
            throwIfAborted(signal);
            const start = pairStart(column, pair.pairKey);
            if (values && valid) {
                values.set(Float64Array.from(await readColumn(prepared.folderPath, pair.values, "values", pair.rowCount)), start);
                valid.set(Uint8Array.from(await readColumn(prepared.folderPath, pair.valid, "valid", pair.rowCount)), start);
            }
        if (observations) observations.set(Uint32Array.from(await readColumn(prepared.folderPath, pair.observations, "observations", pair.rowCount)), start);
        }
        arrays.set(parentId, { values, valid, observations });
    }
    let released = false;
    const active: ActivePairFeatures = {
        ruleKey: rule.key,
        requestedColumns,
        readCandidateFeatures(rowOrdinal) {
            if (released) throw new Error(`Pair feature activation for ${rule.key} has been released.`);
            if (!Number.isSafeInteger(rowOrdinal) || rowOrdinal < 0 || rowOrdinal >= prepared.ledgerRowCount) throw new Error(`Invalid pair feature row ordinal: ${rowOrdinal}.`);
            const result: Record<string, number | null> = {};
            for (const requestedId of requestedColumns) {
                const parentId = parentFeatureId(requestedId);
                const loaded = arrays.get(parentId)!;
                if (requestedId.endsWith("_n")) result[requestedId] = loaded.observations![rowOrdinal]!;
                else result[requestedId] = loaded.valid![rowOrdinal] === 1 ? loaded.values![rowOrdinal]! : null;
            }
            return result;
        },
        release() {
            released = true;
            arrays.clear();
        },
    };
    prepared.active = active;
    return active;
}

function pairStart(column: PreparedColumn, pairKey: string): number {
    const start = column.rowStarts.get(pairKey);
    if (start === undefined) throw new Error(`Prepared feature column is missing pair ${pairKey}.`);
    return start;
}

function receiptSourcePath(sourcePath: string): string {
    const relative = path.relative(process.cwd(), path.resolve(process.cwd(), sourcePath)).replaceAll("\\", "/");
    if (!relative || relative === ".." || relative.startsWith("../") || path.isAbsolute(relative)) throw new Error(`Receipt source path is outside the repository: ${sourcePath}.`);
    return relative;
}

async function receiptRules(rules: readonly PairSelectionRule[]): Promise<ReceiptRule[]> {
    const result: ReceiptRule[] = [];
    for (const rule of rules) {
        const sourceFiles = rule.metadata?.sourceFiles;
        if (!sourceFiles || sourceFiles.length === 0) throw new Error(`Pair-selection rule ${rule.key} must declare metadata.sourceFiles for check receipts.`);
        const files = [];
        for (const sourceFile of [...new Set(sourceFiles)].sort(compare)) {
            const relative = receiptSourcePath(sourceFile);
            files.push({ path: relative, sha256: (await hashFile(path.resolve(process.cwd(), relative))).sha256 });
        }
        const rawParams = { ...rule.defaultParams };
        const parameters = rule.normalizeParams ? rule.normalizeParams(rawParams) : rawParams;
        result.push({ key: rule.key, sourceFiles: files, parameters });
    }
    return result;
}

export async function writePairSelectionCheckReceipt(input: PairSelectionCheckReceiptInput): Promise<PairSelectionCheckReceipt> {
    if (!input.prepared.ledgerSha256 || !input.prepared.sourceSnapshotSha256) throw new Error("Feature check receipts require a prepared source snapshot.");
    const requirements = resolveRequirements(input.rules);
    const releases = [...new Set(requirements.map((item) => item.libraryRelease))].sort(compare);
    const definitions = requirements
        .map((item) => ({ id: item.definition.id, sha256: item.definition.definitionDigest }))
        .sort((left, right) => compare(left.id, right.id));
    const packDigests = input.prepared.packs.map((pack) => ({ path: pack.path, sha256: pack.sha256 })).sort((left, right) => compare(left.path, right.path));
    const libraryReleaseDigests = [...new Map(input.prepared.packs.map((pack) => [
        pack.manifest.libraryRelease,
        { release: pack.manifest.libraryRelease, sha256: pack.manifest.libraryReleaseSha256 },
    ] as const)).values()].sort((left, right) => compare(left.release, right.release));
    const rules = await receiptRules(input.rules);
    const resultBytes = Buffer.from(canonicalJson(input.results.map((result) => {
        const { diagnostics: _diagnostics, ...deterministic } = result;
        return deterministic;
    })), "utf8");
    const withoutDigest = {
        formatVersion: 1 as const,
        ledgerSha256: input.prepared.ledgerSha256,
        sourceSnapshotSha256: input.prepared.sourceSnapshotSha256,
        libraryRelease: releases.length === 1 ? releases[0]! : null,
        libraryReleases: releases,
        libraryReleaseDigests,
        definitionDigests: definitions,
        packDigests,
        rules,
        horizons: [...input.horizons],
        dateBoundaries: { fromSec: input.fromSec ?? null, toSec: input.toSec ?? null },
        resultsSha256: hashBytes(resultBytes),
    };
    const receiptDigest = hashBytes(Buffer.from(canonicalJson(withoutDigest), "utf8"));
    const receipt = { ...withoutDigest, receiptDigest };
    const relativePath = `${FEATURE_PACK_CHECK_DIR}/${receiptDigest}.json`;
    await prepareArtifactDirectory(input.prepared.folderPath, FEATURE_PACK_CHECK_DIR);
    await publishArtifactIfMissing(await safeArtifactPath(input.prepared.folderPath, relativePath), Buffer.from(canonicalJson(receipt), "utf8"));
    return receipt;
}

export function releasePairFeatures(prepared: PreparedPairFeatures): void {
    prepared.active?.release();
    prepared.active = null;
}
