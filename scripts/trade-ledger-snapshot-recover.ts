/**
 * Recovery tool for an interrupted trade-ledger source-snapshot finalize.
 *
 * If the dev server dies while TradeLedgerSnapshotWriter.finalize is
 * streaming its verification, the pair partitions are already on disk but
 * the manifest was never published. This tool reconstructs the manifest
 * from the immutable partitions + the ledger itself (never the other way
 * around), re-running the same verification the writer's finalize performs:
 *   - per-pair contiguous row-ordinal runs covering the ledger exactly once
 *   - every ledger row agrees with its partition entry (identity, direction,
 *     signal time, signal bar index)
 *   - partition integrity (record counts, hashes, strictly increasing bars)
 * and publishes source-snapshot/manifest.json atomically.
 *
 * Usage: esno scripts/trade-ledger-snapshot-recover.ts <runDir>
 * Refuses to run when a manifest already exists (immutability fence).
 */

import { createReadStream, existsSync, readFileSync, readdirSync } from "node:fs";
import { createInterface } from "node:readline";
import { createGunzip } from "node:zlib";
import { createHash } from "node:crypto";
import path from "node:path";
import {
    canonicalJson,
    hashBytes,
    hashFile,
    safeArtifactPath,
    writeArtifactAtomically,
} from "../lib/pair-features/artifact-io";
import { iterateJsonlLines } from "../lib/batch-backtest/trade-ledger-replay-loader";

const MANIFEST_PATH = "source-snapshot/manifest.json";
const PAIRS_DIR = "source-snapshot/pairs";

interface RowRecord {
    ordinal: number;
    pair: string;
    baseSymbol: string;
    quoteSymbol: string;
    direction: string;
    signalTime: number;
    signalBarIndex: number;
}

interface PairGroup {
    pairKey: string;
    identity: { pair: string; baseSymbol: string; quoteSymbol: string };
    rowStart: number;
    rowCount: number;
    rows: Array<{ direction: string; signalTime: number; signalBarIndex: number }>;
}

interface PairGroupArtifacts {
    bars: { count: number; firstTimeSec: number | null; lastTimeSec: number | null };
    trades: { count: number };
    files: {
        bars: ArtifactMeta;
        trades: ArtifactMeta;
        entries: ArtifactMeta;
        entriesWarmup?: ArtifactMeta;
    };
    hasWarmup: boolean;
}

interface ArtifactMeta {
    path: string;
    recordCount: number;
    compressedBytes: number;
    compressedSha256: string;
    uncompressedBytes: number;
    uncompressedSha256: string;
}

function compareRecoveredPairs(
    left: Pick<PairGroup, "rowStart" | "rowCount" | "pairKey">,
    right: Pick<PairGroup, "rowStart" | "rowCount" | "pairKey">,
): number {
    const byRowStart = left.rowStart - right.rowStart;
    if (byRowStart !== 0) return byRowStart;
    if (left.rowCount === 0 && right.rowCount !== 0) return -1;
    if (left.rowCount !== 0 && right.rowCount === 0) return 1;
    return left.pairKey < right.pairKey ? -1 : left.pairKey > right.pairKey ? 1 : 0;
}

function fail(message: string): never {
    console.error(`snapshot-recover: ${message}`);
    process.exit(1);
}

function pairKeyOf(row: Pick<RowRecord, "pair" | "baseSymbol" | "quoteSymbol">): string {
    return hashBytes(
        Buffer.from(canonicalJson([row.pair, row.baseSymbol, row.quoteSymbol]), "utf8"),
    );
}

