import type { PolymarketOutcomeRow } from './types/polymarket-outcomes';
import {
    checkLocalApiAvailable,
    fetchLocalApi,
    isAbortLikeError,
    markLocalApiUnavailable,
    resetLocalApiAvailability,
} from './local-api-transport';

const AVAILABILITY_CACHE_MS = 60000;
const SQLITE_REQUEST_TIMEOUT_MS = 8000;
const SQLITE_INGEST_TIMEOUT_MS = 180000;
const SQLITE_POLYMARKET_API_AVAILABILITY_KEY = 'sqlite-polymarket';

export interface LoadPolymarketOutcomesOptions {
    seriesId?: string;
    startTs?: number;
    endTs?: number;
    limit?: number;
    afterStartTs?: number;
    afterEventSlug?: string;
}

type LoadPolymarketOutcomesResponse = {
    ok: boolean;
    rows?: PolymarketOutcomeRow[];
    count?: number;
    limit?: number;
    truncated?: boolean;
    nextAfterStartTs?: number;
    nextAfterEventSlug?: string;
    error?: string;
};

export type LoadPolymarketOutcomesResult = {
    rows: PolymarketOutcomeRow[];
    count: number;
    limit?: number;
    truncated: boolean;
    nextAfterStartTs?: number;
    nextAfterEventSlug?: string;
};

type StorePolymarketOutcomesResponse = {
    ok: boolean;
    upserted?: number;
    error?: string;
};

function getBaseUrl(): string {
    return typeof window === 'undefined' ? 'http://localhost:5173' : '';
}

async function checkSqliteApiAvailable(force = false): Promise<boolean> {
    return checkLocalApiAvailable({
        key: SQLITE_POLYMARKET_API_AVAILABILITY_KEY,
        statusUrl: getBaseUrl() + '/api/sqlite/status',
        force,
        cacheMs: AVAILABILITY_CACHE_MS,
        timeoutMs: SQLITE_REQUEST_TIMEOUT_MS,
    });
}

