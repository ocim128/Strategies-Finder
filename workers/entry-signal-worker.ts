import { evaluateLatestEntrySignal } from "../lib/signal-entry-evaluator";
import type { BacktestSettings, OHLCVData } from "../lib/types/strategies";
import { parseIntervalSeconds } from "../lib/interval-utils";
import { parseTimeToUnixSeconds } from "../lib/time-normalization";
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
    getWorkerStrategySupportSnapshot,
    isWorkerSupportedStrategyKey,
    resolveSubscriptionExecutionBacktestSettings,
} from "../lib/alert-subscription-utils";
import { PENDING_ENTRY_SIGNAL_REASON } from "../lib/alert-signal-utils";
import { resolveEntryRiskTargets } from "../lib/entry-risk-targets";

type CandleTime = OHLCVData["time"];

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
    /** A pending entry signal that was skipped because the backtest position was occupied */
    pendingEvaluatedEntry?: {
        direction: "long" | "short";
        signalTimeSec: number;
        signalPrice: number;
        fingerprint: string;
        isFresh: boolean;
    } | null;
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
    pendingEntry: {
        direction: "long" | "short";
        signalTimeSec: number;
        signalPrice: number;
        signalAgeBars: number;
        isFresh: boolean;
        fingerprint: string;
    } | null;
}

const DEFAULT_MIN_CANDLES = 200;
const MIN_CANDLES_LOWER_BOUND = 50;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_SUBSCRIPTION_CANDLE_LIMIT = 350;
const MAX_SUBSCRIPTION_CANDLE_LIMIT = 50000;
const MAX_BINANCE_KLINES_PER_REQUEST = 1000;
const STATUS_TEXT_MAX = 1200;
const RESPONSE_SNIPPET_MAX = 320;
// Keep scheduled runs aligned shortly after minute boundary.
// Cloudflare cron granularity is 1 minute, so second-level precision is done in code.
const SCHEDULE_TARGET_SECOND = 10;
const MAX_SCHEDULED_CONCURRENCY = 4;
const MAX_TELEGRAM_RETRIES = 5;

function parseTelegramFailCount(status: string | null): number {
    if (!status) return 0;
    const match = /telegram_send_failed\[(\d+)]/.exec(status);
    if (match) return Number(match[1]);
    if (status.includes('telegram_send_failed')) return 1;
    return 0;
}
const BINANCE_INTERVALS = new Set([
    "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w", "1M",
]);
const DEFAULT_BINANCE_API_BASES = [
    "https://api.binance.us",
    "https://api.mexc.com",
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
];

const CORS_HEADERS: Record<string, string> = {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,OPTIONS",
    "access-control-allow-headers": "content-type,authorization",
};

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

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

function parseNumeric(value: unknown): number | null {
    if (typeof value === "number") {
        return Number.isFinite(value) ? value : null;
    }
    if (typeof value === "string" && value.trim() !== "") {
        const n = Number(value);
        return Number.isFinite(n) ? n : null;
    }
    return null;
}

function parseTimeToSec(value: unknown): number | null {
    return parseTimeToUnixSeconds(value);
}

