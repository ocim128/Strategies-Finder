import { evaluateLatestEntrySignal } from "../lib/signal-entry-evaluator";
import type { BacktestSettings, OHLCVData } from "../lib/types/strategies";

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
    BINANCE_API_BASES?: string;
    BYBIT_API_BASES?: string;
}

interface StreamSignalRequest {
    streamId?: string;
    symbol: string;
    interval: string;
    strategyKey: string;
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
    direction: "long" | "short";
    signalTimeSec: number;
    signalAgeBars: number;
    signalPrice: number;
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
    last_processed_closed_candle_time: number;
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
}

const MIN_CANDLES = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;
const DEFAULT_SUBSCRIPTION_CANDLE_LIMIT = 350;
const MAX_SUBSCRIPTION_CANDLE_LIMIT = 1000;
const STATUS_TEXT_MAX = 1200;
const RESPONSE_SNIPPET_MAX = 320;
const BINANCE_INTERVALS = new Set([
    "1m", "3m", "5m", "15m", "30m",
    "1h", "2h", "4h", "6h", "8h", "12h",
    "1d", "3d", "1w", "1M",
]);
const DEFAULT_BINANCE_API_BASES = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
    "https://api4.binance.com",
    "https://api.binance.us",
];
const DEFAULT_BYBIT_API_BASES = [
    "https://api.bybit.com",
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
    if (typeof value === "number") {
        if (!Number.isFinite(value)) return null;
        return value > 9_999_999_999 ? Math.floor(value / 1000) : Math.floor(value);
    }
    if (typeof value === "string") {
        if (/^\d+$/.test(value.trim())) {
            const asNumber = Number(value.trim());
            return asNumber > 9_999_999_999 ? Math.floor(asNumber / 1000) : Math.floor(asNumber);
        }
        const parsed = Date.parse(value);
        return Number.isNaN(parsed) ? null : Math.floor(parsed / 1000);
    }
    if (value && typeof value === "object" && "year" in (value as Record<string, unknown>)) {
        const day = value as { year: number; month: number; day: number };
        if (!Number.isFinite(day.year) || !Number.isFinite(day.month) || !Number.isFinite(day.day)) return null;
        return Math.floor(Date.UTC(day.year, day.month - 1, day.day) / 1000);
    }
    return null;
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
            time: timeSec,
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

function buildDefaultStreamId(symbol: string, interval: string, strategyKey: string): string {
    return `${symbol}:${interval}:${strategyKey}`.toLowerCase();
}

function safeJsonParse<T>(value: string, fallback: T): T {
    try {
        return JSON.parse(value) as T;
    } catch {
        return fallback;
    }
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
    const configured = (env.BINANCE_API_BASES ?? "")
        .split(",")
        .map((x) => x.trim().replace(/\/+$/, ""))
        .filter(Boolean);

    return configured.length > 0 ? configured : DEFAULT_BINANCE_API_BASES;
}

function readBybitApiBases(env: Env): string[] {
    const configured = (env.BYBIT_API_BASES ?? "")
        .split(",")
        .map((x) => x.trim().replace(/\/+$/, ""))
        .filter(Boolean);

    return configured.length > 0 ? configured : DEFAULT_BYBIT_API_BASES;
}

function normalizeBinanceResponseSnippet(value: string): string {
    return value
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, RESPONSE_SNIPPET_MAX);
}

function parseBybitKlineList(
    rows: Array<[string, string, string, string, string, string, string]>
): OHLCVData[] {
    return rows
        .map((kline) => ({
            time: Math.floor(Number(kline[0]) / 1000),
            open: Number(kline[1]),
            high: Number(kline[2]),
            low: Number(kline[3]),
            close: Number(kline[4]),
            volume: Number(kline[5]),
        }))
        .filter((row) =>
            Number.isFinite(row.time) &&
            Number.isFinite(row.open) &&
            Number.isFinite(row.high) &&
            Number.isFinite(row.low) &&
            Number.isFinite(row.close) &&
            Number.isFinite(row.volume)
        )
        .sort((a, b) => Number(a.time) - Number(b.time));
}

