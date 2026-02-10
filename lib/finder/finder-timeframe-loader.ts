import { dataManager } from "../data-manager";
import { debugLogger } from "../debug-logger";
import type { OHLCVData } from "../types/strategies";
import type { FinderOptions } from "../types/finder";

export interface FinderDataset {
    interval: string;
    data: OHLCVData[];
}

export interface FinderTimeframeContext {
    currentSymbol: string;
    currentInterval: string;
    currentData: OHLCVData[];
}

interface CachedDataset {
    data: OHLCVData[];
    cachedAt: number;
}

export class FinderTimeframeLoader {
    private static readonly CACHE_TTL_MS = 30_000;
    private cache: Map<string, CachedDataset> = new Map();

    constructor(private readonly maxTimeframes: number) {}

    public clearCache(): void {
        this.cache.clear();
    }

    public normalizeInterval(rawInterval: string): string | null {
        const raw = rawInterval.trim();
        const match = raw.match(/^(\d+)\s*([mhdwM])$/);
        if (!match) return null;
        const value = parseInt(match[1], 10);
        if (!Number.isFinite(value) || value <= 0) return null;

        const unit = match[2] === "M" ? "M" : match[2].toLowerCase();
        return `${value}${unit}`;
    }

    public getFinderTimeframesForRun(options: FinderOptions, fallbackInterval: string): string[] {
        if (!options.multiTimeframeEnabled) return [fallbackInterval];

        const deduped: string[] = [];
        const intervals = options.timeframes ?? [];
        for (const interval of intervals) {
            const normalized = this.normalizeInterval(interval);
            if (!normalized) continue;
            if (!deduped.includes(normalized)) {
                deduped.push(normalized);
            }
            if (deduped.length >= this.maxTimeframes) break;
        }

        return deduped.length > 0 ? deduped : [fallbackInterval];
    }

    public async loadMultiTimeframeDatasets(
        symbol: string,
        intervals: string[],
        context: FinderTimeframeContext
    ): Promise<FinderDataset[]> {
        const deduped = Array.from(new Set(intervals));
        const datasetsByInterval = new Map<string, FinderDataset>();
        const missingIntervals: string[] = [];

        for (const interval of deduped) {
            const cached = this.getCachedDataset(symbol, interval);
            if (cached) {
                datasetsByInterval.set(interval, { interval, data: cached });
                continue;
            }
            missingIntervals.push(interval);
        }

        const currentIntervalInList = deduped.includes(context.currentInterval);
        if (currentIntervalInList && context.currentSymbol === symbol && context.currentData.length > 0) {
            datasetsByInterval.set(context.currentInterval, { interval: context.currentInterval, data: context.currentData });
            this.setCachedDataset(symbol, context.currentInterval, context.currentData);
        }

        const trulyMissing = missingIntervals.filter((interval) => !datasetsByInterval.has(interval));
        if (trulyMissing.length > 0) {
            const fetchResults = await Promise.allSettled(
                trulyMissing.map(async (interval) => {
                    const data = await dataManager.fetchData(symbol, interval);
                    return { interval, data };
                })
            );

            for (const result of fetchResults) {
                if (result.status !== "fulfilled") {
                    continue;
                }
                const { interval, data } = result.value;
                if (data.length === 0) {
                    debugLogger.warn(`[Finder] Skipping timeframe ${interval} - no data returned.`);
                    continue;
                }
                this.setCachedDataset(symbol, interval, data);
                datasetsByInterval.set(interval, { interval, data });
            }
        }

        return deduped
            .map((interval) => datasetsByInterval.get(interval))
            .filter((dataset): dataset is FinderDataset => !!dataset);
    }

    private getDatasetCacheKey(symbol: string, interval: string): string {
        return `${symbol}|${interval}`;
    }

    private getCachedDataset(symbol: string, interval: string): OHLCVData[] | null {
        const key = this.getDatasetCacheKey(symbol, interval);
        const cached = this.cache.get(key);
        if (!cached || cached.data.length === 0) return null;
        if ((Date.now() - cached.cachedAt) > FinderTimeframeLoader.CACHE_TTL_MS) {
            this.cache.delete(key);
            return null;
        }
        return cached.data;
    }

    private setCachedDataset(symbol: string, interval: string, data: OHLCVData[]): void {
        const key = this.getDatasetCacheKey(symbol, interval);
        this.cache.set(key, { data, cachedAt: Date.now() });
    }
}
