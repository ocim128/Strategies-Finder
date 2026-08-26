import { dataManager } from "../data-manager";
import type { OHLCVData } from "../types/strategies";
import {
    createRankPairsRecentLoader,
    type RankPairsRecentLoaderStats,
} from "./rank-pairs-recent-loader-core";

export type { RankPairsRecentLoaderStats } from "./rank-pairs-recent-loader-core";

const loader = createRankPairsRecentLoader(
    (symbol, interval, bars, options) =>
        dataManager.fetchHistoricalData(symbol, interval, bars, options),
);

export function getRankPairsRecentLoaderStats(): RankPairsRecentLoaderStats {
    return loader.getStats();
}

export function clearRankPairsRecentLoaderCache(): void {
    loader.clear();
}

/**
 * Return only the latest 200 synthetic ratio closes. `null` means the token is
 * not a synthetic pair and the caller should use the normal Batch loader.
 */
export async function loadRecentRankPairDataset(
    symbol: string,
    interval: string,
    signal?: AbortSignal,
    targetBars?: number,
): Promise<OHLCVData[] | null> {
    return loader.load(symbol, interval, signal, targetBars);
}
