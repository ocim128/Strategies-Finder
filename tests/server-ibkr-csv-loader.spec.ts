import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
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

const CSV = [
    "time,open,high,low,close,volume",
    "2025-01-02T14:30:00.000Z,100,102,99,101,1000",
    "2025-01-02T15:00:00.000Z,101,103,100,102,1100",
    "",
].join("\n");

async function main(): Promise<void> {
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
