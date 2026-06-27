/**
 * Alert Service - thin API client for the Cloudflare Worker alert system.
 * Worker URL is stored in localStorage under 'alert_worker_url'.
 */

import {
    buildStreamId,
    parseConfigNameFromStreamId,
} from "./alert-stream-id";
import {
    readAlertWorkerToken,
    readAlertWorkerUrl,
    writeAlertWorkerToken,
    writeAlertWorkerUrl,
} from "./alert-storage";
import type { OHLCVData } from "./types/strategies";

export const ALERT_WORKER_URL_CHANGED_EVENT = 'alert-worker-url-changed';
const API_FETCH_TIMEOUT_MS = 10_000;
/**
 * Cap on stream ids sent per `/api/subscriptions/states` request. Must be ≤ the
 * worker's MAX_BATCH (100) — the worker hard-truncates past that with one D1
 * `?` per IN value. Also bounds the N-parallel fallback path used when the
 * batched endpoint is unavailable on an older deployed worker.
 */
const COMMITTEE_STATE_MAX_BATCH = 100;

export interface AlertWorkerHealth {
    ok: boolean;
    error?: string;
    service?: string;
    now?: string;
    supportedStrategyKeys?: string[];
    supportedStrategyCount?: number;
    strategyManifestFingerprint?: string;
}

// Types

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
    committee_tag?: string | null;
}

export interface AlertSubscriptionUpsert {
    streamId?: string;
    symbol?: string;
    interval?: string;
    strategyKey?: string;
    configName?: string;
    strategyParams?: Record<string, number>;
    backtestSettings?: unknown;
    freshnessBars?: number;
    notifyTelegram?: boolean;
    notifyExit?: boolean;
    enabled?: boolean;
    candleLimit?: number;
    /**
     * Committee membership tag. Setting a non-empty string tags the subscription
     * as a committee member. Omit to preserve the existing tag on re-upsert.
     * Pass null/'' to clear.
     */
    committeeTag?: string | null;
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

export interface AlertEvaluatedTradeContext {
    entryTimeSec: number;
    entryPrice: number;
    exitReason: string | null;
    isOpen: boolean;
    takeProfitPrice: number | null;
    stopLossPrice: number | null;
    takeProfitPercent: number | null;
    stopLossPercent: number | null;
}

export interface AlertEvaluatedEntrySignal {
    direction: 'long' | 'short';
    signalTimeSec: number;
    signalPrice: number;
    entryPrice?: number | null;
    signalAgeBars: number;
    isFresh: boolean;
    fingerprint: string;
}

export interface AlertSubscriptionState {
    ok: boolean;
    streamId: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    evaluatedAt: string;
    closedCandleTimeSec: number | null;
    reason: string | null;
    latestClose?: number | null;
    latestTrade: AlertEvaluatedTradeContext | null;
    latestEntry: AlertEvaluatedEntrySignal | null;
}

/**
 * One element returned by the batched `/api/subscriptions/states` endpoint.
 * Mirrors AlertSubscriptionState plus the membership/operational fields the
 * committee UI needs to render per-row diagnostics without a second round trip.
 */
export interface CommitteeMemberState {
    streamId: string;
    ok: boolean;
    reason: string | null;
    symbol: string;
    interval: string;
    strategyKey: string;
    evaluatedAt: string;
    closedCandleTimeSec: number | null;
    latestClose: number | null;
    latestTrade: AlertEvaluatedTradeContext | null;
    latestEntry: AlertEvaluatedEntrySignal | null;
    /**
     * Per-trade direction windows [entrySec, exitSec, dirSign] for the
     * historical chart overlay. `exitSec` is null while the trade is open.
     * Absent on old workers or when the strategy produced no trades.
     */
    tradeWindows?: Array<[number, number | null, 1 | -1]> | null;
    lastStatus: string | null;
    lastRunAt: string | null;
    updatedAt: string | null;
    committeeTag: string | null;
}

export interface CommitteeStateResult {
    ok: boolean;
    scanned: number;
    truncated: boolean;
    states: CommitteeMemberState[];
}

export interface CommitteeAlertRule {
    committeeTag: string;
    enabled: boolean;
    longThreshold: number;
    shortThreshold: number;
    lastFiredScoreSign: number;
    lastFiredAt: string | null;
    updatedAt: string;
}

/**
 * Build deterministic stream id. Keeps legacy format when no configName is provided.
 */
export function buildAlertStreamId(
    symbol: string,
    interval: string,
    strategyKey: string,
    configName?: string
): string {
    return buildStreamId(symbol, interval, strategyKey, configName);
}

/**
 * Parse optional configuration name from stream id generated by buildAlertStreamId.
 */
export function parseAlertConfigNameFromStreamId(streamId: string): string | null {
    return parseConfigNameFromStreamId(streamId);
}

// Helpers

function getWorkerUrl(): string {
    return readAlertWorkerUrl();
}

function getWorkerToken(): string {
    return readAlertWorkerToken()
        || ((import.meta as ImportMeta & { env?: { VITE_ALERT_WORKER_TOKEN?: string } }).env?.VITE_ALERT_WORKER_TOKEN ?? '');
}

function setWorkerUrl(url: string): void {
    const prev = getWorkerUrl();
    const normalized = writeAlertWorkerUrl(url);

    if (prev !== normalized && typeof window !== 'undefined' && typeof window.dispatchEvent === 'function' && typeof CustomEvent !== 'undefined') {
        window.dispatchEvent(new CustomEvent(ALERT_WORKER_URL_CHANGED_EVENT, { detail: { url: normalized } }));
    }
}

function setWorkerToken(token: string): void {
    writeAlertWorkerToken(token);
}

function requireUrl(): string {
    const url = getWorkerUrl();
    if (!url) throw new Error('Worker URL not configured. Set it in the Alerts tab.');
    return url;
}

function truncateText(value: string, maxLen = 320): string {
    const trimmed = value.trim();
    if (trimmed.length <= maxLen) return trimmed;
    return `${trimmed.slice(0, Math.max(0, maxLen - 3))}...`;
}

function extractErrorMessage(body: unknown): string | null {
    if (!body || typeof body !== 'object') return null;
    const message = (body as Record<string, unknown>).error;
    return typeof message === 'string' && message.trim() ? message.trim() : null;
}

async function readApiBody(res: Response): Promise<{ json: unknown | null; text: string | null }> {
    const contentType = (res.headers.get('content-type') ?? '').toLowerCase();

    if (contentType.includes('application/json')) {
        try {
            return { json: await res.json(), text: null };
        } catch {
            return { json: null, text: null };
        }
    }

    try {
        const text = await res.text();
        if (!text.trim()) return { json: null, text: null };
        try {
            return { json: JSON.parse(text), text };
        } catch {
            return { json: null, text };
        }
    } catch {
        return { json: null, text: null };
    }
}

function createTimedRequestSignal(sourceSignal?: AbortSignal): {
    signal: AbortSignal;
    cleanup: () => void;
    didTimeout: () => boolean;
} {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, API_FETCH_TIMEOUT_MS);

