import { readFile, readdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { decodeFloat64Le, decodeUint8, decodeUint32Le, hashBytes, safeArtifactPath, canonicalJson } from "../pair-features/artifact-io";
import { validatePairFeatureSnapshot } from "../pair-features/generate";
import { formatNumber, formatPercent, percentile } from "../selection-metrics";
import type { PairFeatureColumnArtifact, PairFeaturePackManifest } from "../pair-features/types";
import type { PairCandidate } from "./types";
import type { PairSelectionArchive, PairSelectionEvent } from "./tally";

export const PAIR_SELECTION_NUMERIC_FIELDS = [
    "feat_entryRangePosition",
    "feat_atrPct",
    "feat_return20",
    "feat_gapPct",
    "feat_dow",
    "feat_hour",
    "feat_pairWinRatePrior",
    "feat_pairTradesPrior",
    "feat_barsSincePairLastFire",
    "feat_pairSpreadVolatility20",
    "feat_legVolatilityRatio20",
    "feat_candidatesAtTime",
] as const satisfies readonly (keyof PairCandidate)[];

type PairNumericField = typeof PAIR_SELECTION_NUMERIC_FIELDS[number];

export interface PairNumericScale {
    values: Record<`p${1 | 10 | 25 | 50 | 75 | 90 | 99}`, number | null>;
    nullShare: number;
}

export interface PairSelectionScaleBlock {
    eventCount: number;
    candidateEvents: number;
    candidates: number;
    numeric: Record<PairNumericField, PairNumericScale>;
    packDerived: Record<string, PairNumericScale>;
}

const PERCENTILES = [0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99] as const;

function numericScale(events: readonly PairSelectionEvent[], field: PairNumericField): PairNumericScale {
    const values: number[] = [];
    let nullCount = 0;
    for (const event of events) {
        for (const candidate of event.candidates) {
            const value = candidate[field];
            if (value === null) nullCount += 1;
            else values.push(value as number);
        }
    }
    values.sort((left, right) => left - right);
    const total = nullCount + values.length;
    const percentileValues = Object.fromEntries(
        PERCENTILES.map((fraction) => [
            `p${fraction * 100}`,
            values.length > 0 ? percentile(values, fraction) : null,
        ]),
    ) as PairNumericScale["values"];
    return { values: percentileValues, nullShare: total > 0 ? nullCount / total : 0 };
}

export function computePairSelectionScales(
    archive: PairSelectionArchive,
    packDerived: Record<string, PairNumericScale> = {},
): PairSelectionScaleBlock {
    const candidateEvents = archive.events
        .filter((event) => event.candidates.length >= 2)
        .slice()
        .sort((left, right) => left.context.signalTime - right.context.signalTime);
    const candidates = candidateEvents.reduce((sum, event) => sum + event.candidates.length, 0);
    return {
        eventCount: archive.events.length,
        candidateEvents: candidateEvents.length,
        candidates,
        numeric: Object.fromEntries(
            PAIR_SELECTION_NUMERIC_FIELDS.map((field) => [field, numericScale(candidateEvents, field)]),
        ) as Record<PairNumericField, PairNumericScale>,
        packDerived,
    };
}

async function readPackedColumn(
    folderPath: string,
    artifact: PairFeatureColumnArtifact,
    kind: "values" | "valid" | "observations",
    rowCount: number,
): Promise<number[]> {
    const bytes = await readFile(await safeArtifactPath(folderPath, artifact.path));
    if (bytes.length !== artifact.bytes || hashBytes(bytes) !== artifact.sha256) throw new Error(`Pack scale ${kind} hash mismatch: ${artifact.path}.`);
    const uncompressed = gunzipSync(bytes);
    const expectedBytes = kind === "values" ? rowCount * 8 : kind === "valid" ? rowCount : rowCount * 4;
    if (uncompressed.length !== expectedBytes
        || uncompressed.length !== artifact.uncompressedBytes
        || hashBytes(uncompressed) !== artifact.uncompressedSha256) {
        throw new Error(`Pack scale ${kind} uncompressed hash or length mismatch: ${artifact.path}.`);
    }
    const decoded = kind === "values" ? decodeFloat64Le(bytes) : kind === "valid" ? decodeUint8(bytes) : decodeUint32Le(bytes);
    if (decoded.length !== rowCount) throw new Error(`Pack scale ${kind} row count mismatch: ${artifact.path}.`);
    return decoded;
}

function buildNumericScale(values: readonly number[], nullCount: number): PairNumericScale {
    const ordered = [...values].sort((left, right) => left - right);
    const percentileValues = Object.fromEntries(
        PERCENTILES.map((fraction) => [`p${fraction * 100}`, ordered.length > 0 ? percentile(ordered, fraction) : null]),
    ) as PairNumericScale["values"];
    const total = ordered.length + nullCount;
    return { values: percentileValues, nullShare: total > 0 ? nullCount / total : 0 };
}

/** Read materialized pack columns through their validated entry-row bindings for offline scale reporting. */
export async function computePairFeaturePackScales(folderPath: string): Promise<Record<string, PairNumericScale>> {
    const snapshot = await validatePairFeatureSnapshot(folderPath);
    let names: string[];
    try {
        names = await readdir(await safeArtifactPath(folderPath, "feature-packs/manifests"));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
    }
    const selected = new Map<string, { values: number[]; observations: number[]; nullCount: number }>();
    const valueFeaturesSeen = new Set<string>();
    const observationFeaturesSeen = new Set<string>();
    const pairByKey = new Map(snapshot.manifest.pairs.map((pair) => [pair.pairKey, pair] as const));
    for (const name of names.filter((item) => item.endsWith(".json")).sort()) {
        const relativePath = `feature-packs/manifests/${name}`;
        const bytes = await readFile(await safeArtifactPath(folderPath, relativePath));
        const digest = path.basename(name, ".json");
        if (hashBytes(Buffer.from(canonicalJson(JSON.parse(bytes.toString("utf8"))), "utf8")) !== digest) throw new Error(`Pack scale manifest digest mismatch: ${relativePath}.`);
        const pack = JSON.parse(bytes.toString("utf8")) as PairFeaturePackManifest;
        if (pack.ledgerSha256 !== snapshot.manifest.ledgerSha256 || pack.ledgerRowCount !== snapshot.manifest.ledgerRowCount || pack.sourceSnapshotSha256 !== snapshot.sourceSnapshotSha256) throw new Error(`Pack scale binding mismatch: ${relativePath}.`);
        const requested = new Set(pack.requestedFeatureIds);
        for (const familyReference of pack.familyManifests) {
            const familyBytes = await readFile(await safeArtifactPath(folderPath, familyReference.path));
            if (hashBytes(Buffer.from(canonicalJson(JSON.parse(familyBytes.toString("utf8"))), "utf8")) !== familyReference.sha256) throw new Error(`Pack scale family manifest digest mismatch: ${familyReference.path}.`);
            const family = JSON.parse(familyBytes.toString("utf8")) as { ledgerSha256: string; ledgerRowCount: number; sourceSnapshotSha256: string; features: Array<{ id: string; pairs: Array<{ pairKey: string; values: PairFeatureColumnArtifact; valid: PairFeatureColumnArtifact; observations: PairFeatureColumnArtifact; rowCount: number }> }> };
            if (family.ledgerSha256 !== snapshot.manifest.ledgerSha256 || family.ledgerRowCount !== snapshot.manifest.ledgerRowCount || family.sourceSnapshotSha256 !== snapshot.sourceSnapshotSha256) throw new Error(`Pack scale family binding mismatch: ${familyReference.path}.`);
            for (const feature of family.features) {
                const wantsValue = requested.has(feature.id) && !valueFeaturesSeen.has(feature.id);
                const wantsObservations = requested.has(`${feature.id}_n`) && !observationFeaturesSeen.has(feature.id);
                if (!wantsValue && !wantsObservations) continue;
                const result = selected.get(feature.id) ?? { values: [], observations: [], nullCount: 0 };
                for (const pair of feature.pairs) {
                    const sourcePair = pairByKey.get(pair.pairKey);
                    if (!sourcePair || sourcePair.rowCount !== pair.rowCount) throw new Error(`Pack scale pair binding mismatch: ${feature.id}/${pair.pairKey}.`);
                    const valid = wantsValue ? await readPackedColumn(folderPath, pair.valid, "valid", pair.rowCount) : [];
                    const values = wantsValue ? await readPackedColumn(folderPath, pair.values, "values", pair.rowCount) : [];
                    const observations = wantsObservations ? await readPackedColumn(folderPath, pair.observations, "observations", pair.rowCount) : [];
                    for (let index = 0; index < pair.rowCount; index += 1) {
                        if (wantsValue) {
                            if (valid[index] === 1) result.values.push(values[index]!);
                            else result.nullCount += 1;
                        }
                        if (wantsObservations) result.observations.push(observations[index]!);
                    }
                }
                selected.set(feature.id, result);
                if (wantsValue) valueFeaturesSeen.add(feature.id);
                if (wantsObservations) observationFeaturesSeen.add(feature.id);
            }
        }
    }
    const result: Record<string, PairNumericScale> = {};
    for (const [featureId, values] of selected) {
        if (values.values.length > 0 || values.nullCount > 0) result[featureId] = buildNumericScale(values.values, values.nullCount);
        if (values.observations.length > 0) result[`${featureId}_n`] = buildNumericScale(values.observations, 0);
    }
    return result;
}

export function formatPairSelectionScales(block: PairSelectionScaleBlock): string[] {
    const lines = [
        `events=${block.eventCount} candidateEvents=${block.candidateEvents} candidates=${block.candidates}`,
    ];
    for (const field of PAIR_SELECTION_NUMERIC_FIELDS) {
        const scale = block.numeric[field];
        lines.push(`${field} p1=${formatNumber(scale.values.p1)} p10=${formatNumber(scale.values.p10)} p25=${formatNumber(scale.values.p25)} p50=${formatNumber(scale.values.p50)} p75=${formatNumber(scale.values.p75)} p90=${formatNumber(scale.values.p90)} p99=${formatNumber(scale.values.p99)} null=${formatPercent(scale.nullShare)}`);
    }
    for (const field of Object.keys(block.packDerived).sort()) {
        const scale = block.packDerived[field]!;
        lines.push(`pack-derived ${field} p1=${formatNumber(scale.values.p1)} p10=${formatNumber(scale.values.p10)} p25=${formatNumber(scale.values.p25)} p50=${formatNumber(scale.values.p50)} p75=${formatNumber(scale.values.p75)} p90=${formatNumber(scale.values.p90)} p99=${formatNumber(scale.values.p99)} null=${formatPercent(scale.nullShare)}`);
    }
    return lines;
}
