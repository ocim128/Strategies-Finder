import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearServerBatchDatasetCaches } from "../../lib/batch-backtest/server-batch-data-loader";
import { clearParsedIbkrCsvCache } from "../../lib/batch-backtest/server-ibkr-csv-loader";
import { clearParsedCryptoCsvCache } from "../../lib/batch-backtest/server-crypto-csv-loader";
import { clearServerFinderDatasetCaches } from "../../lib/finder/server/server-finder-data-loader";
import type { OHLCVData } from "../../lib/types/strategies";

/**
 * Mirrors {@link withLocalIbkrFixture} for synced crypto CSVs. `run` receives
 * the fixture's CSV directory so tests can rewrite a series between reads
 * (mtime invalidation). Runs serially within a spec: server loaders resolve
 * their local CSV root from cwd.
 */
export async function withLocalCryptoFixture(
    interval: string,
    series: Record<string, readonly OHLCVData[]>,
    run: (context: { csvDir: string }) => Promise<void>,
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "crypto-spec-"));
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    const clearCaches = () => {
        clearServerBatchDatasetCaches();
        clearServerFinderDatasetCaches();
        clearParsedIbkrCsvCache();
        clearParsedCryptoCsvCache();
    };
    try {
        const csvDir = join(root, "price-data", "crypto", "csv", interval);
        mkdirSync(csvDir, { recursive: true });
        for (const [symbol, bars] of Object.entries(series)) {
            writeCryptoCsv(csvDir, symbol, bars);
        }
        process.chdir(root);
        clearCaches();
        globalThis.fetch = async () => {
            networkRequests += 1;
            throw new Error("Unexpected network request in local crypto fixture");
        };
        await run({ csvDir });
        assert.equal(networkRequests, 0, "local loader specs must never request remote data");
    } finally {
        globalThis.fetch = originalFetch;
        process.chdir(originalCwd);
        clearCaches();
        rmSync(root, { recursive: true, force: true });
    }
}

export function writeCryptoCsv(csvDir: string, symbol: string, bars: readonly OHLCVData[]): void {
    const rows = bars.map(({ time, open, high, low, close, volume }) =>
        [time, open, high, low, close, volume].join(","));
    writeFileSync(join(csvDir, `${symbol}.csv`), `time,open,high,low,close,volume\n${rows.join("\n")}\n`);
}
