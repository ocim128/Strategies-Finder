import type { PolymarketOutcomeRow } from './types/polymarket-outcomes';

const AVAILABILITY_CACHE_MS = 60000;
const SQLITE_REQUEST_TIMEOUT_MS = 8000;
const SQLITE_INGEST_TIMEOUT_MS = 180000;

let sqliteApiAvailable: boolean | null = null;
let sqliteApiCheckedAt = 0;
let sqliteApiAvailabilityCheckPromise: Promise<boolean> | null = null;

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

function getBaseUrl(): string {
    return typeof window === 'undefined' ? 'http://localhost:5173' : '';
}

async function checkSqliteApiAvailable(force = false): Promise<boolean> {
    const now = Date.now();
    const cacheIsFresh = sqliteApiAvailable !== null && now - sqliteApiCheckedAt < AVAILABILITY_CACHE_MS;
    // A fresh successful probe is good enough for dependent SQLite requests in
    // the same run; re-probing here can turn a transient status hiccup into a
    // false failure while the API is otherwise serving data.
    if (cacheIsFresh && (!force || sqliteApiAvailable === true)) {
        return sqliteApiAvailable ?? false;
    }

    if (sqliteApiAvailabilityCheckPromise) {
        return await sqliteApiAvailabilityCheckPromise;
    }

    const availabilityCheck = (async () => {
        try {
            const response = await fetch(getBaseUrl() + '/api/sqlite/status', {
                method: 'GET',
                signal: createRequestTimeoutSignal(),
            });
            sqliteApiAvailable = response.ok;
        } catch {
            sqliteApiAvailable = false;
        }

        sqliteApiCheckedAt = Date.now();
        return sqliteApiAvailable ?? false;
    })();

    sqliteApiAvailabilityCheckPromise = availabilityCheck;
    try {
        return await availabilityCheck;
    } finally {
        if (sqliteApiAvailabilityCheckPromise === availabilityCheck) {
            sqliteApiAvailabilityCheckPromise = null;
        }
    }
}

export function resetLocalSqlitePolymarketApiAvailabilityForTests(): void {
    sqliteApiAvailable = null;
    sqliteApiCheckedAt = 0;
    sqliteApiAvailabilityCheckPromise = null;
}

