/**
 * Node-only writer for the immutable source inputs captured beside a trade
 * ledger. The writer receives already-consumed exporter inputs and never loads
 * market data or reconstructs engine trades.
 */

import { createReadStream } from "node:fs";
import { mkdir } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { createInterface } from "node:readline";
import { join } from "node:path";
import { createGunzip } from "node:zlib";
import { parseTimeToUnixSeconds } from "../time-normalization";
import { iterateJsonlLines } from "./trade-ledger-replay-loader";
import {
    canonicalJson,
    encodeCanonicalJsonlAsync,
    type EncodedCanonicalJsonl,
    hashFile,
    hashBytes,
    safeArtifactPath,
    writeArtifactAtomically,
} from "../pair-features/artifact-io";
import {
    PAIR_FEATURE_SNAPSHOT_CAPABILITIES,
    type PairFeatureSnapshotArtifact,
    type PairFeatureSnapshotBar,
    type PairFeatureSnapshotEntry,
    type PairFeatureSnapshotFinalizeInput,
    type PairFeatureSnapshotFinalizeResult,
    type PairFeatureSnapshotIdentity,
    type PairFeatureSnapshotManifest,
    type PairFeatureSnapshotPairManifest,
    type PairFeatureSnapshotRuntimeFingerprint,
    type PairFeatureSnapshotSource,
    type PairFeatureSnapshotTrade,
    type PairFeatureSnapshotWarmupEntry,
} from "../pair-features/types";

const SOURCE_SNAPSHOT_DIR = "source-snapshot";
const PAIRS_DIR = `${SOURCE_SNAPSHOT_DIR}/pairs`;
const MANIFEST_PATH = `${SOURCE_SNAPSHOT_DIR}/manifest.json`;
const ERROR_PATH = `${SOURCE_SNAPSHOT_DIR}/error.json`;
// Source snapshots are read back through gzip and do not require the tighter
// ratio used by feature artifacts. Level 1 substantially lowers CPU time for
// the multi-million-bar SAVE TRADE LEDGER workload while retaining compression.
const SOURCE_SNAPSHOT_GZIP_LEVEL = 1;

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function requireFinite(value: unknown, label: string): number {
    if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new Error(`Source snapshot ${label} must be finite.`);
    }
    return Object.is(value, -0) ? 0 : value;
}

function requireInteger(value: unknown, label: string): number {
    const number = requireFinite(value, label);
    if (!Number.isInteger(number)) throw new Error(`Source snapshot ${label} must be an integer.`);
    return number;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string") throw new Error(`Source snapshot ${label} must be a string.`);
    return value;
}

function compareCodeUnits(a: string, b: string): number {
    return a < b ? -1 : a > b ? 1 : 0;
}

