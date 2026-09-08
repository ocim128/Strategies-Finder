import { expect } from "chai";
import { spawnSync } from "node:child_process";
import { describe, it, after } from "node:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import {
    canonicalJson,
    encodeCanonicalJsonl,
    encodeCanonicalJsonlAsync,
    safeArtifactPath,
} from "../lib/pair-features/artifact-io";
import {
    TradeLedgerSnapshotWriter,
} from "../lib/batch-backtest/trade-ledger-snapshot-writer";
import {
    TRADE_LEDGER_VERSION,
    TradeLedgerWriter,
    type TradeLedgerProvenance,
    type TradeLedgerRow,
} from "../lib/batch-backtest/trade-ledger-exporter";
import type { OHLCVData, Time, Trade } from "../lib/types/strategies";

const BASE_TIME = 1_700_000_000;
const HOUR = 3_600;
const tempRoots: string[] = [];

function makeRoot(): string {
    const root = mkdtempSync(path.join(tmpdir(), "pair-feature-snapshot-"));
    tempRoots.push(root);
    return root;
}

function makeBars(): OHLCVData[] {
    return [
        { time: BASE_TIME * 1000 as Time, open: 100, high: 102, low: 99, close: 101, volume: 10 },
        { time: `${new Date((BASE_TIME + HOUR) * 1000).toISOString()}` as unknown as Time, open: 101, high: 104, low: 100, close: 103, volume: 20 },
        { time: BASE_TIME + 2 * HOUR as Time, open: 103, high: 105, low: 102, close: 104, volume: 30 },
    ];
}

function makeTrade(overrides: Partial<Trade> = {}): Trade {
    return {
        id: 7,
        type: "long",
        entryTime: BASE_TIME + HOUR as Time,
        entryPrice: 101.25,
        exitTime: BASE_TIME + 2 * HOUR as Time,
        exitPrice: 103.5,
        pnl: 2.25,
        pnlPercent: 2.22,
        size: 4,
        fees: 0.25,
        exitReason: "take_profit",
        ...overrides,
    };
}

function makeProvenance(runId: string): TradeLedgerProvenance {
    return {
        ledgerVersion: TRADE_LEDGER_VERSION,
        ledgerHorizons: [24],
        featureVersion: 3,
        runId,
        startedAt: new Date(BASE_TIME * 1000).toISOString(),
        interval: "1h",
        strategyKey: "snapshot-test",
        strategyParams: {},
        backtestSettings: {},
        capitalSettings: {},
        engineMode: "typescript",
        executionModel: "signal_close",
        tradeDirection: "long",
        riskMode: "percentage",
        fees: { commissionPercent: 0, slippageBps: 0 },
        pairCount: 1,
        symbols: ["BASE+QUOTE"],
        replay: {
            replayEligible: true,
            replayBlockers: [],
            maxOpenTrades: 1,
            cooldownBars: 0,
            executionModel: "signal_close",
            tradeDirection: "long",
            allowSameBarExit: false,
            disableSignalExits: true,
            slippageRate: 0,
            commissionRate: 0,
        },
    };
}

function makeRow(overrides: Partial<TradeLedgerRow> = {}): TradeLedgerRow {
    return {
        ledgerVersion: TRADE_LEDGER_VERSION,
        pair: "BASE+QUOTE",
        baseSymbol: "BASE",
        quoteSymbol: "QUOTE",
        direction: "long",
        signalTime: BASE_TIME + HOUR,
        signalBarIndex: 1,
        fillTime: BASE_TIME + HOUR,
        fillPrice: 101,
        executed: false,
        notExecutedReason: "match_missing",
        feat_entryRangePosition: null,
        feat_atrPct: null,
        feat_return20: null,
        feat_gapPct: null,
        feat_dow: null,
        feat_hour: null,
        feat_pairWinRatePrior: null,
        feat_pairTradesPrior: 0,
        feat_barsSincePairLastFire: null,
        feat_pairSpreadVolatility20: null,
        feat_legVolatilityRatio20: null,
        feat_rank: null,
        feat_candidatesAtTime: null,
        asIf: null,
        asIfReason: "replay_ineligible",
        horizons: {},
        ...overrides,
    };
}

