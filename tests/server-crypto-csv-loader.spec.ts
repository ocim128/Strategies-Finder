import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    clearParsedCryptoCsvCache,
    loadFreshCryptoCandlesFromDisk,
} from "../lib/batch-backtest/server-crypto-csv-loader";

const CSV = [
    "time,open,high,low,close,volume",
    "2025-01-02T14:30:00.000Z,100,102,99,101,1000",
    "2025-01-02T15:00:00.000Z,101,103,100,102,1100",
    "",
].join("\n");

async function main(): Promise<void> {
    const baseDir = mkdtempSync(join(tmpdir(), "server-crypto-csv-loader-"));
    try {
        const csvDir = join(baseDir, "price-data", "crypto", "csv", "30m");
        mkdirSync(csvDir, { recursive: true });
        writeFileSync(join(csvDir, "BTCUSDT.csv"), CSV, "utf8");

        clearParsedCryptoCsvCache();
        const first = await loadFreshCryptoCandlesFromDisk("BTCUSDT", "30m", undefined, baseDir);
        assert.equal(first?.length, 2);
        assert.equal(first?.[0]?.open, 100);
        assert.equal(first?.[1]?.volume, 1100);

        const second = await loadFreshCryptoCandlesFromDisk("BTCUSDT", "30m", undefined, baseDir);
        assert.strictEqual(second, first, "unchanged crypto CSV should use the parsed cache");

        const filePath = join(csvDir, "BTCUSDT.csv");
        writeFileSync(filePath, CSV.replace(",100,102,99,101,1000", ",200,202,199,201,1000"), "utf8");
        const future = (Date.now() + 60_000) / 1000;
        utimesSync(filePath, future, future);
        const refreshed = await loadFreshCryptoCandlesFromDisk("BTCUSDT", "30m", undefined, baseDir);
        assert.notStrictEqual(refreshed, first, "rewritten crypto CSV must invalidate the parsed cache");
        assert.equal(refreshed?.[0]?.open, 200);

        assert.equal(
            await loadFreshCryptoCandlesFromDisk("MISSINGUSDT", "30m", undefined, baseDir),
            null,
            "missing crypto CSV should fall back to the existing SQLite/network loader",
        );
        assert.equal(
            await loadFreshCryptoCandlesFromDisk("BTCUSDT", "30m@spot", undefined, baseDir),
            refreshed,
            "interval decorations should resolve to the stored crypto timeframe",
        );
    } finally {
        clearParsedCryptoCsvCache();
        rmSync(baseDir, { recursive: true, force: true });
    }

    console.log("PASS: server-crypto-csv-loader.spec.ts");
}

main().catch((error) => {
    console.error("FAIL: server-crypto-csv-loader.spec.ts", error);
    process.exit(1);
});