function normalizeCandles(input: StreamSignalRequest["candles"]): OHLCVData[] {
    const deduped = new Map<number, OHLCVData>();

    for (const row of input) {
        const timeSec = parseTimeToSec(row.time);
        const open = parseNumeric(row.open);
        const high = parseNumeric(row.high);
        const low = parseNumeric(row.low);
        const close = parseNumeric(row.close);
        const volume = parseNumeric(row.volume);

        if (
            timeSec === null ||
            open === null ||
            high === null ||
            low === null ||
            close === null ||
            volume === null
        ) {
            continue;
        }

        deduped.set(timeSec, {
            time: timeSec as CandleTime,
            open,
            high,
            low,
            close,
            volume,
        });
    }

    return Array.from(deduped.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([, candle]) => candle);
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

function intervalToSeconds(interval: string): number | null {
    return parseIntervalSeconds(interval);
}

function isMexcBase(base: string): boolean {
    try {
        return new URL(base).hostname.toLowerCase() === "api.mexc.com";
    } catch {
        return base.toLowerCase().includes("api.mexc.com");
    }
}

function translateIntervalForApiBase(base: string, interval: string): string | null {
    if (!isMexcBase(base)) return interval;

    // MEXC supports Binance-style klines endpoint with a narrower interval set.
    const mexcMap: Record<string, string | null> = {
        "1m": "1m",
        "3m": null,
        "5m": "5m",
        "15m": "15m",
        "30m": "30m",
        "1h": "60m",
        "2h": null,
        "4h": "4h",
        "6h": null,
        "8h": "8h",
        "12h": null,
        "1d": "1d",
        "3d": null,
        "1w": null,
        "1M": "1M",
    };

    return mexcMap[interval] ?? null;
}

function getResampleBucketStart(timeSec: number, intervalSec: number): number {
    return Math.floor(timeSec / intervalSec) * intervalSec;
}

function resampleCandles(
    candles: OHLCVData[],
    targetInterval: string,
    sourceIntervalSec?: number
): OHLCVData[] {
    if (candles.length === 0) return [];
    const targetSec = intervalToSeconds(targetInterval);
    if (!targetSec || targetSec <= 0) return candles;

    // When only one candle is available the gap heuristic is unreliable.
    // Fall back to the explicitly supplied source interval, or to targetSec
    // (which makes targetSec <= sourceSec true and returns candles as-is — safe).
    const sourceSec = candles.length > 1
        ? Math.max(1, Number(candles[1].time) - Number(candles[0].time))
        : (sourceIntervalSec ?? targetSec);
    if (targetSec <= sourceSec) return candles;

    const out: OHLCVData[] = [];
    let current: OHLCVData | null = null;
    let bucketStart = Number.NaN;

    for (const row of candles) {
        const t = Number(row.time);
        if (!Number.isFinite(t)) continue;
        const nextBucket = getResampleBucketStart(t, targetSec);
        if (!current || nextBucket !== bucketStart) {
            if (current) out.push(current);
            current = {
                time: nextBucket as CandleTime,
                open: row.open,
                high: row.high,
                low: row.low,
                close: row.close,
                volume: row.volume,
            };
            bucketStart = nextBucket;
            continue;
        }

        current.high = Math.max(current.high, row.high);
        current.low = Math.min(current.low, row.low);
        current.close = row.close;
        current.volume += row.volume;
    }

    if (current) out.push(current);
    return out;
}

function toBinanceInterval(interval: string): string | null {
    const trimmed = interval.trim();
    if (BINANCE_INTERVALS.has(trimmed)) return trimmed;

    const minutesMatch = /^(\d+)m$/.exec(trimmed);
    if (minutesMatch) {
        const mins = Number(minutesMatch[1]);
        const map: Record<number, string> = {
            1: "1m",
            3: "3m",
            5: "5m",
            15: "15m",
            30: "30m",
            60: "1h",
            120: "2h",
            240: "4h",
            360: "6h",
            480: "8h",
            720: "12h",
            1440: "1d",
            4320: "3d",
            10080: "1w",
        };
        return map[mins] ?? null;
    }

    const hoursMatch = /^(\d+)h$/.exec(trimmed);
    if (hoursMatch) {
        const hours = Number(hoursMatch[1]);
        const map: Record<number, string> = {
            1: "1h",
            2: "2h",
            4: "4h",
            6: "6h",
            8: "8h",
            12: "12h",
            24: "1d",
            72: "3d",
            168: "1w",
        };
        return map[hours] ?? null;
    }

    return null;
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
                const endTimeQuery = typeof endTimeMs === "number" ? `&endTime=${endTimeMs}` : "";
                const endpoint = `${base}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(providerInterval)}&limit=${requestLimit}${endTimeQuery}`;

                const res = await fetch(endpoint, {
                    headers: {
                        accept: "application/json",
                        "user-agent": "strategy-entry-signal-worker/1.0",
                    },
                });

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
                time: Math.floor(kline[0] / 1000) as CandleTime,
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
    return fetchBinanceCandles(symbol, interval, limit, env);
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

function buildPendingEntryTelegramMessage(
    symbol: string,
    interval: string,
    strategyKey: string,
    configName: string | null,
    direction: "long" | "short",
    price: number,
    timeSec: number
): string {
    const icon = direction === "long" ? "\u{1F7E2}" : "\u{1F534}";
    const configLabel = configName ?? strategyKey;
    const lines = [
        `\u{23F3} ${icon} Pending Entry Signal`,
        `Symbol: ${symbol}`,
        `Interval: ${interval}`,
        `Configuration: ${configLabel}`,
        `Strategy: ${strategyKey}`,
        `Direction: ${direction.toUpperCase()}`,
        `Price: ${price}`,
        `Note: Current position is still open. Pending entries do not include TP/SL because the eventual fill price is not known yet.`,
    ];
    lines.push(`Time (UTC): ${new Date(timeSec * 1000).toISOString()}`);
    return lines.join("\n");
}

async function sendTelegramText(env: Env, text: string): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) {
        throw new Error("Missing TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID secret");
    }

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text }),
    });

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
                latestEvaluatedEntry: {
                    direction: evaluation.latestEntry.direction,
                    signalTimeSec: evaluation.latestEntry.signalTimeSec,
                    signalPrice: evaluation.latestEntry.signal.price,
                    entryPrice: evaluatedEntryPrice,
                    fingerprint: evaluation.latestEntry.fingerprint,
                    signal: { price: evaluation.latestEntry.signal.price },
                },
                pendingEvaluatedEntry: evaluation.pendingEntry
                    ? {
                        direction: evaluation.pendingEntry.direction,
                        signalTimeSec: evaluation.pendingEntry.signalTimeSec,
                        signalPrice: evaluation.pendingEntry.signal.price,
                        fingerprint: evaluation.pendingEntry.fingerprint,
                        isFresh: evaluation.pendingEntry.isFresh,
                    }
                    : null,
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
                latestEvaluatedEntry: {
                    direction: evaluation.latestEntry.direction,
                    signalTimeSec: evaluation.latestEntry.signalTimeSec,
                    signalPrice: evaluation.latestEntry.signal.price,
                    entryPrice: evaluatedEntryPrice,
                    fingerprint: evaluation.latestEntry.fingerprint,
                    signal: { price: evaluation.latestEntry.signal.price },
                },
                pendingEvaluatedEntry: evaluation.pendingEntry
                    ? {
                        direction: evaluation.pendingEntry.direction,
                        signalTimeSec: evaluation.pendingEntry.signalTimeSec,
                        signalPrice: evaluation.pendingEntry.signal.price,
                        fingerprint: evaluation.pendingEntry.fingerprint,
                        isFresh: evaluation.pendingEntry.isFresh,
                    }
                    : null,
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
        pendingEvaluatedEntry: evaluation.pendingEntry
            ? {
                direction: evaluation.pendingEntry.direction,
                signalTimeSec: evaluation.pendingEntry.signalTimeSec,
                signalPrice: evaluation.pendingEntry.signal.price,
                fingerprint: evaluation.pendingEntry.fingerprint,
                isFresh: evaluation.pendingEntry.isFresh,
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

    const normalizedCandles = normalizeCandles(payload.candles);
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
                last_processed_candle_open_time
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)
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
                candleLimit
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