    const abortFromSource = () => {
        controller.abort();
    };

    if (sourceSignal) {
        if (sourceSignal.aborted) {
            abortFromSource();
        } else {
            sourceSignal.addEventListener('abort', abortFromSource, { once: true });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timeoutId);
            sourceSignal?.removeEventListener('abort', abortFromSource);
        },
        didTimeout: () => timedOut,
    };
}

async function fetchWithTimeout(input: string, options?: RequestInit): Promise<Response> {
    const timeout = createTimedRequestSignal(options?.signal ?? undefined);
    try {
        return await fetch(input, { ...options, signal: timeout.signal });
    } catch (error) {
        if (timeout.didTimeout() && !(options?.signal?.aborted)) {
            throw new Error(`Request timed out after ${API_FETCH_TIMEOUT_MS}ms.`);
        }
        throw error;
    } finally {
        timeout.cleanup();
    }
}

async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
    const base = requireUrl();
    const token = getWorkerToken();
    const res = await fetchWithTimeout(`${base}${path}`, {
        ...options,
        headers: {
            'content-type': 'application/json',
            ...(token ? { authorization: `Bearer ${token}` } : {}),
            ...(options?.headers ?? {}),
        },
    });
    const body = await readApiBody(res);

    if (!res.ok) {
        const message = extractErrorMessage(body.json)
            ?? (body.text ? truncateText(body.text) : null)
            ?? `HTTP ${res.status}`;
        throw new Error(message);
    }

    if (body.json !== null) return body.json as T;
    throw new Error(`Unexpected non-JSON response (HTTP ${res.status}).`);
}

// Public API

