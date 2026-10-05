import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearParsedIbkrCsvCache,
    loadFreshIbkrCandlesFromDisk,
    parseIbkrCsvPayload,
    getParsedIbkrDailyCacheStats,
    __testInternals,
} from "../lib/batch-backtest/server-ibkr-csv-loader";
import { resolveServerBatchCacheBudget } from "../lib/batch-backtest/server-batch-cache-budget";
import { extractCandlesFromCsvPayload } from "../lib/candle-cache";
import { runAssetSwitchReplay } from "../lib/batch-backtest/open-score-replay/asset-switch";
import { replayArmFields, type ReplayArmResults } from "../lib/batch-backtest/open-score-replay/arm-contract";
import { normalizeTradFiDailyCandles } from "../lib/data/data-interval-utils";
import type { OHLCVData } from "../lib/types/strategies";

const CSV = [
    "time,open,high,low,close,volume",
    "2025-01-02T14:30:00.000Z,100,102,99,101,1000",
    "2025-01-02T15:00:00.000Z,101,103,100,102,1100",
    "",
].join("\n");

async function main(): Promise<void> {
    const tanhBaseDir = mkdtempSync(join(tmpdir(), "server-ibkr-tanh-placeholder-"));
    try {
        const csvDir = join(tanhBaseDir, "price-data", "ibkr", "csv", "1d");
        mkdirSync(csvDir, { recursive: true });
        const csvPath = join(csvDir, "TANH.csv");
        const csv = [
            "time,open,high,low,close,volume",
            "2026-09-03T04:00:00.000Z,12.89,20.5,12.7,18.48,7598",
            "2026-09-04T04:00:00.000Z,0.3696,0.3696,0.3696,0.3696,0",
            "2026-09-08T04:00:00.000Z,18.585,20,18.425,19.99,7674",
            "2026-09-09T04:00:00.000Z,19.1,19.1,19.1,19.1,241",
            "",
        ].join("\n");
        writeFileSync(csvPath, csv);
        // Seed a valid v1 sidecar containing the bad bar, matching current CSV
        // stat metadata. A process restart must rebuild it under the new rule.
        const raw = parseIbkrCsvPayload(csv);
        const oldSidecar = Buffer.alloc(32 + raw.length * 6 * 8);
        oldSidecar.write("IBSC");
        oldSidecar.writeUInt32LE(1, 4);
        oldSidecar.writeUInt32LE(raw.length, 8);
        const csvStat = statSync(csvPath);
        oldSidecar.writeDoubleLE(csvStat.mtimeMs, 16);
        oldSidecar.writeDoubleLE(csvStat.size, 24);
        const keys = ["time", "open", "high", "low", "close", "volume"] as const;
        keys.forEach((key, col) => raw.forEach((bar, row) => {
            oldSidecar.writeDoubleLE(Number(bar[key]), 32 + (col * raw.length + row) * 8);
        }));
        const sidecarDir = join(tanhBaseDir, "price-data", "ibkr", "seed-cache", "1d");
        mkdirSync(sidecarDir, { recursive: true });
        const sidecarPath = join(sidecarDir, "TANH.csv.bin");
        writeFileSync(sidecarPath, oldSidecar);
        clearParsedIbkrCsvCache();
        const symbol = "TANH\u2022";
        const load = () => loadFreshIbkrCandlesFromDisk(symbol, "1d", undefined, tanhBaseDir);
        const loaded = await load();
        assert.deepEqual(loaded!.map(bar => bar.open), [12.89, 18.585, 19.1]);
        assert.equal(readFileSync(sidecarPath).readUInt32LE(4), 2, "pre-filter sidecar must rebuild");
        assert.deepEqual(await load(), loaded, "warm column cache stays filtered");
        clearParsedIbkrCsvCache();
        assert.deepEqual(await load(), loaded, "new sidecar stays filtered after restart");
        const sec = (day: string) => Date.parse(`${day}T00:00:00Z`) / 1000;
        const emptyPicks = Object.fromEntries(replayArmFields().map(arm => [arm, null])) as ReplayArmResults<number | null>;
        const replay = (loadTanh: () => Promise<OHLCVData[] | null>, switchDay: string) => runAssetSwitchReplay({
            views: [{ timeSec: sec("2026-09-03"), picks: { ...emptyPicks, topMean: 0 } },
                { timeSec: sec(switchDay), picks: { ...emptyPicks, topMean: 1 } }],
            assetNames: [symbol, "AAPL\u2022"], pairCount: 1, assetCount: 2,
            slippageRate: 0.0002, commissionRate: 0,
            options: { mode: "asset_switch", interval: "1d", sampleFromSec: sec("2026-09-03"),
                sampleToSec: sec("2026-09-10"), evaluationCutoffSec: sec("2026-09-11"),
                includeEventDetails: true, loadTargetDataset: asset => asset === symbol ? loadTanh() : Promise.resolve([
                    { time: sec("2026-09-08") as OHLCVData["time"], open: 100, high: 100, low: 100, close: 100, volume: 100 },
                    { time: sec("2026-09-09") as OHLCVData["time"], open: 100, high: 100, low: 100, close: 100, volume: 100 },
                ]) },
            shouldStop: () => false, onPhase: () => undefined,
        });
        const before = await replay(async () => normalizeTradFiDailyCandles(raw, "1d"), "2026-09-04");
        assert.ok(before.ok);
        if (!before.ok) throw new Error("Replay interrupted");
        const phantom = before.result.trades!.find(row => row.asset === symbol)!;
        assert.equal(phantom.netPnl!.toFixed(2), "49263.98", "reproduce the reported phantom trade exactly");
        assert.equal((phantom.entryCost + phantom.exitCost).toFixed(2), "10.25");
        const after = await replay(load, "2026-09-04");
        assert.ok(after.ok);
        if (!after.ok) throw new Error("Replay interrupted");
        assert.equal(after.result.trades!.some(row => row.asset === symbol), false,
            "the same decisions cancel the unfilled TANH order before its next traded candle");
        const result = await replay(load, "2026-09-08");
        assert.ok(result.ok);
        if (!result.ok) throw new Error("Replay interrupted");
        const trade = result.result.trades!.find(row => row.arm === "topMean")!;
        assert.equal(trade.entryTimeSec, sec("2026-09-08"));
        assert.equal(trade.entryPrice, 18.585 * 1.0002);
        assert.equal(result.result.arms.topMean.completedTrades, 1);
        assert.ok(Math.abs(result.result.arms.topMean.realizedNetPnl!) < 100,
            "TANH cannot produce a $49k phantom profit from the untraded split-day price");
    } finally {
        clearParsedIbkrCsvCache();
        rmSync(tanhBaseDir, { recursive: true, force: true });
    }

    const pointCache = new __testInternals.PointBoundedParsedCache(5);
    const entry = (n: number) => ({ mtimeMs: 1, columns: {
        time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n),
        low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n),
    } });
    pointCache.set("A", entry(2)); pointCache.set("B", entry(2));
    const recent = pointCache.get("A")!; pointCache.delete("A"); pointCache.set("A", recent);
    pointCache.set("C", entry(2));
    assert.deepEqual([...pointCache.keys()], ["A", "C"], "point pressure evicts least recently used columns");
    assert.equal(pointCache.points, 4);
    pointCache.set("A", entry(4));
    assert.deepEqual([...pointCache.keys()], ["A"], "replacement subtracts previous points before eviction");
    assert.equal(pointCache.points, 4);
    pointCache.set("oversized", entry(6));
    assert.equal(pointCache.points, 0, "one oversized series cannot exceed the memory budget");
    assert.equal(pointCache.size, 0);
    pointCache.set("A", entry(1)); pointCache.clear();
    assert.equal(pointCache.points, 0, "clear resets point accounting");
    const parsed = parseIbkrCsvPayload(CSV);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.open, 100);
    assert.equal(parsed[1]!.volume, 1100);
    assert.deepEqual(
        parsed,
        extractCandlesFromCsvPayload(CSV),
        "canonical fast parsing must preserve the shared parser's candle contract",
    );

    const baseDir = mkdtempSync(join(tmpdir(), "server-ibkr-loader-"));
    try {
        const csvDir = join(baseDir, "price-data", "ibkr", "csv", "30m");
        mkdirSync(csvDir, { recursive: true });
        writeFileSync(join(csvDir, "AAPL.csv"), CSV, "utf8");
        const loaded = await loadFreshIbkrCandlesFromDisk("AAPL\u2022", "30m", undefined, baseDir);
        assert.deepEqual(loaded, parsed, "server workers read authoritative IBKR CSVs directly from disk");
    } finally {
        rmSync(baseDir, { recursive: true, force: true });
    }

    assert.deepEqual(resolveServerBatchCacheBudget(16 * 1024 ** 3), {
        legCacheMaxEntries: 24,
        pairCacheMaxEntries: 16,
    });
    assert.deepEqual(resolveServerBatchCacheBudget(64 * 1024 ** 3), {
        legCacheMaxEntries: 128,
        pairCacheMaxEntries: 32,
    });

    const dailyBaseDir = mkdtempSync(join(tmpdir(), "server-ibkr-daily-working-set-"));
    const dailyCsv = CSV.replace("2025-01-02T14:30", "2025-01-02T00:00").replace("2025-01-02T15:00", "2025-01-03T00:00");
    try {
        const csvDir = join(dailyBaseDir, "price-data", "ibkr", "csv", "1d");
        mkdirSync(csvDir, { recursive: true });
        clearParsedIbkrCsvCache();
        let firstDaily: Awaited<ReturnType<typeof loadFreshIbkrCandlesFromDisk>> = null;
        for (let i = 0; i < 514; i++) {
            const path = join(csvDir, `DAILY${i}.csv`);
            writeFileSync(path, dailyCsv, "utf8"); utimesSync(path, 1800000000, 1800000000);
            const data = await loadFreshIbkrCandlesFromDisk(`DAILY${i}\u2022`, "1d", undefined, dailyBaseDir);
            if (i === 0) firstDaily = data;
        }
        const firstPath = join(csvDir, "DAILY0.csv");
        writeFileSync(firstPath, dailyCsv.replace("100,102,99,101,1000", "900,902,899,901,1000"), "utf8");
        utimesSync(firstPath, 1800000000, 1800000000);
        rmSync(join(dailyBaseDir, "price-data", "ibkr", "seed-cache", "1d", "DAILY0.csv.bin"));
        const warm = await loadFreshIbkrCandlesFromDisk("DAILY0\u2022", "1d", undefined, dailyBaseDir);
        assert.deepEqual(warm, firstDaily, "daily targets retain a working set larger than the old 512-entry cache");
        assert.equal(getParsedIbkrDailyCacheStats().hits, 1);
        assert.equal(getParsedIbkrDailyCacheStats().misses, 514);
        utimesSync(firstPath, 1800000001, 1800000001);
        const fresh = await loadFreshIbkrCandlesFromDisk("DAILY0\u2022", "1d", undefined, dailyBaseDir);
        assert.equal(fresh![0]!.open, 900, "CSV sync invalidates retained daily columns");
        clearParsedIbkrCsvCache();
        assert.equal(getParsedIbkrDailyCacheStats().points, 0);
        assert.equal(getParsedIbkrDailyCacheStats().entries, 0);
    } finally {
        clearParsedIbkrCsvCache(); rmSync(dailyBaseDir, { recursive: true, force: true });
    }

    // ---- parsed-CSV cache behavior ----
    // Intent: a 1000-pair Asset Opportunity run touches ~500 unique IBKR legs.
    // The in-memory SyntheticLegCache (128 entries) overflows, causing repeated
    // CSV re-parses. The parsed-CSV cache sits below the leg cache and prevents
    // re-parsing the same file within a run. It invalidates on mtime change
    // (IBKR sync rewrites the seed) and is cleared by `clearParsedIbkrCsvCache`.
    const cacheBaseDir = mkdtempSync(join(tmpdir(), "server-ibkr-csv-cache-"));
    try {
        const cacheCsvDir = join(cacheBaseDir, "price-data", "ibkr", "csv", "30m");
        mkdirSync(cacheCsvDir, { recursive: true });
        const csvPath = join(cacheCsvDir, "MSFT.csv");
        writeFileSync(csvPath, CSV, "utf8");

        clearParsedIbkrCsvCache();
        const first = await loadFreshIbkrCandlesFromDisk("MSFT\u2022", "30m", undefined, cacheBaseDir);
        assert.equal(first!.length, 2, "first load parses and returns candles");

        // Second call with unchanged mtime → cache hit (same candle array).
        const second = await loadFreshIbkrCandlesFromDisk("MSFT\u2022", "30m", undefined, cacheBaseDir);
        assert.deepEqual(second, first, "cache hit returns the same candles without re-parsing");

        // Bump mtime → cache miss → re-parse (simulates IBKR sync rewriting the seed).
        const newCsv = [
            "time,open,high,low,close,volume",
            "2025-01-02T14:30:00.000Z,200,202,199,201,2000",
            "",
        ].join("\n");
        writeFileSync(csvPath, newCsv, "utf8");
        const futureMs = Date.now() * 2;
        utimesSync(csvPath, futureMs / 1000, futureMs / 1000);
        const afterSync = await loadFreshIbkrCandlesFromDisk("MSFT\u2022", "30m", undefined, cacheBaseDir);
        assert.equal(afterSync![0]!.open, 200, "mtime change invalidates the cache and re-parses");

        // Explicit clear → next call re-parses.
        clearParsedIbkrCsvCache();
        const afterClear = await loadFreshIbkrCandlesFromDisk("MSFT\u2022", "30m", undefined, cacheBaseDir);
        assert.equal(afterClear![0]!.open, 200, "clear forces re-parse but content is unchanged");
    } finally {
        rmSync(cacheBaseDir, { recursive: true, force: true });
    }

    // ---- disk-backed parsed-seed sidecar ----
    // Intent: large TOP_MEAN runs give each worker a working set of thousands
    // of distinct seeds; the 512-entry in-memory parse cache thrashes, so
    // every revisit re-parses the CSV text (~70–140 ms each). The sidecar
    // persists the parsed columns on disk keyed by the CSV (mtimeMs, size),
    // so one parse amortizes across all worker processes and later runs.
    const sidecarBaseDir = mkdtempSync(join(tmpdir(), "server-ibkr-seed-sidecar-"));
    try {
        const sidecarCsvDir = join(sidecarBaseDir, "price-data", "ibkr", "csv", "30m");
        mkdirSync(sidecarCsvDir, { recursive: true });
        const sidecarCsvPath = join(sidecarCsvDir, "TSLA.csv");
        const sidecarPath = join(sidecarBaseDir, "price-data", "ibkr", "seed-cache", "30m", "TSLA.csv.bin");
        writeFileSync(sidecarCsvPath, CSV, "utf8");
        // Integer-second mtimes keep the (mtimeMs, size) sidecar key exact.
        utimesSync(sidecarCsvPath, 1800000000, 1800000000);

        clearParsedIbkrCsvCache();
        const first = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir);
        assert.equal(first!.length, 2, "first load parses the CSV text");
        assert.ok(existsSync(sidecarPath), "first text parse writes the columnar sidecar");

        // Same-length content rewrite with the original mtime restored: the
        // sidecar (mtimeMs, size) key still matches, so the OLD columns must
        // be served without re-parsing the CSV text.
        clearParsedIbkrCsvCache();
        writeFileSync(sidecarCsvPath, CSV.replace("100,102,99,101,1000", "900,102,99,101,1000"), "utf8");
        utimesSync(sidecarCsvPath, 1800000000, 1800000000);
        const fromSidecar = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir);
        assert.equal(fromSidecar![0]!.open, 100, "sidecar hit serves cached columns without re-parsing the CSV");

        // Removing the regenerable sidecar must not force another text parse
        // while unchanged CSV metadata still validates the warm memory entry.
        rmSync(sidecarPath, { force: true });
        const warmSidecar = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir);
        assert.deepEqual(warmSidecar, fromSidecar, "sidecar hits populate the bounded parsed-column LRU");

        // mtime bump → sidecar invalid → re-parse picks up the new content.
        const sidecarFutureMs = Date.now() * 2;
        utimesSync(sidecarCsvPath, sidecarFutureMs / 1000, sidecarFutureMs / 1000);
        const afterSync = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir);
        assert.equal(afterSync![0]!.open, 900, "mtime change invalidates the sidecar and re-parses");

        // Tail materialization from sidecar columns matches the full-series slice.
        clearParsedIbkrCsvCache();
        const full = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir);
        const tail = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, 1);
        assert.deepEqual(tail, full!.slice(-1), "limitBars tail materialization matches the full-series tail");

        // A cold TEXT parse ignores limitBars and returns the full parsed
        // series; the routing layer applies its final limit to that result.
        clearParsedIbkrCsvCache();
        rmSync(sidecarPath, { force: true });
        const coldLimited = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, 1);
        assert.deepEqual(coldLimited, full, "cold text reads return the full series even with a bar limit");
        // Warm hits materialize the requested bounds; a zero limit reads none.
        assert.deepEqual(await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, 0), []);
        assert.deepEqual(await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, 99), full);
        // Invalid limits keep the loader's baseline contract: the out-of-range
        // tail start throws and the loader converts that to null rather than a
        // silent empty read. The failed read must not poison the warm cache.
        assert.equal(
            await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, -1),
            null,
            "negative finite limit on a warm-cache read returns null",
        );
        assert.equal(
            await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, Number.NEGATIVE_INFINITY),
            null,
            "negative-infinite limit on a warm-cache read returns null",
        );
        assert.deepEqual(await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir), full,
            "a valid read after invalid limits still serves the cached columns");
        // A sidecar hit with a cold memory cache still materializes the tail.
        clearParsedIbkrCsvCache();
        const sidecarTail = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, 1);
        assert.deepEqual(sidecarTail, full!.slice(-1), "sidecar hits materialize the requested tail");
        // Sidecar reads enforce the same invalid-limit contract.
        clearParsedIbkrCsvCache();
        assert.equal(
            await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, -1),
            null,
            "negative finite limit on a sidecar read returns null",
        );
        clearParsedIbkrCsvCache();
        assert.equal(
            await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir, Number.NEGATIVE_INFINITY),
            null,
            "negative-infinite limit on a sidecar read returns null",
        );
        assert.deepEqual(await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir), full,
            "a valid read after invalid sidecar reads still serves the columns");
        // Returned candles are fresh objects: mutating a hit never leaks into
        // the cached columns or the next materialization.
        sidecarTail![0]!.close = -1;
        assert.deepEqual(
            await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir),
            full,
            "mutating a materialized tail must not poison the cached columns",
        );

        // Corrupt sidecar → fall back to the authoritative CSV parse.
        writeFileSync(sidecarPath, Buffer.alloc(10));
        clearParsedIbkrCsvCache();
        const afterCorruption = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir);
        assert.deepEqual(afterCorruption, full, "corrupt sidecar falls back to the CSV text parse");

        // Kill switch: no sidecar reads or writes.
        process.env.IBKR_CSV_SEED_CACHE = "0";
        rmSync(sidecarPath, { force: true });
        clearParsedIbkrCsvCache();
        const disabled = await loadFreshIbkrCandlesFromDisk("TSLA\u2022", "30m", undefined, sidecarBaseDir);
        assert.deepEqual(disabled, full, "kill switch serves from the CSV text parse");
        assert.ok(!existsSync(sidecarPath), "kill switch prevents sidecar writes");
        delete process.env.IBKR_CSV_SEED_CACHE;
    } finally {
        rmSync(sidecarBaseDir, { recursive: true, force: true });
    }

    console.log("PASS: server-ibkr-csv-loader.spec.ts");
}

main().catch((error) => {
    console.error("FAIL: server-ibkr-csv-loader.spec.ts", error);
    process.exit(1);
});
