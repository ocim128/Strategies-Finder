import type { DataProvider } from "./types/data-providers";

export type LocalDailyDatasetKey =
    | "sp500"
    | "indonesian-stock"
    | "forbes2000-stock"
    | "nasdaq-stock"
    | "nyse-stock"
    | "sp500-stock";

// Diamond suffix marking stock_market_data symbols so they namespace apart
// from Binance/Bybit/indonesian-stock sources. The marker is preserved
// end-to-end through .trim().toUpperCase(), so cache/SQLite/IndexedDB keys
// stay distinct from the bare ticker.
export const STOCK_MARKET_SYMBOL_SUFFIX = "\u2666"; // ♦

const STOCK_MARKET_DATASET_KEYS: ReadonlySet<LocalDailyDatasetKey> = new Set([
    "forbes2000-stock",
    "nasdaq-stock",
    "nyse-stock",
    "sp500-stock",
]);

export function markStockSymbol(symbol: string): string {
    const normalized = symbol.trim().toUpperCase();
    if (!normalized) return normalized;
    return normalized.endsWith(STOCK_MARKET_SYMBOL_SUFFIX)
        ? normalized
        : `${normalized}${STOCK_MARKET_SYMBOL_SUFFIX}`;
}

export function isStockMarketSymbol(symbol: string): boolean {
    return symbol.trim().endsWith(STOCK_MARKET_SYMBOL_SUFFIX);
}

export function stripStockMarketMarker(symbol: string): string {
    const trimmed = symbol.trim();
    return trimmed.endsWith(STOCK_MARKET_SYMBOL_SUFFIX)
        ? trimmed.slice(0, -STOCK_MARKET_SYMBOL_SUFFIX.length).toUpperCase()
        : trimmed.toUpperCase();
}

export function isStockMarketDatasetKey(key: string): boolean {
    return STOCK_MARKET_DATASET_KEYS.has(key as LocalDailyDatasetKey);
}

export interface LocalDailyDatasetConfig {
    key: LocalDailyDatasetKey;
    label: string;
    catalogUrl: string;
    catalogFormat: "csv" | "json";
    candlesBasePath: string;
    provider: Extract<DataProvider, "bybit-tradfi" | "local-daily">;
}

export interface LocalDailyAsset {
    symbol: string;
    name: string;
    dataset: LocalDailyDatasetKey;
    datasetLabel: string;
    provider: Extract<DataProvider, "bybit-tradfi" | "local-daily">;
    sector?: string;
}

type LocalPriceDataCatalogResponse = {
    assets?: Array<{ symbol?: unknown; name?: unknown; sector?: unknown }>;
};