function decodeJsonl<T>(filePath: string): T[] {
    const text = gunzipSync(readFileSync(filePath)).toString("utf8");
    if (!text) return [];
    expect(text.endsWith("\n")).to.equal(true);
    return text.trimEnd().split("\n").map((line) => JSON.parse(line) as T);
}

async function writeExperimentFiles(root: string, rowCount: number): Promise<void> {
    await writeFile(path.join(root, "ledger.jsonl"), `${"{}\n".repeat(rowCount)}`, "utf8");
    await writeFile(path.join(root, "provenance.json"), "{}", "utf8");
    await writeFile(path.join(root, "summary.json"), "{}", "utf8");
    await writeFile(path.join(root, "signal-ranks.jsonl"), "", "utf8");
}

function snapshotSource(overrides: Partial<Parameters<TradeLedgerSnapshotWriter["capturePair"]>[0]> = {}) {
    return {
        identity: { pair: "BASE+QUOTE", baseSymbol: "BASE", quoteSymbol: "QUOTE" },
        bars: makeBars(),
        trades: [makeTrade()],
        entries: [
            [0, 1, "long", BASE_TIME + HOUR] as const,
            [1, 1, "short", BASE_TIME + HOUR] as const,
        ],
        rowStart: 0,
        ...overrides,
    };
}

