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
}

const MIN_CANDLES = 200;
const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

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

function buildTelegramMessage(signal: StoredSignalPayload): string {
    return [
        "New Entry Signal",
        `Symbol: ${signal.symbol}`,
        `Interval: ${signal.interval}`,
        `Strategy: ${signal.strategyName} (${signal.strategyKey})`,
        `Direction: ${signal.direction.toUpperCase()}`,
        `Price: ${signal.signalPrice}`,
        `Time (UTC): ${new Date(signal.signalTimeSec * 1000).toISOString()}`,
        signal.signalReason ? `Reason: ${signal.signalReason}` : "",
    ]
        .filter(Boolean)
        .join("\n");
}

async function sendTelegramAlert(env: Env, signal: StoredSignalPayload): Promise<void> {
    const token = env.TELEGRAM_BOT_TOKEN;
    const chatId = env.TELEGRAM_CHAT_ID;
    if (!token || !chatId) return;

    const response = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            chat_id: chatId,
            text: buildTelegramMessage(signal),
        }),
    });

    if (!response.ok) {
        const detail = await response.text();
        throw new Error(`Telegram send failed (${response.status}): ${detail}`);
    }
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
    if (normalizedCandles.length < MIN_CANDLES) {
        return toJsonResponse(
            {
                ok: false,
                error: `Not enough candles. Need at least ${MIN_CANDLES}.`,
                candleCount: normalizedCandles.length,
            },
            400
        );
    }

    const symbol = normalizeText(payload.symbol).toUpperCase();
    const interval = normalizeText(payload.interval);
    const strategyKey = normalizeText(payload.strategyKey);
    const streamId = payload.streamId ? normalizeText(payload.streamId) : "";
    const channelKey = buildChannelKey({ streamId, symbol, interval, strategyKey });

    const evaluation = evaluateLatestEntrySignal({
        strategyKey,
        candles: normalizedCandles,
        strategyParams: payload.strategyParams ?? {},
        backtestSettings: payload.backtestSettings ?? {},
        freshnessBars: payload.freshnessBars ?? 1,
    });

    if (!evaluation.ok) {
        return toJsonResponse(
            {
                ok: false,
                error: evaluation.reason ?? "evaluation_failed",
                rawSignalCount: evaluation.rawSignalCount,
                preparedSignalCount: evaluation.preparedSignalCount,
            },
            422
        );
    }

    if (!evaluation.latestEntry) {
        return toJsonResponse({
            ok: true,
            newEntry: false,
            reason: evaluation.reason ?? "no_signals",
            rawSignalCount: evaluation.rawSignalCount,
            preparedSignalCount: evaluation.preparedSignalCount,
        });
    }

    if (!evaluation.latestEntry.isFresh) {
        return toJsonResponse({
            ok: true,
            newEntry: false,
            reason: "stale_signal",
            signalAgeBars: evaluation.latestEntry.signalAgeBars,
            rawSignalCount: evaluation.rawSignalCount,
            preparedSignalCount: evaluation.preparedSignalCount,
            latestEntry: evaluation.latestEntry,
        });
    }

    const entryPayload: StoredSignalPayload = {
        streamId: streamId || channelKey,
        symbol,
        interval,
        strategyKey,
        strategyName: evaluation.latestEntry.strategyName,
        direction: evaluation.latestEntry.direction,
        signalTimeSec: evaluation.latestEntry.signalTimeSec,
        signalAgeBars: evaluation.latestEntry.signalAgeBars,
        signalPrice: evaluation.latestEntry.signal.price,
        signalReason: evaluation.latestEntry.signal.reason ?? null,
        fingerprint: evaluation.latestEntry.fingerprint,
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

    if (inserted && payload.notifyTelegram) {
        try {
            await sendTelegramAlert(env, entryPayload);
        } catch (error) {
            return toJsonResponse(
                {
                    ok: true,
                    newEntry: true,
                    telegramSent: false,
                    telegramError: error instanceof Error ? error.message : String(error),
                    entry: entryPayload,
                },
                200
            );
        }
    }

    return toJsonResponse({
        ok: true,
        newEntry: inserted,
        duplicate: !inserted,
        entry: entryPayload,
        rawSignalCount: evaluation.rawSignalCount,
        preparedSignalCount: evaluation.preparedSignalCount,
    });
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
            payload: safeJsonParse(row.payload_json),
        })),
    });
}

function safeJsonParse(value: string): unknown {
    try {
        return JSON.parse(value);
    } catch {
        return null;
    }
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

        return toJsonResponse({ ok: false, error: "Not found" }, 404);
    },
};