async function gzStatsAndRecords<T>(
    filePath: string,
    parse: (value: unknown, index: number) => T,
): Promise<{ records: T[]; compressedBytes: number; compressedSha256: string; uncompressedBytes: number; uncompressedSha256: string }> {
    const compressedSha = createHash("sha256");
    const decompressedSha = createHash("sha256");
    const read = createReadStream(filePath);
    let compressedBytes = 0;
    let uncompressedBytes = 0;
    read.on("data", (chunk: Buffer) => {
        compressedSha.update(chunk);
        compressedBytes += chunk.length;
    });
    const gunzip = createGunzip();
    gunzip.on("data", (chunk: Buffer) => {
        decompressedSha.update(chunk);
        uncompressedBytes += chunk.length;
    });
    read.on("error", (error) => gunzip.destroy(error));
    gunzip.on("error", (error) => read.destroy(error));
    read.pipe(gunzip);
    const reader = createInterface({ input: gunzip, crlfDelay: Infinity });
    const records: T[] = [];
    try {
        for await (const rawLine of reader) {
            const line = rawLine.trim();
            if (line) records.push(parse(JSON.parse(line), records.length));
        }
    } finally {
        reader.close();
        read.destroy();
        gunzip.close();
    }
    return {
        records,
        compressedBytes,
        compressedSha256: compressedSha.digest("hex"),
        uncompressedBytes,
        uncompressedSha256: decompressedSha.digest("hex"),
    };
}

async function verifyPairPartition(
    runDir: string,
    group: PairGroup,
): Promise<PairGroupArtifacts> {
    const pairDir = path.join(runDir, PAIRS_DIR, group.pairKey);
    const barsFile = path.join(pairDir, "bars.jsonl.gz");
    const tradesFile = path.join(pairDir, "trades.jsonl.gz");
    const entriesFile = path.join(pairDir, "entries.jsonl.gz");
    for (const file of [barsFile, tradesFile, entriesFile]) {
        if (!existsSync(file)) fail(`missing partition file ${file}`);
    }

    const bars = await gzStatsAndRecords<readonly [number, number, number, number, number, number]>(
        barsFile,
        (value, index) => {
            if (!Array.isArray(value) || value.length !== 6) fail(`bars ${group.pairKey}:${index} is not a 6-tuple.`);
            const timeSec = value[0] as number;
            if (!Number.isFinite(timeSec)) fail(`bars ${group.pairKey}:${index} has a non-finite time.`);
            for (const v of value.slice(1)) {
                if (!Number.isFinite(v as number)) fail(`bars ${group.pairKey}:${index} has a non-finite value.`);
            }
            return [timeSec, value[1] as number, value[2] as number, value[3] as number, value[4] as number, value[5] as number];
        },
    );
    let previousBarTime = -Infinity;
    for (const bar of bars.records) {
        if (bar[0] <= previousBarTime) fail(`bars for ${group.identity.pair} are not strictly increasing.`);
        previousBarTime = bar[0];
    }

    const trades = await gzStatsAndRecords<Record<string, unknown>>(
        tradesFile,
        (value, index) => {
            if (!value || typeof value !== "object" || Array.isArray(value)) {
                fail(`trades ${group.identity.pair}:${index} is not an object.`);
            }
            return value as Record<string, unknown>;
        },
    );

    const entries = await gzStatsAndRecords<readonly [number, number, "long" | "short", number]>(
        entriesFile,
        (value, index) => {
            if (!Array.isArray(value) || value.length !== 4) {
                fail(`entries ${group.pairKey}:${index} is not a 4-tuple.`);
            }
            if (typeof value[2] !== "string" || (value[2] !== "long" && value[2] !== "short")) {
                fail(`entries ${group.pairKey}:${index} has an invalid direction.`);
            }
            if (!Number.isSafeInteger(value[0]) || !Number.isSafeInteger(value[1]) || !Number.isFinite(value[3] as number)) {
                fail(`entries ${group.pairKey}:${index} has invalid numeric fields.`);
            }
            return value as unknown as readonly [number, number, "long" | "short", number];
        },
    );
    if (entries.records.length !== group.rowCount) {
        fail(`entries count ${entries.records.length} != ledger rows ${group.rowCount} for ${group.identity.pair}.`);
    }
    for (const [offset, entry] of entries.records.entries()) {
        const expectedOrdinal = group.rowStart + offset;
        const ledgerRow = group.rows[offset]!;
        if (entry[0] !== expectedOrdinal) fail(`entries ordinal ${entry[0]} != ${expectedOrdinal} for ${group.identity.pair}.`);
        if (entry[1] !== ledgerRow.signalBarIndex || entry[2] !== ledgerRow.direction || entry[3] !== ledgerRow.signalTime) {
            fail(`entries row ${expectedOrdinal} does not agree with the ledger for ${group.identity.pair}.`);
        }
        const bar = bars.records[ledgerRow.signalBarIndex];
        if (!bar || bar[0] !== ledgerRow.signalTime) {
            fail(`entry signal bar does not match its signal time for ${group.identity.pair} at ordinal ${expectedOrdinal}.`);
        }
    }

    const warmupFile = path.join(pairDir, "entries-warmup.jsonl.gz");
    const warmup = existsSync(warmupFile)
        ? await gzStatsAndRecords<readonly [number, "long" | "short", number]>(warmupFile, (value, index) => {
            if (!Array.isArray(value) || value.length !== 3 || !Number.isSafeInteger(value[0]) || (value[1] !== "long" && value[1] !== "short") || !Number.isFinite(value[2] as number)) {
                fail(`warmup entries ${group.pairKey}:${index} is malformed.`);
            }
            const bar = bars.records[value[0] as number];
            if (!bar || bar[0] !== value[2]) fail(`warmup entry ${group.pairKey}:${index} does not match its signal bar.`);
            return value as unknown as readonly [number, "long" | "short", number];
        })
        : null;
    let previousWarmupBar = -1;
    for (const entry of warmup?.records ?? []) {
        if (entry[0] < previousWarmupBar || (entries.records[0] && entry[0] >= entries.records[0][1])) fail(`warmup entries are not strictly before in-window entries for ${group.identity.pair}.`);
        previousWarmupBar = entry[0];
    }
    const artifact = (relativePath: string, stats: { records: unknown[]; compressedBytes: number; compressedSha256: string; uncompressedBytes: number; uncompressedSha256: string }): ArtifactMeta => ({
        path: relativePath,
        recordCount: stats.records.length,
        compressedBytes: stats.compressedBytes,
        compressedSha256: stats.compressedSha256,
        uncompressedBytes: stats.uncompressedBytes,
        uncompressedSha256: stats.uncompressedSha256,
    });
    const files: PairGroupArtifacts["files"] = {
        bars: artifact(
            `${PAIRS_DIR}/${group.pairKey}/bars.jsonl.gz`,
            bars as { records: unknown[]; compressedBytes: number; compressedSha256: string; uncompressedBytes: number; uncompressedSha256: string },
        ),
        trades: artifact(
            `${PAIRS_DIR}/${group.pairKey}/trades.jsonl.gz`,
            trades as { records: unknown[]; compressedBytes: number; compressedSha256: string; uncompressedBytes: number; uncompressedSha256: string },
        ),
        entries: artifact(
            `${PAIRS_DIR}/${group.pairKey}/entries.jsonl.gz`,
            entries as { records: unknown[]; compressedBytes: number; compressedSha256: string; uncompressedBytes: number; uncompressedSha256: string },
        ),
    };
    if (warmup) files.entriesWarmup = artifact(`${PAIRS_DIR}/${group.pairKey}/entries-warmup.jsonl.gz`, warmup as { records: unknown[]; compressedBytes: number; compressedSha256: string; uncompressedBytes: number; uncompressedSha256: string });
    return {
        bars: {
            count: bars.records.length,
            firstTimeSec: bars.records[0]?.[0] ?? null,
            lastTimeSec: bars.records[bars.records.length - 1]?.[0] ?? null,
        },
        trades: { count: trades.records.length },
        files,
        hasWarmup: warmup !== null,
    };
}