describe("pair feature snapshot artifact I/O", () => {
    after(() => {
        for (const root of tempRoots) rmSync(root, { recursive: true, force: true });
    });

    it("canonicalizes JSON and produces reproducible level-6 gzip bytes", async () => {
        const records = [
            { z: -0, a: 2, nested: { beta: 1, alpha: "x" } },
            ["keeps", "array", "order"],
        ];
        expect(canonicalJson(records[0])).to.equal('{"a":2,"nested":{"alpha":"x","beta":1},"z":0}');
        const first = encodeCanonicalJsonl(records);
        const second = encodeCanonicalJsonl(records);
        const asyncEncoded = await encodeCanonicalJsonlAsync(records);
        expect(first.compressed.equals(second.compressed)).to.equal(true);
        expect(first.compressed.equals(asyncEncoded.compressed)).to.equal(true);
        expect(first.uncompressed.equals(second.uncompressed)).to.equal(true);
        expect(gunzipSync(first.compressed).toString("utf8")).to.equal(
            '{"a":2,"nested":{"alpha":"x","beta":1},"z":0}\n["keeps","array","order"]\n',
        );
        expect(encodeCanonicalJsonl([]).uncompressed.byteLength).to.equal(0);
        expect(gunzipSync(encodeCanonicalJsonl([]).compressed).byteLength).to.equal(0);
        expect(() => canonicalJson({ bad: Number.NaN })).to.throw(/Non-finite/);
        expect(() => canonicalJson({ bad: undefined })).to.throw(/Unsupported JSON value/);
    });

    it("rejects traversal and symlink/reparse artifact paths", async () => {
        const root = makeRoot();
        await mkdir(path.join(root, "real"));
        expect(await safeArtifactPath(root, "real/file.bin")).to.equal(path.join(root, "real", "file.bin"));
        await expectPromise(safeArtifactPath(root, "../outside"), /Unsafe artifact path/);
        await expectPromise(safeArtifactPath(root, "real\\file.bin"), /Unsafe artifact path/);
    });

    it("round-trips bars, normalized times, actual trades, and two entry directions at one timestamp", async () => {
        const root = makeRoot();
        await writeExperimentFiles(root, 2);
        await writeFile(path.join(root, "ledger.jsonl"), [
            JSON.stringify({ pair: "BASE+QUOTE", baseSymbol: "BASE", quoteSymbol: "QUOTE", direction: "long", signalTime: BASE_TIME + HOUR, signalBarIndex: 1 }),
            JSON.stringify({ pair: "BASE+QUOTE", baseSymbol: "BASE", quoteSymbol: "QUOTE", direction: "short", signalTime: BASE_TIME + HOUR, signalBarIndex: 1 }),
            "",
        ].join("\n"), "utf8");
        const writer = new TradeLedgerSnapshotWriter({ runDir: root });
        await writer.capturePair(snapshotSource());
        const result = await writer.finalize({
            ledgerComplete: true,
            ledgerRowCount: 2,
            ledgerPath: path.join(root, "ledger.jsonl"),
            provenancePath: path.join(root, "provenance.json"),
            summaryPath: path.join(root, "summary.json"),
            ranksPath: path.join(root, "signal-ranks.jsonl"),
        });
        expect(result.complete).to.equal(true);
        expect(result.manifestSha256).to.match(/^[0-9a-f]{64}$/);

        const manifest = JSON.parse(readFileSync(path.join(root, "source-snapshot/manifest.json"), "utf8")) as any;
        expect(manifest.complete).to.equal(true);
        expect(manifest.capabilities).to.deep.equal(["pair_bars_v1", "closed_trade_records_v1", "entry_candidates_v1", "entry_candidates_warmup_v1"]);
        expect(manifest.ledgerRowCount).to.equal(2);
        expect(manifest.pairs).to.have.length(1);
        const pair = manifest.pairs[0];
        expect(pair.pair).to.equal("BASE+QUOTE");
        expect(pair.baseSymbol).to.equal("BASE");
        expect(pair.quoteSymbol).to.equal("QUOTE");
        expect(pair.barCount).to.equal(3);
        expect(pair.tradeCount).to.equal(1);
        expect(pair.rowStart).to.equal(0);
        expect(pair.rowCount).to.equal(2);

        const pairDir = path.join(root, "source-snapshot", "pairs", pair.pairKey);
        expect(decodeJsonl(pairDir + "/bars.jsonl.gz")).to.deep.equal([
            [BASE_TIME, 100, 102, 99, 101, 10],
            [BASE_TIME + HOUR, 101, 104, 100, 103, 20],
            [BASE_TIME + 2 * HOUR, 103, 105, 102, 104, 30],
        ]);
        expect(decodeJsonl(pairDir + "/entries.jsonl.gz")).to.deep.equal([
            [0, 1, "long", BASE_TIME + HOUR],
            [1, 1, "short", BASE_TIME + HOUR],
        ]);
        expect(decodeJsonl(pairDir + "/trades.jsonl.gz")).to.deep.equal([{
            tradeOrdinal: 0,
            id: 7,
            direction: "long",
            entryTimeSec: BASE_TIME + HOUR,
            exitTimeSec: BASE_TIME + 2 * HOUR,
            entryBarIndex: 1,
            exitBarIndex: 2,
            entryPrice: 101.25,
            exitPrice: 103.5,
            pnl: 2.25,
            pnlPercent: 2.22,
            size: 4,
            fees: 0.25,
            exitReason: "take_profit",
        }]);
        expect(pair.files.entries.recordCount).to.equal(2);
        expect(pair.files.entries.compressedBytes).to.equal(readFileSync(pairDir + "/entries.jsonl.gz").byteLength);
        expect(pair.files.entries.uncompressedBytes).to.equal(Buffer.byteLength("[0,1,\"long\",1700003600]\n[1,1,\"short\",1700003600]\n"));
        expect(decodeJsonl(pairDir + "/entries-warmup.jsonl.gz")).to.deep.equal([]);
    });

    it("round-trips pre-window entries without ledger ordinals or outcomes", async () => {
        const root = makeRoot();
        const writer = await TradeLedgerWriter.create({
            rootDir: root,
            folder: "runs",
            runId: "window-warmup",
            startedAtMs: BASE_TIME * 1000,
            provenance: makeProvenance("window-warmup"),
            ledgerWindow: { fromSec: BASE_TIME + 2 * HOUR, toSec: null },
        });
        expect(writer).to.not.equal(null);
        await writer!.appendPairRows(
            {
                rows: [
                    makeRow(),
                    makeRow({ signalTime: BASE_TIME + 2 * HOUR, signalBarIndex: 2 }),
                ],
                duplicatesCollapsed: 0,
                rightCensored: 0,
            },
            { pair: "BASE+QUOTE", data: makeBars(), trades: [] },
        );
        const result = await writer!.finalize({ cancelled: false, finishedAtMs: BASE_TIME * 1000 + 1 });
        expect(result.snapshotComplete).to.equal(true);
        const manifest = JSON.parse(readFileSync(path.join(writer!.runDir, "source-snapshot/manifest.json"), "utf8")) as any;
        const pair = manifest.pairs[0];
        expect(pair.rowCount).to.equal(1);
        expect(pair.files.entriesWarmup.recordCount).to.equal(1);
        const pairDir = path.join(writer!.runDir, "source-snapshot", "pairs", pair.pairKey);
        expect(decodeJsonl(pairDir + "/entries-warmup.jsonl.gz")).to.deep.equal([
            [1, "long", BASE_TIME + HOUR],
        ]);
        expect(JSON.stringify(decodeJsonl(pairDir + "/entries-warmup.jsonl.gz"))).to.not.include("outcome");
    });

    it("captures an empty entry/trade partition and refuses a reused run directory", async () => {
        const root = makeRoot();
        const first = await TradeLedgerWriter.create({
            rootDir: root,
            folder: "runs",
            runId: "same-run",
            startedAtMs: BASE_TIME * 1000,
            provenance: makeProvenance("same-run"),
        });
        expect(first).to.not.equal(null);
        await first!.appendPairRows(
            { rows: [], duplicatesCollapsed: 0, rightCensored: 0 },
            { pair: "EMPTY+PAIR", data: makeBars(), trades: [], baseSymbol: "EMPTY", quoteSymbol: "PAIR" },
        );
        const firstResult = await first!.finalize({ cancelled: false, finishedAtMs: BASE_TIME * 1000 + 1 });
        expect(firstResult.snapshotComplete).to.equal(true);
        const runDir = first!.runDir;
        const before = new Map([
            ["provenance.json", readFileSync(path.join(runDir, "provenance.json"))],
            ["ledger.jsonl", readFileSync(path.join(runDir, "ledger.jsonl"))],
            ["source-snapshot/manifest.json", readFileSync(path.join(runDir, "source-snapshot/manifest.json"))],
        ]);
        const refused = await TradeLedgerWriter.create({
            rootDir: root,
            folder: "runs",
            runId: "same-run",
            startedAtMs: BASE_TIME * 1000,
            provenance: makeProvenance("different-provenance"),
        });
        expect(refused).to.equal(null);
        for (const [relative, bytes] of before) expect(readFileSync(path.join(runDir, relative)).equals(bytes)).to.equal(true);
        const manifest = JSON.parse(readFileSync(path.join(runDir, "source-snapshot/manifest.json"), "utf8")) as any;
        expect(manifest.pairs[0].barCount).to.equal(3);
        expect(manifest.pairs[0].tradeCount).to.equal(0);
        expect(manifest.pairs[0].rowCount).to.equal(0);
        const emptyPairDir = path.join(runDir, "source-snapshot", "pairs", manifest.pairs[0].pairKey);
        expect(decodeJsonl(emptyPairDir + "/trades.jsonl.gz")).to.deep.equal([]);
        expect(decodeJsonl(emptyPairDir + "/entries.jsonl.gz")).to.deep.equal([]);
    });

    it("sorts manifest partitions by row start and rejects noncontiguous/repeated capture", async () => {
        const root = makeRoot();
        await writeExperimentFiles(root, 1);
        await writeFile(path.join(root, "ledger.jsonl"), `${JSON.stringify({ pair: "B+Q", baseSymbol: "B", quoteSymbol: "Q", direction: "long", signalTime: BASE_TIME + HOUR, signalBarIndex: 1 })}\n`, "utf8");
        const writer = new TradeLedgerSnapshotWriter({ runDir: root });
        await writer.capturePair({
            ...snapshotSource({
                identity: { pair: "B+Q", baseSymbol: "B", quoteSymbol: "Q" },
                entries: [[0, 1, "long", BASE_TIME + HOUR]],
                rowStart: 0,
            }),
        });
        await writer.capturePair({
            ...snapshotSource({
                identity: { pair: "A+Q", baseSymbol: "A", quoteSymbol: "Q" },
                entries: [],
                trades: [],
                rowStart: 1,
            }),
        });
        const result = await writer.finalize({
            ledgerComplete: true,
            ledgerRowCount: 1,
            ledgerPath: path.join(root, "ledger.jsonl"),
            provenancePath: path.join(root, "provenance.json"),
            summaryPath: path.join(root, "summary.json"),
            ranksPath: path.join(root, "signal-ranks.jsonl"),
        });
        expect(result.complete).to.equal(true);
        const manifest = JSON.parse(readFileSync(path.join(root, "source-snapshot/manifest.json"), "utf8")) as any;
        expect(manifest.pairs.map((item: any) => item.pair)).to.deep.equal(["B+Q", "A+Q"]);

        const repeatedRoot = makeRoot();
        await writeExperimentFiles(repeatedRoot, 1);
        const repeated = new TradeLedgerSnapshotWriter({ runDir: repeatedRoot });
        await repeated.capturePair(snapshotSource());
        await repeated.capturePair(snapshotSource());
        const repeatedResult = await repeated.finalize({
            ledgerComplete: true,
            ledgerRowCount: 2,
            ledgerPath: path.join(repeatedRoot, "ledger.jsonl"),
            provenancePath: path.join(repeatedRoot, "provenance.json"),
            summaryPath: path.join(repeatedRoot, "summary.json"),
            ranksPath: path.join(repeatedRoot, "signal-ranks.jsonl"),
        });
        expect(repeatedResult.complete).to.equal(false);
        expect(existsSync(path.join(repeatedRoot, "source-snapshot/manifest.json"))).to.equal(false);
    });

    it("keeps a complete legacy ledger checkable when snapshot I/O or mappings fail", async () => {
        const root = makeRoot();
        const writer = await TradeLedgerWriter.create({
            rootDir: root,
            folder: "runs",
            runId: "snapshot-failure",
            startedAtMs: BASE_TIME * 1000,
            provenance: makeProvenance("snapshot-failure"),
        });
        expect(writer).to.not.equal(null);
        await writer!.appendPairRows(
            { rows: [makeRow()], duplicatesCollapsed: 0, rightCensored: 0 },
            { pair: "BASE+QUOTE", data: [makeBars()[0]!, makeBars()[0]!], trades: [] },
        );
        const result = await writer!.finalize({ cancelled: false, finishedAtMs: BASE_TIME * 1000 + 1 });
        expect(result.ledgerComplete).to.equal(true);
        expect(result.snapshotComplete).to.equal(false);
        expect(result.snapshotError).to.match(/strictly increasing|unique/i);
        expect(JSON.parse(readFileSync(path.join(writer!.runDir, "summary.json"), "utf8")).ledgerComplete).to.equal(true);
        expect(JSON.parse(readFileSync(path.join(writer!.runDir, "summary.json"), "utf8")).lastError).to.include("source snapshot failed");
        expect(existsSync(path.join(writer!.runDir, "source-snapshot/error.json"))).to.equal(true);
        expect(existsSync(path.join(writer!.runDir, "source-snapshot/manifest.json"))).to.equal(false);

        const mappingRoot = makeRoot();
        await writeExperimentFiles(mappingRoot, 0);
        const mapping = new TradeLedgerSnapshotWriter({ runDir: mappingRoot });
        await mapping.capturePair({ ...snapshotSource({ trades: [makeTrade({ exitTime: BASE_TIME + 99 * HOUR as Time })], entries: [] }) });
        const mappingResult = await mapping.finalize({
            ledgerComplete: true,
            ledgerRowCount: 0,
            ledgerPath: path.join(mappingRoot, "ledger.jsonl"),
            provenancePath: path.join(mappingRoot, "provenance.json"),
            summaryPath: path.join(mappingRoot, "summary.json"),
            ranksPath: path.join(mappingRoot, "signal-ranks.jsonl"),
        });
        expect(mappingResult.error).to.match(/does not map/);
    });

    it("never publishes a complete snapshot for cancellation or a failed ledger append", async () => {
        const cancelledRoot = makeRoot();
        const cancelled = await TradeLedgerWriter.create({
            rootDir: cancelledRoot,
            folder: "runs",
            runId: "cancelled",
            startedAtMs: BASE_TIME * 1000,
            provenance: makeProvenance("cancelled"),
        });
        await cancelled!.appendPairRows(
            { rows: [makeRow()], duplicatesCollapsed: 0, rightCensored: 0 },
            { pair: "BASE+QUOTE", data: makeBars(), trades: [] },
        );
        const cancelledResult = await cancelled!.finalize({ cancelled: true, finishedAtMs: BASE_TIME * 1000 + 1 });
        expect(cancelledResult.snapshotComplete).to.equal(false);
        expect(existsSync(path.join(cancelled!.runDir, "source-snapshot/manifest.json"))).to.equal(false);
        const incompleteRoot = makeRoot();
        await writeExperimentFiles(incompleteRoot, 1);
        const incomplete = new TradeLedgerSnapshotWriter({ runDir: incompleteRoot });
        await incomplete.capturePair({ ...snapshotSource({ entries: [[0, 1, "long", BASE_TIME + HOUR]] }) });
        const incompleteResult = await incomplete.finalize({
            ledgerComplete: false,
            ledgerRowCount: 1,
            ledgerPath: path.join(incompleteRoot, "ledger.jsonl"),
            provenancePath: path.join(incompleteRoot, "provenance.json"),
            summaryPath: path.join(incompleteRoot, "summary.json"),
            ranksPath: path.join(incompleteRoot, "signal-ranks.jsonl"),
        });
        expect(incompleteResult.complete).to.equal(false);
        expect(existsSync(path.join(incompleteRoot, "source-snapshot/manifest.json"))).to.equal(false);

        const failedRoot = makeRoot();
        let firstAppend = true;
        const failed = await TradeLedgerWriter.create({
            rootDir: failedRoot,
            folder: "runs",
            runId: "append-failure",
            startedAtMs: BASE_TIME * 1000,
            provenance: makeProvenance("append-failure"),
            deps: {
                appendFile: (async (filePath: unknown) => {
                    if (firstAppend && String(filePath).endsWith("ledger.jsonl")) {
                        firstAppend = false;
                        throw new Error("append failed");
                    }
                }) as any,
            },
        });
        await failed!.appendPairRows(
            { rows: [makeRow()], duplicatesCollapsed: 0, rightCensored: 0 },
            { pair: "BASE+QUOTE", data: makeBars(), trades: [] },
        );
        const failedResult = await failed!.finalize({ cancelled: false, finishedAtMs: BASE_TIME * 1000 + 1 });
        expect(failedResult.ledgerComplete).to.equal(false);
        expect(failedResult.snapshotComplete).to.equal(false);
        expect(existsSync(path.join(failed!.runDir, "source-snapshot/manifest.json"))).to.equal(false);
        expect(existsSync(path.join(failed!.runDir, "source-snapshot"))).to.equal(false);
    });

    it("recovers a zero-row partition and records compressed and uncompressed metadata", async () => {
        const root = makeRoot();
        const writer = await TradeLedgerWriter.create({
            rootDir: root,
            folder: "runs",
            runId: "recovery-zero",
            startedAtMs: BASE_TIME * 1000,
            provenance: makeProvenance("recovery-zero"),
        });
        expect(writer).to.not.equal(null);
        await writer!.appendPairRows(
            { rows: [], duplicatesCollapsed: 0, rightCensored: 0 },
            { pair: "BASE+QUOTE", data: makeBars(), trades: [], baseSymbol: "BASE", quoteSymbol: "QUOTE" },
        );
        await writeFile(path.join(writer!.runDir, "summary.json"), JSON.stringify({ ledgerComplete: true, cancelled: false }), "utf8");
        const esno = path.resolve(process.cwd(), "../../../node_modules/esno/esno.js");
        const script = path.resolve(process.cwd(), "scripts/trade-ledger-snapshot-recover.ts");
        const recovered = spawnSync(process.execPath, [esno, script, writer!.runDir], { encoding: "utf8" });
        expect(recovered.status, recovered.stderr).to.equal(0);
        const manifest = JSON.parse(readFileSync(path.join(writer!.runDir, "source-snapshot/manifest.json"), "utf8")) as any;
        expect(manifest.pairs).to.have.length(1);
        expect(manifest.pairs[0].rowCount).to.equal(0);
        expect(manifest.pairs[0].files.bars.uncompressedBytes).to.be.greaterThan(0);
        expect(manifest.pairs[0].files.entries.uncompressedBytes).to.equal(0);
    });
});

async function expectPromise(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
    try {
        await promise;
        expect.fail("expected promise to reject");
    } catch (error) {
        expect(String(error)).to.match(pattern);
    }
}
