import { clearLocalDailyAssetCaches } from "./local-daily-datasets";
import { dataManager } from "./data-manager";
import { finderManager } from "./finder-manager";
import { clearBatchDatasetCaches } from "./batch-backtest/batch-backtest-loader";
import { clearRankPairsRecentLoaderCache } from "./rank-pairs/rank-pairs-recent-loader";

/** Invalidate every browser cache that can retain locally synced market data. */
export async function invalidateLocalMarketData(
    symbols: readonly string[],
    interval: unknown,
): Promise<void> {
    if (symbols.length === 0) return;
    const normalizedInterval = String(interval ?? "").trim().toLowerCase();
    clearLocalDailyAssetCaches();
    dataManager.invalidateLocalSeries(symbols, normalizedInterval ? [normalizedInterval] : undefined);
    await finderManager.invalidateLocalDataCaches();
    clearBatchDatasetCaches();
    clearRankPairsRecentLoaderCache();
}
