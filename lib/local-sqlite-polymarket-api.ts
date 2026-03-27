import { parseTimeToUnixSeconds } from './time-normalization';
import type { PolymarketOutcomeRow } from './types/polymarket-outcomes';

const AVAILABILITY_CACHE_MS = 60000;
const SQLITE_REQUEST_TIMEOUT_MS = 8000;

let sqliteApiAvailable: boolean | null = null;
let sqliteApiCheckedAt = 0;

export interface LoadPolymarketOutcomesOptions {
    seriesId?: string;
    startTs?: number;
    endTs?: number;
    limit?: number;
}

type LoadPolymarketOutcomesResponse = {
    ok: boolean;
    rows?: PolymarketOutcomeRow[];
    error?: string;
};

type StorePolymarketOutcomesResponse = {
    ok: boolean;
    upserted?: number;
    error?: string;
};

function isAbortLikeError(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return error.name === 'AbortError' || error.name === 'TimeoutError';
}

function createRequestTimeoutSignal(): AbortSignal {
    return AbortSignal.timeout(SQLITE_REQUEST_TIMEOUT_MS);
}

async function checkSqliteApiAvailable(force = false): Promise<boolean> {
    const now = Date.now();
    if (!force && sqliteApiAvailable !== null && now - sqliteApiCheckedAt < AVAILABILITY_CACHE_MS) {
        return sqliteApiAvailable;
    }

    try {
        const response = await fetch('/api/sqlite/status', {
            method: 'GET',
            signal: createRequestTimeoutSignal(),
        });
        sqliteApiAvailable = response.ok;
    } catch {
        sqliteApiAvailable = false;
    }

    sqliteApiCheckedAt = now;
    return sqliteApiAvailable;
}

export async function loadPolymarketOutcomes(
    options: LoadPolymarketOutcomesOptions = {}
): Promise<PolymarketOutcomeRow[]> {
    const checkStart = Date.now();
    const available = await checkSqliteApiAvailable(true);
    console.log('[PolymarketSQLite] API availability check', { available, checkDurationMs: Date.now() - checkStart });
    if (!available) {
        console.error('[PolymarketSQLite] API unavailable - throwing error');
        throw new Error('Local SQLite API is unavailable. Start the Vite dev server and verify /api/sqlite/status.');
    }

    const params = new URLSearchParams();
    if (options.seriesId) params.set('seriesId', options.seriesId);
    if (options.startTs != null) params.set('startTs', String(Math.floor(options.startTs)));
    if (options.endTs != null) params.set('endTs', String(Math.floor(options.endTs)));
    if (options.limit != null) params.set('limit', String(Math.max(1, Math.floor(options.limit))));

    const url = `/api/sqlite/load-polymarket-outcomes${params.size ? `?${params.toString()}` : ''}`;
    console.log('[PolymarketSQLite] Making fetch request to SQLite API', { url, seriesId: options.seriesId, startTs: options.startTs, endTs: options.endTs });
    let res: Response;
    const fetchStart = Date.now();
    try {
        res = await fetch(url, {
            method: 'GET',
            signal: createRequestTimeoutSignal(),
        });
        console.log('[PolymarketSQLite] Fetch response received', {
            status: res.status,
            ok: res.ok,
            durationMs: Date.now() - fetchStart,
        });
    } catch (error) {
        sqliteApiAvailable = false;
        sqliteApiCheckedAt = Date.now();
        if (isAbortLikeError(error)) {
            throw new Error(`Loading Polymarket outcomes from SQLite timed out after ${Math.round(SQLITE_REQUEST_TIMEOUT_MS / 1000)}s.`);
        }
        throw error instanceof Error
            ? new Error(`Failed to reach /api/sqlite/load-polymarket-outcomes: ${error.message}`)
            : new Error('Failed to reach /api/sqlite/load-polymarket-outcomes.');
    }

    if (!res.ok) {
        if (res.status === 404 || res.status >= 500) {
            sqliteApiAvailable = false;
            sqliteApiCheckedAt = Date.now();
        }
        const payload = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `load-polymarket-outcomes failed (${res.status})`);
    }

    const payload = await res.json() as LoadPolymarketOutcomesResponse;
    if (!payload.ok) {
        throw new Error(payload.error ?? 'load-polymarket-outcomes: ok=false');
    }

    return payload.rows ?? [];
}

export async function storePolymarketOutcomes(
    rows: PolymarketOutcomeRow[]
): Promise<StorePolymarketOutcomesResponse> {
    if (!rows.length) return { ok: true, upserted: 0 };

    const available = await checkSqliteApiAvailable(true);
    if (!available) {
        return {
            ok: false,
            error: 'Local SQLite API is unavailable. Start the Vite dev server and verify /api/sqlite/status.',
        };
    }

    let res: Response;
    try {
        res = await fetch('/api/sqlite/store-polymarket-outcomes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows }),
            signal: createRequestTimeoutSignal(),
        });
    } catch (error) {
        sqliteApiAvailable = false;
        sqliteApiCheckedAt = Date.now();
        if (isAbortLikeError(error)) {
            return { ok: false, error: `Storing Polymarket outcomes timed out after ${Math.round(SQLITE_REQUEST_TIMEOUT_MS / 1000)}s.` };
        }
        return {
            ok: false,
            error: error instanceof Error
                ? `Failed to reach /api/sqlite/store-polymarket-outcomes: ${error.message}`
                : 'Failed to reach /api/sqlite/store-polymarket-outcomes.',
        };
    }

    const payload = await res.json() as StorePolymarketOutcomesResponse;
    if (!res.ok || !payload.ok) {
        return { ok: false, error: payload.error ?? `store-polymarket-outcomes failed (${res.status})` };
    }

    return payload;
}

export function toPolymarketUnixSeconds(value: unknown): number | null {
    return parseTimeToUnixSeconds(value);
}
