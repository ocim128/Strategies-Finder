import type { DatabaseSync } from "node:sqlite";
import { upsertPolymarketReference1sPrices } from "./db";
import { getSymbolForReferenceSourceSymbol } from "./symbols";
import type {
    PolymarketReference1sPriceRow,
    SecondMarketReferenceSource,
    SecondMarketSymbol,
} from "./types";

const POLYMARKET_RTDS_WS_URL = "wss://ws-live-data.polymarket.com";

function nowSec(): number {
    return Math.floor(Date.now() / 1000);
}

function parseNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
}

function parseBooleanInt(value: unknown): 0 | 1 {
    return value === true || value === 1 || value === "true" ? 1 : 0;
}

function normalizePayloadRows(payload: unknown): Record<string, unknown>[] {
    if (!payload || typeof payload !== "object") return [];
    const row = payload as Record<string, unknown>;
    if (Array.isArray(row.data)) {
        return row.data
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
            .map((item) => ({
                ...item,
                symbol: item.symbol ?? row.symbol,
            }));
    }
    return [row];
}

function normalizeReferenceRow(
    topic: SecondMarketReferenceSource,
    payload: Record<string, unknown>,
    messageTimestamp: number | null,
    receivedAtMs: number
): PolymarketReference1sPriceRow | null {
    const sourceSymbol = String(payload.symbol ?? "").trim().toLowerCase();
    const symbol = getSymbolForReferenceSourceSymbol(sourceSymbol, topic);
    if (!symbol) return null;
    const sourceTsMs = parseNumber(payload.timestamp) ?? messageTimestamp;
    const value = parseNumber(payload.value);
    if (sourceTsMs === null || value === null || value <= 0) return null;
    return {
        symbol,
        reference_source: topic,
        source_symbol: sourceSymbol,
        ts: Math.floor(sourceTsMs / 1000),
        source_ts_ms: Math.floor(sourceTsMs),
        received_ts_ms: parseNumber(payload.received_at) ?? receivedAtMs,
        reference_price: value,
        full_accuracy_value: String(payload.full_accuracy_value ?? ""),
        is_carried_forward: parseBooleanInt(payload.is_carried_forward),
        quality_flags: parseBooleanInt(payload.is_carried_forward) ? "carried_forward" : "",
        updated_at: nowSec(),
    };
}

export function normalizeRtdsReferenceMessage(
    message: unknown,
    receivedAtMs = Date.now()
): PolymarketReference1sPriceRow[] {
    if (!message || typeof message !== "object") return [];
    const row = message as Record<string, unknown>;
    const topic = String(row.topic ?? "").trim() as SecondMarketReferenceSource;
    if (topic !== "crypto_prices" && topic !== "crypto_prices_chainlink") return [];
    const messageTimestamp = parseNumber(row.timestamp);
    return normalizePayloadRows(row.payload)
        .map((payload) => normalizeReferenceRow(topic, payload, messageTimestamp, receivedAtMs))
        .filter((item): item is PolymarketReference1sPriceRow => item !== null);
}

function buildReferenceSubscriptions(
    _symbols: readonly SecondMarketSymbol[],
    sources: readonly SecondMarketReferenceSource[]
): Array<Record<string, string>> {
    const subscriptions: Array<Record<string, string>> = [];
    if (sources.includes("crypto_prices")) {
        subscriptions.push({
            topic: "crypto_prices",
            type: "update",
        });
    }
    if (sources.includes("crypto_prices_chainlink")) {
        subscriptions.push({
            topic: "crypto_prices_chainlink",
            type: "*",
        });
    }
    return subscriptions;
}

export async function runPolymarketReferenceCapture(db: DatabaseSync, args: {
    symbols: readonly SecondMarketSymbol[];
    sources?: readonly SecondMarketReferenceSource[];
    durationSec?: number;
    signal?: AbortSignal;
    wsUrl?: string;
    onRows?: (rows: PolymarketReference1sPriceRow[]) => void;
}): Promise<void> {
    const sources = args.sources ?? ["crypto_prices"];
    const subscriptions = buildReferenceSubscriptions(args.symbols, sources);
    if (subscriptions.length === 0) return;
    const wsUrl = args.wsUrl ?? POLYMARKET_RTDS_WS_URL;

    await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let pingInterval: ReturnType<typeof setInterval> | null = null;
        let settled = false;
        const startedAt = Date.now();
        const symbolSet = new Set<SecondMarketSymbol>(args.symbols);
        const abort = () => stop();
        const cleanup = () => {
            if (pingInterval) clearInterval(pingInterval);
            args.signal?.removeEventListener("abort", abort);
            if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
                ws.close();
            }
        };
        const stop = () => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        };
        const fail = (error: Error) => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(error);
        };

        args.signal?.addEventListener("abort", abort, { once: true });

        ws.onopen = () => {
            ws.send(JSON.stringify({
                action: "subscribe",
                subscriptions,
            }));
            pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send("PING");
                }
                if (args.durationSec && Date.now() - startedAt >= args.durationSec * 1000) {
                    stop();
                }
            }, 5000);
        };

        ws.onmessage = (messageEvent) => {
            let payload: unknown = messageEvent.data;
            if (typeof payload === "string") {
                try {
                    payload = JSON.parse(payload);
                } catch {
                    return;
                }
            }
            const rows = normalizeRtdsReferenceMessage(payload, Date.now())
                .filter((row) => symbolSet.has(row.symbol));
            if (rows.length > 0) {
                upsertPolymarketReference1sPrices(db, rows);
                args.onRows?.(rows);
            }
        };

        ws.onerror = () => {
            fail(new Error("Polymarket RTDS websocket error."));
        };
        ws.onclose = () => {
            fail(new Error("Polymarket RTDS websocket closed."));
        };
    });
}
