import type { DataProvider } from "./types/data-providers";
import { fetchAndConsumeWithTimeoutAndRetry } from "./dataProviders/fetch-helpers";

export type LocalDailyDatasetKey = "ibkr-stock";

export const IBKR_SYMBOL_SUFFIX = "\u2022";

export function markIbkrSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return normalized;
    return normalized.endsWith(IBKR_SYMBOL_SUFFIX)
        ? normalized
        : `${normalized}${IBKR_SYMBOL_SUFFIX}`;
}

export function isIbkrSymbol(symbol: string): boolean {
    return symbol.trim().endsWith(IBKR_SYMBOL_SUFFIX);
}

export function stripIbkrMarker(symbol: string): string {
    const trimmed = symbol.trim();
    return trimmed.endsWith(IBKR_SYMBOL_SUFFIX)
        ? trimmed.slice(0, -IBKR_SYMBOL_SUFFIX.length).toUpperCase()
        : trimmed.toUpperCase();
}

export interface LocalDailyDatasetConfig {
    key: LocalDailyDatasetKey;
    label: string;
    catalogUrl: string;
    candlesBasePath: string;
    supportedIntervals?: readonly string[];
    provider: Extract<DataProvider, "ibkr-local">;
}

export interface LocalDailyAsset {
    symbol: string;
    name: string;
    dataset: LocalDailyDatasetKey;
    datasetLabel: string;
    provider: Extract<DataProvider, "ibkr-local">;
    sector?: string;
}

type LocalPriceDataCatalogResponse = {
    assets?: Array<{ symbol?: unknown; name?: unknown; sector?: unknown }>;
};

export const LOCAL_DAILY_DATASETS: readonly LocalDailyDatasetConfig[] = [
    {
        key: "ibkr-stock",
        label: "IBKR Local",
        catalogUrl: "/api/local-price-data/ibkr/catalog",
        candlesBasePath: "/price-data/ibkr/csv",
        supportedIntervals: ["1d", "4h", "1h", "30m", "15m", "5m", "1m"],
        provider: "ibkr-local",
    },
];

const assetCacheByDataset = new Map<LocalDailyDatasetKey, LocalDailyAsset[]>();
const pendingLoadByDataset = new Map<LocalDailyDatasetKey, Promise<LocalDailyAsset[]>>();
// Pre-normalized search index kept in sync with `assetCacheByDataset` so the
// per-keystroke search loop avoids recomputing alphanumeric-normalized forms
// for every row on every query.
const indexedCacheByDataset = new Map<LocalDailyDatasetKey, IndexedLocalDailyAsset[]>();

type IndexedLocalDailyAsset = {
    asset: LocalDailyAsset;
    symbol: string;
    symbolNormalized: string;
    name: string;
    nameNormalized: string;
    datasetLabel: string;
};

function buildIndexedAssets(assets: LocalDailyAsset[]): IndexedLocalDailyAsset[] {
    return assets.map((asset) => {
        const symbol = asset.symbol.toUpperCase();
        const name = asset.name.toUpperCase();
        return {
            asset,
            symbol,
            symbolNormalized: symbol.replace(/[^A-Z0-9]/g, ""),
            name,
            nameNormalized: name.replace(/[^A-Z0-9]/g, ""),
            datasetLabel: asset.datasetLabel.toUpperCase(),
        };
    });
}

export function getLocalDailyDatasetConfig(key: LocalDailyDatasetKey): LocalDailyDatasetConfig | null {
    return LOCAL_DAILY_DATASETS.find((dataset) => dataset.key === key) ?? null;
}

function toAsset(
    config: LocalDailyDatasetConfig,
    symbol: string,
    name: string,
    sector = ""
): LocalDailyAsset | null {
    const trimmedSymbol = symbol.trim().toUpperCase();
    if (!trimmedSymbol) return null;
    const normalizedSymbol = markIbkrSymbol(stripIbkrMarker(trimmedSymbol));
    return {
        symbol: normalizedSymbol,
        name: name.trim() || normalizedSymbol,
        dataset: config.key,
        datasetLabel: config.label,
        provider: config.provider,
        ...(sector.trim() ? { sector: sector.trim() } : {}),
    };
}

function parseJsonCatalog(payload: LocalPriceDataCatalogResponse, config: LocalDailyDatasetConfig): LocalDailyAsset[] {
    const rows = Array.isArray(payload.assets) ? payload.assets : [];
    const bySymbol = new Map<string, LocalDailyAsset>();

    for (const row of rows) {
        const symbol = String(row.symbol ?? "");
        const name = String(row.name ?? symbol);
        const sector = String(row.sector ?? "");
        const asset = toAsset(config, symbol, name, sector);
        if (asset && !bySymbol.has(asset.symbol)) {
            bySymbol.set(asset.symbol, asset);
        }
    }

    return Array.from(bySymbol.values()).sort(compareLocalAssets);
}

