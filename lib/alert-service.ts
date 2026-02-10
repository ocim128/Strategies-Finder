/**
 * Alert Service — thin API client for the Cloudflare Worker alert system.
 * Worker URL is stored in localStorage under 'alert_worker_url'.
 */

const WORKER_URL_KEY = 'alert_worker_url';

// ── Types ────────────────────────────────────────────────────────────────────

export interface AlertSubscription {
    id: number;
    stream_id: string;
    enabled: number;
    symbol: string;
    interval: string;
    strategy_key: string;
    strategy_params_json: string;
    backtest_settings_json: string;
    freshness_bars: number;
    notify_telegram: number;
    notify_exit: number;
    candle_limit: number;
    last_processed_closed_candle_time: number;
    last_run_at: string | null;
    last_status: string | null;
    created_at: string;
    updated_at: string;
}

export interface AlertSubscriptionUpsert {
    streamId?: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    strategyParams?: Record<string, number>;
    backtestSettings?: Record<string, unknown>;
    freshnessBars?: number;
    notifyTelegram?: boolean;
    notifyExit?: boolean;
    enabled?: boolean;
    candleLimit?: number;
}

export interface AlertSignalRecord {
    id: number;
    stream_id: string;
    symbol: string;
    interval: string;
    strategy_key: string;
    direction: 'long' | 'short';
    signal_time: number;
    signal_price: number;
    signal_reason: string | null;
    payload_json: string;
    created_at: string;
}

export interface RunNowResult {
    streamId: string;
    status: string;
    closedCandleTimeSec?: number;
    result?: Record<string, unknown>;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function getWorkerUrl(): string {
    return localStorage.getItem(WORKER_URL_KEY) ?? '';
}

function setWorkerUrl(url: string): void {
    localStorage.setItem(WORKER_URL_KEY, url.replace(/\/+$/, ''));
}

function requireUrl(): string {
    const url = getWorkerUrl();
    if (!url) throw new Error('Worker URL not configured. Set it in the Alerts tab.');
    return url;
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const base = requireUrl();
    const res = await fetch(`${base}${path}`, {
        ...options,
        headers: { 'content-type': 'application/json', ...(options?.headers ?? {}) },
    });
    const json = await res.json();
    if (!res.ok) throw new Error((json as Record<string, string>).error ?? `HTTP ${res.status}`);
    return json as T;
}

// ── Public API ───────────────────────────────────────────────────────────────

export const alertService = {
    getWorkerUrl,
    setWorkerUrl,

    /** Test worker connectivity */
    async healthCheck(): Promise<{ ok: boolean; error?: string }> {
        try {
            const base = requireUrl();
            const res = await fetch(`${base}/health`);
            const json = (await res.json()) as Record<string, unknown>;
            return { ok: !!json.ok };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    },

    /** List all subscriptions */
    async listSubscriptions(): Promise<AlertSubscription[]> {
        const data = await apiFetch<{ ok: boolean; items: AlertSubscription[] }>('/api/subscriptions');
        return data.items ?? [];
    },

    /** Create or update a subscription */
    async upsertSubscription(payload: AlertSubscriptionUpsert): Promise<{
        ok: boolean;
        streamId: string;
        subscription: AlertSubscription;
    }> {
        return apiFetch('/api/subscriptions/upsert', {
            method: 'POST',
            body: JSON.stringify(payload),
        });
    },

    /** Disable a subscription (soft-delete) */
    async disableSubscription(streamId: string): Promise<void> {
        await apiFetch('/api/subscriptions/upsert', {
            method: 'POST',
            body: JSON.stringify({ streamId, symbol: '_', interval: '_', strategyKey: '_', enabled: false }),
        });
    },

    /** Trigger immediate evaluation for a subscription */
    async runNow(streamId: string, force = false): Promise<RunNowResult> {
        return apiFetch('/api/subscriptions/run-now', {
            method: 'POST',
            body: JSON.stringify({ streamId, force }),
        });
    },

    /** Get signal history for a stream */
    async getSignalHistory(streamId: string, limit = 20): Promise<AlertSignalRecord[]> {
        const data = await apiFetch<{ ok: boolean; signals: AlertSignalRecord[] }>(
            `/api/stream/signals?streamId=${encodeURIComponent(streamId)}&limit=${limit}`
        );
        return data.signals ?? [];
    },
};
