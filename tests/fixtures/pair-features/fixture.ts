import { mkdir, writeFile } from "node:fs/promises";
import { Buffer } from "node:buffer";
import { join } from "node:path";
import {
    canonicalJson,
    encodeCanonicalJsonl,
    hashBytes,
    writeArtifactAtomically,
} from "../../../lib/pair-features/artifact-io";
import type {
    PairFeatureSnapshotBar,
    PairFeatureSnapshotEntry,
    PairFeatureSnapshotManifest,
    PairFeatureSnapshotPairManifest,
    PairFeatureSnapshotRuntimeFingerprint,
    PairFeatureSnapshotTrade,
} from "../../../lib/pair-features/types";

export const FIXTURE_PAIR = "FIXTURE_PAIR";
export const FIXTURE_BASE = "FIXTURE_BASE";
export const FIXTURE_QUOTE = "FIXTURE_QUOTE";

export interface PairFeatureFixtureOptions {
    mutateBar?: (bars: PairFeatureSnapshotBar[]) => void;
    mutateTrade?: (trades: PairFeatureSnapshotTrade[]) => void;
    entries?: readonly PairFeatureSnapshotEntry[];
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

function pairKey(): string {
    return hashBytes(Buffer.from(canonicalJson([FIXTURE_PAIR, FIXTURE_BASE, FIXTURE_QUOTE]), "utf8"));
}

function buildBars(): PairFeatureSnapshotBar[] {
    return Array.from({ length: 30 }, (_, index) => {
        const close = index <= 12 ? 2 ** index : 1;
        return [1000 + index, close, close + 1, Math.max(0, close - 1), close, 100 + index];
    });
}

function buildTrades(): PairFeatureSnapshotTrade[] {
    return Array.from({ length: 9 }, (_, index) => {
        const exitBarIndex = index === 8 ? 20 : 12 + index;
        return {
            tradeOrdinal: index,
            id: index + 1,
            direction: index % 2 === 0 ? "long" : "short",
            entryTimeSec: 1000 + exitBarIndex - 1,
            exitTimeSec: 1000 + exitBarIndex,
            entryBarIndex: exitBarIndex - 1,
            exitBarIndex,
            entryPrice: 10 + index,
            exitPrice: 11 + index,
            pnl: index + 1,
            pnlPercent: index + 1,
            size: 1,
            fees: 0.25,
            exitReason: "take_profit",
        };
    });
}

function writeJson(path: string, value: unknown): Promise<void> {
    return writeFile(path, Buffer.from(canonicalJson(value), "utf8"));
}

async function writeGzipArtifact<T>(
    folder: string,
    relativePath: string,
    records: readonly T[],
): Promise<ReturnType<typeof encodeCanonicalJsonl>> {
    const encoded = encodeCanonicalJsonl(records);
    const path = join(folder, ...relativePath.split("/"));
    await mkdir(join(path, ".."), { recursive: true });
    await writeArtifactAtomically(path, encoded.compressed);
    return encoded;
}

function artifact(
    path: string,
    recordCount: number,
    encoded: ReturnType<typeof encodeCanonicalJsonl>,
): PairFeatureSnapshotPairManifest["files"]["bars"] {
    return {
        path,
        recordCount,
        compressedBytes: encoded.compressed.length,
        compressedSha256: encoded.compressedSha256,
        uncompressedBytes: encoded.uncompressed.length,
        uncompressedSha256: encoded.uncompressedSha256,
    };
}

export async function createPairFeatureFixture(
    folder: string,
    options: PairFeatureFixtureOptions = {},
): Promise<{ folder: string; pairKey: string; entries: PairFeatureSnapshotEntry[]; bars: PairFeatureSnapshotBar[]; trades: PairFeatureSnapshotTrade[] }> {
    await mkdir(folder, { recursive: true });
    const bars = buildBars();
    const trades = buildTrades();
    options.mutateBar?.(bars);
    options.mutateTrade?.(trades);
    const entries = [...(options.entries ?? [
        [0, 12, "long", 1012],
        [1, 13, "short", 1013],
        [2, 20, "long", 1020],
    ] as const)];
    const key = pairKey();
    const prefix = `source-snapshot/pairs/${key}`;
    const barsEncoded = await writeGzipArtifact(folder, `${prefix}/bars.jsonl.gz`, bars);
    const tradesEncoded = await writeGzipArtifact(folder, `${prefix}/trades.jsonl.gz`, trades);
    const entriesEncoded = await writeGzipArtifact(folder, `${prefix}/entries.jsonl.gz`, entries);
    const ledgerRows = entries.map((entry) => ({
        ledgerVersion: 3,
        pair: FIXTURE_PAIR,
        baseSymbol: FIXTURE_BASE,
        quoteSymbol: FIXTURE_QUOTE,
        direction: entry[2],
        signalTime: entry[3],
        signalBarIndex: entry[1],
    }));
    const ledgerBytes = Buffer.from(ledgerRows.map((row) => `${canonicalJson(row)}\n`).join(""), "utf8");
    await writeFile(join(folder, "ledger.jsonl"), ledgerBytes);
    await writeJson(join(folder, "provenance.json"), {});
    await writeJson(join(folder, "summary.json"), {});
    await writeFile(join(folder, "signal-ranks.jsonl"), Buffer.alloc(0));
    const pair: PairFeatureSnapshotPairManifest = {
        pair: FIXTURE_PAIR,
        baseSymbol: FIXTURE_BASE,
        quoteSymbol: FIXTURE_QUOTE,
        pairKey: key,
        barCount: bars.length,
        firstTimeSec: bars[0]![0],
        lastTimeSec: bars[bars.length - 1]![0],
        tradeCount: trades.length,
        rowStart: 0,
        rowCount: entries.length,
        files: {
            bars: artifact(`${prefix}/bars.jsonl.gz`, bars.length, barsEncoded),
            trades: artifact(`${prefix}/trades.jsonl.gz`, trades.length, tradesEncoded),
            entries: artifact(`${prefix}/entries.jsonl.gz`, entries.length, entriesEncoded),
        },
    };
    const manifest: PairFeatureSnapshotManifest = {
        formatVersion: 1,
        writerRevision: 1,
        complete: true,
        ledgerSha256: hashBytes(ledgerBytes),
        ledgerBytes: ledgerBytes.length,
        ledgerRowCount: ledgerRows.length,
        provenanceSha256: hashBytes(Buffer.from(canonicalJson({}), "utf8")),
        summarySha256: hashBytes(Buffer.from(canonicalJson({}), "utf8")),
        ranksSha256: hashBytes(Buffer.alloc(0)),
        runtime: runtimeFingerprint(),
        capabilities: ["pair_bars_v1", "closed_trade_records_v1", "entry_candidates_v1"],
        pairs: [pair],
    };
    await writeJson(join(folder, "source-snapshot", "manifest.json"), manifest);
    return { folder, pairKey: key, entries, bars, trades };
}
