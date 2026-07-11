import { evaluateLatestEntrySignal } from "../lib/signal-entry-evaluator";
import "../lib/strategies/library";
import type { BacktestSettings, OHLCVData } from "../lib/types/strategies";
import {
    intervalToSeconds,
    normalizeOhlcvCandles,
    resampleCandles,
    toBinanceInterval,
    translateIntervalForApiBase,
} from "../lib/binance-market-data-utils";
import {
    buildExecutionAwareCandleWindow,
    countClosedCandles,
    selectClosedCandleWindow,
} from "../lib/alert-evaluation-window";
import {
    buildStreamId as buildAlertStreamId,
    parseConfigNameFromStreamId as parseConfigNameFromAlertStreamId,
} from "../lib/alert-stream-id";
import {
    buildSyntheticPairFromLegs,
} from "../scripts/lib/synthetic-pair";
import {
    getWorkerStrategySupportSnapshot,
    isWorkerSupportedStrategyKey,
    resolveSubscriptionExecutionBacktestSettings,
} from "../lib/alert-subscription-utils";
import { PENDING_ENTRY_SIGNAL_REASON } from "../lib/alert-signal-utils";
import { resolveEntryRiskTargets } from "../lib/entry-risk-targets";

interface ScheduledController {
    scheduledTime: number | string;
    cron?: string;
}

interface D1Meta {
    changes?: number;
}

interface D1Result<T = unknown> {
    results?: T[];
    meta?: D1Meta;
}

interface D1PreparedStatement {
    bind(...values: unknown[]): D1PreparedStatement;
    first<T = unknown>(columnName?: string): Promise<T | null>;
    run<T = unknown>(): Promise<D1Result<T>>;
    all<T = unknown>(): Promise<D1Result<T>>;
}

interface D1Database {
    prepare(query: string): D1PreparedStatement;
}

interface Env {
    SIGNALS_DB: D1Database;
    TELEGRAM_BOT_TOKEN?: string;
    TELEGRAM_CHAT_ID?: string;
    MARKET_DATA_API_BASES?: string;
    BINANCE_API_BASES?: string;
    MIN_CLOSED_CANDLES?: string;
    WORKER_API_TOKEN?: string;
    /**
     * Optional base URL of a local candle proxy (e.g. a cloudflared tunnel to
     * the user's Vite dev server). When set, fetchCandlesViaProxy is tried
     * first for every leg; public exchanges are only used as a per-request
     * fallback. Works around Binance geo-blocking Cloudflare egress IPs.
     * The proxy must serve /api/sqlite/load-ohlcv?symbol=&interval=&limit=
     * with the same { ok, candles: OHLCVData[] } JSON shape and epoch-second
     * time values that the local SQLite cache returns.
     */
    LOCAL_CANDLE_PROXY_URL?: string;
    /** Shared secret sent as `Authorization: Bearer <token>` to the proxy. */
    LOCAL_CANDLE_PROXY_TOKEN?: string;
}

interface StreamSignalRequest {
    streamId?: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    configName?: string;
    strategyParams?: Record<string, number>;
    backtestSettings?: BacktestSettings;
    freshnessBars?: number;
    candles: Array<{
        time: unknown;
        open: unknown;
        high: unknown;
        low: unknown;
        close: unknown;
        volume: unknown;
    }>;
    notifyTelegram?: boolean;
}

interface SubscriptionUpsertRequest {
    streamId?: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    configName?: string;
    strategyParams?: Record<string, number>;
    backtestSettings?: BacktestSettings;
    freshnessBars?: number;
    notifyTelegram?: boolean;
    notifyExit?: boolean;
    enabled?: boolean;
    candleLimit?: number;
    committeeTag?: string | null;
}

interface SubscriptionRunWithCandlesRequest {
    streamId?: string;
    candles?: StreamSignalRequest["candles"];
    force?: boolean;
}

interface StoredSignalRow {
    id: number;
    stream_id: string;
    symbol: string;
    interval: string;
    strategy_key: string;
    direction: "long" | "short";
    signal_time: number;
    signal_price: number;
    signal_reason: string | null;
    payload_json: string;
    created_at: string;
}

interface StoredSignalPayload {
    streamId: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    strategyName: string;
    configName?: string;
    direction: "long" | "short";
    signalTimeSec: number;
    signalAgeBars: number;
    signalPrice: number;
    entryPrice?: number;
    signalReason: string | null;
    fingerprint: string;
    takeProfitPrice?: number;
    stopLossPrice?: number;
    takeProfitPercent?: number;
    stopLossPercent?: number;
}

interface SubscriptionRow {
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
    last_processed_candle_open_time: number;
    last_run_at: string | null;
    last_status: string | null;
    created_at: string;
    updated_at: string;
    latest_state_json: string | null;
    committee_tag: string | null;
}

interface ProcessSignalPayload {
    streamId: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    configName?: string;
    strategyParams: Record<string, number>;
    backtestSettings: BacktestSettings;
    freshnessBars: number;
    notifyTelegram: boolean;
    notifyExit: boolean;
    candles: OHLCVData[];
}

interface ProcessSignalResult {
    ok: boolean;
    newEntry: boolean;
    duplicate?: boolean;
    reason?: string;
    signalAgeBars?: number;
    rawSignalCount: number;
    preparedSignalCount: number;
    latestEntry?: unknown;
    entry?: StoredSignalPayload;
    telegramSent?: boolean;
    telegramError?: string;
    error?: string;
    /** The latest evaluated entry signal from the evaluation (may be null if no signals) */
    latestEvaluatedEntry?: {
        direction: "long" | "short";
        signalTimeSec: number;
        signalPrice: number;
        entryPrice: number;
        fingerprint: string;
        signal: { price: number };
    } | null;
    /**
     * Latest trade context from the evaluation (entry/exit timing, isOpen).
     * Surfaced so the cron can persist it into latest_state_json for the
     * batched state endpoint without re-running evaluateLatestEntrySignal.
     */
    latestTrade?: SubscriptionStateResult["latestTrade"];
    /**
     * Compact per-trade direction windows [entrySec, exitSec, dirSign] used by
     * the Signal Committee chart overlay to forward-fill historical votes.
     * Null when the strategy produced no trades.
     */
    tradeWindows?: Array<[number, number | null, 1 | -1]> | null;
}

interface SubscriptionStateResult {
    ok: boolean;
    streamId: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    evaluatedAt: string;
    closedCandleTimeSec: number | null;
    reason: string | null;
    latestClose: number | null;
    latestTrade: {
        entryTimeSec: number;
        entryPrice: number;
        exitReason: string | null;
        isOpen: boolean;
        takeProfitPrice: number | null;
        stopLossPrice: number | null;
        takeProfitPercent: number | null;
        stopLossPercent: number | null;
    } | null;
    latestEntry: {
        direction: "long" | "short";
        signalTimeSec: number;
        signalPrice: number;
        entryPrice?: number | null;
        signalAgeBars: number;
        isFresh: boolean;
        fingerprint: string;
    } | null;
}

interface SyntheticPairSettings {
    baseSymbol: string;
    quoteSymbol: string;
}

/**
 * Shape persisted in `signal_subscriptions.latest_state_json` by the cron
 * and read back by the batched `/api/subscriptions/states` endpoint. Must
 * stay forward-compatible: missing fields are tolerated by readers.
 */
interface StoredLatestState {
    evaluatedAt: string;
    closedCandleTimeSec: number | null;
    latestClose: number | null;
    reason: string | null;
    latestTrade: SubscriptionStateResult["latestTrade"];
    latestEntry: SubscriptionStateResult["latestEntry"];
    /**
     * Optional per-trade direction windows [entrySec, exitSec, dirSign] for the
     * Signal Committee historical chart overlay. Absent on old cron writes;
     * readers treat absence as "no historical vote data".
     */
    tradeWindows?: Array<[number, number | null, 1 | -1]> | null;
}

const DEFAULT_MIN_CANDLES = 200;
const MIN_CANDLES_LOWER_BOUND = 50;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_SUBSCRIPTION_CANDLE_LIMIT = 350;
const MAX_SUBSCRIPTION_CANDLE_LIMIT = 100000;
const MAX_BINANCE_KLINES_PER_REQUEST = 1000;
const STATUS_TEXT_MAX = 1200;
const RESPONSE_SNIPPET_MAX = 320;
// Keep scheduled runs aligned shortly after minute boundary.
// Cloudflare cron granularity is 1 minute, so second-level precision is done in code.
const SCHEDULE_TARGET_SECOND = 10;
const MAX_SCHEDULED_CONCURRENCY = 4;
const MAX_TELEGRAM_RETRIES = 5;
// Cap on per-subscription error records emitted in the scheduled cron log.
// Successful and skipped runs are aggregated into counts; only failures are
// sampled (with streamId) so operators can see actionable errors without the
// log growing linearly with total subscription count. See finding 5.
const SCHEDULED_LOG_MAX_ERRORS = 20;

function parseTelegramFailCount(status: string | null): number {
    if (!status) return 0;
    const match = /telegram_send_failed\[(\d+)]/.exec(status);
    if (match) return Number(match[1]);
    if (status.includes('telegram_send_failed')) return 1;
    return 0;
}
const DEFAULT_BINANCE_API_BASES = [
    // data-api.binance.vision is Binance's public data mirror: same instruments
    // as api.binance.com, not geo-blocked, no auth, and honors the full 1000
    // klines/request cap. Lead with it so synthetic-pair legs (e.g. ZECUSDT,
    // APTUSDT — Binance.com-only listings) resolve with deep history.
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
    "https://api.binance.us",
];

const CORS_HEADERS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
};
const BINANCE_FETCH_TIMEOUT_MS = 10_000;
const TELEGRAM_FETCH_TIMEOUT_MS = 8_000;

function toJsonResponse(payload: unknown, status = 200): Response {
    return new Response(JSON.stringify(payload), {
        status,
        headers: {
            "content-type": "application/json; charset=utf-8",
            ...CORS_HEADERS,
        },
    });
}

function toNoContentResponse(): Response {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
}

function isAuthRequired(env: Env): boolean {
    return typeof env.WORKER_API_TOKEN === "string" && env.WORKER_API_TOKEN.trim().length > 0;
}

function isAuthorizedRequest(request: Request, env: Env): boolean {
    if (!isAuthRequired(env)) return true;
    const expected = `Bearer ${env.WORKER_API_TOKEN!.trim()}`;
    return request.headers.get("authorization") === expected;
}