function pairKey(identity: PairFeatureSnapshotIdentity): string {
    const canonicalIdentity = canonicalJson([
        requireString(identity.pair, "pair identity"),
        requireString(identity.baseSymbol, "base identity"),
        requireString(identity.quoteSymbol, "quote identity"),
    ]);
    return hashBytes(Buffer.from(canonicalIdentity, "utf8"));
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

function buildBars(source: PairFeatureSnapshotSource["bars"]): {
    records: PairFeatureSnapshotBar[];
    barIndexByTime: Map<number, number>;
} {
    const records: PairFeatureSnapshotBar[] = [];
    const barIndexByTime = new Map<number, number>();
    let previousTime = -Infinity;
    for (const [index, bar] of source.entries()) {
        const timeSec = parseTimeToUnixSeconds(bar.time);
        if (timeSec === null) throw new Error(`Source snapshot bar ${index} has an invalid time.`);
        if (timeSec <= previousTime) {
            throw new Error(`Source snapshot bars must have strictly increasing unique times (bar ${index}).`);
        }
        previousTime = timeSec;
        barIndexByTime.set(timeSec, index);
        records.push([
            timeSec,
            requireFinite(bar.open, `bar ${index} open`),
            requireFinite(bar.high, `bar ${index} high`),
            requireFinite(bar.low, `bar ${index} low`),
            requireFinite(bar.close, `bar ${index} close`),
            requireFinite(bar.volume, `bar ${index} volume`),
        ]);
    }
    return { records, barIndexByTime };
}

function buildTrades(source: PairFeatureSnapshotSource["trades"], barIndexByTime: Map<number, number>): PairFeatureSnapshotTrade[] {
    return source.map((trade, tradeOrdinal) => {
        if (trade.type !== "long" && trade.type !== "short") {
            throw new Error(`Source snapshot trade ${tradeOrdinal} has an invalid direction.`);
        }
        const entryTimeSec = parseTimeToUnixSeconds(trade.entryTime);
        const exitTimeSec = parseTimeToUnixSeconds(trade.exitTime);
        if (entryTimeSec === null || exitTimeSec === null) {
            throw new Error(`Source snapshot trade ${tradeOrdinal} has an invalid time.`);
        }
        const entryBarIndex = barIndexByTime.get(entryTimeSec);
        const exitBarIndex = barIndexByTime.get(exitTimeSec);
        if (entryBarIndex === undefined || exitBarIndex === undefined) {
            throw new Error(`Source snapshot trade ${tradeOrdinal} time does not map to a captured bar.`);
        }
        const fees = trade.fees === undefined || trade.fees === null
            ? null
            : requireFinite(trade.fees, `trade ${tradeOrdinal} fees`);
        if (trade.exitReason !== undefined && trade.exitReason !== null && typeof trade.exitReason !== "string") {
            throw new Error(`Source snapshot trade ${tradeOrdinal} has an invalid exit reason.`);
        }
        return {
            tradeOrdinal,
            id: requireFinite(trade.id, `trade ${tradeOrdinal} id`),
            direction: trade.type,
            entryTimeSec,
            exitTimeSec,
            entryBarIndex,
            exitBarIndex,
            entryPrice: requireFinite(trade.entryPrice, `trade ${tradeOrdinal} entryPrice`),
            exitPrice: requireFinite(trade.exitPrice, `trade ${tradeOrdinal} exitPrice`),
            pnl: requireFinite(trade.pnl, `trade ${tradeOrdinal} pnl`),
            pnlPercent: requireFinite(trade.pnlPercent, `trade ${tradeOrdinal} pnlPercent`),
            size: requireFinite(trade.size, `trade ${tradeOrdinal} size`),
            fees,
            exitReason: trade.exitReason ?? null,
        };
    });
}

function buildEntries(
    source: PairFeatureSnapshotSource["entries"],
    bars: readonly PairFeatureSnapshotBar[],
): PairFeatureSnapshotEntry[] {
    return source.map((entry, index) => {
        const rowOrdinal = requireInteger(entry[0], `entry ${index} rowOrdinal`);
        const signalBarIndex = requireInteger(entry[1], `entry ${index} signalBarIndex`);
        if (rowOrdinal < 0 || signalBarIndex < 0 || signalBarIndex >= bars.length) {
            throw new Error(`Source snapshot entry ${index} has an out-of-range ordinal or bar index.`);
        }
        if (entry[2] !== "long" && entry[2] !== "short") {
            throw new Error(`Source snapshot entry ${index} has an invalid direction.`);
        }
        const signalTimeSec = requireFinite(entry[3], `entry ${index} signalTimeSec`);
        if (bars[signalBarIndex]![0] !== signalTimeSec) {
            throw new Error(`Source snapshot entry ${index} time does not match its signal bar.`);
        }
        return [rowOrdinal, signalBarIndex, entry[2], signalTimeSec];
    });
}

function buildWarmupEntries(
    source: readonly PairFeatureSnapshotWarmupEntry[],
    bars: readonly PairFeatureSnapshotBar[],
): PairFeatureSnapshotWarmupEntry[] {
    let previousSignalBarIndex = -1;
    return source.map((entry, index) => {
        const signalBarIndex = requireInteger(entry[0], `warmup entry ${index} signalBarIndex`);
        if (signalBarIndex < 0 || signalBarIndex >= bars.length || signalBarIndex < previousSignalBarIndex) {
            throw new Error(`Source snapshot warmup entry ${index} has an invalid or non-monotonic bar index.`);
        }
        previousSignalBarIndex = signalBarIndex;
        if (entry[1] !== "long" && entry[1] !== "short") {
            throw new Error(`Source snapshot warmup entry ${index} has an invalid direction.`);
        }
        const signalTimeSec = requireFinite(entry[2], `warmup entry ${index} signalTimeSec`);
        if (bars[signalBarIndex]![0] !== signalTimeSec) {
            throw new Error(`Source snapshot warmup entry ${index} time does not match its signal bar.`);
        }
        return [signalBarIndex, entry[1], signalTimeSec];
    });
}

function artifactMetadata(
    relativePath: string,
    recordCount: number,
    encoded: EncodedCanonicalJsonl,
): PairFeatureSnapshotArtifact {
    return {
        path: relativePath,
        recordCount,
        compressedBytes: encoded.compressed.byteLength,
        compressedSha256: encoded.compressedSha256,
        uncompressedBytes: encoded.uncompressed.byteLength,
        uncompressedSha256: encoded.uncompressedSha256,
    };
}

async function* iterateGzipJsonl(filePath: string): AsyncGenerator<string> {
    const source = createReadStream(filePath);
    const gunzip = createGunzip();
    source.pipe(gunzip);
    const reader = createInterface({ input: gunzip, crlfDelay: Infinity });
    try {
        for await (const rawLine of reader) {
            const line = rawLine.trim();
            if (line) yield line;
        }
    } finally {
        reader.close();
        source.destroy();
        gunzip.destroy();
    }
}

async function verifyLedgerEntries(
    runDir: string,
    ledgerPath: string,
    pairs: readonly PairFeatureSnapshotPairManifest[],
    ledgerRowCount: number,
): Promise<void> {
    const ledger = iterateJsonlLines(ledgerPath);
    let consumedRows = 0;
    try {
        for (const pair of pairs) {
            const entriesPath = await safeArtifactPath(runDir, pair.files.entries.path);
            const entries = iterateGzipJsonl(entriesPath);
            let consumedPairEntries = 0;
            try {
                while (consumedPairEntries < pair.rowCount) {
                    const ledgerLine = await ledger.next(undefined);
                    const entryLine = await entries.next(undefined);
                    if (ledgerLine.done || entryLine.done) {
                        throw new Error(`Source snapshot row coverage ended early for ${pair.pairKey}.`);
                    }
                    const row = JSON.parse(ledgerLine.value) as {
                        pair?: unknown;
                        baseSymbol?: unknown;
                        quoteSymbol?: unknown;
                        direction?: unknown;
                        signalTime?: unknown;
                        signalBarIndex?: unknown;
                    };
                    const entry = JSON.parse(entryLine.value) as unknown;
                    if (!Array.isArray(entry) || entry.length !== 4) {
                        throw new Error(`Source snapshot entry record is malformed for ${pair.pairKey}.`);
                    }
                    const expectedOrdinal = pair.rowStart + consumedPairEntries;
                    if (
                        row.pair !== pair.pair
                        || row.baseSymbol !== pair.baseSymbol
                        || row.quoteSymbol !== pair.quoteSymbol
                        || row.direction !== entry[2]
                        || row.signalTime !== entry[3]
                        || row.signalBarIndex !== entry[1]
                        || entry[0] !== expectedOrdinal
                    ) {
                        throw new Error(`Source snapshot entry does not agree with ledger row ${expectedOrdinal}.`);
                    }
                    consumedPairEntries += 1;
                    consumedRows += 1;
                }
                const extraEntry = await entries.next(undefined);
                if (!extraEntry.done) throw new Error(`Source snapshot has extra entries for ${pair.pairKey}.`);
            } finally {
                await entries.return?.(undefined);
            }
        }
        const extraLedgerRow = await ledger.next(undefined);
        if (!extraLedgerRow.done || consumedRows !== ledgerRowCount) {
            throw new Error(`Source snapshot row coverage does not match the ledger (${consumedRows}/${ledgerRowCount}).`);
        }
    } finally {
        await ledger.return?.(undefined);
    }
}

export interface TradeLedgerSnapshotWriterOptions {
    runDir: string;
}

/**
 * Incremental source-snapshot writer. At most two complete pair payloads are
 * retained while their independent gzip/file operations overlap; finalize
 * drains those bounded captures before publishing the manifest.
 */
export class TradeLedgerSnapshotWriter {
    private static readonly MAX_IN_FLIGHT_CAPTURES = 2;
    private readonly runDir: string;
    private initialized = false;
    private initializationPromise: Promise<void> | null = null;
    private active = false;
    private failure: string | null = null;
    private finalized: PairFeatureSnapshotFinalizeResult | null = null;
    private readonly pairs: PairFeatureSnapshotPairManifest[] = [];
    private readonly pairKeys = new Set<string>();
    private inFlightCaptures = new Set<Promise<void>>();
    private activeCaptureCount = 0;
    private readonly captureSlotWaiters: Array<() => void> = [];

    constructor(options: TradeLedgerSnapshotWriterOptions) {
        this.runDir = options.runDir;
    }

    get error(): string | null {
        return this.failure;
    }

    get isActive(): boolean {
        return this.active;
    }

    /** Capture one successful pair after its ledger rows have committed. */
    async capturePair(source: PairFeatureSnapshotSource): Promise<void> {
        const capture = await this.startCapture(source);
        if (capture) await capture;
    }

    /**
     * Start a bounded capture and return once its slot is occupied. Batch uses
     * this to overlap source-snapshot work with the next pair; `finalize()`
     * waits for every started capture before checking coverage or hashes.
     */
    async enqueuePair(source: PairFeatureSnapshotSource): Promise<void> {
        await this.startCapture(source);
    }

    private async startCapture(source: PairFeatureSnapshotSource): Promise<Promise<void> | null> {
        this.active = true;
        if (this.failure) return null;
        let key: string;
        try {
            key = pairKey(source.identity);
            if (this.pairKeys.has(key)) {
                throw new Error(`Source snapshot pair ${key} was captured more than once.`);
            }
            // Reserve the key before waiting for a slot. This keeps concurrent
            // callers from scheduling duplicate partitions for the same pair.
            this.pairKeys.add(key);
        } catch (error) {
            await this.recordFailure(error);
            return null;
        }

        await this.acquireCaptureSlot();
        if (this.failure) {
            this.releaseCaptureSlot();
            return null;
        }
        const capture = this.capturePairNow(source, key).catch(async (error) => {
            await this.recordFailure(error);
        });
        this.inFlightCaptures.add(capture);
        void capture.then(() => {
            this.inFlightCaptures.delete(capture);
            this.releaseCaptureSlot();
        });
        return capture;
    }

    private async capturePairNow(source: PairFeatureSnapshotSource, key: string): Promise<void> {
        await this.initialize();
        const rowStart = requireInteger(source.rowStart, "pair rowStart");
        if (rowStart < 0) throw new Error("Source snapshot pair rowStart must not be negative.");

        const { records: bars, barIndexByTime } = buildBars(source.bars);
        const trades = buildTrades(source.trades, barIndexByTime);
        const entries = buildEntries(source.entries, bars);
        const warmupEntries = buildWarmupEntries(source.warmupEntries ?? [], bars);
        const expectedRowOrdinal = rowStart;
        for (const [index, entry] of entries.entries()) {
            if (entry[0] !== expectedRowOrdinal + index) {
                throw new Error(`Source snapshot entry ordinals are not contiguous at entry ${index}.`);
            }
        }

        const prefix = `${PAIRS_DIR}/${key}`;
        // Start all four independent partitions before awaiting them. The
        // async zlib encoder uses Node's worker pool, so source snapshots
        // no longer serialize four compression jobs on the event loop.
        const [barsFile, tradesFile, entriesFile, warmupFile] = await Promise.all([
            this.writeJsonl(`${prefix}/bars.jsonl.gz`, bars),
            this.writeJsonl(`${prefix}/trades.jsonl.gz`, trades),
            this.writeJsonl(`${prefix}/entries.jsonl.gz`, entries),
            this.writeJsonl(`${prefix}/entries-warmup.jsonl.gz`, warmupEntries),
        ]);
        this.pairs.push({
            ...source.identity,
            pairKey: key,
            barCount: bars.length,
            firstTimeSec: bars[0]?.[0] ?? null,
            lastTimeSec: bars[bars.length - 1]?.[0] ?? null,
            tradeCount: trades.length,
            rowStart,
            rowCount: entries.length,
            files: {
                bars: barsFile,
                trades: tradesFile,
                entries: entriesFile,
                entriesWarmup: warmupFile,
            },
        });
    }

    private acquireCaptureSlot(): Promise<void> {
        if (this.activeCaptureCount < TradeLedgerSnapshotWriter.MAX_IN_FLIGHT_CAPTURES) {
            this.activeCaptureCount += 1;
            return Promise.resolve();
        }
        return new Promise((resolve) => {
            this.captureSlotWaiters.push(() => {
                this.activeCaptureCount += 1;
                resolve();
            });
        });
    }

    private releaseCaptureSlot(): void {
        const next = this.captureSlotWaiters.shift();
        if (next) next();
        else this.activeCaptureCount = Math.max(0, this.activeCaptureCount - 1);
    }

    private async waitForCaptures(): Promise<void> {
        while (this.inFlightCaptures.size > 0) {
            await Promise.all([...this.inFlightCaptures]);
        }
    }

    async finalize(input: PairFeatureSnapshotFinalizeInput): Promise<PairFeatureSnapshotFinalizeResult> {
        if (this.finalized) return this.finalized;
        await this.waitForCaptures();
        if (!this.active) return { complete: false, error: null, manifestSha256: null };
        if (this.failure) return { complete: false, error: this.failure, manifestSha256: null };
        if (!input.ledgerComplete) return { complete: false, error: null, manifestSha256: null };

        try {
            const pairs = [...this.pairs].sort((a, b) => a.rowStart - b.rowStart || compareCodeUnits(a.pairKey, b.pairKey));
            let nextRowOrdinal = 0;
            for (const pair of pairs) {
                if (pair.rowStart !== nextRowOrdinal) {
                    throw new Error(`Source snapshot pair rows are not contiguous at ${pair.pairKey}.`);
                }
                nextRowOrdinal += pair.rowCount;
            }
            if (nextRowOrdinal !== input.ledgerRowCount) {
                throw new Error(`Source snapshot covers ${nextRowOrdinal} rows but the ledger has ${input.ledgerRowCount}.`);
            }
            await verifyLedgerEntries(this.runDir, input.ledgerPath, pairs, input.ledgerRowCount);

            const ledger = await hashFile(input.ledgerPath);
            const provenance = await hashFile(input.provenancePath);
            let ranksSha256: string | null = null;
            try {
                ranksSha256 = (await hashFile(input.ranksPath)).sha256;
            } catch (error) {
                if ((error as NodeJS.ErrnoException | null)?.code !== "ENOENT") throw error;
            }
            const manifest: PairFeatureSnapshotManifest = {
                formatVersion: 1,
                writerRevision: 1,
                complete: true,
                ledgerSha256: ledger.sha256,
                ledgerBytes: ledger.bytes,
                ledgerRowCount: input.ledgerRowCount,
                provenanceSha256: provenance.sha256,
                summarySha256: (await hashFile(input.summaryPath)).sha256,
                ranksSha256,
                runtime: runtimeFingerprint(),
                capabilities: PAIR_FEATURE_SNAPSHOT_CAPABILITIES,
                pairs,
            };
            const manifestPath = await safeArtifactPath(this.runDir, MANIFEST_PATH);
            await writeArtifactAtomically(manifestPath, canonicalJson(manifest));
            const manifestHash = await hashFile(manifestPath);
            this.finalized = { complete: true, error: null, manifestSha256: manifestHash.sha256 };
            return this.finalized;
        } catch (error) {
            await this.recordFailure(error);
            this.finalized = { complete: false, error: this.failure, manifestSha256: null };
            return this.finalized;
        }
    }

    private async initialize(): Promise<void> {
        if (this.initialized) return;
        if (this.initializationPromise) return this.initializationPromise;
        this.initializationPromise = this.initializeOnce();
        await this.initializationPromise;
    }

    private async initializeOnce(): Promise<void> {
        const sourceSnapshotPath = await safeArtifactPath(this.runDir, SOURCE_SNAPSHOT_DIR);
        await mkdir(sourceSnapshotPath);
        const pairsPath = await safeArtifactPath(this.runDir, PAIRS_DIR);
        await mkdir(pairsPath);
        await safeArtifactPath(this.runDir, SOURCE_SNAPSHOT_DIR);
        await safeArtifactPath(this.runDir, PAIRS_DIR);
        this.initialized = true;
    }

    private async writeJsonl(relativePath: string, records: readonly unknown[]): Promise<PairFeatureSnapshotArtifact> {
        const encoded = await encodeCanonicalJsonlAsync(records, { gzipLevel: SOURCE_SNAPSHOT_GZIP_LEVEL });
        const parent = relativePath.slice(0, relativePath.lastIndexOf("/"));
        await safeArtifactPath(this.runDir, parent);
        await mkdir(join(this.runDir, parent), { recursive: true });
        const target = await safeArtifactPath(this.runDir, relativePath);
        await writeArtifactAtomically(target, encoded.compressed);
        return artifactMetadata(relativePath, records.length, encoded);
    }

    private async recordFailure(error: unknown): Promise<void> {
        if (!this.failure) this.failure = errorMessage(error);
        try {
            await mkdir(join(this.runDir, SOURCE_SNAPSHOT_DIR), { recursive: true });
            const errorPath = await safeArtifactPath(this.runDir, ERROR_PATH);
            await writeArtifactAtomically(errorPath, JSON.stringify({ error: this.failure }, null, 2));
        } catch {
            // The original failure is the useful diagnostic when the snapshot
            // directory itself is unavailable or unsafe.
        }
    }
}