function compareLocalAssets(a: LocalDailyAsset, b: LocalDailyAsset): number {
    return a.symbol.localeCompare(b.symbol);
}

async function loadDatasetAssets(config: LocalDailyDatasetConfig): Promise<LocalDailyAsset[]> {
    const cached = assetCacheByDataset.get(config.key);
    if (cached) return cached;

    const pending = pendingLoadByDataset.get(config.key);
    if (pending) return pending;

    const nextLoad = (async () => {
        try {
            // Local catalog assets are same-origin but a stalled dev-server
            // response would otherwise hold pendingLoadByDataset indefinitely.
            // Single attempt, 5s cap — no retry since these are local reads.
            const payload = await fetchAndConsumeWithTimeoutAndRetry(
                config.catalogUrl,
                { cache: "no-store" },
                async response => response.ok ? await response.json() as LocalPriceDataCatalogResponse : null,
                { timeoutMs: 5_000, maxAttempts: 1 },
            );
            if (!payload) return [];

            const assets = parseJsonCatalog(payload, config);
            assetCacheByDataset.set(config.key, assets);
            indexedCacheByDataset.set(config.key, buildIndexedAssets(assets));
            return assets;
        } catch {
            return [];
        } finally {
            pendingLoadByDataset.delete(config.key);
        }
    })();

    pendingLoadByDataset.set(config.key, nextLoad);
    return nextLoad;
}

export async function getLocalDailyAssets(datasetKey?: LocalDailyDatasetKey): Promise<LocalDailyAsset[]> {
    const configs = datasetKey
        ? LOCAL_DAILY_DATASETS.filter((config) => config.key === datasetKey)
        : LOCAL_DAILY_DATASETS;
    if (configs.length === 0) return [];

    const byDataset = await Promise.all(configs.map((config) => loadDatasetAssets(config)));
    return byDataset.flat();
}

export function clearLocalDailyAssetCaches(): void {
    assetCacheByDataset.clear();
    pendingLoadByDataset.clear();
    indexedCacheByDataset.clear();
}

export async function getLocalDailyAsset(symbol: string): Promise<LocalDailyAsset | null> {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return null;

    const assets = await getLocalDailyAssets();
    return assets.find((asset) => asset.symbol === normalized) ?? null;
}

export async function searchLocalDailyAssets(
    query: string,
    limit = 50,
    datasetKey?: LocalDailyDatasetKey
): Promise<LocalDailyAsset[]> {
    const indexedCatalog = await getIndexedLocalDailyAssets(datasetKey);
    if (indexedCatalog.length === 0) return [];

    const normalizedLimit = Math.max(1, Math.floor(limit));
    const trimmed = query.trim();
    if (!trimmed) {
        return indexedCatalog.slice(0, normalizedLimit).map((entry) => entry.asset);
    }

    const term = trimmed.toUpperCase();
    const normalizedTerm = term.replace(/[^A-Z0-9]/g, "");
    const scored = indexedCatalog.map((entry) => {
        const { symbol, symbolNormalized, name, nameNormalized, datasetLabel } = entry;
        let score = 0;

        if (symbol === term || symbolNormalized === normalizedTerm) score += 1000;
        if (symbol.startsWith(term) || symbolNormalized.startsWith(normalizedTerm)) score += 140;
        if (symbol.includes(term) || symbolNormalized.includes(normalizedTerm)) score += 70;
        if (name.startsWith(term) || nameNormalized.startsWith(normalizedTerm)) score += 40;
        if (name.includes(term) || nameNormalized.includes(normalizedTerm)) score += 20;
        if (datasetLabel.includes(term)) score += 5;

        return { asset: entry.asset, score };
    });

    return scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score || a.asset.symbol.localeCompare(b.asset.symbol))
        .slice(0, normalizedLimit)
        .map((item) => item.asset);
}

async function getIndexedLocalDailyAssets(
    datasetKey?: LocalDailyDatasetKey
): Promise<IndexedLocalDailyAsset[]> {
    const configs = datasetKey
        ? LOCAL_DAILY_DATASETS.filter((config) => config.key === datasetKey)
        : LOCAL_DAILY_DATASETS;
    if (configs.length === 0) return [];

    // `loadDatasetAssets` populates `indexedCacheByDataset` as a side effect.
    await Promise.all(configs.map((config) => loadDatasetAssets(config)));
    return configs.flatMap((config) => indexedCacheByDataset.get(config.key) ?? []);
}