function toUnauthorizedResponse(): Response {
    return toJsonResponse({ ok: false, error: "Unauthorized" }, 401);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithTimeout(input: RequestInfo | URL, init: RequestInit, timeoutMs: number): Promise<Response> {
    const controller = new AbortController();
    let timedOut = false;
    const timeoutId = setTimeout(() => {
        timedOut = true;
        controller.abort();
    }, timeoutMs);
    const sourceSignal = init.signal;
    const abortFromSource = () => controller.abort();

    if (sourceSignal) {
        if (sourceSignal.aborted) {
            abortFromSource();
        } else {
            sourceSignal.addEventListener("abort", abortFromSource, { once: true });
        }
    }

    try {
        return await fetch(input, {
            ...init,
            signal: controller.signal,
        });
    } catch (error) {
        if (timedOut && !sourceSignal?.aborted) {
            throw new Error(`Fetch timed out after ${timeoutMs}ms.`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
        sourceSignal?.removeEventListener("abort", abortFromSource);
    }
}

function computeScheduleAlignmentDelayMs(
    scheduledTimeMs: number,
    targetSecond: number,
    nowMs: number = Date.now()
): number {
    if (!Number.isFinite(scheduledTimeMs)) return 0;
    const minuteStartMs = Math.floor(scheduledTimeMs / 60_000) * 60_000;
    const clampedSecond = Math.max(0, Math.min(59, Math.floor(targetSecond)));
    const targetMs = minuteStartMs + clampedSecond * 1000;
    const waitMs = targetMs - nowMs;
    return waitMs > 0 ? waitMs : 0;
}

function normalizeText(value: string): string {
    return value.trim();
}

function buildChannelKey(payload: {
    streamId?: string;
    symbol: string;
    interval: string;
    strategyKey: string;
}): string {
    if (payload.streamId && payload.streamId.trim()) {
        return payload.streamId.trim().toLowerCase();
    }
    return `${payload.symbol}:${payload.interval}:${payload.strategyKey}`.toLowerCase();
}

function buildDefaultStreamId(symbol: string, interval: string, strategyKey: string, configName?: string): string {
    return buildAlertStreamId(symbol, interval, strategyKey, configName);
}

function parseConfigNameFromStreamId(streamId: string): string | null {
    return parseConfigNameFromAlertStreamId(streamId);
}

function safeJsonParse<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
}

export function buildLatestActionableEntrySignalQuery(selectClause: string): string {
    return `SELECT ${selectClause} FROM entry_signals WHERE channel_key = ? AND COALESCE(signal_reason, '') != ? ORDER BY signal_time DESC, id DESC LIMIT 1`;
}

function normalizeStatusText(value: string, maxLen = STATUS_TEXT_MAX): string {
    const normalized = value.replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLen) return normalized;
    if (maxLen <= 3) return normalized.slice(0, maxLen);

    const truncated = normalized.slice(0, maxLen - 3);
    const lastSpaceIdx = truncated.lastIndexOf(" ");
    const compact = lastSpaceIdx > Math.floor((maxLen - 3) * 0.6)
        ? truncated.slice(0, lastSpaceIdx)
        : truncated;
    return `${compact}...`;
}

function extractExitAlertKey(status: string | null | undefined): string | null {
    if (!status) return null;
    const parts = status.split(";");
    for (const part of parts) {
        if (part.startsWith("exit_alert:")) {
            const value = part.slice("exit_alert:".length).trim();
            if (value) return value;
        }
    }
    return null;
}

function composeSubscriptionStatus(baseStatus: string, exitAlertKey: string | null): string {
    if (!exitAlertKey) return normalizeStatusText(baseStatus, STATUS_TEXT_MAX);

    const suffix = `;exit_alert:${exitAlertKey}`;
    const baseBudget = Math.max(32, STATUS_TEXT_MAX - suffix.length);
    const normalizedBase = normalizeStatusText(baseStatus, baseBudget);
    const raw = `${normalizedBase}${suffix}`;
    return normalizeStatusText(raw, STATUS_TEXT_MAX);
}

function readBinanceApiBases(env: Env): string[] {
    const configuredRaw = (env.MARKET_DATA_API_BASES ?? env.BINANCE_API_BASES ?? "");
    const configured = configuredRaw
        .split(",")
        .map((x) => x.trim().replace(/\/+$/, ""))
        .filter(Boolean);

    return configured.length > 0 ? configured : DEFAULT_BINANCE_API_BASES;
}

function readMinClosedCandles(env: Env): number {
    const parsed = Number(env.MIN_CLOSED_CANDLES);
    if (!Number.isFinite(parsed)) return DEFAULT_MIN_CANDLES;
    return Math.max(MIN_CANDLES_LOWER_BOUND, Math.floor(parsed));
}

function normalizeBinanceResponseSnippet(value: string): string {
    return value
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, RESPONSE_SNIPPET_MAX);
}

async function fetchBinanceCandles(
    symbol: string,
    interval: string,
    limit: number,
    env: Env
): Promise<OHLCVData[]> {
    const minClosedCandles = readMinClosedCandles(env);
    const requestedIntervalSec = intervalToSeconds(interval);
    // Always compose 2H from 1H candles so odd/even parity remains consistent
    // and does not rely on exchange-native 2H interval support.
    const useTwoHourResample = requestedIntervalSec === 7200;
    const sourceInterval = useTwoHourResample ? "1h" : interval;
    const binanceInterval = toBinanceInterval(sourceInterval);
    if (!binanceInterval) {
        throw new Error(`Unsupported interval for Binance: ${sourceInterval}`);
    }
    const clampedLimit = Math.max(minClosedCandles, Math.min(MAX_SUBSCRIPTION_CANDLE_LIMIT, Math.floor(limit)));
    // Pull one extra bar so, after dropping an in-progress candle, we still keep the configured minimum closed bars.
    const targetBarsWithSpare = Math.min(MAX_SUBSCRIPTION_CANDLE_LIMIT, clampedLimit + 1);
    const sourceLimit = useTwoHourResample
        ? Math.max(minClosedCandles, Math.min(MAX_SUBSCRIPTION_CANDLE_LIMIT, targetBarsWithSpare * 2 + 6))
        : targetBarsWithSpare;
    const bases = readBinanceApiBases(env);
    const endpointErrors: string[] = [];
    for (const base of bases) {
        const providerInterval = translateIntervalForApiBase(base, binanceInterval);
        if (!providerInterval) {
            endpointErrors.push(`${base} -> unsupported_interval:${binanceInterval}`);
            continue;
        }

        try {
            let endTimeMs: number | null = null;
            const collectedRows: Array<[number, string, string, string, string, string]> = [];

            while (collectedRows.length < sourceLimit) {
                const remaining = sourceLimit - collectedRows.length;
                const requestLimit = Math.max(1, Math.min(MAX_BINANCE_KLINES_PER_REQUEST, remaining));
                const timeQuery = typeof endTimeMs === "number" ? `&endTime=${endTimeMs}` : "";
                const endpoint = `${base}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(providerInterval)}&limit=${requestLimit}${timeQuery}`;

                const res = await fetchWithTimeout(endpoint, {
                    headers: {
                        accept: "application/json",
                        "user-agent": "strategy-entry-signal-worker/1.0",
                    },
                }, BINANCE_FETCH_TIMEOUT_MS);

                if (!res.ok) {
                    const body = normalizeBinanceResponseSnippet(await res.text());
                    throw new Error(`${base} -> ${res.status}${body ? ` ${body}` : ""}`);
                }

                const rows = (await res.json()) as Array<[number, string, string, string, string, string]>;
                if (!Array.isArray(rows) || rows.length === 0) {
                    break;
                }

                // Each paged request returns oldest->newest; prepend older pages.
                collectedRows.unshift(...rows);

                if (rows.length < requestLimit) {
                    break;
                }

                const oldestOpenMs = Number(rows[0]?.[0]);
                if (!Number.isFinite(oldestOpenMs) || oldestOpenMs <= 0) {
                    break;
                }
                endTimeMs = oldestOpenMs - 1;
            }

            if (collectedRows.length === 0) {
                throw new Error(`${base} -> empty_response`);
            }

            const sourceCandles = collectedRows.map((kline) => ({
                time: Math.floor(kline[0] / 1000) as OHLCVData["time"],
                open: Number(kline[1]),
                high: Number(kline[2]),
                low: Number(kline[3]),
                close: Number(kline[4]),
                volume: Number(kline[5]),
            }));

            if (!useTwoHourResample) {
                return sourceCandles.slice(-targetBarsWithSpare);
            }
            return resampleCandles(sourceCandles, interval, 3600).slice(-targetBarsWithSpare);
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            const normalized = detail.startsWith(`${base} ->`)
                ? normalizeStatusText(detail, 120)
                : `${base} -> ${normalizeStatusText(detail, 120)}`;
            endpointErrors.push(normalized);
        }
    }

    const summary = normalizeStatusText(endpointErrors.join(" | "), 900);
    throw new Error(`Binance API unavailable: ${summary || "all endpoints failed"}`);
}

async function fetchMarketCandles(
    symbol: string,
    interval: string,
    limit: number,
    env: Env
): Promise<OHLCVData[]> {
    const proxied = await fetchCandlesViaProxy(symbol, interval, limit, env);
    if (proxied !== null) return proxied;
    return fetchBinanceCandles(symbol, interval, limit, env);
}

/**
 * Try the user's local candle proxy (cloudflared tunnel → Vite dev server's
 * /api/sqlite/load-ohlcv). Returns the candles on success, or null when the
 * proxy is unconfigured, unreachable, returns an error, or has no bars for
 * the requested symbol. Never throws — callers fall back to public exchanges.
 *
 * The proxy is preferred because Binance geo-blocks Cloudflare egress IPs,
 * while the user's machine has unrestricted access and a durable SQLite
 * cache of the legs they actually trade.
 */
async function fetchCandlesViaProxy(
    symbol: string,
    interval: string,
    limit: number,
    env: Env
): Promise<OHLCVData[] | null> {
    const base = env.LOCAL_CANDLE_PROXY_URL?.trim();
    if (!base) return null;
    const trimmedBase = base.replace(/\/+$/, "");
    const token = env.LOCAL_CANDLE_PROXY_TOKEN?.trim();
    const url = `${trimmedBase}/api/sqlite/load-ohlcv`
        + `?symbol=${encodeURIComponent(symbol.toUpperCase())}`
        + `&interval=${encodeURIComponent(interval.toLowerCase())}`
        + `&limit=${Math.max(1, Math.floor(limit))}`;
    try {
        const res = await fetchWithTimeout(url, {
            headers: {
                accept: "application/json",
                ...(token ? { authorization: `Bearer ${token}` } : {}),
            },
        }, BINANCE_FETCH_TIMEOUT_MS);
        if (!res.ok) return null;
        const body = await res.json() as { ok?: boolean; candles?: unknown };
        if (!body || body.ok !== true || !Array.isArray(body.candles) || body.candles.length === 0) {
            return null;
        }
        const candles: OHLCVData[] = [];
        for (const row of body.candles) {
            if (!row || typeof row !== "object") continue;
            const r = row as Record<string, unknown>;
            const time = Number(r.time);
            const open = Number(r.open);
            const high = Number(r.high);
            const low = Number(r.low);
            const close = Number(r.close);
            const volume = Number(r.volume ?? 0);
            if (!Number.isFinite(time) || !Number.isFinite(open) || !Number.isFinite(close)) continue;
            candles.push({
                time: Math.floor(time) as OHLCVData["time"],
                open, high, low, close,
                volume: Number.isFinite(volume) ? volume : 0,
            });
        }
        return candles.length > 0 ? candles : null;
    } catch {
        return null;
    }
}

/**
 * Resolve a single leg via the local proxy when configured, falling back to
 * Binance public endpoints. Used for both plain-symbol and synthetic-pair
 * legs so the proxy benefits each leg independently.
 */
async function fetchCandlesForLeg(
    symbol: string,
    interval: string,
    limit: number,
    env: Env
): Promise<OHLCVData[]> {
    const proxied = await fetchCandlesViaProxy(symbol, interval, limit, env);
    if (proxied !== null) return proxied;
    return fetchBinanceCandles(symbol, interval, limit, env);
}