async function main(): Promise<void> {
    const runDir = path.resolve(process.argv[2] ?? "");
    if (!runDir || !existsSync(path.join(runDir, "provenance.json"))) {
        fail(`not a trade-ledger run folder: ${runDir}`);
    }
    const manifestTarget = path.join(runDir, MANIFEST_PATH);
    // A prior recovery may have published a manifest even though the original
    // run left source-snapshot/error.json. Allow that known-invalid state to be
    // replaced after the recovery ordering rules are corrected; preserve the
    // immutability fence for ordinary completed snapshots.
    if (existsSync(manifestTarget) && !existsSync(path.join(runDir, "source-snapshot/error.json"))) {
        fail("manifest.json already exists — nothing to recover.");
    }

    const summary = JSON.parse(readFileSync(path.join(runDir, "summary.json"), "utf8")) as { ledgerComplete?: boolean; cancelled?: boolean };
    if (summary.cancelled) fail("run was cancelled — re-run the batch instead of recovering.");
    if (summary.ledgerComplete !== true) fail("ledger is incomplete — re-run the batch instead of recovering.");

    const ledgerPath = path.join(runDir, "ledger.jsonl");

    // Single streaming pass: group rows into contiguous per-pair runs in file
    // order (= capture order), verifying each completed group's partition
    // before moving on. Memory stays bounded to one group's rows.
    const groups: PairGroup[] = [];
    const groupByKey = new Map<string, PairGroup>();
    let current: PairGroup | null = null;
    let ordinal = 0;

    for await (const line of iterateJsonlLines(ledgerPath)) {
        const value = JSON.parse(line) as Record<string, unknown>;
        const direction = value.direction === "long" || value.direction === "short" ? value.direction : null;
        const row: RowRecord = {
            ordinal,
            pair: typeof value.pair === "string" ? value.pair : "",
            baseSymbol: typeof value.baseSymbol === "string" ? value.baseSymbol : "",
            quoteSymbol: typeof value.quoteSymbol === "string" ? value.quoteSymbol : "",
            direction: direction ?? "long",
            signalTime: typeof value.signalTime === "number" ? value.signalTime : Number.NaN,
            signalBarIndex: typeof value.signalBarIndex === "number" ? value.signalBarIndex : Number.NaN,
        };
        if (!row.pair || !row.baseSymbol || !row.quoteSymbol || !direction || !Number.isFinite(row.signalTime) || !Number.isSafeInteger(row.signalBarIndex)) {
            fail(`ledger row ${ordinal} is missing identity fields.`);
        }

        const key = pairKeyOf(row);
        if (!current || current.pairKey !== key) {
            if (groupByKey.has(key)) fail(`pair ${row.pair} reappears in a non-contiguous run at row ${ordinal}.`);
            current = {
                pairKey: key,
                identity: { pair: row.pair, baseSymbol: row.baseSymbol, quoteSymbol: row.quoteSymbol },
                rowStart: ordinal,
                rowCount: 0,
                rows: [],
            };
            groupByKey.set(key, current);
            groups.push(current);
        } else if (
            current.identity.pair !== row.pair
            || current.identity.baseSymbol !== row.baseSymbol
            || current.identity.quoteSymbol !== row.quoteSymbol
        ) {
            fail(`ledger row ${ordinal} reuses pair key ${key} with a different identity.`);
        }
        current.rowCount += 1;
        current.rows.push({ direction: row.direction, signalTime: row.signalTime, signalBarIndex: row.signalBarIndex });
        ordinal += 1;
    }

    const ledgerRowCount = ordinal;
    const totalRows = groups.reduce((sum, group) => sum + group.rowCount, 0);
    if (totalRows !== ledgerRowCount) fail(`group rows ${totalRows} != ledger rows ${ledgerRowCount}.`);

    const pairsDir = path.join(runDir, PAIRS_DIR);
    if (!existsSync(pairsDir)) fail(`missing partition directory ${pairsDir}.`);
    const partitionKeys = new Set<string>();
    for (const entry of readdirSync(pairsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const pairDir = path.join(pairsDir, entry.name);
        for (const file of ["bars.jsonl.gz", "trades.jsonl.gz", "entries.jsonl.gz"]) {
            if (!existsSync(path.join(pairDir, file))) fail(`partition directory ${entry.name} is missing ${file}.`);
        }
        partitionKeys.add(entry.name);
    }
    const provenance = JSON.parse(readFileSync(path.join(runDir, "provenance.json"), "utf8")) as { symbols?: unknown };
    if (!Array.isArray(provenance.symbols)) fail("provenance symbols are missing.");
    const orderedGroups: PairGroup[] = [];
    const seenPartitions = new Set<string>();
    for (const symbol of provenance.symbols) {
        if (typeof symbol !== "string") fail(`provenance symbol is not a string: ${String(symbol)}.`);
        const separator = symbol.indexOf("+");
        if (separator <= 0 || separator === symbol.length - 1) fail(`cannot derive pair identity from provenance symbol ${symbol}.`);
        const identity = { pair: symbol, baseSymbol: symbol.slice(0, separator), quoteSymbol: symbol.slice(separator + 1) };
        const key = hashBytes(Buffer.from(canonicalJson([identity.pair, identity.baseSymbol, identity.quoteSymbol]), "utf8"));
        if (!partitionKeys.has(key)) continue;
        if (seenPartitions.has(key)) fail(`partition ${key} is listed more than once in provenance.`);
        seenPartitions.add(key);
        const group = groupByKey.get(key) ?? { pairKey: key, identity, rowStart: 0, rowCount: 0, rows: [] };
        if (group.identity.pair !== identity.pair || group.identity.baseSymbol !== identity.baseSymbol || group.identity.quoteSymbol !== identity.quoteSymbol) fail(`partition ${key} identity disagrees with provenance.`);
        orderedGroups.push(group);
    }
    for (const key of partitionKeys) if (!seenPartitions.has(key)) fail(`partition ${key} cannot be matched to a provenance or ledger identity.`);
    for (const group of groups) if (!seenPartitions.has(group.pairKey)) fail(`ledger pair ${group.pairKey} has no discovered partition.`);

    let nextRowStart = 0;
    const artifacts: PairGroupArtifacts[] = [];
    for (const group of orderedGroups) {
        if (group.rowCount > 0 && group.rowStart !== nextRowStart) fail(`ledger row partition order disagrees with provenance at ${group.pairKey}.`);
        group.rowStart = nextRowStart;
        await finalizeGroup(runDir, group, artifacts);
        nextRowStart += group.rowCount;
    }
    if (nextRowStart !== ledgerRowCount) fail(`recovered partition rows ${nextRowStart} != ledger rows ${ledgerRowCount}.`);
    console.log(`ledger: ${ledgerRowCount} rows across ${groups.length} pairs — partition verification passed`);

    const ledgerHash = await hashFile(ledgerPath);
    const provenanceHash = await hashFile(path.join(runDir, "provenance.json"));
    const summaryHash = await hashFile(path.join(runDir, "summary.json"));
    const ranksPath = path.join(runDir, "signal-ranks.jsonl");
    const ranks = existsSync(ranksPath) ? await hashFile(ranksPath) : null;

    const hasWarmup = artifacts.some((item) => item.hasWarmup);
    const pairManifests = orderedGroups
        .map((group, index) => ({
            ...group.identity,
            pairKey: group.pairKey,
            barCount: artifacts[index]!.bars.count,
            firstTimeSec: artifacts[index]!.bars.firstTimeSec,
            lastTimeSec: artifacts[index]!.bars.lastTimeSec,
            tradeCount: artifacts[index]!.trades.count,
            rowStart: group.rowStart,
            rowCount: group.rowCount,
            files: artifacts[index]!.files,
        }))
        .sort(compareRecoveredPairs);

    const manifest = {
        formatVersion: 1,
        writerRevision: 1,
        complete: true,
        ledgerSha256: ledgerHash.sha256,
        ledgerBytes: ledgerHash.bytes,
        ledgerRowCount,
        provenanceSha256: provenanceHash.sha256,
        summarySha256: summaryHash.sha256,
        ranksSha256: ranks ? ranks.sha256 : null,
        runtime: {
            node: process.version,
            v8: process.versions.v8,
            zlib: process.versions.zlib ?? "unknown",
            platform: process.platform,
            arch: process.arch,
        },
        capabilities: hasWarmup
            ? ["pair_bars_v1", "closed_trade_records_v1", "entry_candidates_v1", "entry_candidates_warmup_v1"]
            : ["pair_bars_v1", "closed_trade_records_v1", "entry_candidates_v1"],
        pairs: pairManifests,
    };

    const manifestPath = await safeArtifactPath(runDir, MANIFEST_PATH);
    await writeArtifactAtomically(manifestPath, Buffer.from(canonicalJson(manifest), "utf8"));
    console.log(`published ${MANIFEST_PATH}: pairs=${pairManifests.length} rows=${ledgerRowCount} — recovery complete`);
}

async function finalizeGroup(runDir: string, group: PairGroup, artifacts: PairGroupArtifacts[]): Promise<void> {
    const verified = await verifyPairPartition(runDir, group);
    artifacts.push(verified);
}

void main();
