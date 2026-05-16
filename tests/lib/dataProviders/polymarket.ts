import type { Time } from "lightweight-charts";
import { OHLCVData } from "../strategies/index";
import { debugLogger } from "../debug-logger";
import { HistoricalFetchOptions } from "../types/index";
import { getIntervalSeconds } from "./utils";
import { formatProviderError, isAbortError } from "./fetch-helpers";
import {
    fetchPolymarketHistoryWithFallback,
    normalizePolymarketHistoryPoints,
    type PolymarketHistoryPoint,
} from "../polymarket-history-client";

const POLYMARKET_PROXY_EVENT_URL = "/api/polymarket-event";
const POLYMARKET_PROXY_HISTORY_URL = "/api/polymarket-history";
const POLYMARKET_EVENT_URL = "https://gamma-api.polymarket.com/events/slug";
const POLYMARKET_HISTORY_URL = "https://clob.polymarket.com/prices-history";
const DEFAULT_POLYMARKET_INTERVAL = "5m";

type PolymarketDirection = "up" | "down";

type ParsedPolymarketInput = {
    slug: string;
    direction?: PolymarketDirection;
    canonicalSymbol: string;
};

type PolymarketMarket = {
    slug?: string;
    question?: string;
    outcomes?: string[] | string;
    clobTokenIds?: string[] | string;
    startDate?: string;
    endDate?: string;
};

type PolymarketEvent = {
    slug?: string;
    title?: string;
    startDate?: string;
    endDate?: string;
    markets?: PolymarketMarket[];
};

type ResolvedPolymarketMarket = {
    slug: string;
    canonicalSymbol: string;
    eventTitle: string;
    marketQuestion: string;
    outcomeLabel: string;
    clobTokenId: string;
    startTs?: number;
    endTs?: number;
};

const resolvedMarketCache = new Map<string, ResolvedPolymarketMarket>();

function normalizeDirection(raw: string | null | undefined): PolymarketDirection | undefined {
    if (!raw) return undefined;
    const value = raw.trim().toLowerCase();
    if (value === "up" || value === "yes") return "up";
    if (value === "down" || value === "no") return "down";
    return undefined;
}

function parsePolymarketUrl(input: string): ParsedPolymarketInput | null {
    try {
        const url = new URL(input);
        if (!/(^|\.)polymarket\.com$/i.test(url.hostname)) return null;
        const parts = url.pathname.split("/").filter(Boolean);
        const eventIdx = parts.findIndex(part => part.toLowerCase() === "event");
        if (eventIdx < 0 || !parts[eventIdx + 1]) return null;
        const slug = decodeURIComponent(parts[eventIdx + 1]).trim().toLowerCase();
        if (!/^[a-z0-9-]+$/.test(slug)) return null;
        const direction = normalizeDirection(url.searchParams.get("outcome") ?? url.searchParams.get("side"));
        const canonicalSymbol = `PM:${slug}${direction ? `:${direction.toUpperCase()}` : ""}`;
        return { slug, direction, canonicalSymbol };
    } catch {
        return null;
    }
}