export function resetLocalSqlitePolymarketApiAvailabilityForTests(): void {
    resetLocalApiAvailability(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
}

export async function loadPolymarketOutcomes(
    options: LoadPolymarketOutcomesOptions = {}
): Promise<PolymarketOutcomeRow[]> {
    return (await loadPolymarketOutcomesWithMetadata(options)).rows;
}

export async function loadPolymarketOutcomesWithMetadata(
    options: LoadPolymarketOutcomesOptions = {}
): Promise<LoadPolymarketOutcomesResult> {
    const available = await checkSqliteApiAvailable();
    if (!available) {
        throw new Error('Local SQLite API is unavailable. Start the Vite dev server and verify /api/sqlite/status.');
    }

    const params = new URLSearchParams();
    if (options.seriesId) params.set('seriesId', options.seriesId);
    if (options.startTs != null) params.set('startTs', String(Math.floor(options.startTs)));
    if (options.endTs != null) params.set('endTs', String(Math.floor(options.endTs)));
    if (options.limit != null) params.set('limit', String(Math.max(1, Math.floor(options.limit))));
    if (options.afterStartTs != null) params.set('afterStartTs', String(Math.floor(options.afterStartTs)));
    if (options.afterEventSlug) params.set('afterEventSlug', options.afterEventSlug);

    const url = `${getBaseUrl()}/api/sqlite/load-polymarket-outcomes${params.size ? `?${params.toString()}` : ''}`;
    let res: Response;
    try {
        res = await fetchLocalApi(url, {
            method: 'GET',
        }, SQLITE_REQUEST_TIMEOUT_MS);
    } catch (error) {
        markLocalApiUnavailable(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
        if (isAbortLikeError(error)) {
            throw new Error(`Loading Polymarket outcomes from SQLite timed out after ${Math.round(SQLITE_REQUEST_TIMEOUT_MS / 1000)}s.`);
        }
        throw error instanceof Error
            ? new Error(`Failed to reach /api/sqlite/load-polymarket-outcomes: ${error.message}`)
            : new Error('Failed to reach /api/sqlite/load-polymarket-outcomes.');
    }

    if (!res.ok) {
        if (res.status === 404) {
            markLocalApiUnavailable(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
        }
        const payload = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `load-polymarket-outcomes failed (${res.status})`);
    }

    const payload = await res.json() as LoadPolymarketOutcomesResponse;
    if (!payload.ok) {
        throw new Error(payload.error ?? 'load-polymarket-outcomes: ok=false');
    }

    const rows = payload.rows ?? [];
    return {
        rows,
        count: payload.count ?? rows.length,
        limit: payload.limit,
        truncated: payload.truncated === true,
        nextAfterStartTs: payload.nextAfterStartTs,
        nextAfterEventSlug: payload.nextAfterEventSlug,
    };
}

export async function storePolymarketOutcomes(
    rows: PolymarketOutcomeRow[]
): Promise<StorePolymarketOutcomesResponse> {
    if (!rows.length) return { ok: true, upserted: 0 };

    const available = await checkSqliteApiAvailable();
    if (!available) {
        return {
            ok: false,
            error: 'Local SQLite API is unavailable. Start the Vite dev server and verify /api/sqlite/status.',
        };
    }

    let res: Response;
    try {
        res = await fetchLocalApi(`${getBaseUrl()}/api/sqlite/store-polymarket-outcomes`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows }),
        }, SQLITE_REQUEST_TIMEOUT_MS);
    } catch (error) {
        markLocalApiUnavailable(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
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
    const available = await checkSqliteApiAvailable();
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
        res = await fetchLocalApi(url, {
            method: 'GET',
        }, SQLITE_REQUEST_TIMEOUT_MS);
    } catch (error) {
        markLocalApiUnavailable(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
        if (isAbortLikeError(error)) {
            throw new Error(`Loading Polymarket price points from SQLite timed out after ${Math.round(SQLITE_REQUEST_TIMEOUT_MS / 1000)}s.`);
        }
        throw error instanceof Error
            ? new Error(`Failed to reach /api/sqlite/load-polymarket-price-points: ${error.message}`)
            : new Error('Failed to reach /api/sqlite/load-polymarket-price-points.');
    }

    if (!res.ok) {
        if (res.status === 404) {
            markLocalApiUnavailable(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
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
    failedEvents?: number;
    missingTokenEvents?: number;
    error?: string;
};

export async function storePolymarketPricePoints(
    rows: PolymarketPricePoint[]
): Promise<StorePolymarketPricePointsResponse> {
    if (!rows.length) return { ok: true, upserted: 0 };

    const available = await checkSqliteApiAvailable();
    if (!available) {
        return {
            ok: false,
            error: 'Local SQLite API is unavailable.',
        };
    }

    let res: Response;
    try {
        res = await fetchLocalApi(`${getBaseUrl()}/api/sqlite/store-polymarket-price-points`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ rows }),
        }, SQLITE_REQUEST_TIMEOUT_MS);
    } catch (error) {
        markLocalApiUnavailable(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
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

export type EnsurePolymarketPricePointsResult = {
    rows: PolymarketPricePoint[];
    upserted: number;
    fetchedEvents: number;
    failedEvents: number;
    missingTokenEvents: number;
};

export async function ensurePolymarketPricePointsWithMetadata(args: {
    seriesId: string;
    outcomes: PolymarketOutcomeRow[];
}): Promise<EnsurePolymarketPricePointsResult> {
    if (!args.seriesId || args.outcomes.length === 0) {
        return { rows: [], upserted: 0, fetchedEvents: 0, failedEvents: 0, missingTokenEvents: 0 };
    }

    const available = await checkSqliteApiAvailable();
    if (!available) {
        throw new Error('Local SQLite API is unavailable. Start the Vite dev server and verify /api/sqlite/status.');
    }

    let res: Response;
    try {
        res = await fetchLocalApi(`${getBaseUrl()}/api/sqlite/ensure-polymarket-price-points`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                seriesId: args.seriesId,
                outcomes: args.outcomes,
            }),
        }, SQLITE_INGEST_TIMEOUT_MS);
    } catch (error) {
        markLocalApiUnavailable(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
        if (isAbortLikeError(error)) {
            throw new Error(`Ensuring Polymarket price points timed out after ${Math.round(SQLITE_INGEST_TIMEOUT_MS / 1000)}s.`);
        }
        throw error instanceof Error
            ? new Error(`Failed to reach /api/sqlite/ensure-polymarket-price-points: ${error.message}`)
            : new Error('Failed to reach /api/sqlite/ensure-polymarket-price-points.');
    }

    if (!res.ok) {
        if (res.status === 404) {
            markLocalApiUnavailable(SQLITE_POLYMARKET_API_AVAILABILITY_KEY);
        }
        const payload = await res.json().catch(() => ({})) as { error?: string };
        throw new Error(payload.error ?? `ensure-polymarket-price-points failed (${res.status})`);
    }

    const payload = await res.json() as EnsurePolymarketPricePointsResponse;
    if (!payload.ok) {
        throw new Error(payload.error ?? 'ensure-polymarket-price-points: ok=false');
    }

    return {
        rows: payload.rows ?? [],
        upserted: payload.upserted ?? 0,
        fetchedEvents: payload.fetchedEvents ?? 0,
        failedEvents: payload.failedEvents ?? 0,
        missingTokenEvents: payload.missingTokenEvents ?? 0,
    };
}

export async function ensurePolymarketPricePoints(args: {
    seriesId: string;
    outcomes: PolymarketOutcomeRow[];
}): Promise<PolymarketPricePoint[]> {
    return (await ensurePolymarketPricePointsWithMetadata(args)).rows;
}
