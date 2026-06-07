import type { DatabaseSync } from "node:sqlite";
import { upsertPolymarketClob1sQuotes } from "./db";
import type {
    PolymarketClob1sQuoteRow,
    SecondMarketPolymarketEvent,
    SecondMarketSide,
} from "./types";

const POLYMARKET_CLOB_MARKET_WS_URL = "wss://ws-subscriptions-clob.polymarket.com/ws/market";

type TokenQuote = {
    bid: number | null;
    ask: number | null;
    last: number | null;
    sourceTsMs: number | null;
};

export type PolymarketClobBookState = {
    yes: TokenQuote;
    no: TokenQuote;
};

function emptyTokenQuote(): TokenQuote {
    return {
        bid: null,
        ask: null,
        last: null,
        sourceTsMs: null,
    };
}

export function createEmptyClobBookState(): PolymarketClobBookState {
    return {
        yes: emptyTokenQuote(),
        no: emptyTokenQuote(),
    };
}

function parseNumber(value: unknown): number | null {
    if (typeof value === "number") return Number.isFinite(value) ? value : null;
    if (typeof value === "string" && value.trim() !== "") {
        const numeric = Number(value);
        return Number.isFinite(numeric) ? numeric : null;
    }
    return null;
}

function clampProbability(value: number | null): number | null {
    if (value === null) return null;
    if (value < 0 || value > 1) return null;
    return value;
}

function parseSourceTsMs(value: unknown, fallback: number): number {
    const numeric = parseNumber(value);
    if (numeric === null) return fallback;
    return numeric > 9_999_999_999 ? Math.floor(numeric) : Math.floor(numeric * 1000);
}

function parseLevelsBest(levels: unknown, preferHigh: boolean): number | null {
    if (!Array.isArray(levels) || levels.length === 0) return null;
    const prices = levels
        .map((level) => {
            if (Array.isArray(level)) return parseNumber(level[0]);
            if (level && typeof level === "object") {
                const row = level as Record<string, unknown>;
                return parseNumber(row.price ?? row.p);
            }
            return null;
        })
        .filter((value): value is number => value !== null && value >= 0 && value <= 1);
    if (prices.length === 0) return null;
    return preferHigh ? Math.max(...prices) : Math.min(...prices);
}

function getMessageRows(message: unknown): Record<string, unknown>[] {
    if (Array.isArray(message)) {
        return message.flatMap(getMessageRows);
    }
    if (!message || typeof message !== "object") return [];
    const row = message as Record<string, unknown>;
    if (Array.isArray(row.data)) return getMessageRows(row.data);
    if (Array.isArray(row.events)) return getMessageRows(row.events);
    if (Array.isArray(row.price_changes)) {
        return row.price_changes
            .filter((item): item is Record<string, unknown> => Boolean(item && typeof item === "object"))
            .map((item) => ({
                ...item,
                event_type: item.event_type ?? row.event_type,
                market: item.market ?? row.market,
                timestamp: item.timestamp ?? row.timestamp,
            }));
    }
    return [row];
}

function resolveSide(row: Record<string, unknown>, event: SecondMarketPolymarketEvent): SecondMarketSide | null {
    const assetId = String(row.asset_id ?? row.assetId ?? row.token_id ?? row.tokenId ?? row.market ?? "").trim();
    if (assetId === event.yesTokenId) return "yes";
    if (event.noTokenId && assetId === event.noTokenId) return "no";
    return null;
}

function updateTokenQuote(target: TokenQuote, patch: Partial<TokenQuote>, sourceTsMs: number): void {
    if (patch.bid !== undefined) target.bid = clampProbability(patch.bid);
    if (patch.ask !== undefined) target.ask = clampProbability(patch.ask);
    if (patch.last !== undefined) target.last = clampProbability(patch.last);
    target.sourceTsMs = Math.max(target.sourceTsMs ?? 0, sourceTsMs);
}

export function applyClobWebSocketMessage(
    state: PolymarketClobBookState,
    event: SecondMarketPolymarketEvent,
    message: unknown,
    receivedTsMs = Date.now()
): void {
    for (const row of getMessageRows(message)) {
        const side = resolveSide(row, event);
        if (!side) continue;
        const sourceTsMs = parseSourceTsMs(row.timestamp ?? row.ts ?? row.time, receivedTsMs);
        const eventType = String(row.event_type ?? row.type ?? "").trim().toLowerCase();
        const target = side === "yes" ? state.yes : state.no;

        if (eventType === "book" || Array.isArray(row.bids) || Array.isArray(row.asks)) {
            updateTokenQuote(target, {
                bid: parseLevelsBest(row.bids ?? row.buys, true),
                ask: parseLevelsBest(row.asks ?? row.sells, false),
            }, sourceTsMs);
            continue;
        }

        const bestBid = parseNumber(row.best_bid ?? row.bestBid ?? row.bid);
        const bestAsk = parseNumber(row.best_ask ?? row.bestAsk ?? row.ask);
        const last = parseNumber(row.last_trade_price ?? row.lastTradePrice ?? row.price);
        updateTokenQuote(target, {
            ...(bestBid !== null ? { bid: bestBid } : {}),
            ...(bestAsk !== null ? { ask: bestAsk } : {}),
            ...(last !== null ? { last } : {}),
        }, sourceTsMs);
    }
}

function midPrice(bid: number | null, ask: number | null): number | null {
    if (bid === null || ask === null) return null;
    return (bid + ask) / 2;
}

function latestSourceTsMs(state: PolymarketClobBookState): number | null {
    const values = [state.yes.sourceTsMs, state.no.sourceTsMs]
        .filter((value): value is number => value !== null && Number.isFinite(value));
    return values.length > 0 ? Math.max(...values) : null;
}

