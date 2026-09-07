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

import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
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

interface PartitionFileMeta {
    path: string;
    recordCount: number;
    compressedBytes: number;
    compressedSha256: string;
    uncompressedSha256: string;
}

interface PairGroupArtifacts {
    bars: { count: number; firstTimeSec: number | null; lastTimeSec: number | null };
    trades: { count: number };
    files: {
        bars: PartitionFileMeta;
        trades: PartitionFileMeta;
        entries: PartitionFileMeta;
    };
}

interface ArtifactMeta {
    path: string;
    recordCount: number;
    compressedBytes: number;
    compressedSha256: string;
    uncompressedSha256: string;
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

async function hashStream(stream: import("node:stream").Readable): Promise<string> {
    const hash = createHash("sha256");
    for await (const chunk of stream) hash.update(chunk as Buffer);
    return hash.digest("hex");
}

void hashStream;

async function gzStatsAndRecords<T>(
    filePath: string,
    parse: (value: unknown, index: number) => T,
): Promise<{ records: T[]; compressedBytes: number; compressedSha256: string; uncompressedSha256: string }> {
    const compressedSha = createHash("sha256");
    const decompressedSha = createHash("sha256");
    const read = createReadStream(filePath);
    let compressedBytes = 0;
    read.on("data", (chunk: Buffer) => {
        compressedSha.update(chunk);
        compressedBytes += chunk.length;
    });
    const gunzip = createGunzip();
    gunzip.on("data", (chunk: Buffer) => decompressedSha.update(chunk));
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
        uncompressedSha256: decompressedSha.digest("hex"),
    };
}

interface PairGroupArtifacts {
    bars: { count: number; firstTimeSec: number | null; lastTimeSec: number | null };
    trades: { count: number };
    files: {
        bars: ArtifactMeta;
        trades: ArtifactMeta;
        entries: ArtifactMeta;
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

    const entries = await gzStatsAndRecords<readonly [number, number, string, number]>(
        entriesFile,
        (value, index) => {
            if (!Array.isArray(value) || value.length !== 4) {
                fail(`entries ${group.pairKey}:${index} is not a 4-tuple.`);
            }
            if (typeof value[2] !== "string" || (value[2] !== "long" && value[2] !== "short")) {
                fail(`entries ${group.pairKey}:${index} has an invalid direction.`);
            }
            return value as unknown as readonly [number, number, string, number];
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

    const files = {
        bars: {
            path: `${PAIRS_DIR}/${group.pairKey}/bars.jsonl.gz`,
            recordCount: bars.records.length,
            compressedBytes: statSync(barsFile).size,
            compressedSha256: bars.compressedSha256,
            uncompressedSha256: bars.uncompressedSha256,
        },
        trades: {
            path: `${PAIRS_DIR}/${group.pairKey}/trades.jsonl.gz`,
            recordCount: trades.records.length,
            compressedBytes: statSync(tradesFile).size,
            compressedSha256: trades.compressedSha256,
            uncompressedSha256: trades.uncompressedSha256,
        },
        entries: {
            path: `${PAIRS_DIR}/${group.pairKey}/entries.jsonl.gz`,
            recordCount: entries.records.length,
            compressedBytes: statSync(entriesFile).size,
            compressedSha256: entries.compressedSha256,
            uncompressedSha256: entries.uncompressedSha256,
        },
    };
    return {
        bars: {
            count: bars.records.length,
            firstTimeSec: bars.records[0]?.[0] ?? null,
            lastTimeSec: bars.records[bars.records.length - 1]?.[0] ?? null,
        },
        trades: { count: trades.records.length },
        files,
    };
}

async function main(): Promise<void> {
    const runDir = path.resolve(process.argv[2] ?? "");
    if (!runDir || !existsSync(path.join(runDir, "provenance.json"))) {
        fail(`not a trade-ledger run folder: ${runDir}`);
    }
    const manifestTarget = path.join(runDir, MANIFEST_PATH);
    if (existsSync(manifestTarget)) fail("manifest.json already exists — nothing to recover.");

    const summary = JSON.parse(await readFileText(path.join(runDir, "summary.json"))) as {
        ledgerComplete?: boolean;
        cancelled?: boolean;
        totals?: { signals?: number };
    };
    if (summary.cancelled) fail("run was cancelled — re-run the batch instead of recovering.");
    if (summary.ledgerComplete !== true) fail("ledger is incomplete — re-run the batch instead of recovering.");

    const ledgerPath = path.join(runDir, "ledger.jsonl");

    // Single streaming pass: group rows into contiguous per-pair runs in file
    // order (= capture order), verifying each completed group's partition
    // before moving on. Memory stays bounded to one group's rows.
    const groups: PairGroup[] = [];
    const artifacts: PairGroupArtifacts[] = [];
    const groupByKey = new Map<string, PairGroup>();
    let current: PairGroup | null = null;
    let ordinal = 0;
    let expectedNextOrdinal = 0;

    for await (const line of iterateJsonlLines(ledgerPath)) {
        const value = JSON.parse(line) as Record<string, unknown>;
        const row: RowRecord = {
            ordinal,
            pair: typeof value.pair === "string" ? value.pair : "",
            baseSymbol: typeof value.baseSymbol === "string" ? value.baseSymbol : "",
            quoteSymbol: typeof value.quoteSymbol === "string" ? value.quoteSymbol : "",
            direction: typeof value.direction === "string" ? value.direction : "",
            signalTime: typeof value.signalTime === "number" ? value.signalTime : Number.NaN,
            signalBarIndex: typeof value.signalBarIndex === "number" ? value.signalBarIndex : Number.NaN,
        };
        if (!row.pair || !row.baseSymbol || !row.quoteSymbol || (row.direction !== "long" && row.direction !== "short") || !Number.isFinite(row.signalTime) || !Number.isInteger(row.signalBarIndex)) {
            fail(`ledger row ${ordinal} is missing identity fields.`);
        }
        if (row.ordinal !== expectedNextOrdinal) {
            fail(`ledger row ordinals are not sequential at ${row.ordinal}.`);
        }

        const key = pairKeyOf(row);
        if (!current || current.pairKey !== key) {
            if (current) await finalizeGroup(runDir, current, artifacts);
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
        expectedNextOrdinal += 1;
    }
    if (current) await finalizeGroup(runDir, current, artifacts);

    const ledgerRowCount = ordinal;
    if (groups.length === 0) fail("ledger has no rows.");
    const totalRows = groups.reduce((sum, group) => sum + group.rowCount, 0);
    if (totalRows !== ledgerRowCount) fail(`group rows ${totalRows} != ledger rows ${ledgerRowCount}.`);
    console.log(`ledger: ${ledgerRowCount} rows across ${groups.length} pairs — partition verification passed`);

    const ledgerHash = await hashFile(ledgerPath);
    const provenanceHash = await hashFile(path.join(runDir, "provenance.json"));
    const summaryHash = await hashFile(path.join(runDir, "summary.json"));
    const ranksPath = path.join(runDir, "signal-ranks.jsonl");
    const ranks = existsSync(ranksPath) ? await hashFile(ranksPath) : null;

    const pairManifests = groups
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
        .sort((a, b) => a.rowStart - b.rowStart || compareCodeUnits(a.pairKey, b.pairKey));

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
        capabilities: ["pair_bars_v1", "closed_trade_records_v1", "entry_candidates_v1"],
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

function compareCodeUnits(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

async function readFileText(filePath: string): Promise<string> {
    return readFileSync(filePath, "utf8");
}

void main();