function intervalToSeconds(interval: string): number | null {
    const trimmed = interval.trim();
    if (!trimmed) return null;
    const m = /^(\d+)(m|h|d|w|M)$/.exec(trimmed);
    if (!m) return null;
    const value = Number(m[1]);
    if (!Number.isFinite(value) || value <= 0) return null;
    const unit = m[2];

    if (unit === "m") return value * 60;
    if (unit === "h") return value * 60 * 60;
    if (unit === "d") return value * 24 * 60 * 60;
    if (unit === "w") return value * 7 * 24 * 60 * 60;
    if (unit === "M") return value * 30 * 24 * 60 * 60;
    return null;
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

async function fetchBinanceCandles(symbol: string, interval: string, limit: number, env: Env): Promise<OHLCVData[]> {
    const binanceInterval = toBinanceInterval(interval);
    if (!binanceInterval) {
        throw new Error(`Unsupported interval for Binance: ${interval}`);
    }
    const clampedLimit = Math.max(MIN_CANDLES, Math.min(MAX_SUBSCRIPTION_CANDLE_LIMIT, Math.floor(limit)));
    const bases = readBinanceApiBases(env);
    const endpointErrors: string[] = [];

    for (const base of bases) {
        const endpoint = `${base}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(binanceInterval)}&limit=${clampedLimit}`;
        try {
            const res = await fetch(endpoint, {
                headers: {
                    accept: "application/json",
                    "user-agent": "strategy-entry-signal-worker/1.0",
                },
            });

            if (!res.ok) {
                const body = normalizeBinanceResponseSnippet(await res.text());
                endpointErrors.push(`${base} -> ${res.status}${body ? ` ${body}` : ""}`);
                continue;
            }

            const rows = (await res.json()) as Array<[number, string, string, string, string, string]>;
            if (!Array.isArray(rows) || rows.length === 0) {
                endpointErrors.push(`${base} -> empty_response`);
                continue;
            }

            return rows.map((kline) => ({
                time: Math.floor(kline[0] / 1000),
                open: Number(kline[1]),
                high: Number(kline[2]),
                low: Number(kline[3]),
                close: Number(kline[4]),
                volume: Number(kline[5]),
            }));
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            endpointErrors.push(`${base} -> ${normalizeStatusText(detail, 120)}`);
        }
    }

    const summary = normalizeStatusText(endpointErrors.join(" | "), 900);
    throw new Error(`Binance API unavailable: ${summary}`);
}

function toBybitInterval(interval: string): string | null {
    const trimmed = interval.trim();
    if (/^\d+m$/.test(trimmed)) {
        const mins = Number(trimmed.slice(0, -1));
        const supported = new Set([1, 3, 5, 15, 30, 60, 120, 240, 360, 720]);
        return supported.has(mins) ? String(mins) : null;
    }
    if (/^\d+h$/.test(trimmed)) {
        const hours = Number(trimmed.slice(0, -1));
        const mins = hours * 60;
        const supported = new Set([60, 120, 240, 360, 720]);
        return supported.has(mins) ? String(mins) : null;
    }
    if (trimmed === "1d" || trimmed === "24h") return "D";
    if (trimmed === "1w" || trimmed === "7d") return "W";
    if (trimmed === "1M" || trimmed === "30d") return "M";
    return null;
}

async function fetchBybitCandles(symbol: string, interval: string, limit: number, env: Env): Promise<OHLCVData[]> {
    const bybitInterval = toBybitInterval(interval);
    if (!bybitInterval) {
        throw new Error(`Unsupported interval for Bybit: ${interval}`);
    }

    const clampedLimit = Math.max(MIN_CANDLES, Math.min(MAX_SUBSCRIPTION_CANDLE_LIMIT, Math.floor(limit)));
    const bases = readBybitApiBases(env);
    const endpointErrors: string[] = [];

    for (const base of bases) {
        for (const category of ["spot", "linear"]) {
            const endpoint = `${base}/v5/market/kline?category=${category}&symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(bybitInterval)}&limit=${clampedLimit}`;
            try {
                const res = await fetch(endpoint, {
                    headers: {
                        accept: "application/json",
                        "user-agent": "strategy-entry-signal-worker/1.0",
                    },
                });
                if (!res.ok) {
                    endpointErrors.push(`${base}/${category} -> ${res.status}`);
                    continue;
                }

                const body = (await res.json()) as {
                    retCode?: number;
                    retMsg?: string;
                    result?: { list?: Array<[string, string, string, string, string, string, string]> };
                };

                if (body.retCode !== 0) {
                    endpointErrors.push(`${base}/${category} -> code:${body.retCode ?? "?"} ${body.retMsg ?? ""}`.trim());
                    continue;
                }

                const list = body.result?.list ?? [];
                const candles = parseBybitKlineList(list);
                if (candles.length === 0) {
                    endpointErrors.push(`${base}/${category} -> empty_response`);
                    continue;
                }

                return candles;
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                endpointErrors.push(`${base}/${category} -> ${normalizeStatusText(detail, 120)}`);
            }
        }
    }

    const summary = normalizeStatusText(endpointErrors.join(" | "), 900);
    throw new Error(`Bybit API unavailable: ${summary}`);
}

async function fetchMarketCandles(symbol: string, interval: string, limit: number, env: Env): Promise<OHLCVData[]> {
    try {
        // Prefer Bybit first because Binance endpoints may be region-restricted
        // from Cloudflare Worker egress in some geographies.
        return await fetchBybitCandles(symbol, interval, limit, env);
    } catch (bybitError) {
        try {
            return await fetchBinanceCandles(symbol, interval, limit, env);
        } catch (binanceError) {
            const bybitMessage = bybitError instanceof Error ? bybitError.message : String(bybitError);
            const binanceMessage = binanceError instanceof Error ? binanceError.message : String(binanceError);
            throw new Error(
                normalizeStatusText(
                    `Bybit failed: ${bybitMessage} | Binance failed: ${binanceMessage}`,
                    1000
                )
            );
        }
    }
}

function selectClosedCandleWindow(
    candles: OHLCVData[],
    interval: string,
    nowSec: number = Math.floor(Date.now() / 1000)
): { candles: OHLCVData[]; closedCandleTimeSec: number } | null {
    if (candles.length < 2) return null;
    const intervalSeconds = intervalToSeconds(interval);
    if (!intervalSeconds || intervalSeconds <= 0) return null;

    let closedIdx = candles.length - 1;
    const lastOpenSec = Number(candles[closedIdx].time);
    if (!Number.isFinite(lastOpenSec)) return null;

    // If last kline is still open, use the previous candle as latest closed candle.
    if (nowSec < lastOpenSec + intervalSeconds) {
        closedIdx -= 1;
    }
    if (closedIdx < MIN_CANDLES - 1) return null;

    const closedTime = Number(candles[closedIdx].time);
    if (!Number.isFinite(closedTime)) return null;

    return {
        candles: candles.slice(0, closedIdx + 1),
        closedCandleTimeSec: closedTime,
    };
}

function formatPercent(value: number): string {
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(2)}%`;
}

function buildTelegramMessage(signal: StoredSignalPayload): string {
    const icon = signal.direction === "long" ? "\u{1F7E2}" : "\u{1F534}";
    const lines = [
        `${icon} New Entry Signal`,
        `Symbol: ${signal.symbol}`,
        `Interval: ${signal.interval}`,
        `Strategy: ${signal.strategyName} (${signal.strategyKey})`,
        `Direction: ${signal.direction.toUpperCase()}`,
        `Price: ${signal.signalPrice}`,
    ];
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

function buildExitTelegramMessage(exitDirection: "long" | "short", symbol: string, interval: string, strategyName: string, strategyKey: string, price: number, timeSec: number): string {
    return [
        `\u{1F6AA} Exit Signal`,
        `Symbol: ${symbol}`,
        `Interval: ${interval}`,
        `Strategy: ${strategyName} (${strategyKey})`,
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
    if (payload.candles.length < MIN_CANDLES) {
        return {
            ok: false,
            newEntry: false,
            error: `Not enough candles. Need at least ${MIN_CANDLES}.`,
            rawSignalCount: 0,
            preparedSignalCount: 0,
        };
    }

    const symbol = normalizeText(payload.symbol).toUpperCase();
    const interval = normalizeText(payload.interval);
    const strategyKey = normalizeText(payload.strategyKey);
    const streamId = normalizeText(payload.streamId);
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

    if (!evaluation.latestEntry.isFresh) {
        return {
            ok: true,
            newEntry: false,
            reason: "stale_signal",
            signalAgeBars: evaluation.latestEntry.signalAgeBars,
            rawSignalCount: evaluation.rawSignalCount,
            preparedSignalCount: evaluation.preparedSignalCount,
            latestEntry: evaluation.latestEntry,
        };
    }

    // Compute TP/SL target prices from backtest settings (percentage mode)
    const bs = payload.backtestSettings;
    const price = evaluation.latestEntry.signal.price;
    const isLong = evaluation.latestEntry.direction === "long";
    let takeProfitPrice: number | undefined;
    let stopLossPrice: number | undefined;
    let takeProfitPercent: number | undefined;
    let stopLossPercent: number | undefined;

    if (bs.riskMode === "percentage") {
        if (bs.takeProfitEnabled && bs.takeProfitPercent && bs.takeProfitPercent > 0) {
            takeProfitPercent = bs.takeProfitPercent;
            takeProfitPrice = isLong ? price * (1 + bs.takeProfitPercent / 100) : price * (1 - bs.takeProfitPercent / 100);
        }
        if (bs.stopLossEnabled && bs.stopLossPercent && bs.stopLossPercent > 0) {
            stopLossPercent = bs.stopLossPercent;
            stopLossPrice = isLong ? price * (1 - bs.stopLossPercent / 100) : price * (1 + bs.stopLossPercent / 100);
        }
    }

    const entryPayload: StoredSignalPayload = {
        streamId,
        symbol,
        interval,
        strategyKey,
        strategyName: evaluation.latestEntry.strategyName,
        direction: evaluation.latestEntry.direction,
        signalTimeSec: evaluation.latestEntry.signalTimeSec,
        signalAgeBars: evaluation.latestEntry.signalAgeBars,
        signalPrice: price,
        signalReason: evaluation.latestEntry.signal.reason ?? null,
        fingerprint: evaluation.latestEntry.fingerprint,
        takeProfitPrice,
        stopLossPrice,
        takeProfitPercent,
        stopLossPercent,
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
        : buildDefaultStreamId(payload.symbol.toUpperCase(), payload.interval, payload.strategyKey);

    const result = await processSignalPayload(
        {
            streamId,
            symbol: payload.symbol,
            interval: payload.interval,
            strategyKey: payload.strategyKey,
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

    const streamId = incomingStreamId
        ? incomingStreamId
        : buildDefaultStreamId(symbol, interval, strategyKey);
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
    const candleLimit = Math.max(
        MIN_CANDLES,
        Math.min(
            MAX_SUBSCRIPTION_CANDLE_LIMIT,
            Math.floor(payload.candleLimit ?? existing?.candle_limit ?? DEFAULT_SUBSCRIPTION_CANDLE_LIMIT)
        )
    );
    const strategyParams = payload.strategyParams
        ?? safeJsonParse(existing?.strategy_params_json ?? "{}", {} as Record<string, number>);
    const backtestSettings = payload.backtestSettings
        ?? safeJsonParse(existing?.backtest_settings_json ?? "{}", {} as BacktestSettings);

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
            last_processed_closed_candle_time
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
}

async function handleSubscriptionList(_request: Request, env: Env): Promise<Response> {
    if (!env.SIGNALS_DB) {
        return toJsonResponse({ ok: false, error: "Missing SIGNALS_DB binding" }, 500);
    }

    const result = await env.SIGNALS_DB.prepare(
        `SELECT * FROM signal_subscriptions ORDER BY updated_at DESC`
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
    const payload = body as { streamId?: string };
    const streamId = payload.streamId?.trim();
    if (!streamId) {
        return toJsonResponse({ ok: false, error: "streamId is required" }, 400);
    }

    const subsDelete = await env.SIGNALS_DB.prepare(
        `DELETE FROM signal_subscriptions WHERE stream_id = ?`
    )
        .bind(streamId)
        .run();
    const signalsDelete = await env.SIGNALS_DB.prepare(
        `DELETE FROM entry_signals WHERE stream_id = ? OR channel_key = ?`
    )
        .bind(streamId, streamId.toLowerCase())
        .run();

    return toJsonResponse({
        ok: true,
        streamId,
        deleted: (subsDelete.meta?.changes ?? 0) > 0,
        subscriptionsDeleted: subsDelete.meta?.changes ?? 0,
        signalsDeleted: signalsDelete.meta?.changes ?? 0,
    });
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
                last_processed_closed_candle_time = ?,
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

    try {
        const candles = await fetchMarketCandles(
            subscription.symbol,
            subscription.interval,
            subscription.candle_limit || DEFAULT_SUBSCRIPTION_CANDLE_LIMIT,
            env
        );

        const closed = selectClosedCandleWindow(candles, subscription.interval);
        if (!closed) {
            await updateSubscriptionStatus(env, streamId, "insufficient_candles");
            return { streamId, status: "insufficient_candles" };
        }

        if (!force && closed.closedCandleTimeSec <= (subscription.last_processed_closed_candle_time || 0)) {
            await updateSubscriptionStatus(env, streamId, "no_new_closed_candle");
            return {
                streamId,
                status: "no_new_closed_candle",
                closedCandleTimeSec: closed.closedCandleTimeSec,
            };
        }

        const result = await processSignalPayload(
            {
                streamId,
                symbol: subscription.symbol,
                interval: subscription.interval,
                strategyKey: subscription.strategy_key,
                strategyParams: safeJsonParse(subscription.strategy_params_json, {} as Record<string, number>),
                backtestSettings: safeJsonParse(subscription.backtest_settings_json, {} as BacktestSettings),
                freshnessBars: Math.max(0, subscription.freshness_bars ?? 1),
                notifyTelegram: subscription.notify_telegram === 1,
                notifyExit: subscription.notify_exit === 1,
                candles: closed.candles,
            },
            env
        );

        // Exit signal detection: if no new entry and exit alerts enabled,
        // check if the last entry's opposite signal has fired
        if (result.ok && !result.newEntry && subscription.notify_exit === 1 && subscription.notify_telegram === 1) {
            try {
                const lastEntry = await env.SIGNALS_DB.prepare(
                    `SELECT payload_json FROM entry_signals WHERE stream_id = ? ORDER BY signal_time DESC, id DESC LIMIT 1`
                ).bind(streamId).first<{ payload_json: string }>();
                if (lastEntry) {
                    const lastPayload = safeJsonParse(lastEntry.payload_json, null as StoredSignalPayload | null);
                    if (lastPayload && result.preparedSignalCount > 0) {
                        // check latest prepared signal direction vs last entry direction
                        const evaluation = evaluateLatestEntrySignal({
                            strategyKey: subscription.strategy_key,
                            candles: closed.candles,
                            strategyParams: safeJsonParse(subscription.strategy_params_json, {} as Record<string, number>),
                            backtestSettings: safeJsonParse(subscription.backtest_settings_json, {} as BacktestSettings),
                            // Keep exit alerts fresh and avoid repeated stale exits.
                            freshnessBars: Math.max(0, subscription.freshness_bars ?? 1),
                        });
                        if (
                            evaluation.ok &&
                            evaluation.latestEntry &&
                            evaluation.latestEntry.direction !== lastPayload.direction &&
                            evaluation.latestEntry.signalTimeSec > lastPayload.signalTimeSec
                        ) {
                            const exitAlertKey = `${lastPayload.fingerprint}:${evaluation.latestEntry.fingerprint}`;
                            if (persistedExitAlertKey !== exitAlertKey) {
                                const exitMsg = buildExitTelegramMessage(
                                    lastPayload.direction,
                                    subscription.symbol,
                                    subscription.interval,
                                    evaluation.latestEntry.strategyName,
                                    subscription.strategy_key,
                                    evaluation.latestEntry.signal.price,
                                    evaluation.latestEntry.signalTimeSec
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
                }
            } catch { /* exit alerts are best effort */ }
        }

        if (result.ok && result.newEntry) {
            // New entry starts a fresh cycle; clear prior exit alert dedupe key.
            persistedExitAlertKey = null;
        }

        const baseStatus = result.ok
            ? result.newEntry
                ? "new_entry"
                : result.reason ?? "no_entry"
            : result.error ?? "processing_error";
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
        const status = normalizeStatusText(
            error instanceof Error ? error.message : String(error),
            Math.max(32, STATUS_TEXT_MAX - 6)
        );
        await updateSubscriptionStatus(env, streamId, `error:${status}`);
        return { streamId, status: `error:${status}` };
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
    const runs: Record<string, unknown>[] = [];

    for (const subscription of subscriptions) {
        const run = await runSubscription(env, subscription, false);
        runs.push(run);
    }

    return {
        ok: true,
        scanned: subscriptions.length,
        runs,
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
            return toJsonResponse({
                ok: true,
                service: "entry-signal-worker",
                now: new Date().toISOString(),
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

        if (request.method === "POST" && pathname === "/api/subscriptions/delete") {
            return handleSubscriptionDelete(request, env);
        }

        if (request.method === "POST" && pathname === "/api/subscriptions/run-now") {
            return handleRunNow(request, env);
        }

        return toJsonResponse({ ok: false, error: "Not found" }, 404);
    },

    async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
        if (!env.SIGNALS_DB) {
            console.error(JSON.stringify({ ok: false, error: "Missing SIGNALS_DB binding" }));
            return;
        }
        const summary = await runScheduledSubscriptions(env);
        console.log(JSON.stringify(summary));
    },
};
