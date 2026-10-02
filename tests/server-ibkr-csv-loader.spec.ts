import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearParsedIbkrCsvCache,
    loadFreshIbkrCandlesFromDisk,
    parseIbkrCsvPayload,
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