function readSyntheticPairSettings(settings: BacktestSettings): SyntheticPairSettings | null {
    const raw = (settings as Record<string, unknown>).syntheticPair;
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const candidate = raw as Record<string, unknown>;
    const baseSymbol = typeof candidate.baseSymbol === "string" ? normalizeText(candidate.baseSymbol).toUpperCase() : "";
    const quoteSymbol = typeof candidate.quoteSymbol === "string" ? normalizeText(candidate.quoteSymbol).toUpperCase() : "";
    if (!baseSymbol || !quoteSymbol || baseSymbol === quoteSymbol) return null;
    return { baseSymbol, quoteSymbol };
}

async function fetchSyntheticMarketCandles(
    syntheticPair: SyntheticPairSettings,
    interval: string,
    limit: number,
    env: Env
): Promise<OHLCVData[]> {
    const minClosedCandles = readMinClosedCandles(env);
    const targetLimit = Math.max(minClosedCandles + 2, Math.floor(limit));
    const result = await buildSyntheticPairFromLegs({
        baseSymbol: syntheticPair.baseSymbol,
        quoteSymbol: syntheticPair.quoteSymbol,
        interval,
        targetBars: targetLimit,
        fetchLeg: (symbol, sourceInterval, sourceBars) =>
            fetchCandlesForLeg(symbol, sourceInterval, sourceBars, env),
        tailSliceBars: targetLimit,
    });

    // Structured diagnostics so silent synthetic failures (rate-limited leg,
    // empty quote response, alignment collapse) are greppable in worker logs
    // instead of surfacing only as a generic "no candles" error downstream.
    // Mirrors the synth_* event names used by lib/data-mining-manager.ts so
    // UI and worker logs can be searched together.
    if (result.base.length === 0 || result.quote.length === 0) {
        console.error(JSON.stringify({
            event: "synth_worker_zero_data",
            base: syntheticPair.baseSymbol,
            quote: syntheticPair.quoteSymbol,
            interval,
            sourceInterval: result.sourceInterval,
            baseBars: result.base.length,
            quoteBars: result.quote.length,
        }));
    } else {
        console.log(JSON.stringify({
            event: "synth_worker_built",
            base: syntheticPair.baseSymbol,
            quote: syntheticPair.quoteSymbol,
            interval,
            sourceInterval: result.sourceInterval,
            baseBars: result.base.length,
            quoteBars: result.quote.length,
            alignedBars: result.meta.alignedBars,
            droppedBars: result.meta.droppedBars,
            outputBars: result.bars.length,
        }));
    }
    return result.bars;
}

function formatPercent(value: number): string {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
}

function buildTelegramMessage(signal: StoredSignalPayload): string {
    const icon = signal.direction === "long" ? "\u{1F7E2}" : "\u{1F534}";
    const configLabel = signal.configName ?? signal.strategyKey;
    const entryPrice = signal.entryPrice ?? signal.signalPrice;
    const lines = [
        `${icon} New Entry Signal`,
        `Symbol: ${signal.symbol}`,
        `Interval: ${signal.interval}`,
        `Configuration: ${configLabel}`,
        `Strategy: ${signal.strategyKey}`,
        `Direction: ${signal.direction.toUpperCase()}`,
        `Entry Price: ${entryPrice}`,
    ];
    if (signal.entryPrice != null && Math.abs(signal.signalPrice - signal.entryPrice) > Math.max(1e-8, Math.abs(signal.entryPrice) * 1e-8)) {
        lines.push(`Signal Price: ${signal.signalPrice}`);
    }
    if (signal.takeProfitPrice != null && signal.takeProfitPercent != null) {
        lines.push(`\u{1F3AF} Take Profit: ${signal.takeProfitPrice.toFixed(4)} (${formatPercent(signal.takeProfitPercent)})`);
    }
    if (signal.stopLossPrice != null && signal.stopLossPercent != null) {
        lines.push(`\u{1F6D1} Stop Loss: ${signal.stopLossPrice.toFixed(4)} (${formatPercent(-Math.abs(signal.stopLossPercent))})`);
    }
    lines.push(`Time (UTC): ${new Date(signal.signalTimeSec * 1000).toISOString()}`);
    if (signal.signalReason) lines.push(`Reason: ${signal.signalReason}`);
    return lines.join("\n");
}

function buildExitTelegramMessage(
    exitDirection: "long" | "short",
    symbol: string,
    interval: string,
    strategyKey: string,
    configName: string | null,
    price: number,
    timeSec: number
): string {
    const configLabel = configName ?? strategyKey;
    return [
        `\u{1F6AA} Exit Signal`,
        `Symbol: ${symbol}`,
        `Interval: ${interval}`,
        `Configuration: ${configLabel}`,
        `Strategy: ${strategyKey}`,
        `Closing: ${exitDirection.toUpperCase()} position`,
        `Price: ${price}`,
        `Time (UTC): ${new Date(timeSec * 1000).toISOString()}`,
    ].join("\n");
}