export async function loadPolymarketOutcomes(
    options: LoadPolymarketOutcomesOptions = {}
): Promise<PolymarketOutcomeRow[]> {
    const available = await checkSqliteApiAvailable(true);
    if (!available) {
        throw new Error('Local SQLite API is unavailable. Start the Vite dev server and verify /api/sqlite/status.');
    }

    const params = new URLSearchParams();
    if (options.seriesId) params.set('seriesId', options.seriesId);
    if (options.startTs != null) params.set('startTs', String(Math.floor(options.startTs)));
    if (options.endTs != null) params.set('endTs', String(Math.floor(options.endTs)));
    if (options.limit != null) params.set('limit', String(Math.max(1, Math.floor(options.limit))));

    const url = `${getBaseUrl()}/api/sqlite/load-polymarket-outcomes${params.size ? `?${params.toString()}` : ''}`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'GET',
            signal: createRequestTimeoutSignal(),
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
        res = await fetch(`${getBaseUrl()}/api/sqlite/store-polymarket-outcomes`, {
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

export interface PolymarketPricePoint {
    series_id: string;
    event_start_ts: number;
    event_end_ts: number;
    market_slug: string;
    yes_token_id: string;
    no_token_id: string;
    ts: number;
    yes_price: number | null;
    no_price: number | null;
    updated_at: number;
}

export interface LoadPolymarketPricePointsOptions {
    seriesId: string;
    eventStartTs?: number[];
    startTs?: number;
    endTs?: number;
    limit?: number;
}

type LoadPolymarketPricePointsResponse = {
    ok: boolean;
    rows?: PolymarketPricePoint[];
    count?: number;
    error?: string;
};

export async function loadPolymarketPricePoints(
    options: LoadPolymarketPricePointsOptions
): Promise<PolymarketPricePoint[]> {
    const available = await checkSqliteApiAvailable(true);
    if (!available) {
        throw new Error('Local SQLite API is unavailable. Start the Vite dev server and verify /api/sqlite/status.');
    }

    const params = new URLSearchParams();
    params.set('seriesId', options.seriesId);
    if (options.eventStartTs && options.eventStartTs.length > 0) {
        params.set('eventStartTs', options.eventStartTs.map(String).join(','));
    }
    if (options.startTs != null) params.set('startTs', String(Math.floor(options.startTs)));
    if (options.endTs != null) params.set('endTs', String(Math.floor(options.endTs)));
    if (options.limit != null) params.set('limit', String(Math.max(1, Math.floor(options.limit))));

    const url = `${getBaseUrl()}/api/sqlite/load-polymarket-price-points?${params.toString()}`;
    let res: Response;
    try {
        res = await fetch(url, {
            method: 'GET',
            signal: createRequestTimeoutSignal(),
        });
    } catch (error) {
        sqliteApiAvailable = false;
        sqliteApiCheckedAt = Date.now();
        if (isAbortLikeError(error)) {
            throw new Error(`Loading Polymarket price points from SQLite timed out after ${Math.round(SQLITE_REQUEST_TIMEOUT_MS / 1000)}s.`);
        }
        throw error instanceof Error
            ? new Error(`Failed to reach /api/sqlite/load-polymarket-price-points: ${error.message}`)
            : new Error('Failed to reach /api/sqlite/load-polymarket-price-points.');
    }

    if (!res.ok) {
        if (res.status === 404 || res.status >= 500) {
            sqliteApiAvailable = false;
            sqliteApiCheckedAt = Date.now();
        }
        const payload = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `load-polymarket-price-points failed (${res.status})`);
    }

    const payload = await res.json() as LoadPolymarketPricePointsResponse;
    if (!payload.ok) {
        throw new Error(payload.error ?? 'load-polymarket-price-points: ok=false');
    }

    return payload.rows ?? [];
}

type StorePolymarketPricePointsResponse = {
    ok: boolean;
    upserted?: number;
    error?: string;
};

type EnsurePolymarketPricePointsResponse = {
    ok: boolean;
    rows?: PolymarketPricePoint[];
    upserted?: number;
    fetchedEvents?: number;
    error?: string;
};

export async function storePolymarketPricePoints(
    rows: PolymarketPricePoint[]
): Promise<StorePolymarketPricePointsResponse> {
    if (!rows.length) return { ok: true, upserted: 0 };

    const available = await checkSqliteApiAvailable(true);
    if (!available) {
        return {
            ok: false,
            error: 'Local SQLite API is unavailable.',
        };
    }

    let res: Response;
    try {
        res = await fetch(`${getBaseUrl()}/api/sqlite/store-polymarket-price-points`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows }),
            signal: createRequestTimeoutSignal(),
        });
    } catch (error) {
        sqliteApiAvailable = false;
        sqliteApiCheckedAt = Date.now();
        return {
            ok: false,
            error: error instanceof Error
                ? `Failed to reach /api/sqlite/store-polymarket-price-points: ${error.message}`
                : 'Failed to reach /api/sqlite/store-polymarket-price-points.',
        };
    }

    const payload = await res.json() as StorePolymarketPricePointsResponse;
    if (!res.ok || !payload.ok) {
        return { ok: false, error: payload.error ?? `store-polymarket-price-points failed (${res.status})` };
    }

    return payload;
}

export async function ensurePolymarketPricePoints(args: {
    seriesId: string;
    outcomes: PolymarketOutcomeRow[];
}): Promise<PolymarketPricePoint[]> {
    if (!args.seriesId || args.outcomes.length === 0) {
        return [];
    }

    const available = await checkSqliteApiAvailable(true);
    if (!available) {
        throw new Error('Local SQLite API is unavailable. Start the Vite dev server and verify /api/sqlite/status.');
    }

    let res: Response;
    try {
        res = await fetch(`${getBaseUrl()}/api/sqlite/ensure-polymarket-price-points`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seriesId: args.seriesId,
                outcomes: args.outcomes,
            }),
            signal: AbortSignal.timeout(SQLITE_INGEST_TIMEOUT_MS),
        });
    } catch (error) {
        sqliteApiAvailable = false;
        sqliteApiCheckedAt = Date.now();
        if (isAbortLikeError(error)) {
            throw new Error(`Ensuring Polymarket price points timed out after ${Math.round(SQLITE_INGEST_TIMEOUT_MS / 1000)}s.`);
        }
        throw error instanceof Error
            ? new Error(`Failed to reach /api/sqlite/ensure-polymarket-price-points: ${error.message}`)
            : new Error('Failed to reach /api/sqlite/ensure-polymarket-price-points.');
    }

    if (!res.ok) {
        if (res.status === 404 || res.status >= 500) {
            sqliteApiAvailable = false;
            sqliteApiCheckedAt = Date.now();
        }
        const payload = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `ensure-polymarket-price-points failed (${res.status})`);
    }

    const payload = await res.json() as EnsurePolymarketPricePointsResponse;
    if (!payload.ok) {
        throw new Error(payload.error ?? 'ensure-polymarket-price-points: ok=false');
    }

    return payload.rows ?? [];
}
