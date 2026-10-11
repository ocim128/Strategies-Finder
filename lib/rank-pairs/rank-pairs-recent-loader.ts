import { dataManager } from "../data-manager";
import {
    createRankPairsRecentLoader,
} from "./rank-pairs-recent-loader-core";

export type { RankPairsRecentLoaderStats } from "./rank-pairs-recent-loader-core";

const loader = createRankPairsRecentLoader(
    (symbol, interval, bars, options) =>
        dataManager.fetchHistoricalData(symbol, interval, bars, options),
);

export function clearRankPairsRecentLoaderCache(): void {
    loader.clear();
}
