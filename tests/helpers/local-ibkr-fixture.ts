import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clearServerBatchDatasetCaches } from "../../lib/batch-backtest/server-batch-data-loader";
import { clearParsedIbkrCsvCache } from "../../lib/batch-backtest/server-ibkr-csv-loader";
import { clearServerFinderDatasetCaches } from "../../lib/finder/server/server-finder-data-loader";
import type { OHLCVData } from "../../lib/types/strategies";

/** Runs serially within a spec: server loaders resolve their local CSV root from cwd. */
export async function withLocalIbkrFixture(
    interval: string,
    series: Record<string, readonly OHLCVData[]>,
    run: () => Promise<void>,
): Promise<void> {
    const root = mkdtempSync(join(tmpdir(), "ibkr-spec-"));
    const originalCwd = process.cwd();
    const originalFetch = globalThis.fetch;
    let networkRequests = 0;
    const clearCaches = () => {
        clearServerBatchDatasetCaches();
        clearServerFinderDatasetCaches();
        clearParsedIbkrCsvCache();
    };
    try {
        const csvDir = join(root, "price-data", "ibkr", "csv", interval);
        mkdirSync(csvDir, { recursive: true });
        for (const [asset, bars] of Object.entries(series)) {
            const rows = bars.map(({ time, open, high, low, close, volume }) =>
                [time, open, high, low, close, volume].join(","));
            writeFileSync(join(csvDir, `${asset}.csv`), `time,open,high,low,close,volume\n${rows.join("\n")}\n`);
        }
        process.chdir(root);
        clearCaches();
        globalThis.fetch = async () => {
            networkRequests += 1;
            throw new Error("Unexpected network request in local IBKR fixture");
        };
        await run();
        assert.equal(networkRequests, 0, "local loader specs must never request remote data");
    } finally {
        globalThis.fetch = originalFetch;
        process.chdir(originalCwd);
        clearCaches();
        rmSync(root, { recursive: true, force: true });
    }
}