export const alertService = {
    getWorkerUrl,
    getWorkerToken,
    setWorkerUrl,
    setWorkerToken,

    /** Test worker connectivity */
    async healthCheck(): Promise<AlertWorkerHealth> {
        try {
            const base = requireUrl();
            const res = await fetchWithTimeout(`${base}/health`);
            const body = await readApiBody(res);
            if (!res.ok) {
                return {
                    ok: false,
                    error: extractErrorMessage(body.json)
                        ?? (body.text ? truncateText(body.text) : `HTTP ${res.status}`),
                };
            }
            const json = body.json as Record<string, unknown> | null;
            const supportedStrategyKeys = Array.isArray(json?.supportedStrategyKeys)
                ? json.supportedStrategyKeys.filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
                : undefined;

            return {
                ok: !!json?.ok,
                service: typeof json?.service === 'string' ? json.service : undefined,
                now: typeof json?.now === 'string' ? json.now : undefined,
                supportedStrategyKeys,
                supportedStrategyCount: typeof json?.supportedStrategyCount === 'number' ? json.supportedStrategyCount : undefined,
                strategyManifestFingerprint: typeof json?.strategyManifestFingerprint === 'string'
                    ? json.strategyManifestFingerprint
                    : undefined,
            };
        } catch (err) {
            return { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
    },

    /** List all subscriptions */
    async listSubscriptions(): Promise<AlertSubscription[]> {
        const data = await apiFetch<{ ok: boolean; items: AlertSubscription[] }>('/api/subscriptions');
        return data.items ?? [];
    },

    /** List only committee-tagged subscriptions. Falls back to client-side filter on old workers. */
    async listCommitteeSubscriptions(): Promise<AlertSubscription[]> {
        try {
            const data = await apiFetch<{ ok: boolean; items: AlertSubscription[] }>('/api/subscriptions?committee=1');
            const items = data.items ?? [];
            // Defend against older workers that ignore the ?committee flag.
            return items.length > 0 && items.some((sub) => sub.committee_tag)
                ? items.filter((sub) => sub.committee_tag)
                : items;
        } catch {
            const all = await this.listSubscriptions();
            return all.filter((sub) => sub.committee_tag);
        }
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
        try {
            await apiFetch('/api/subscriptions/delete', {
                method: 'POST',
                body: JSON.stringify({ streamId }),
            });
        } catch {
            // Backward compatibility for workers that do not expose /delete yet.
            await apiFetch('/api/subscriptions/upsert', {
                method: 'POST',
                body: JSON.stringify({ streamId, enabled: false }),
            });
        }
    },

    /**
     * Hard-delete a subscription and its signal history. Used by the Signal
     * Committee Remove action so membership actually goes away (not just
     * disabled). Falls back to soft-disable on workers without hard-delete.
     */
    async deleteSubscription(streamId: string, hardDelete = true): Promise<void> {
        try {
            await apiFetch('/api/subscriptions/delete', {
                method: 'POST',
                body: JSON.stringify({ streamId, hardDelete }),
            });
        } catch {
            await this.disableSubscription(streamId);
        }
    },

    /** Trigger immediate evaluation for a subscription */
    async runNow(streamId: string, force = false): Promise<RunNowResult> {
        const data = await apiFetch<{ ok: boolean; run?: RunNowResult } & Partial<RunNowResult>>('/api/subscriptions/run-now', {
            method: 'POST',
            body: JSON.stringify({ streamId, force }),
        });

        return data.run ?? {
            streamId: data.streamId ?? streamId,
            status: data.status ?? 'unknown',
            closedCandleTimeSec: data.closedCandleTimeSec,
            result: data.result,
        };
    },

    /** Trigger immediate subscription evaluation using caller-supplied candles. */
    async runWithCandles(streamId: string, candles: OHLCVData[], force = false): Promise<RunNowResult> {
        const data = await apiFetch<{ ok: boolean; run?: RunNowResult } & Partial<RunNowResult>>('/api/subscriptions/run-with-candles', {
            method: 'POST',
            body: JSON.stringify({ streamId, candles, force }),
        });

        return data.run ?? {
            streamId: data.streamId ?? streamId,
            status: data.status ?? 'unknown',
            closedCandleTimeSec: data.closedCandleTimeSec,
            result: data.result,
        };
    },

    /** Get signal history for a stream */
    async getSignalHistory(streamId: string, limit = 20): Promise<AlertSignalRecord[]> {
        const data = await apiFetch<{ ok: boolean; signals?: AlertSignalRecord[]; items?: AlertSignalRecord[] }>(
            `/api/stream/signals?streamId=${encodeURIComponent(streamId)}&limit=${limit}`
        );
        return data.items ?? data.signals ?? [];
    },

    /**
     * Read-only worker-side state for a subscription.
     * This endpoint evaluates current worker market data without mutating subscription state.
     */
    async getSubscriptionState(streamId: string): Promise<AlertSubscriptionState> {
        const data = await apiFetch<{ ok: boolean; state?: AlertSubscriptionState; item?: AlertSubscriptionState }>(
            `/api/subscriptions/state?streamId=${encodeURIComponent(streamId)}`
        );

        const state = data.state ?? data.item;
        if (!state) {
            throw new Error('Subscription state response missing payload.');
        }
        return state;
    },

    /**
     * Batched committee state. Reads precomputed `latest_state_json` written by
     * the cron, so cost is one request regardless of member count. Falls back
     * to N parallel getSubscriptionState calls if the batched endpoint is
     * missing (worker not yet redeployed) or returns an error.
     *
     * The request and fallback are both bounded by
     * `Math.min(streamIds.length, COMMITTEE_STATE_MAX_BATCH)`.
     */
    async getCommitteeState(streamIds: readonly string[]): Promise<CommitteeStateResult> {
        const limited = streamIds.slice(0, COMMITTEE_STATE_MAX_BATCH);
        if (limited.length === 0) {
            return { ok: true, scanned: 0, truncated: false, states: [] };
        }

        try {
            const data = await apiFetch<CommitteeStateResult>('/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: limited }),
            });
            return {
                ok: Boolean(data.ok),
                scanned: typeof data.scanned === "number" ? data.scanned : data.states?.length ?? 0,
                truncated: streamIds.length > COMMITTEE_STATE_MAX_BATCH || data.truncated === true,
                states: Array.isArray(data.states) ? data.states : [],
            };
        } catch {
            // Worker has not been redeployed with /api/subscriptions/states yet.
            // Degrade to N parallel on-demand state calls.
            const settled = await Promise.all(
                limited.map((streamId) =>
                    this.getSubscriptionState(streamId)
                        .then((state): CommitteeMemberState => ({
                            streamId: state.streamId,
                            ok: state.ok,
                            reason: state.reason,
                            symbol: state.symbol,
                            interval: state.interval,
                            strategyKey: state.strategyKey,
                            evaluatedAt: state.evaluatedAt,
                            closedCandleTimeSec: state.closedCandleTimeSec,
                            latestClose: state.latestClose ?? null,
                            latestTrade: state.latestTrade,
                            latestEntry: state.latestEntry,
                            lastStatus: null,
                            lastRunAt: null,
                            updatedAt: null,
                            committeeTag: null,
                        }))
                        .catch((error): CommitteeMemberState => ({
                            streamId,
                            ok: false,
                            reason: error instanceof Error ? error.message : String(error),
                            symbol: "",
                            interval: "",
                            strategyKey: "",
                            evaluatedAt: new Date().toISOString(),
                            closedCandleTimeSec: null,
                            latestClose: null,
                            latestTrade: null,
                            latestEntry: null,
                            lastStatus: null,
                            lastRunAt: null,
                            updatedAt: null,
                            committeeTag: null,
                        }))
                )
            );
            return {
                ok: true,
                scanned: limited.length,
                truncated: streamIds.length > COMMITTEE_STATE_MAX_BATCH,
                states: settled,
            };
        }
    },

    /** List all committee alert rules. Empty array on old workers. */
    async listCommitteeAlertRules(): Promise<CommitteeAlertRule[]> {
        try {
            const data = await apiFetch<{ ok: boolean; items?: CommitteeAlertRule[] }>('/api/committee-alert/rules');
            return data.items ?? [];
        } catch {
            return [];
        }
    },

    /**
     * Upsert a committee alert rule. Returns the persisted rule, or null if the
     * worker does not support the endpoint yet.
     */
    async upsertCommitteeAlertRule(rule: {
        committeeTag: string;
        enabled: boolean;
        longThreshold: number;
        shortThreshold: number;
    }): Promise<CommitteeAlertRule | null> {
        try {
            const data = await apiFetch<{ ok: boolean; item?: CommitteeAlertRule }>(
                '/api/committee-alert/rules',
                {
                    method: 'POST',
                    body: JSON.stringify(rule),
                }
            );
            return data.item ?? null;
        } catch {
            return null;
        }
    },
};
