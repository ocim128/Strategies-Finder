import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
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
    console.log("PASS: server-ibkr-csv-loader.spec.ts");
}

main().catch((error) => {
    console.error("FAIL: server-ibkr-csv-loader.spec.ts", error);
    process.exit(1);
});