export const LOCAL_DAILY_DATASETS: readonly LocalDailyDatasetConfig[] = [
    {
        key: "sp500",
        label: "S&P 500",
        catalogUrl: "/price-data/sp500_comprehensive_dataset/sp500_comprehensive/sp500_company_info.csv",
        catalogFormat: "csv",
        candlesBasePath: "/price-data/sp500_comprehensive_dataset/sp500_comprehensive/individual_analysis",
        provider: "bybit-tradfi",
    },
    {
        key: "indonesian-stock",
        label: "Indonesian Stocks",
        catalogUrl: "/api/local-price-data/indonesian-stock/catalog",
        catalogFormat: "json",
        candlesBasePath: "/price-data/indonesian-stock",
        provider: "local-daily",
    },
    {
        key: "forbes2000-stock",
        label: "Stock Market \u2014 Forbes 2000",
        catalogUrl: "/api/local-price-data/stock-market/catalog?dataset=forbes2000",
        catalogFormat: "json",
        candlesBasePath: "/price-data/stock_market_data/forbes2000/csv",
        provider: "local-daily",
    },
    {
        key: "nasdaq-stock",
        label: "Stock Market \u2014 NASDAQ",
        catalogUrl: "/api/local-price-data/stock-market/catalog?dataset=nasdaq",
        catalogFormat: "json",
        candlesBasePath: "/price-data/stock_market_data/nasdaq/csv",
        provider: "local-daily",
    },
    {
        key: "nyse-stock",
        label: "Stock Market \u2014 NYSE",
        catalogUrl: "/api/local-price-data/stock-market/catalog?dataset=nyse",
        catalogFormat: "json",
        candlesBasePath: "/price-data/stock_market_data/nyse/csv",
        provider: "local-daily",
    },
    {
        key: "sp500-stock",
        label: "Stock Market \u2014 S&P 500",
        catalogUrl: "/api/local-price-data/stock-market/catalog?dataset=sp500",
        catalogFormat: "json",
        candlesBasePath: "/price-data/stock_market_data/sp500/csv",
        provider: "local-daily",
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

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = "";
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === "\"") {
            if (inQuotes && line[i + 1] === "\"") {
                current += "\"";
                i += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (ch === "," && !inQuotes) {
            values.push(current.trim());
            current = "";
            continue;
        }
        current += ch;
    }
    values.push(current.trim());
    return values;
}

function toAsset(
    config: LocalDailyDatasetConfig,
    symbol: string,
    name: string,
    sector = ""
): LocalDailyAsset | null {
    const trimmedSymbol = symbol.trim().toUpperCase();
    if (!trimmedSymbol) return null;
    // Stock-market datasets namespace their symbols with the diamond marker
    // so they never collide with bare tickers from other providers. The
    // catalog endpoint already returns marked symbols, but re-marking here
    // keeps the asset shape consistent regardless of which path fed it in.
    const normalizedSymbol = isStockMarketDatasetKey(config.key)
        ? markStockSymbol(stripStockMarketMarker(trimmedSymbol))
        : trimmedSymbol;
    return {
        symbol: normalizedSymbol,
        name: name.trim() || normalizedSymbol,
        dataset: config.key,
        datasetLabel: config.label,
        provider: config.provider,
        ...(sector.trim() ? { sector: sector.trim() } : {}),
    };
}

function parseSp500Catalog(rawCsv: string, config: LocalDailyDatasetConfig): LocalDailyAsset[] {
    const lines = rawCsv
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return [];

    const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
    const tickerIdx = header.indexOf("ticker");
    const nameIdx = header.indexOf("name");
    const sectorIdx = header.indexOf("sector");
    if (tickerIdx < 0 || nameIdx < 0) return [];

    const bySymbol = new Map<string, LocalDailyAsset>();
    for (let i = 1; i < lines.length; i += 1) {
        const row = parseCsvLine(lines[i]);
        const asset = toAsset(
            config,
            row[tickerIdx] ?? "",
            row[nameIdx] ?? "",
            sectorIdx >= 0 ? row[sectorIdx] ?? "" : ""
        );
        if (asset && !bySymbol.has(asset.symbol)) {
            bySymbol.set(asset.symbol, asset);
        }
    }

    return Array.from(bySymbol.values()).sort(compareLocalAssets);
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
            const response = await fetch(config.catalogUrl, { cache: "no-store" });
            if (!response.ok) return [];

            const assets = config.catalogFormat === "csv"
                ? parseSp500Catalog(await response.text(), config)
                : parseJsonCatalog(await response.json() as LocalPriceDataCatalogResponse, config);
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

export function encodeLocalDailyAssetSelection(asset: LocalDailyAsset): string {
    return `${asset.dataset}:${asset.symbol}`;
}

export function parseLocalDailyAssetSelection(value: string): { dataset: LocalDailyDatasetKey; symbol: string } | null {
    const [rawDataset, rawSymbol] = value.split(":", 2);
    const dataset = rawDataset as LocalDailyDatasetKey;
    const symbol = (rawSymbol ?? "").trim().toUpperCase();
    if (!symbol || !getLocalDailyDatasetConfig(dataset)) return null;
    return { dataset, symbol };
}