async function handleSubscriptionList(_request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    const result = await env.SIGNALS_DB.prepare(
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

async function runSubscription(
    env: Env,
    subscription: SubscriptionRow,
    force = false
): Promise<Record<string, unknown>> {
    const streamId = subscription.stream_id;
    const lastExitAlertKey = extractExitAlertKey(subscription.last_status);
    let persistedExitAlertKey: string | null = lastExitAlertKey;
    const parsedStrategyParams = safeJsonParse(subscription.strategy_params_json, {} as Record<string, number>);
    const parsedBacktestSettings = resolveSubscriptionExecutionBacktestSettings(
        safeJsonParse(subscription.backtest_settings_json, {} as BacktestSettings)
    );
    const minClosedCandles = readMinClosedCandles(env);
    const subscriptionFreshnessBars = Math.max(0, subscription.freshness_bars ?? 1);
    const effectiveFreshnessBars = force
        ? Math.max(subscriptionFreshnessBars, subscription.candle_limit || DEFAULT_SUBSCRIPTION_CANDLE_LIMIT)
        : subscriptionFreshnessBars;
    const prevTelegramFailCount = parseTelegramFailCount(subscription.last_status);
    const telegramRetriesExhausted = prevTelegramFailCount >= MAX_TELEGRAM_RETRIES;

    try {
        const candles = await fetchMarketCandles(
            subscription.symbol,
            subscription.interval,
            subscription.candle_limit || DEFAULT_SUBSCRIPTION_CANDLE_LIMIT,
            env
        );

        const nowSec = Math.floor(Date.now() / 1000);
        const closed = selectClosedCandleWindow(candles, subscription.interval, nowSec, minClosedCandles);
        if (!closed) {
            const closedCount = countClosedCandles(candles, subscription.interval, nowSec);
            const status = composeSubscriptionStatus(`insufficient_candles:${closedCount}/${minClosedCandles}`, persistedExitAlertKey);
            await updateSubscriptionStatus(env, streamId, status);
            return { streamId, status };
        }

        if (!force && closed.closedCandleTimeSec <= (subscription.last_processed_candle_open_time || 0)) {
            const status = composeSubscriptionStatus("no_new_closed_candle", persistedExitAlertKey);
            await updateSubscriptionStatus(env, streamId, status);
            return {
                streamId,
                status,
                closedCandleTimeSec: closed.closedCandleTimeSec,
            };
        }

        const evaluationCandles = buildExecutionAwareCandleWindow(
            closed.candles,
            closed.nextOpenCandle,
            parsedBacktestSettings
        );

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

        // Pending entry alert: a signal fired while the backtest position was occupied.
        // Send a heads-up so the user can manually enter when their current position closes.
        if (
            result.ok &&
            !result.newEntry &&
            result.pendingEvaluatedEntry?.isFresh &&
            subscription.notify_telegram === 1 &&
            !telegramRetriesExhausted
        ) {
            try {
                const pe = result.pendingEvaluatedEntry;
                const pendingDedupeKey = `pending:${streamId.toLowerCase()}:${pe.fingerprint}`;
                const pendingInsert = await env.SIGNALS_DB.prepare(
                    `INSERT INTO entry_signals (channel_key, dedupe_key, stream_id, symbol, interval, strategy_key, direction, signal_time, signal_price, signal_reason, payload_json)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                     ON CONFLICT(dedupe_key) DO NOTHING`
                ).bind(
                    streamId.toLowerCase(),
                    pendingDedupeKey,
                    streamId,
                    subscription.symbol,
                    subscription.interval,
                    subscription.strategy_key,
                    pe.direction,
                    pe.signalTimeSec,
                    pe.signalPrice,
                    'pending_entry',
                    JSON.stringify({ pending: true, direction: pe.direction, signalTimeSec: pe.signalTimeSec, signalPrice: pe.signalPrice, fingerprint: pe.fingerprint })
                ).run();

                if ((pendingInsert.meta?.changes ?? 0) > 0) {
                    const pendingMsg = buildPendingEntryTelegramMessage(
                        subscription.symbol,
                        subscription.interval,
                        subscription.strategy_key,
                        parseConfigNameFromStreamId(streamId),
                        pe.direction,
                        pe.signalPrice,
                        pe.signalTimeSec
                    );
                    try {
                        await sendTelegramText(env, pendingMsg);
                    } catch { /* pending alerts are best effort */ }
                }
            } catch { /* pending entry alerts are best effort */ }
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
        return { streamId, status };
    }
}

async function evaluateSubscriptionState(
    env: Env,
    subscription: SubscriptionRow
): Promise<SubscriptionStateResult> {
    const streamId = subscription.stream_id;
    const parsedStrategyParams = safeJsonParse(subscription.strategy_params_json, {} as Record<string, number>);
    const parsedBacktestSettings = resolveSubscriptionExecutionBacktestSettings(
        safeJsonParse(subscription.backtest_settings_json, {} as BacktestSettings)
    );
    const minClosedCandles = readMinClosedCandles(env);

    const base: Omit<SubscriptionStateResult, "ok" | "reason" | "closedCandleTimeSec" | "latestTrade" | "latestEntry" | "pendingEntry"> = {
        streamId,
        symbol: subscription.symbol,
        interval: subscription.interval,
        strategyKey: subscription.strategy_key,
        evaluatedAt: new Date().toISOString(),
    };

    const candles = await fetchMarketCandles(
        subscription.symbol,
        subscription.interval,
        subscription.candle_limit || DEFAULT_SUBSCRIPTION_CANDLE_LIMIT,
        env
    );

    const nowSec = Math.floor(Date.now() / 1000);
    const closed = selectClosedCandleWindow(candles, subscription.interval, nowSec, minClosedCandles);
    if (!closed) {
        const closedCount = countClosedCandles(candles, subscription.interval, nowSec);
        return {
            ...base,
            ok: false,
            reason: `insufficient_candles:${closedCount}/${minClosedCandles}`,
            closedCandleTimeSec: null,
            latestTrade: null,
            latestEntry: null,
            pendingEntry: null,
        };
    }

    const evaluationCandles = buildExecutionAwareCandleWindow(
        closed.candles,
        closed.nextOpenCandle,
        parsedBacktestSettings
    );

    const evaluation = evaluateLatestEntrySignal({
        strategyKey: subscription.strategy_key,
        candles: evaluationCandles,
        strategyParams: parsedStrategyParams,
        backtestSettings: parsedBacktestSettings,
        freshnessBars: Math.max(0, subscription.freshness_bars ?? 1),
    });

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

    const pendingEntry = evaluation.pendingEntry
        ? {
            direction: evaluation.pendingEntry.direction,
            signalTimeSec: evaluation.pendingEntry.signalTimeSec,
            signalPrice: evaluation.pendingEntry.signal.price,
            signalAgeBars: evaluation.pendingEntry.signalAgeBars,
            isFresh: evaluation.pendingEntry.isFresh,
            fingerprint: evaluation.pendingEntry.fingerprint,
        }
        : null;

    return {
        ...base,
        ok: evaluation.ok,
        reason: evaluation.reason ?? null,
        closedCandleTimeSec: closed.closedCandleTimeSec,
        latestTrade: evaluation.latestTrade ?? null,
        latestEntry,
        pendingEntry,
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
                    reason: "evaluation_failed",
                    latestTrade: null,
                    latestEntry: null,
                    pendingEntry: null,
                } as SubscriptionStateResult,
            },
            500
        );
    }
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

        if (request.method === "POST" && pathname === "/api/subscriptions/delete") {
            return handleSubscriptionDelete(request, env);
        }

        if (request.method === "POST" && pathname === "/api/subscriptions/run-now") {
            return handleRunNow(request, env);
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
            ...summary,
        }));
    },
};