export function parsePolymarketEventInput(input: string): ParsedPolymarketInput | null {
    const value = input.trim();
    if (!value) return null;

    const fromUrl = parsePolymarketUrl(value);
    if (fromUrl) return fromUrl;

    const prefixed = value.match(/^(?:pm|polymarket):(.+)$/i);
    const raw = prefixed ? prefixed[1].trim() : value;

    const withDirection = raw.match(/^([a-z0-9-]+?)(?:(?:[:#])(up|down|yes|no))?$/i);
    if (!withDirection) return null;

    const slug = withDirection[1].toLowerCase();
    const direction = normalizeDirection(withDirection[2]);
    // Accept canonical event-style slugs, including the common epoch suffix.
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)+$/.test(slug)) return null;
    if (!/-\d{8,}$/.test(slug) && !prefixed) return null;

    const canonicalSymbol = `PM:${slug}${direction ? `:${direction.toUpperCase()}` : ""}`;
    return { slug, direction, canonicalSymbol };
}

export function isPolymarketEventSymbol(symbol: string): boolean {
    return parsePolymarketEventInput(symbol) !== null;
}

export function formatPolymarketDisplayName(symbol: string): string | null {
    const parsed = parsePolymarketEventInput(symbol);
    if (!parsed) return null;
    const side = parsed.direction ? ` (${parsed.direction.toUpperCase()})` : "";
    return `Polymarket ${parsed.slug}${side}`;
}

async function fetchJsonWithFallback<T>(urls: string[], signal?: AbortSignal): Promise<T> {
    let lastError: unknown = null;
    for (const url of urls) {
        try {
            const response = await fetch(url, {
                signal,
                headers: {
                    Accept: "application/json",
                },
            });
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} for ${url}`);
            }
            return await response.json() as T;
        } catch (error) {
            lastError = error;
            if (isAbortError(error)) throw error;
        }
    }
    throw lastError ?? new Error("Polymarket request failed");
}

function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value
            .map((item) => String(item ?? "").trim())
            .filter(Boolean);
    }
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            const parsed = JSON.parse(trimmed);
            if (Array.isArray(parsed)) {
                return parsed
                    .map((item) => String(item ?? "").trim())
                    .filter(Boolean);
            }
        } catch {
            return [];
        }
    }
    return [];
}

function parseDateToSec(value: unknown): number | undefined {
    if (typeof value !== "string") return undefined;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return undefined;
    return Math.floor(ms / 1000);
}

function normalizeEvent(event: unknown): PolymarketEvent | null {
    if (!event || typeof event !== "object") return null;
    return event as PolymarketEvent;
}

function chooseOutcomeIndex(outcomes: string[], direction?: PolymarketDirection): number {
    if (!outcomes.length) return 0;

    const norm = outcomes.map((value) => value.trim().toLowerCase());
    if (direction === "down") {
        const idx = norm.findIndex((label) => label === "down" || label === "no" || label.includes("down"));
        if (idx >= 0) return idx;
    } else {
        const idx = norm.findIndex((label) => label === "up" || label === "yes" || label.includes("up"));
        if (idx >= 0) return idx;
    }

    const yesLikeIdx = norm.findIndex((label) => label === "yes" || label === "up");
    if (yesLikeIdx >= 0) return yesLikeIdx;
    return 0;
}

async function resolvePolymarketMarket(
    symbol: string,
    signal?: AbortSignal
): Promise<ResolvedPolymarketMarket | null> {
    const parsed = parsePolymarketEventInput(symbol);
    if (!parsed) return null;

    const cacheKey = parsed.canonicalSymbol.toUpperCase();
    const cached = resolvedMarketCache.get(cacheKey);
    if (cached) return cached;

    const encodedSlug = encodeURIComponent(parsed.slug);
    const event = await fetchJsonWithFallback<PolymarketEvent>([
        `${POLYMARKET_PROXY_EVENT_URL}?slug=${encodedSlug}`,
        `${POLYMARKET_EVENT_URL}/${encodedSlug}`,
    ], signal).then(normalizeEvent);

    if (!event) return null;

    const markets = Array.isArray(event.markets) ? event.markets : [];
    const market = markets.find((item) => String(item.slug || "").toLowerCase() === parsed.slug) ?? markets[0];
    if (!market) return null;

    const clobTokenIds = parseStringArray(market.clobTokenIds);
    if (clobTokenIds.length === 0) return null;

    const outcomes = parseStringArray(market.outcomes);
    const outcomeIndex = chooseOutcomeIndex(outcomes, parsed.direction);
    const clobTokenId = clobTokenIds[outcomeIndex] ?? clobTokenIds[0];
    if (!clobTokenId) return null;

    const resolved: ResolvedPolymarketMarket = {
        slug: parsed.slug,
        canonicalSymbol: parsed.canonicalSymbol,
        eventTitle: String(event.title || parsed.slug),
        marketQuestion: String(market.question || event.title || parsed.slug),
        outcomeLabel: outcomes[outcomeIndex] ?? outcomes[0] ?? (parsed.direction === "down" ? "Down" : "Up"),
        clobTokenId,
        startTs: parseDateToSec(market.startDate) ?? parseDateToSec(event.startDate),
        endTs: parseDateToSec(market.endDate) ?? parseDateToSec(event.endDate),
    };

    resolvedMarketCache.set(cacheKey, resolved);
    return resolved;
}

function toCandles(points: PolymarketHistoryPoint[], interval: string): OHLCVData[] {
    if (points.length === 0) return [];

    const intervalSeconds = Math.max(1, getIntervalSeconds(interval) || getIntervalSeconds(DEFAULT_POLYMARKET_INTERVAL) || 300);
    const candles: OHLCVData[] = [];
    let currentBucket = -1;
    let current: OHLCVData | null = null;

    for (const point of points) {
        const bucketStart = Math.floor(point.t / intervalSeconds) * intervalSeconds;
        if (!current || bucketStart !== currentBucket) {
            if (current) candles.push(current);
            currentBucket = bucketStart;
            current = {
                time: bucketStart as Time,
                open: point.p,
                high: point.p,
                low: point.p,
                close: point.p,
                volume: 1,
            };
            continue;
        }

        current.high = Math.max(current.high, point.p);
        current.low = Math.min(current.low, point.p);
        current.close = point.p;
        current.volume = (current.volume || 0) + 1;
    }

    if (current) candles.push(current);
    return candles;
}

async function fetchPolymarketHistory(
    market: ResolvedPolymarketMarket,
    signal?: AbortSignal
): Promise<PolymarketHistoryPoint[]> {
    const params = new URLSearchParams({ market: market.clobTokenId });
    const nowSec = Math.floor(Date.now() / 1000);
    const startTs = market.startTs;
    const endTs = market.endTs ? Math.min(market.endTs, nowSec) : nowSec;

    if (Number.isFinite(startTs) && Number.isFinite(endTs) && (endTs as number) > (startTs as number)) {
        params.set("startTs", String(Math.max(0, Math.floor((startTs as number) - 3600))));
        params.set("endTs", String(Math.max(0, Math.floor((endTs as number) + 900))));
    } else {
        params.set("interval", "max");
    }

    const response = await fetchPolymarketHistoryWithFallback([
        `${POLYMARKET_PROXY_HISTORY_URL}?${params.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${params.toString()}`,
    ], { signal });

    const points = normalizePolymarketHistoryPoints(response);
    if (points.length > 0) return points;

    // Fallback for markets that reject start/end windows.
    const fallbackParams = new URLSearchParams({
        market: market.clobTokenId,
        interval: "max",
    });
    const fallback = await fetchPolymarketHistoryWithFallback([
        `${POLYMARKET_PROXY_HISTORY_URL}?${fallbackParams.toString()}`,
        `${POLYMARKET_HISTORY_URL}?${fallbackParams.toString()}`,
    ], { signal });
    return normalizePolymarketHistoryPoints(fallback);
}

export async function fetchPolymarketData(
    symbol: string,
    interval: string,
    signal?: AbortSignal
): Promise<OHLCVData[]> {
    try {
        const market = await resolvePolymarketMarket(symbol, signal);
        if (!market) return [];

        const points = await fetchPolymarketHistory(market, signal);
        const candles = toCandles(points, interval);
        debugLogger.info("data.polymarket.fetch", {
            symbol: market.canonicalSymbol,
            slug: market.slug,
            outcome: market.outcomeLabel,
            points: points.length,
            candles: candles.length,
            interval,
        });
        return candles;
    } catch (error) {
        if (isAbortError(error)) return [];
        debugLogger.error("data.polymarket.error", {
            symbol,
            interval,
            error: formatProviderError(error),
        });
        return [];
    }
}

export async function fetchPolymarketDataWithLimit(
    symbol: string,
    interval: string,
    totalBars: number,
    options?: HistoricalFetchOptions
): Promise<OHLCVData[]> {
    const targetBars = Math.max(1, Math.floor(totalBars));
    const candles = await fetchPolymarketData(symbol, interval, options?.signal);
    const sliced = candles.slice(-targetBars);
    options?.onProgress?.({
        fetched: sliced.length,
        total: targetBars,
        requestCount: 1,
    });
    return sliced;
}
