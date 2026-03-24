import { parseTimeToUnixSeconds } from './time-normalization';
import type { PolymarketOutcomeRow } from './types/polymarket-outcomes';

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

export async function loadPolymarketOutcomes(
    options: LoadPolymarketOutcomesOptions = {}
): Promise<PolymarketOutcomeRow[]> {
    const params = new URLSearchParams();
    if (options.seriesId) params.set('seriesId', options.seriesId);
    if (options.startTs != null) params.set('startTs', String(Math.floor(options.startTs)));
    if (options.endTs != null) params.set('endTs', String(Math.floor(options.endTs)));
    if (options.limit != null) params.set('limit', String(Math.max(1, Math.floor(options.limit))));

    const url = `/api/sqlite/load-polymarket-outcomes${params.size ? `?${params.toString()}` : ''}`;
    const res = await fetch(url, { method: 'GET' });
    if (!res.ok) {
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

    const res = await fetch('/api/sqlite/store-polymarket-outcomes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ rows }),
    });

    const payload = await res.json() as StorePolymarketOutcomesResponse;
    if (!res.ok || !payload.ok) {
        return { ok: false, error: payload.error ?? `store-polymarket-outcomes failed (${res.status})` };
    }

    return payload;
}

export function toPolymarketUnixSeconds(value: unknown): number | null {
    return parseTimeToUnixSeconds(value);
}