function hasReceivedAnyBookData(state: PolymarketClobBookState): boolean {
    return state.yes.sourceTsMs !== null || state.no.sourceTsMs !== null;
}

function isEventActiveAt(event: SecondMarketPolymarketEvent, sampleTs: number): boolean {
    return event.eventStartTs <= sampleTs && sampleTs < event.eventEndTs;
}

export function selectClobSubscriptionEvents(
    events: readonly SecondMarketPolymarketEvent[],
    sampleTs: number,
    horizonSec: number
): SecondMarketPolymarketEvent[] {
    const maxStartTs = sampleTs + Math.max(0, Math.floor(horizonSec));
    const seen = new Set<string>();
    const selected: SecondMarketPolymarketEvent[] = [];

    for (const event of events) {
        if (event.eventEndTs <= sampleTs) continue;
        if (event.eventStartTs > maxStartTs) continue;
        const key = `${event.yesTokenId}:${event.noTokenId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        selected.push(event);
    }

    return selected.sort((a, b) =>
        a.eventStartTs - b.eventStartTs || a.symbol.localeCompare(b.symbol)
    );
}

function qualityFlags(state: PolymarketClobBookState, sourceTsMs: number | null, sampleTs: number): string {
    const flags: string[] = [];
    if (sourceTsMs === null) flags.push("missing_source_ts");
    if (state.yes.bid === null || state.yes.ask === null) flags.push("missing_yes_bid_ask");
    if (state.no.bid === null || state.no.ask === null) flags.push("missing_no_bid_ask");
    if (sourceTsMs !== null && Math.floor(sourceTsMs / 1000) < sampleTs) flags.push("carried_forward");
    return flags.join(",");
}

export function buildClobQuoteRow(
    event: SecondMarketPolymarketEvent,
    state: PolymarketClobBookState,
    sampleTs: number,
    receivedTsMs = Date.now()
): PolymarketClob1sQuoteRow {
    const sourceTsMs = latestSourceTsMs(state);
    return {
        series_id: event.seriesId,
        symbol: event.symbol,
        outcome_interval: event.outcomeInterval,
        event_start_ts: event.eventStartTs,
        event_end_ts: event.eventEndTs,
        condition_id: event.conditionId,
        market_slug: event.marketSlug,
        yes_token_id: event.yesTokenId,
        no_token_id: event.noTokenId,
        sample_ts: sampleTs,
        yes_bid: state.yes.bid,
        yes_ask: state.yes.ask,
        yes_mid: midPrice(state.yes.bid, state.yes.ask),
        yes_last: state.yes.last,
        no_bid: state.no.bid,
        no_ask: state.no.ask,
        no_mid: midPrice(state.no.bid, state.no.ask),
        no_last: state.no.last,
        source: "polymarket_clob_1s",
        source_ts_ms: sourceTsMs,
        quote_age_ms: sourceTsMs === null ? null : Math.max(0, receivedTsMs - sourceTsMs),
        quality_flags: qualityFlags(state, sourceTsMs, sampleTs),
        updated_at: Math.floor(receivedTsMs / 1000),
    };
}

export async function runPolymarketClobCapture(db: DatabaseSync, args: {
    events: readonly SecondMarketPolymarketEvent[];
    durationSec?: number;
    signal?: AbortSignal;
    wsUrl?: string;
    onSample?: (rows: PolymarketClob1sQuoteRow[]) => void;
}): Promise<void> {
    if (args.events.length === 0) return;
    const wsUrl = args.wsUrl ?? POLYMARKET_CLOB_MARKET_WS_URL;
    const stateByEvent = new Map<SecondMarketPolymarketEvent, PolymarketClobBookState>();
    for (const event of args.events) {
        stateByEvent.set(event, createEmptyClobBookState());
    }

    await new Promise<void>((resolve, reject) => {
        const ws = new WebSocket(wsUrl);
        let interval: ReturnType<typeof setInterval> | null = null;
        let pingInterval: ReturnType<typeof setInterval> | null = null;
        let settled = false;
        const startedAt = Date.now();
        const abort = () => stop();
        const cleanup = () => {
            if (interval) clearInterval(interval);
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
            const assetIds = args.events.flatMap((event) =>
                event.noTokenId ? [event.yesTokenId, event.noTokenId] : [event.yesTokenId]
            );
            ws.send(JSON.stringify({
                type: "market",
                assets_ids: assetIds,
                custom_feature_enabled: true,
            }));
            pingInterval = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) {
                    ws.send("PING");
                }
            }, 10_000);
            interval = setInterval(() => {
                const sampleTs = Math.floor(Date.now() / 1000);
                const receivedTsMs = Date.now();
                const rows = args.events
                    .filter((event) => isEventActiveAt(event, sampleTs))
                    .filter((event) => hasReceivedAnyBookData(stateByEvent.get(event)!))
                    .map((event) => buildClobQuoteRow(event, stateByEvent.get(event)!, sampleTs, receivedTsMs));
                if (rows.length > 0) {
                    upsertPolymarketClob1sQuotes(db, rows);
                }
                args.onSample?.(rows);
                if (args.durationSec && Date.now() - startedAt >= args.durationSec * 1000) {
                    stop();
                }
            }, 1000);
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
            const receivedTsMs = Date.now();
            for (const event of args.events) {
                applyClobWebSocketMessage(stateByEvent.get(event)!, event, payload, receivedTsMs);
            }
        };

        ws.onerror = () => {
            fail(new Error("Polymarket CLOB websocket error."));
        };
        ws.onclose = (event: CloseEvent) => {
            const reason = event.reason ? ` reason=${event.reason}` : "";
            fail(new Error(`Polymarket CLOB websocket closed code=${event.code}${reason}.`));
        };
    });
}
