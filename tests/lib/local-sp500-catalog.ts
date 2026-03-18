export interface LocalSp500Asset {
    symbol: string;
    name: string;
    sector: string;
}

const LOCAL_SP500_COMPANY_INFO_PATH =
    '/price-data/sp500_comprehensive_dataset/sp500_comprehensive/sp500_company_info.csv';

let cachedLocalSp500Assets: LocalSp500Asset[] | null = null;
let pendingLocalSp500Load: Promise<LocalSp500Asset[]> | null = null;

function parseCsvLine(line: string): string[] {
    const values: string[] = [];
    let current = '';
    let inQuotes = false;

    for (let i = 0; i < line.length; i += 1) {
        const ch = line[i];
        if (ch === '"') {
            if (inQuotes && line[i + 1] === '"') {
                current += '"';
                i += 1;
                continue;
            }
            inQuotes = !inQuotes;
            continue;
        }
        if (ch === ',' && !inQuotes) {
            values.push(current.trim());
            current = '';
            continue;
        }
        current += ch;
    }
    values.push(current.trim());
    return values;
}

function parseLocalSp500AssetsCsv(rawCsv: string): LocalSp500Asset[] {
    const lines = rawCsv
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return [];

    const header = parseCsvLine(lines[0]).map((value) => value.toLowerCase());
    const tickerIdx = header.indexOf('ticker');
    const nameIdx = header.indexOf('name');
    const sectorIdx = header.indexOf('sector');
    if (tickerIdx < 0 || nameIdx < 0) return [];

    const bySymbol = new Map<string, LocalSp500Asset>();
    for (let i = 1; i < lines.length; i += 1) {
        const row = parseCsvLine(lines[i]);
        const symbol = (row[tickerIdx] ?? '').trim().toUpperCase();
        if (!symbol) continue;
        const name = (row[nameIdx] ?? symbol).trim() || symbol;
        const sector = (sectorIdx >= 0 ? row[sectorIdx] : '').trim();
        if (!bySymbol.has(symbol)) {
            bySymbol.set(symbol, { symbol, name, sector });
        }
    }

    return Array.from(bySymbol.values()).sort((a, b) => a.symbol.localeCompare(b.symbol));
}

export async function getLocalSp500Assets(): Promise<LocalSp500Asset[]> {
    if (cachedLocalSp500Assets) return cachedLocalSp500Assets;
    if (pendingLocalSp500Load) return pendingLocalSp500Load;

    pendingLocalSp500Load = (async () => {
        try {
            const response = await fetch(LOCAL_SP500_COMPANY_INFO_PATH, {
                cache: 'no-store',
            });
            if (!response.ok) return [];
            const payload = await response.text();
            const parsed = parseLocalSp500AssetsCsv(payload);
            cachedLocalSp500Assets = parsed;
            return parsed;
        } catch {
            return [];
        } finally {
            pendingLocalSp500Load = null;
        }
    })();

    return pendingLocalSp500Load;
}

export async function searchLocalSp500Assets(query: string, limit = 50): Promise<LocalSp500Asset[]> {
    const catalog = await getLocalSp500Assets();
    if (catalog.length === 0) return [];

    const trimmed = query.trim();
    if (!trimmed) {
        return catalog.slice(0, Math.max(1, Math.floor(limit)));
    }

    const term = trimmed.toUpperCase();
    const normalizedTerm = term.replace(/[^A-Z0-9]/g, '');
    const scored = catalog.map((asset) => {
        const symbol = asset.symbol.toUpperCase();
        const name = asset.name.toUpperCase();
        const symbolNormalized = symbol.replace(/[^A-Z0-9]/g, '');
        const nameNormalized = name.replace(/[^A-Z0-9]/g, '');
        let score = 0;

        if (symbol === term || symbolNormalized === normalizedTerm) score += 1000;
        if (symbol.startsWith(term) || symbolNormalized.startsWith(normalizedTerm)) score += 140;
        if (symbol.includes(term) || symbolNormalized.includes(normalizedTerm)) score += 70;
        if (name.startsWith(term) || nameNormalized.startsWith(normalizedTerm)) score += 40;
        if (name.includes(term) || nameNormalized.includes(normalizedTerm)) score += 20;

        return { asset, score };
    });

    return scored
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, Math.max(1, Math.floor(limit)))
        .map((item) => item.asset);
}

