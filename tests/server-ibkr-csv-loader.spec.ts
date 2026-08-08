import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
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

    console.log("PASS: server-ibkr-csv-loader.spec.ts");
}

main().catch((error) => {
    console.error("FAIL: server-ibkr-csv-loader.spec.ts", error);
    process.exit(1);
});