async function sendTelegramText(env: Env, text: string): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID secret");
    }

    const response = await fetchWithTimeout(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
    }, TELEGRAM_FETCH_TIMEOUT_MS);

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram send failed (${response.status}): ${detail}`);
    }
}

async function processSignalPayload(payload: ProcessSignalPayload, env: Env): Promise<ProcessSignalResult> {
    const minClosedCandles = readMinClosedCandles(env);
    if (payload.candles.length < minClosedCandles) {
        return {
            ok: false,
            newEntry: false,
            error: `Not enough candles. Need at least ${minClosedCandles}.`,
            rawSignalCount: 0,
            preparedSignalCount: 0,
        };
    }

    const symbol = normalizeText(payload.symbol).toUpperCase();
    const interval = normalizeText(payload.interval);
    const strategyKey = normalizeText(payload.strategyKey);
    const streamId = normalizeText(payload.streamId);
    const configName = (payload.configName ?? parseConfigNameFromStreamId(streamId) ?? "").trim() || null;
    const channelKey = buildChannelKey({ streamId, symbol, interval, strategyKey });

    const evaluation = evaluateLatestEntrySignal({
        strategyKey,
        candles: payload.candles,
        strategyParams: payload.strategyParams,
        backtestSettings: payload.backtestSettings,
        freshnessBars: payload.freshnessBars,
    });

    if (!evaluation.ok) {
        return {
            ok: false,
            newEntry: false,
            error: evaluation.reason ?? "evaluation_failed",
            rawSignalCount: evaluation.rawSignalCount,
            preparedSignalCount: evaluation.preparedSignalCount,
            latestEvaluatedEntry: null,
        };
    }

    if (!evaluation.latestEntry) {
        return {
            ok: true,
            newEntry: false,
            reason: evaluation.reason ?? "no_signals",
            rawSignalCount: evaluation.rawSignalCount,
            preparedSignalCount: evaluation.preparedSignalCount,
            latestTrade: evaluation.latestTrade ?? null,
            tradeWindows: evaluation.tradeWindows ?? null,
        };
    }

    const evaluatedEntryPrice = evaluation.latestTrade?.entryPrice ?? evaluation.latestEntry.signal.price;

    if (!evaluation.latestEntry.isFresh) {
        const staleOpenTrade = evaluation.latestTrade?.isOpen === true;
        if (!staleOpenTrade) {
            return {
                ok: true,
                newEntry: false,
                reason: "stale_signal",
                signalAgeBars: evaluation.latestEntry.signalAgeBars,
                rawSignalCount: evaluation.rawSignalCount,
                preparedSignalCount: evaluation.preparedSignalCount,
                latestEntry: evaluation.latestEntry,
                latestTrade: evaluation.latestTrade ?? null,
                tradeWindows: evaluation.tradeWindows ?? null,
                latestEvaluatedEntry: {
                    direction: evaluation.latestEntry.direction,
                    signalTimeSec: evaluation.latestEntry.signalTimeSec,
                    signalPrice: evaluation.latestEntry.signal.price,
                    entryPrice: evaluatedEntryPrice,
                    fingerprint: evaluation.latestEntry.fingerprint,
                    signal: { price: evaluation.latestEntry.signal.price },
                },
            };
        }

        // One-time catch-up: if stream has an active open trade but no prior entry
        // record, allow the stale entry to be inserted/sent once.
        const existingEntry = await env.SIGNALS_DB.prepare(
            buildLatestActionableEntrySignalQuery("id")
        )
            .bind(channelKey, PENDING_ENTRY_SIGNAL_REASON)
            .first<{ id: number }>();

        if (existingEntry) {
            return {
                ok: true,
                newEntry: false,
                reason: "stale_signal",
                signalAgeBars: evaluation.latestEntry.signalAgeBars,
                rawSignalCount: evaluation.rawSignalCount,
                preparedSignalCount: evaluation.preparedSignalCount,
                latestTrade: evaluation.latestTrade ?? null,
                tradeWindows: evaluation.tradeWindows ?? null,
                latestEvaluatedEntry: {
                    direction: evaluation.latestEntry.direction,
                    signalTimeSec: evaluation.latestEntry.signalTimeSec,
                    signalPrice: evaluation.latestEntry.signal.price,
                    entryPrice: evaluatedEntryPrice,
                    fingerprint: evaluation.latestEntry.fingerprint,
                    signal: { price: evaluation.latestEntry.signal.price },
                },
                latestEntry: evaluation.latestEntry,
            };
        }
    }

    // Compute TP/SL target prices from backtest settings.
    const bs = payload.backtestSettings;
    const riskTargets = resolveEntryRiskTargets({
        candles: payload.candles,
        entryTime: evaluation.latestEntry.signal.time,
        entryPrice: evaluatedEntryPrice,
        direction: evaluation.latestEntry.direction,
        settings: bs,
        entryBarIndex: Number.isFinite(evaluation.latestEntry.signal.barIndex)
            ? Math.trunc(evaluation.latestEntry.signal.barIndex as number)
            : null,
    });
    const evaluatedTrade = evaluation.latestTrade;

    const entryPayload: StoredSignalPayload = {
        streamId,
        symbol,
        interval,
        strategyKey,
        strategyName: evaluation.latestEntry.strategyName,
        configName: configName ?? undefined,
        direction: evaluation.latestEntry.direction,
        signalTimeSec: evaluation.latestEntry.signalTimeSec,
        signalAgeBars: evaluation.latestEntry.signalAgeBars,
        signalPrice: evaluation.latestEntry.signal.price,
        entryPrice: evaluatedEntryPrice,
        signalReason: evaluation.latestEntry.signal.reason ?? null,
        fingerprint: evaluation.latestEntry.fingerprint,
        takeProfitPrice: evaluatedTrade?.takeProfitPrice ?? riskTargets.takeProfitPrice ?? undefined,
        stopLossPrice: evaluatedTrade?.stopLossPrice ?? riskTargets.stopLossPrice ?? undefined,
        takeProfitPercent: evaluatedTrade?.takeProfitPercent ?? riskTargets.takeProfitPercent ?? undefined,
        stopLossPercent: evaluatedTrade?.stopLossPercent ?? riskTargets.stopLossPercent ?? undefined,
    };

    const dedupeKey = `${channelKey}:${evaluation.latestEntry.fingerprint}`;
    const insert = await env.SIGNALS_DB.prepare(
        `
        INSERT INTO entry_signals (
            channel_key,
            dedupe_key,
            stream_id,
            symbol,
            interval,
            strategy_key,
            direction,
            signal_time,
            signal_price,
            signal_reason,
            payload_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(dedupe_key) DO NOTHING
        `
    )
        .bind(
            channelKey,
            dedupeKey,
            entryPayload.streamId,
            symbol,
            interval,
            strategyKey,
            entryPayload.direction,
            entryPayload.signalTimeSec,
            entryPayload.signalPrice,
            entryPayload.signalReason,
            JSON.stringify(entryPayload)
        )
        .run();

    const inserted = (insert.meta?.changes ?? 0) > 0;
    let telegramSent: boolean | undefined;
    let telegramError: string | undefined;

    if (inserted && payload.notifyTelegram) {
        try {
            await sendTelegramText(env, buildTelegramMessage(entryPayload));
            telegramSent = true;
        } catch (error) {
            telegramSent = false;
            telegramError = error instanceof Error ? error.message : String(error);
            // Keep dedupe open so retries can resend when Telegram recovers.
            // Issue #3 fix: Wrap delete in try-catch with logging to handle crash-recovery scenario.
            try {
                await env.SIGNALS_DB.prepare(`DELETE FROM entry_signals WHERE dedupe_key = ?`)
                    .bind(dedupeKey)
                    .run();
            } catch (deleteError) {
                // Log for manual intervention - row exists but Telegram failed.
                const deleteMsg = deleteError instanceof Error ? deleteError.message : String(deleteError);
                console.error(JSON.stringify({
                    event: "telegram_delete_failed",
                    dedupeKey,
                    streamId: entryPayload.streamId,
                    telegramError,
                    deleteError: deleteMsg,
                }));
            }

            return {
                ok: false,
                newEntry: false,
                error: `telegram_send_failed:${normalizeStatusText(telegramError, 240)}`,
                rawSignalCount: evaluation.rawSignalCount,
                preparedSignalCount: evaluation.preparedSignalCount,
                entry: entryPayload,
                telegramSent,
                telegramError,
            };
        }
    }

    return {
        ok: true,
        newEntry: inserted,
        duplicate: !inserted,
        telegramSent,
        telegramError,
        entry: entryPayload,
        rawSignalCount: evaluation.rawSignalCount,
        preparedSignalCount: evaluation.preparedSignalCount,
        latestTrade: evaluation.latestTrade ?? null,
        tradeWindows: evaluation.tradeWindows ?? null,
        latestEvaluatedEntry: evaluation.latestEntry
            ? {
                direction: evaluation.latestEntry.direction,
                signalTimeSec: evaluation.latestEntry.signalTimeSec,
                signalPrice: evaluation.latestEntry.signal.price,
                entryPrice: evaluatedEntryPrice,
                fingerprint: evaluation.latestEntry.fingerprint,
                signal: { price: evaluation.latestEntry.signal.price },
            }
            : null,
    };
}

async function handleStreamSignal(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    let payload: StreamSignalRequest;
    try {
        payload = (await request.json()) as StreamSignalRequest;
    } catch {
        return toJsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
    }

    if (!payload || !payload.symbol || !payload.interval || !payload.strategyKey || !Array.isArray(payload.candles)) {
        return toJsonResponse(
            {
                ok: false,
                error: "Required fields: symbol, interval, strategyKey, candles[]",
            },
            400
        );
    }

    if (!isWorkerSupportedStrategyKey(payload.strategyKey)) {
        return toJsonResponse(
            { ok: false, error: `worker_strategy_not_supported:${payload.strategyKey}` },
            400
        );
    }

    const normalizedCandles = normalizeOhlcvCandles(payload.candles);
    const streamId = payload.streamId
        ? normalizeText(payload.streamId)
        : buildDefaultStreamId(payload.symbol.toUpperCase(), payload.interval, payload.strategyKey, payload.configName);

    const result = await processSignalPayload(
        {
            streamId,
            symbol: payload.symbol,
            interval: payload.interval,
            strategyKey: payload.strategyKey,
            configName: payload.configName,
            strategyParams: payload.strategyParams ?? {},
            backtestSettings: payload.backtestSettings ?? {},
            freshnessBars: Math.max(0, Math.floor(payload.freshnessBars ?? 1)),
            notifyTelegram: payload.notifyTelegram === true,
            notifyExit: false,
            candles: normalizedCandles,
        },
        env
    );

    const status = result.ok ? 200 : 422;
    return toJsonResponse(result, status);
}

async function handleSignalHistory(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    const url = new URL(request.url);
    const streamId = url.searchParams.get("streamId")?.trim();
    const symbol = url.searchParams.get("symbol")?.trim().toUpperCase();
    const interval = url.searchParams.get("interval")?.trim();
    const strategyKey = url.searchParams.get("strategyKey")?.trim();
    const requestedLimit = Number(url.searchParams.get("limit"));
    const limit = Number.isFinite(requestedLimit)
        ? Math.max(1, Math.min(MAX_LIMIT, Math.floor(requestedLimit)))
        : DEFAULT_LIMIT;

    const channelKey =
        streamId && streamId.length > 0
            ? streamId.toLowerCase()
            : symbol && interval && strategyKey
                ? buildChannelKey({ symbol, interval, strategyKey })
                : null;

    if (!channelKey) {
        return toJsonResponse(
            {
                ok: false,
                error: "Provide streamId or (symbol, interval, strategyKey).",
            },
            400
        );
    }

    const result = await env.SIGNALS_DB.prepare(
        `
        SELECT
            id,
            stream_id,
            symbol,
            interval,
            strategy_key,
            direction,
            signal_time,
            signal_price,
            signal_reason,
            payload_json,
            created_at
        FROM entry_signals
        WHERE channel_key = ?
        ORDER BY signal_time DESC, id DESC
        LIMIT ?
        `
    )
        .bind(channelKey, limit)
        .all<StoredSignalRow>();

    const rows = result.results ?? [];

    return toJsonResponse({
        ok: true,
        count: rows.length,
        items: rows.map((row) => ({
            ...row,
            payload: safeJsonParse(row.payload_json, null as unknown),
        })),
        // Backward compatibility with older frontend clients.
        signals: rows.map((row) => ({
            ...row,
            payload: safeJsonParse(row.payload_json, null as unknown),
        })),
    });
}

async function handleSubscriptionUpsert(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    let payload: SubscriptionUpsertRequest;
    try {
        payload = (await request.json()) as SubscriptionUpsertRequest;
    } catch {
        return toJsonResponse({ ok: false, error: "Invalid JSON body" }, 400);
    }

    const incomingStreamId = payload.streamId ? normalizeText(payload.streamId) : "";
    const existing = incomingStreamId
        ? await env.SIGNALS_DB.prepare(`SELECT * FROM signal_subscriptions WHERE stream_id = ? LIMIT 1`)
            .bind(incomingStreamId)
            .first<SubscriptionRow>()
        : null;

    const symbol = payload.symbol
        ? normalizeText(payload.symbol).toUpperCase()
        : existing?.symbol;
    const interval = payload.interval
        ? normalizeText(payload.interval)
        : existing?.interval;
    const strategyKey = payload.strategyKey
        ? normalizeText(payload.strategyKey)
        : existing?.strategy_key;

    if (!symbol || !interval || !strategyKey) {
        return toJsonResponse(
            { ok: false, error: "Required fields: symbol, interval, strategyKey" },
            400
        );
    }
    if (!isWorkerSupportedStrategyKey(strategyKey)) {
        return toJsonResponse(
            { ok: false, error: `worker_strategy_not_supported:${strategyKey}` },
            400
        );
    }

    const streamId = incomingStreamId
        ? incomingStreamId
        : buildDefaultStreamId(symbol, interval, strategyKey, payload.configName);
    const enabled = payload.enabled === undefined
        ? existing?.enabled ?? 1
        : payload.enabled === false ? 0 : 1;
    const notifyTelegram = payload.notifyTelegram === undefined
        ? existing?.notify_telegram ?? 1
        : payload.notifyTelegram === false ? 0 : 1;
    const notifyExit = payload.notifyExit === undefined
        ? existing?.notify_exit ?? 0
        : payload.notifyExit === true ? 1 : 0;
    const freshnessBars = Math.max(
        0,
        Math.floor(payload.freshnessBars ?? existing?.freshness_bars ?? 1)
    );
    const minClosedCandles = readMinClosedCandles(env);
    const candleLimit = Math.max(
        minClosedCandles,
        Math.min(
            MAX_SUBSCRIPTION_CANDLE_LIMIT,
            Math.floor(payload.candleLimit ?? existing?.candle_limit ?? DEFAULT_SUBSCRIPTION_CANDLE_LIMIT)
        )
    );
    const strategyParams = payload.strategyParams
        ?? safeJsonParse(existing?.strategy_params_json ?? "{}", {} as Record<string, number>);
    const backtestSettings = resolveSubscriptionExecutionBacktestSettings(
        (payload.backtestSettings
        ?? safeJsonParse(existing?.backtest_settings_json ?? "{}", {} as BacktestSettings)) as BacktestSettings
    );
    // committee_tag: null/undefined payload value preserves the existing tag
    // (so Alerts-tab re-upserts of a tagged subscription do not silently untag it).
    // An explicit empty string clears the tag.
    const committeeTagRaw = payload.committeeTag === undefined ? existing?.committee_tag : payload.committeeTag;
    const committeeTag = typeof committeeTagRaw === "string" && committeeTagRaw.trim().length > 0
        ? normalizeText(committeeTagRaw)
        : null;

    try {
        await env.SIGNALS_DB.prepare(
            `
            INSERT INTO signal_subscriptions (
                stream_id,
                enabled,
                symbol,
                interval,
                strategy_key,
                strategy_params_json,
                backtest_settings_json,
                freshness_bars,
                notify_telegram,
                notify_exit,
                candle_limit,
                committee_tag,
                last_processed_candle_open_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
            ON CONFLICT(stream_id) DO UPDATE SET
                enabled = excluded.enabled,
                symbol = excluded.symbol,
                interval = excluded.interval,
                strategy_key = excluded.strategy_key,
                strategy_params_json = excluded.strategy_params_json,
                backtest_settings_json = excluded.backtest_settings_json,
                freshness_bars = excluded.freshness_bars,
                notify_telegram = excluded.notify_telegram,
                notify_exit = excluded.notify_exit,
                candle_limit = excluded.candle_limit,
                committee_tag = excluded.committee_tag,
                updated_at = CURRENT_TIMESTAMP
            `
        )
            .bind(
                streamId,
                enabled,
                symbol,
                interval,
                strategyKey,
                JSON.stringify(strategyParams),
                JSON.stringify(backtestSettings),
                freshnessBars,
                notifyTelegram,
                notifyExit,
                candleLimit,
                committeeTag
            )
            .run();

        const subscription = await env.SIGNALS_DB.prepare(
            `SELECT * FROM signal_subscriptions WHERE stream_id = ? LIMIT 1`
        )
            .bind(streamId)
            .first<SubscriptionRow>();

        return toJsonResponse({
            ok: true,
            streamId,
            subscription,
        });
    } catch (error) {
        const detail = normalizeStatusText(error instanceof Error ? error.message : String(error), 260);
        return toJsonResponse(
            {
                ok: false,
                error: `subscription_upsert_failed:${detail}`,
                streamId,
            },
            500
        );
    }
}

async function handleSubscriptionList(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    const url = new URL(request.url);
    const committeeOnly = url.searchParams.get("committee") === "1";

    const result = committeeOnly
        ? await env.SIGNALS_DB.prepare(
            `SELECT * FROM signal_subscriptions WHERE committee_tag IS NOT NULL ORDER BY updated_at DESC LIMIT 500`
        ).all<SubscriptionRow>()
        : await env.SIGNALS_DB.prepare(
            `SELECT * FROM signal_subscriptions ORDER BY updated_at DESC LIMIT 500`
        ).all<SubscriptionRow>();

    return toJsonResponse({
        ok: true,
        count: (result.results ?? []).length,
        items: result.results ?? [],
    });
}

async function handleSubscriptionDelete(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const payload = body as { streamId?: string; hardDelete?: boolean };
    const streamId = payload.streamId?.trim();
    if (!streamId) {
        return toJsonResponse({ ok: false, error: "streamId is required" }, 400);
    }

    if (payload.hardDelete === true) {
        // Read subscription before deleting so we can also delete entry_signals that were
        // written under the bare channel key (symbol:interval:strategyKey) — which happens
        // when signals are posted via /api/stream/signal without an explicit streamId.
        const subForDelete = await env.SIGNALS_DB.prepare(
            `SELECT symbol, interval, strategy_key FROM signal_subscriptions WHERE stream_id = ? LIMIT 1`
        )
            .bind(streamId)
            .first<{ symbol: string; interval: string; strategy_key: string }>();

        const subsDelete = await env.SIGNALS_DB.prepare(
            `DELETE FROM signal_subscriptions WHERE stream_id = ?`
        )
            .bind(streamId)
            .run();

        const channelKey = streamId.toLowerCase();
        const bareKey = subForDelete
            ? `${subForDelete.symbol}:${subForDelete.interval}:${subForDelete.strategy_key}`.toLowerCase()
            : null;

        const signalsDelete = bareKey && bareKey !== channelKey
            ? await env.SIGNALS_DB.prepare(
                `DELETE FROM entry_signals WHERE stream_id = ? OR channel_key = ? OR channel_key = ?`
            )
                .bind(streamId, channelKey, bareKey)
                .run()
            : await env.SIGNALS_DB.prepare(
                `DELETE FROM entry_signals WHERE stream_id = ? OR channel_key = ?`
            )
                .bind(streamId, channelKey)
                .run();

        return toJsonResponse({
            ok: true,
            mode: "hard_delete",
            streamId,
            deleted: (subsDelete.meta?.changes ?? 0) > 0,
            subscriptionsDeleted: subsDelete.meta?.changes ?? 0,
            signalsDeleted: signalsDelete.meta?.changes ?? 0,
        });
    }

    const existing = await env.SIGNALS_DB.prepare(
        `SELECT last_status FROM signal_subscriptions WHERE stream_id = ? LIMIT 1`
    )
        .bind(streamId)
        .first<{ last_status: string | null }>();
    const status = composeSubscriptionStatus("disabled", extractExitAlertKey(existing?.last_status));

    const disabled = await env.SIGNALS_DB.prepare(
        `
        UPDATE signal_subscriptions
        SET
            enabled = 0,
            last_run_at = CURRENT_TIMESTAMP,
            last_status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE stream_id = ?
        `
    )
        .bind(status, streamId)
        .run();

    return toJsonResponse({
        ok: true,
        mode: "soft_disable",
        streamId,
        disabled: (disabled.meta?.changes ?? 0) > 0,
        subscriptionsDisabled: disabled.meta?.changes ?? 0,
        signalsDeleted: 0,
    });
}

function shouldPollSubscriptionOnSchedule(
    subscription: SubscriptionRow,
    nowSec: number = Math.floor(Date.now() / 1000)
): boolean {
    const intervalSeconds = intervalToSeconds(subscription.interval);
    if (!intervalSeconds || intervalSeconds <= 0) return true;

    const lastProcessedOpenTimeSec = Number(subscription.last_processed_candle_open_time ?? 0);
    if (!Number.isFinite(lastProcessedOpenTimeSec) || lastProcessedOpenTimeSec <= 0) return true;

    // last_processed_closed_candle_time stores candle OPEN time.
    // The processed candle closes at lastProcessedOpenTimeSec + intervalSeconds.
    // The next candle opens at that same time and closes one more interval later.
    // Poll slightly before that close so we never miss boundary candles due to
    // timing jitter, API propagation delay, or exchange clock skew.
    // The extra API calls are cheap  runSubscription short-circuits immediately
    // if no new closed candle exists (closedCandleTimeSec <= last_processed).
    const EARLY_POLL_GRACE_SEC = 60;
    const nextPossibleNewClosedCandleSec =
        lastProcessedOpenTimeSec + intervalSeconds * 2 - EARLY_POLL_GRACE_SEC;
    return nowSec >= nextPossibleNewClosedCandleSec;
}

async function updateSubscriptionStatus(
    env: Env,
    streamId: string,
    status: string,
    closedCandleTimeSec?: number
): Promise<void> {
    const safeStatus = normalizeStatusText(status);

    if (typeof closedCandleTimeSec === "number") {
        await env.SIGNALS_DB.prepare(
            `
            UPDATE signal_subscriptions
            SET
                last_processed_candle_open_time = ?,
                last_run_at = CURRENT_TIMESTAMP,
                last_status = ?,
                updated_at = CURRENT_TIMESTAMP
            WHERE stream_id = ?
            `
        )
            .bind(closedCandleTimeSec, safeStatus, streamId)
            .run();
        return;
    }

    await env.SIGNALS_DB.prepare(
        `
        UPDATE signal_subscriptions
        SET
            last_run_at = CURRENT_TIMESTAMP,
            last_status = ?,
            updated_at = CURRENT_TIMESTAMP
        WHERE stream_id = ?
        `
    )
        .bind(safeStatus, streamId)
        .run();
}

/**
 * Best-effort write of the latest evaluation state into
 * `signal_subscriptions.latest_state_json`. Called from the cron after every
 * due evaluation so the batched `/api/subscriptions/states` endpoint can
 * serve cached state without re-running `evaluateLatestEntrySignal` per
 * stream. Failures are swallowed and logged: the cron's signal-insert path
 * must never regress because of a state-write failure.
 */
async function persistLatestSubscriptionState(
    env: Env,
    streamId: string,
    state: StoredLatestState
): Promise<void> {
    try {
        await env.SIGNALS_DB.prepare(
            `UPDATE signal_subscriptions SET latest_state_json = ? WHERE stream_id = ?`
        )
            .bind(JSON.stringify(state), streamId)
            .run();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        console.error(JSON.stringify({
            event: "latest_state_persist_failed",
            streamId,
            error: detail,
        }));
    }
}

type SubscriptionCandleContext = {
    parsedStrategyParams: Record<string, number>;
    parsedBacktestSettings: BacktestSettings;
    closed: NonNullable<ReturnType<typeof selectClosedCandleWindow>>;
    evaluationCandles: OHLCVData[];
    latestClose: number | null;
};

function readLatestClose(candles: readonly OHLCVData[]): number | null {
    const latest = candles[candles.length - 1] ?? null;
    const close = latest ? Number(latest.close) : NaN;
    return Number.isFinite(close) ? close : null;
}

async function evaluateSubscriptionWithCandles(
    env: Env,
    subscription: SubscriptionRow,
    candles: OHLCVData[],
    force = false
): Promise<Record<string, unknown>> {
    const streamId = subscription.stream_id;
    const parsedStrategyParams = safeJsonParse(subscription.strategy_params_json, {} as Record<string, number>);
    const parsedBacktestSettings = resolveSubscriptionExecutionBacktestSettings(
        safeJsonParse(subscription.backtest_settings_json, {} as BacktestSettings)
    );
    const minClosedCandles = readMinClosedCandles(env);
    const nowSec = Math.floor(Date.now() / 1000);
    const closed = selectClosedCandleWindow(candles, subscription.interval, nowSec, minClosedCandles);
    if (!closed) {
        const closedCount = countClosedCandles(candles, subscription.interval, nowSec);
        const status = `insufficient_candles:${closedCount}/${minClosedCandles}`;
        await updateSubscriptionStatus(env, streamId, status);
        await persistLatestSubscriptionState(env, streamId, {
            evaluatedAt: new Date().toISOString(),
            closedCandleTimeSec: null,
            latestClose: null,
            reason: status,
            latestTrade: null,
            tradeWindows: null,
            latestEntry: null,
        });
        return { streamId, status };
    }

    if (!force && closed.closedCandleTimeSec <= (subscription.last_processed_candle_open_time || 0)) {
        const status = "no_new_closed_candle";
        await updateSubscriptionStatus(env, streamId, status);
        return { streamId, status, closedCandleTimeSec: closed.closedCandleTimeSec };
    }

    const evaluationCandles = buildExecutionAwareCandleWindow(
        closed.candles,
        closed.nextOpenCandle,
        parsedBacktestSettings
    );
    const subscriptionFreshnessBars = Math.max(0, subscription.freshness_bars ?? 1);
    const result = await processSignalPayload(
        {
            streamId,
            symbol: subscription.symbol,
            interval: subscription.interval,
            strategyKey: subscription.strategy_key,
            configName: parseConfigNameFromStreamId(streamId) ?? undefined,
            strategyParams: parsedStrategyParams,
            backtestSettings: parsedBacktestSettings,
            freshnessBars: subscriptionFreshnessBars,
            notifyTelegram: false,
            notifyExit: false,
            candles: evaluationCandles,
        },
        env
    );

    const baseStatus = result.ok
        ? result.newEntry ? "new_entry" : (result.reason ?? "no_entry")
        : result.error ?? "processing_error";
    const status = composeSubscriptionStatus(baseStatus, extractExitAlertKey(subscription.last_status));
    const latestCloseValue = readLatestClose(candles);
    const evaluatedEntry = result.latestEvaluatedEntry;
    await updateSubscriptionStatus(env, streamId, status, result.ok ? closed.closedCandleTimeSec : undefined);
    await persistLatestSubscriptionState(env, streamId, {
        evaluatedAt: new Date().toISOString(),
        closedCandleTimeSec: closed.closedCandleTimeSec,
        latestClose: latestCloseValue,
        reason: result.reason ?? result.error ?? null,
        latestTrade: result.latestTrade ?? null,
        tradeWindows: result.tradeWindows ?? null,
        latestEntry: evaluatedEntry
            ? {
                direction: evaluatedEntry.direction,
                signalTimeSec: evaluatedEntry.signalTimeSec,
                signalPrice: evaluatedEntry.signalPrice,
                entryPrice: evaluatedEntry.entryPrice ?? null,
                signalAgeBars: result.signalAgeBars ?? 0,
                isFresh: true,
                fingerprint: evaluatedEntry.fingerprint,
            }
            : null,
    });

    return { streamId, status, closedCandleTimeSec: closed.closedCandleTimeSec, result };
}

async function buildSubscriptionCandleContext(
    env: Env,
    subscription: SubscriptionRow
): Promise<
    | { ok: true; context: SubscriptionCandleContext }
    | { ok: false; reason: string; closedCandleTimeSec: null }
> {
    const parsedStrategyParams = safeJsonParse(subscription.strategy_params_json, {} as Record<string, number>);
    const parsedBacktestSettings = resolveSubscriptionExecutionBacktestSettings(
        safeJsonParse(subscription.backtest_settings_json, {} as BacktestSettings)
    );
    const minClosedCandles = readMinClosedCandles(env);
    const syntheticPair = readSyntheticPairSettings(parsedBacktestSettings);
    const candleLimit = subscription.candle_limit || DEFAULT_SUBSCRIPTION_CANDLE_LIMIT;
    const candles = syntheticPair
        ? await fetchSyntheticMarketCandles(syntheticPair, subscription.interval, candleLimit, env)
        : await fetchMarketCandles(
            subscription.symbol,
            subscription.interval,
            candleLimit,
            env
        );

    const nowSec = Math.floor(Date.now() / 1000);
    const closed = selectClosedCandleWindow(candles, subscription.interval, nowSec, minClosedCandles);
    if (!closed) {
        const closedCount = countClosedCandles(candles, subscription.interval, nowSec);
        return {
            ok: false,
            reason: `insufficient_candles:${closedCount}/${minClosedCandles}`,
            closedCandleTimeSec: null,
        };
    }

    return {
        ok: true,
        context: {
            parsedStrategyParams,
            parsedBacktestSettings,
            closed,
            evaluationCandles: buildExecutionAwareCandleWindow(
                closed.candles,
                closed.nextOpenCandle,
                parsedBacktestSettings
            ),
            latestClose: readLatestClose(candles),
        },
    };
}

async function runSubscription(
    env: Env,
    subscription: SubscriptionRow,
    force = false
): Promise<Record<string, unknown>> {
    const streamId = subscription.stream_id;
    const lastExitAlertKey = extractExitAlertKey(subscription.last_status);
    let persistedExitAlertKey: string | null = lastExitAlertKey;
    const subscriptionFreshnessBars = Math.max(0, subscription.freshness_bars ?? 1);
    const effectiveFreshnessBars = force
        ? Math.max(subscriptionFreshnessBars, subscription.candle_limit || DEFAULT_SUBSCRIPTION_CANDLE_LIMIT)
        : subscriptionFreshnessBars;
    const prevTelegramFailCount = parseTelegramFailCount(subscription.last_status);
    const telegramRetriesExhausted = prevTelegramFailCount >= MAX_TELEGRAM_RETRIES;
    // Synthetic members can't self-recover from a Binance fetch failure: their
    // only recovery path is a manual "Sync Synthetic Legs", which pushes locally-
    // built synthetic candles via runWithCandles and never hits Binance. Wiping
    // latest_state_json on such a failure would blind the committee with no
    // cron-side recovery. Instead we keep serving the last good snapshot
    // (direction + tradeWindows) until the next manual sync; the error is still
    // surfaced via last_status so the row shows WHY the snapshot is stale.
    // Real-symbol members keep the original wipe behavior: they have no manual
    // recovery, so a stale-but-ok snapshot would mislead.
    const isSyntheticMember = readSyntheticPairSettings(
        resolveSubscriptionExecutionBacktestSettings(
            safeJsonParse(subscription.backtest_settings_json, {} as BacktestSettings)
        )
    ) !== null;

    try {
        const prepared = await buildSubscriptionCandleContext(env, subscription);
        if (!prepared.ok) {
            const status = composeSubscriptionStatus(prepared.reason, persistedExitAlertKey);
            await updateSubscriptionStatus(env, streamId, status);
            if (!isSyntheticMember) {
                await persistLatestSubscriptionState(env, streamId, {
                    evaluatedAt: new Date().toISOString(),
                    closedCandleTimeSec: null,
                    latestClose: null,
                    reason: prepared.reason,
                    latestTrade: null,
                    tradeWindows: null,
                    latestEntry: null,
                });
            }
            return { streamId, status };
        }
        const { parsedStrategyParams, parsedBacktestSettings, closed, evaluationCandles, latestClose } = prepared.context;

        if (!force && closed.closedCandleTimeSec <= (subscription.last_processed_candle_open_time || 0)) {
            const status = composeSubscriptionStatus("no_new_closed_candle", persistedExitAlertKey);
            await updateSubscriptionStatus(env, streamId, status);
            return {
                streamId,
                status,
                closedCandleTimeSec: closed.closedCandleTimeSec,
            };
        }

        const result = await processSignalPayload(
            {
                streamId,
                symbol: subscription.symbol,
                interval: subscription.interval,
                strategyKey: subscription.strategy_key,
                configName: parseConfigNameFromStreamId(streamId) ?? undefined,
                strategyParams: parsedStrategyParams,
                backtestSettings: parsedBacktestSettings,
                freshnessBars: effectiveFreshnessBars,
                notifyTelegram: telegramRetriesExhausted ? false : subscription.notify_telegram === 1,
                notifyExit: subscription.notify_exit === 1,
                candles: evaluationCandles,
            },
            env
        );

        // Exit signal detection: if no new entry and exit alerts enabled,
        // check if the last entry's opposite signal has fired.
        // Uses cached evaluation result (fixes race condition) and ignores freshness (exit alerts always fire).
        if (result.ok && !result.newEntry && subscription.notify_exit === 1 && subscription.notify_telegram === 1) {
            try {
                const lastEntry = await env.SIGNALS_DB.prepare(
                    buildLatestActionableEntrySignalQuery("payload_json")
                ).bind(streamId.toLowerCase(), PENDING_ENTRY_SIGNAL_REASON).first<{ payload_json: string }>();
                if (lastEntry) {
                    const lastPayload = safeJsonParse(lastEntry.payload_json, null as StoredSignalPayload | null);
                    // Use cached latestEvaluatedEntry from result instead of re-evaluating (Issue #1 fix)
                    // Exit alerts ignore freshness - they fire regardless of signal age (Issue #2 fix)
                    if (
                        lastPayload &&
                        result.preparedSignalCount > 0 &&
                        result.latestEvaluatedEntry &&
                        result.latestEvaluatedEntry.direction !== lastPayload.direction &&
                        result.latestEvaluatedEntry.signalTimeSec > lastPayload.signalTimeSec
                    ) {
                        const exitAlertKey = `${lastPayload.fingerprint}:${result.latestEvaluatedEntry.fingerprint}`;
                        if (persistedExitAlertKey !== exitAlertKey) {
                            const exitMsg = buildExitTelegramMessage(
                                lastPayload.direction,
                                subscription.symbol,
                                subscription.interval,
                                subscription.strategy_key,
                                parseConfigNameFromStreamId(streamId),
                                result.latestEvaluatedEntry.signal.price,
                                result.latestEvaluatedEntry.signalTimeSec
                            );
                            try {
                                await sendTelegramText(env, exitMsg);
                                persistedExitAlertKey = exitAlertKey;
                            } catch {
                                // Exit alerts are best effort.
                            }
                        }
                    }
                }
            } catch { /* exit alerts are best effort */ }
        }

        if (result.ok && result.newEntry) {
            // New entry starts a fresh cycle; clear prior exit alert dedupe key.
            persistedExitAlertKey = null;
        }

        let baseStatus: string;
        if (result.ok) {
            if (result.newEntry && telegramRetriesExhausted && subscription.notify_telegram === 1) {
                baseStatus = `new_entry(telegram_skipped_after_${prevTelegramFailCount}_failures)`;
            } else {
                baseStatus = result.newEntry ? "new_entry" : (result.reason ?? "no_entry");
            }
        } else if (result.error?.startsWith("telegram_send_failed:")) {
            const newCount = prevTelegramFailCount + 1;
            baseStatus = `telegram_send_failed[${newCount}]:${result.error.slice("telegram_send_failed:".length)}`;
        } else {
            baseStatus = result.error ?? "processing_error";
        }
        const status = composeSubscriptionStatus(baseStatus, persistedExitAlertKey);

        if (result.ok) {
            await updateSubscriptionStatus(env, streamId, status, closed.closedCandleTimeSec);
            // Persist the latest evaluation snapshot for the batched state endpoint.
            // Best-effort: a failed write must not break the cron path.
            const evaluatedEntry = result.latestEvaluatedEntry;
            const statePayload: StoredLatestState = {
                evaluatedAt: new Date().toISOString(),
                closedCandleTimeSec: closed.closedCandleTimeSec,
                latestClose,
                reason: result.reason ?? result.error ?? null,
                latestTrade: result.latestTrade ?? null,
                tradeWindows: result.tradeWindows ?? null,
                latestEntry: evaluatedEntry
                    ? {
                        direction: evaluatedEntry.direction,
                        signalTimeSec: evaluatedEntry.signalTimeSec,
                        signalPrice: evaluatedEntry.signalPrice,
                        entryPrice: evaluatedEntry.entryPrice ?? null,
                        signalAgeBars: result.signalAgeBars ?? 0,
                        isFresh: true,
                        fingerprint: evaluatedEntry.fingerprint,
                    }
                    : null,
            };
            await persistLatestSubscriptionState(env, streamId, statePayload);
        } else {
            await updateSubscriptionStatus(env, streamId, status);
        }

        return {
            streamId,
            status,
            closedCandleTimeSec: closed.closedCandleTimeSec,
            result,
        };
    } catch (error) {
        const rawStatus = normalizeStatusText(
            error instanceof Error ? error.message : String(error),
            Math.max(32, STATUS_TEXT_MAX - 6)
        );
        const status = composeSubscriptionStatus(`error:${rawStatus}`, persistedExitAlertKey);
        await updateSubscriptionStatus(env, streamId, status);
        if (!isSyntheticMember) {
            await persistLatestSubscriptionState(env, streamId, {
                evaluatedAt: new Date().toISOString(),
                closedCandleTimeSec: null,
                latestClose: null,
                reason: status,
                latestTrade: null,
                tradeWindows: null,
                latestEntry: null,
            });
        }
        return { streamId, status };
    }
}

async function evaluateSubscriptionState(
    env: Env,
    subscription: SubscriptionRow
): Promise<SubscriptionStateResult> {
    const streamId = subscription.stream_id;

    const base: Omit<SubscriptionStateResult, "ok" | "reason" | "closedCandleTimeSec" | "latestTrade" | "latestEntry"> = {
        streamId,
        symbol: subscription.symbol,
        interval: subscription.interval,
        strategyKey: subscription.strategy_key,
        evaluatedAt: new Date().toISOString(),
        latestClose: null,
    };

    const prepared = await buildSubscriptionCandleContext(env, subscription);
    if (!prepared.ok) {
        return {
            ...base,
            ok: false,
            reason: prepared.reason,
            closedCandleTimeSec: null,
            latestClose: null,
            latestTrade: null,
            latestEntry: null,
        };
    }
    const { parsedStrategyParams, parsedBacktestSettings, closed, evaluationCandles } = prepared.context;

    const evaluation = evaluateLatestEntrySignal({
        strategyKey: subscription.strategy_key,
        candles: evaluationCandles,
        strategyParams: parsedStrategyParams,
        backtestSettings: parsedBacktestSettings,
        freshnessBars: Math.max(0, subscription.freshness_bars ?? 1),
    });

    const closedCandles = closed.candles;
    const latestCloseBar = closedCandles.length > 0 ? closedCandles[closedCandles.length - 1] : null;
    const latestClose = latestCloseBar && Number.isFinite(Number(latestCloseBar.close))
        ? Number(latestCloseBar.close)
        : null;

    const latestEntry = evaluation.latestEntry
        ? {
            direction: evaluation.latestEntry.direction,
            signalTimeSec: evaluation.latestEntry.signalTimeSec,
            signalPrice: evaluation.latestEntry.signal.price,
            entryPrice: evaluation.latestTrade?.entryPrice ?? evaluation.latestEntry.signal.price,
            signalAgeBars: evaluation.latestEntry.signalAgeBars,
            isFresh: evaluation.latestEntry.isFresh,
            fingerprint: evaluation.latestEntry.fingerprint,
        }
        : null;

    return {
        ...base,
        ok: evaluation.ok,
        reason: evaluation.reason ?? null,
        closedCandleTimeSec: closed.closedCandleTimeSec,
        latestClose,
        latestTrade: evaluation.latestTrade ?? null,
        latestEntry,
    };
}

async function handleSubscriptionState(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    const url = new URL(request.url);
    const streamId = url.searchParams.get("streamId")?.trim();
    if (!streamId) {
        return toJsonResponse({ ok: false, error: "streamId is required" }, 400);
    }

    const subscription = await env.SIGNALS_DB.prepare(
        `SELECT * FROM signal_subscriptions WHERE stream_id = ? LIMIT 1`
    )
        .bind(streamId)
        .first<SubscriptionRow>();

    if (!subscription) {
        return toJsonResponse({ ok: false, error: "Subscription not found" }, 404);
    }

    try {
        const state = await evaluateSubscriptionState(env, subscription);
        return toJsonResponse({ ok: true, state, item: state });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        return toJsonResponse(
            {
                ok: false,
                error: normalizeStatusText(detail, 320),
                state: {
                    ok: false,
                    streamId: subscription.stream_id,
                    symbol: subscription.symbol,
                    interval: subscription.interval,
                    strategyKey: subscription.strategy_key,
                    evaluatedAt: new Date().toISOString(),
                    closedCandleTimeSec: null,
                    latestClose: null,
                    reason: "evaluation_failed",
                    latestTrade: null,
                    latestEntry: null,
                } as SubscriptionStateResult,
            },
            500
        );
    }
}

interface SubscriptionStatesBatchRow {
    stream_id: string;
    symbol: string;
    interval: string;
    strategy_key: string;
    latest_state_json: string | null;
    last_status: string | null;
    updated_at: string;
    last_run_at: string | null;
    committee_tag: string | null;
}

/**
 * Batched state read for the Signal Committee. Reads precomputed
 * `latest_state_json` written by the cron, so the cost is one SQL query
 * regardless of member count. Never re-evaluates per stream.
 *
 * Streams with no cached state (subscription created but never evaluated by
 * the cron) are returned with `ok: false, reason: "no_cached_state"` so the
 * UI can render them as pending instead of hiding them.
 */
async function handleSubscriptionStatesBatch(request: Request, env: Env): Promise<Response> {
    const body = await request.json().catch(() => ({}));
    const rawStreamIds = (body as { streamIds?: unknown }).streamIds;
    if (!Array.isArray(rawStreamIds)) {
        return toJsonResponse({ ok: false, error: "streamIds must be an array" }, 400);
    }

    const streamIds = rawStreamIds
        .map((value) => (typeof value === "string" ? value.trim() : ""))
        .filter((value) => value.length > 0);

    if (streamIds.length === 0) {
        return toJsonResponse({ ok: true, states: [] });
    }

    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    // D1 binding limit is one ? per each IN value. Cap defensively.
    const MAX_BATCH = 100;
    const limited = streamIds.slice(0, MAX_BATCH);
    const placeholders = limited.map(() => "?").join(",");
    const result = await env.SIGNALS_DB.prepare(
        `SELECT
            stream_id,
            symbol,
            interval,
            strategy_key,
            latest_state_json,
            last_status,
            updated_at,
            last_run_at,
            committee_tag
        FROM signal_subscriptions
        WHERE stream_id IN (${placeholders})`
    )
        .bind(...limited)
        .all<SubscriptionStatesBatchRow>();

    const rows = result.results ?? [];
    const byStreamId = new Map<string, SubscriptionStatesBatchRow>();
    for (const row of rows) {
        byStreamId.set(row.stream_id, row);
    }

    const nowIso = new Date().toISOString();
    const states: Array<{
        streamId: string;
        ok: boolean;
        reason: string | null;
        symbol: string;
        interval: string;
        strategyKey: string;
        evaluatedAt: string;
        closedCandleTimeSec: number | null;
        latestClose: number | null;
        latestTrade: SubscriptionStateResult["latestTrade"];
        latestEntry: SubscriptionStateResult["latestEntry"];
        tradeWindows: Array<[number, number | null, 1 | -1]> | null;
        lastStatus: string | null;
        lastRunAt: string | null;
        updatedAt: string | null;
        committeeTag: string | null;
    }> = new Array(limited.length);

    for (let i = 0; i < limited.length; i++) {
        const streamId = limited[i];
        const row = byStreamId.get(streamId);
        if (!row) {
            states[i] = {
                streamId,
                ok: false,
                reason: "subscription_not_found",
                symbol: "",
                interval: "",
                strategyKey: "",
                evaluatedAt: nowIso,
                closedCandleTimeSec: null,
                latestClose: null,
                latestTrade: null,
                latestEntry: null,
                tradeWindows: null,
                lastStatus: null,
                lastRunAt: null,
                updatedAt: null,
                committeeTag: null,
            };
            continue;
        }

        const parsed = row.latest_state_json
            ? safeJsonParse<StoredLatestState | null>(row.latest_state_json, null)
            : null;

        if (!parsed) {
            states[i] = {
                streamId,
                ok: false,
                reason: "no_cached_state",
                symbol: row.symbol,
                interval: row.interval,
                strategyKey: row.strategy_key,
                evaluatedAt: nowIso,
                closedCandleTimeSec: null,
                latestClose: null,
                latestTrade: null,
                latestEntry: null,
                tradeWindows: null,
                lastStatus: row.last_status,
                lastRunAt: row.last_run_at,
                updatedAt: row.updated_at,
                committeeTag: row.committee_tag,
            };
            continue;
        }

        states[i] = {
            streamId,
            ok: true,
            reason: parsed.reason ?? null,
            symbol: row.symbol,
            interval: row.interval,
            strategyKey: row.strategy_key,
            evaluatedAt: parsed.evaluatedAt,
            closedCandleTimeSec: parsed.closedCandleTimeSec ?? null,
            latestClose: Number.isFinite(parsed.latestClose as number) ? parsed.latestClose : null,
            latestTrade: parsed.latestTrade ?? null,
            latestEntry: parsed.latestEntry ?? null,
            tradeWindows: Array.isArray(parsed.tradeWindows) ? parsed.tradeWindows : null,
            lastStatus: row.last_status,
            lastRunAt: row.last_run_at,
            updatedAt: row.updated_at,
            committeeTag: row.committee_tag,
        };
    }

    return toJsonResponse({
        ok: true,
        scanned: limited.length,
        truncated: streamIds.length > MAX_BATCH,
        states,
    });
}

// ========================================================================
// Committee aggregate-score alert rules (Phase 4)
// ------------------------------------------------------------------------
// Opt-in (default disabled). When the committee net score crosses a
// configured threshold AND its sign differs from the last fired alert's
// sign, a Telegram message is sent. Hysteresis via `last_fired_score_sign`
// prevents spam on threshold flap and duplicate alerts every cron tick.
// ========================================================================

interface CommitteeAlertRuleRow {
    committee_tag: string;
    enabled: number;
    long_threshold: number;
    short_threshold: number;
    last_fired_score_sign: number;
    last_fired_at: string | null;
    updated_at: string;
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
 * Pure decision: given the current score and the rule, should an alert fire?
 * Returns the new `lastFiredScoreSign` to persist, or `null` if no fire.
 *
 * Hysteresis rule:
 * - score > 0 and score >= longThreshold and lastSign <= 0 -> fire, new sign = +1
 * - score < 0 and score <= shortThreshold and lastSign >= 0 -> fire, new sign = -1
 * - otherwise -> no fire (sign unchanged)
 *
 * The sign-differs check is what prevents repeat alerts while the score stays
 * on one side of zero across cron ticks.
 */
export function decideCommitteeAlert(
    score: number,
    rule: { enabled: boolean; longThreshold: number; shortThreshold: number; lastFiredScoreSign: number }
): { fire: true; newSign: 1 | -1 } | { fire: false } {
    if (!rule.enabled) return { fire: false };
    if (score > 0 && score >= rule.longThreshold && rule.lastFiredScoreSign <= 0) {
        return { fire: true, newSign: 1 };
    }
    if (score < 0 && score <= rule.shortThreshold && rule.lastFiredScoreSign >= 0) {
        return { fire: true, newSign: -1 };
    }
    return { fire: false };
}

interface CommitteeMemberStateRow {
    stream_id: string;
    committee_tag: string | null;
    latest_state_json: string | null;
}

/**
 * Cron-side aggregate-score alert pass. Runs after `runScheduledSubscriptions`
 * so `latest_state_json` is fresh. For each distinct committee_tag with an
 * enabled rule, sums the open-trade votes of its members and fires Telegram
 * on threshold cross with hysteresis. Failures are logged and swallowed so
 * they never block the cron.
 */
async function runCommitteeAlertPass(env: Env): Promise<void> {
    if (!env.SIGNALS_DB) return;

    const rulesResult = await env.SIGNALS_DB.prepare(
        `SELECT * FROM committee_alert_rules WHERE enabled = 1`
    ).all<CommitteeAlertRuleRow>();
    const rules = rulesResult.results ?? [];
    if (rules.length === 0) return;

    const membersResult = await env.SIGNALS_DB.prepare(
        `SELECT stream_id, committee_tag, latest_state_json
         FROM signal_subscriptions
         WHERE committee_tag IS NOT NULL AND enabled = 1`
    ).all<CommitteeMemberStateRow>();
    const members = membersResult.results ?? [];

    const membersByTag = new Map<string, CommitteeMemberStateRow[]>();
    for (const m of members) {
        if (!m.committee_tag) continue;
        const arr = membersByTag.get(m.committee_tag) ?? [];
        arr.push(m);
        membersByTag.set(m.committee_tag, arr);
    }

    for (const rule of rules) {
        const tagMembers = membersByTag.get(rule.committee_tag) ?? [];
        let score = 0;
        for (const m of tagMembers) {
            if (!m.latest_state_json) continue;
            const parsed = safeJsonParse<StoredLatestState | null>(m.latest_state_json, null);
            if (!parsed?.latestTrade?.isOpen || !parsed.latestEntry) continue;
            score += parsed.latestEntry.direction === "long" ? 1
                : parsed.latestEntry.direction === "short" ? -1 : 0;
        }

        const decision = decideCommitteeAlert(score, {
            enabled: rule.enabled !== 0,
            longThreshold: rule.long_threshold,
            shortThreshold: rule.short_threshold,
            lastFiredScoreSign: rule.last_fired_score_sign,
        });

        if (!decision.fire) continue;

        try {
            const sign = decision.newSign;
            const text = `📊 Committee "${rule.committee_tag}" score crossed ${sign > 0 ? "+" : ""}${score}` +
                ` (threshold ${sign > 0 ? `long≥${rule.long_threshold}` : `short≤${rule.short_threshold}`}).`;
            await sendTelegramText(env, text);
            await env.SIGNALS_DB.prepare(
                `UPDATE committee_alert_rules
                 SET last_fired_score_sign = ?, last_fired_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                 WHERE committee_tag = ?`
            ).bind(sign, rule.committee_tag).run();
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            console.error(JSON.stringify({
                event: "committee_alert_send_failed",
                committeeTag: rule.committee_tag,
                error: detail,
            }));
        }
    }
}

async function handleCommitteeAlertRulesList(_request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }
    const result = await env.SIGNALS_DB.prepare(
        `SELECT * FROM committee_alert_rules ORDER BY committee_tag ASC LIMIT 100`
    ).all<CommitteeAlertRuleRow>();
    const items: CommitteeAlertRule[] = (result.results ?? []).map(rowToRule);
    return toJsonResponse({ ok: true, count: items.length, items });
}

async function handleCommitteeAlertRulesUpsert(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }
    const body = await request.json().catch(() => ({}));
    const payload = body as {
        committeeTag?: string;
        enabled?: boolean;
        longThreshold?: number;
        shortThreshold?: number;
    };
    const committeeTag = typeof payload.committeeTag === "string" ? payload.committeeTag.trim() : "";
    if (!committeeTag) {
        return toJsonResponse({ ok: false, error: "committeeTag is required" }, 400);
    }
    const enabled = payload.enabled === true ? 1 : 0;
    const longThreshold = Number.isFinite(payload.longThreshold)
        ? Math.max(1, Math.floor(Number(payload.longThreshold)))
        : 1;
    const shortThreshold = Number.isFinite(payload.shortThreshold)
        ? Math.min(-1, Math.floor(Number(payload.shortThreshold)))
        : -1;

    await env.SIGNALS_DB.prepare(
        `INSERT INTO committee_alert_rules
            (committee_tag, enabled, long_threshold, short_threshold, last_fired_score_sign, last_fired_at)
         VALUES (?, ?, ?, ?, 0, NULL)
         ON CONFLICT(committee_tag) DO UPDATE SET
            enabled = excluded.enabled,
            long_threshold = excluded.long_threshold,
            short_threshold = excluded.short_threshold,
            updated_at = CURRENT_TIMESTAMP`
    ).bind(committeeTag, enabled, longThreshold, shortThreshold).run();

    const row = await env.SIGNALS_DB.prepare(
        `SELECT * FROM committee_alert_rules WHERE committee_tag = ? LIMIT 1`
    ).bind(committeeTag).first<CommitteeAlertRuleRow>();
    return toJsonResponse({ ok: true, item: row ? rowToRule(row) : null });
}

function rowToRule(row: CommitteeAlertRuleRow): CommitteeAlertRule {
    return {
        committeeTag: row.committee_tag,
        enabled: row.enabled !== 0,
        longThreshold: row.long_threshold,
        shortThreshold: row.short_threshold,
        lastFiredScoreSign: row.last_fired_score_sign,
        lastFiredAt: row.last_fired_at,
        updatedAt: row.updated_at,
    };
}

async function handleRunNow(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const payload = body as { streamId?: string; force?: boolean };
    const streamId = payload.streamId?.trim();
    if (!streamId) {
        return toJsonResponse({ ok: false, error: "streamId is required" }, 400);
    }

    const subscription = await env.SIGNALS_DB.prepare(
        `SELECT * FROM signal_subscriptions WHERE stream_id = ? LIMIT 1`
    )
        .bind(streamId)
        .first<SubscriptionRow>();

    if (!subscription) {
        return toJsonResponse({ ok: false, error: "Subscription not found" }, 404);
    }

    // Bug fix: respect `enabled` flag — a soft-disabled subscription must not be
    // triggered via run-now, as it may re-send Telegram alerts for a stream the
    // user intentionally paused. Re-enable the subscription first if needed.
    if (!subscription.enabled) {
        return toJsonResponse({ ok: false, error: "Subscription is disabled. Re-enable it before running manually." }, 400);
    }

    const run = await runSubscription(env, subscription, payload.force === true);
    return toJsonResponse({ ok: true, run, ...(run as Record<string, unknown>) });
}

async function handleRunWithCandles(request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const payload = body as SubscriptionRunWithCandlesRequest;
    const streamId = payload.streamId?.trim();
    if (!streamId) {
        return toJsonResponse({ ok: false, error: "streamId is required" }, 400);
    }
    if (!Array.isArray(payload.candles)) {
        return toJsonResponse({ ok: false, error: "candles[] is required" }, 400);
    }

    const subscription = await env.SIGNALS_DB.prepare(
        `SELECT * FROM signal_subscriptions WHERE stream_id = ? LIMIT 1`
    )
        .bind(streamId)
        .first<SubscriptionRow>();

    if (!subscription) {
        return toJsonResponse({ ok: false, error: "Subscription not found" }, 404);
    }
    if (!subscription.enabled) {
        return toJsonResponse({ ok: false, error: "Subscription is disabled. Re-enable it before running manually." }, 400);
    }

    const candles = normalizeOhlcvCandles(payload.candles);
    if (candles.length === 0) {
        return toJsonResponse({ ok: false, error: "No valid candles found." }, 400);
    }

    const run = await evaluateSubscriptionWithCandles(env, subscription, candles, payload.force === true);
    return toJsonResponse({ ok: true, run, ...(run as Record<string, unknown>) });
}

async function runScheduledSubscriptions(env: Env): Promise<Record<string, unknown>> {
    if (!env.SIGNALS_DB) {
        return { ok: false, error: "Missing SIGNALS_DB binding" };
    }

    const result = await env.SIGNALS_DB.prepare(
        `SELECT * FROM signal_subscriptions WHERE enabled = 1 ORDER BY updated_at DESC`
    ).all<SubscriptionRow>();

    const subscriptions = result.results ?? [];
    const runs: Record<string, unknown>[] = new Array(subscriptions.length);
    const nowSec = Math.floor(Date.now() / 1000);
    let skippedNotDue = 0;
    const dueIndexes: number[] = [];

    for (let i = 0; i < subscriptions.length; i++) {
        const subscription = subscriptions[i];
        if (!shouldPollSubscriptionOnSchedule(subscription, nowSec)) {
            skippedNotDue += 1;
            runs[i] = {
                streamId: subscription.stream_id,
                status: "skipped_interval_not_due",
            };
            continue;
        }
        dueIndexes.push(i);
    }

    let cursor = 0;
    const workerCount = Math.min(MAX_SCHEDULED_CONCURRENCY, dueIndexes.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const current = cursor;
            cursor += 1;
            if (current >= dueIndexes.length) break;

            const index = dueIndexes[current];
            const subscription = subscriptions[index];
            try {
                runs[index] = await runSubscription(env, subscription, false);
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                runs[index] = {
                    streamId: subscription.stream_id,
                    status: `error:${normalizeStatusText(detail, 200)}`,
                };
            }
        }
    });

    await Promise.all(workers);

    return {
        ok: true,
        scanned: subscriptions.length,
        eligible: subscriptions.length - skippedNotDue,
        skippedNotDue,
        runs: runs.filter((entry): entry is Record<string, unknown> => Boolean(entry)),
        at: new Date().toISOString(),
    };
}

// Builds the bounded observability payload emitted by the cron `scheduled`
// handler. The full `runs` array (one entry per subscription) is kept on the
// `runScheduledSubscriptions` return value for any authenticated diagnostic
// surface; this helper collapses it into aggregate counts plus a bounded
// sample of failures so the per-minute log no longer grows with subscription
// count. See finding 5.
export function buildScheduledCronSummary(summary: Record<string, unknown>): Record<string, unknown> {
    const runs = Array.isArray(summary.runs) ? summary.runs as Array<Record<string, unknown>> : [];
    const counts: Record<string, number> = {};
    const errors: Array<{ streamId: unknown; status: unknown }> = [];
    let errorCount = 0;
    for (const run of runs) {
        const status = typeof run.status === "string" ? run.status : "unknown";
        // Normalize `error:<detail>` → `error` for the aggregate bucket so the
        // count stays actionable, but keep the full status in the sample below.
        const bucket = status.startsWith("error:") ? "error" : status;
        counts[bucket] = (counts[bucket] ?? 0) + 1;
        if (bucket === "error") {
            errorCount += 1;
            if (errors.length < SCHEDULED_LOG_MAX_ERRORS) {
                errors.push({ streamId: run.streamId, status });
            }
        }
    }
    return {
        ok: summary.ok,
        scanned: summary.scanned,
        eligible: summary.eligible,
        skippedNotDue: summary.skippedNotDue,
        counts,
        errorCount,
        errorsTruncated: Math.max(0, errorCount - errors.length),
        errors,
        // Preserve a top-level error reason when the summary itself failed
        // (e.g. missing SIGNALS_DB binding) so the cron log stays diagnostic.
        ...(typeof summary.error === "string" ? { error: summary.error } : {}),
        at: summary.at,
    };
}

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        if (request.method === "OPTIONS") {
            return toNoContentResponse();
        }

        const url = new URL(request.url);
        const pathname = url.pathname.replace(/\/+$/, "") || "/";

        if (request.method === "GET" && pathname === "/health") {
            const workerStrategySupport = getWorkerStrategySupportSnapshot();
            return toJsonResponse({
                ok: true,
                service: "entry-signal-worker",
                now: new Date().toISOString(),
                ...workerStrategySupport,
            });
        }

        if (!isAuthorizedRequest(request, env)) {
            return toUnauthorizedResponse();
        }

        if (request.method === "POST" && pathname === "/api/stream/signal") {
            return handleStreamSignal(request, env);
        }

        if (request.method === "GET" && pathname === "/api/stream/signals") {
            return handleSignalHistory(request, env);
        }

        if (request.method === "POST" && pathname === "/api/subscriptions/upsert") {
            return handleSubscriptionUpsert(request, env);
        }

        if (request.method === "GET" && pathname === "/api/subscriptions") {
            return handleSubscriptionList(request, env);
        }

        if (request.method === "GET" && pathname === "/api/subscriptions/state") {
            return handleSubscriptionState(request, env);
        }

        if (request.method === "POST" && pathname === "/api/subscriptions/states") {
            return handleSubscriptionStatesBatch(request, env);
        }

        if (request.method === "POST" && pathname === "/api/subscriptions/delete") {
            return handleSubscriptionDelete(request, env);
        }

        if (request.method === "POST" && pathname === "/api/subscriptions/run-now") {
            return handleRunNow(request, env);
        }

        if (request.method === "POST" && pathname === "/api/subscriptions/run-with-candles") {
            return handleRunWithCandles(request, env);
        }

        if (request.method === "GET" && pathname === "/api/committee-alert/rules") {
            return handleCommitteeAlertRulesList(request, env);
        }

        if (request.method === "POST" && pathname === "/api/committee-alert/rules") {
            return handleCommitteeAlertRulesUpsert(request, env);
        }

        return toJsonResponse({ ok: false, error: "Not found" }, 404);
    },

    async scheduled(controller: ScheduledController, env: Env): Promise<void> {
        if (!env.SIGNALS_DB) {
            console.error(JSON.stringify({ ok: false, error: "Missing SIGNALS_DB binding" }));
            return;
        }

        // Intentional behavior:
        // - Wrangler cron runs every minute (`* * * * *`)
        // - We delay to second 10 so evaluation happens just after minute boundary updates settle.
        // - Subscriptions are interval-gated in code to avoid unnecessary fetches.
        const scheduledTimeMs = Number(controller.scheduledTime);
        const waitMs = computeScheduleAlignmentDelayMs(scheduledTimeMs, SCHEDULE_TARGET_SECOND);
        if (waitMs > 0) {
            await sleep(waitMs);
        }

        const summary = await runScheduledSubscriptions(env);
        console.info(JSON.stringify({
            event: "scheduled_run_summary",
            ...buildScheduledCronSummary(summary),
        }));

        // Phase 4: opt-in committee aggregate-score alerts. Runs after the
        // subscription pass so latest_state_json is fresh. Swallows its own
        // errors so alert failures never block the cron.
        await runCommitteeAlertPass(env);
    },
};
