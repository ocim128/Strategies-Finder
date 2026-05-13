import { createHash } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import { getPolymarketOutcomeIntervalDurationSec, resolvePolymarketOutcomeInterval, type PolymarketOutcomeInterval } from "../polymarket-outcome-interval";
import { upsertPolymarketGammaSnapshots } from "./db";
import { getSecondMarketSeriesId } from "./symbols";
import type {
    PolymarketGammaSnapshotRow,
    SecondMarketPolymarketEvent,
    SecondMarketSymbol,
} from "./types";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";

type RawMarket = Record<string, unknown>;
type RawEvent = Record<string, unknown>;

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
    if (value === true) return 1;
    if (value === false || value === null || value === undefined) return 0;
    if (typeof value === "number") return value > 0 ? 1 : 0;
    if (typeof value === "string") {
        const normalized = value.trim().toLowerCase();
        return normalized === "true" || normalized === "1" || normalized === "yes" ? 1 : 0;
    }
    return 0;
}

function parseIsoSec(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) {
        return value.map((item) => String(item ?? "").trim()).filter(Boolean);
    }
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed)
            ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean)
            : [];
    } catch {
        return trimmed.split(",").map((item) => item.trim()).filter(Boolean);
    }
}

function chooseYesIndex(outcomes: readonly string[]): number {
    const normalized = outcomes.map((outcome) => outcome.trim().toLowerCase());
    const upIndex = normalized.findIndex((outcome) =>
        outcome === "up" || outcome === "yes" || outcome.includes("up")
    );
    return upIndex >= 0 ? upIndex : 0;
}

function hashJson(value: unknown): string {
    return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function normalizeMarketEvent(args: {
    symbol: SecondMarketSymbol;
    seriesId: string;
    outcomeInterval: PolymarketOutcomeInterval;
    event: RawEvent;
    market: RawMarket;
}): SecondMarketPolymarketEvent | null {
    const endTs = parseIsoSec(args.event.endDate ?? args.event.end_date ?? args.market.endDate ?? args.market.end_date);
    if (endTs === null) return null;
    const eventStartTs = endTs - getPolymarketOutcomeIntervalDurationSec(args.outcomeInterval);
    const marketSlug = String(args.market.slug ?? args.event.slug ?? "").trim();
    const eventSlug = String(args.event.slug ?? marketSlug).trim();
    const marketId = String(args.market.id ?? args.market.marketId ?? marketSlug).trim();
    const conditionId = String(args.market.conditionId ?? args.market.condition_id ?? "").trim();
    const outcomes = parseStringArray(args.market.outcomes);
    const tokenIds = parseStringArray(args.market.clobTokenIds ?? args.market.clob_token_ids);
    if (!marketSlug || !eventSlug || !marketId || tokenIds.length === 0) return null;
    const yesIndex = chooseYesIndex(outcomes);
    const yesTokenId = tokenIds[yesIndex] ?? tokenIds[0] ?? "";
    const noIndex = yesIndex === 0 && tokenIds.length > 1 ? 1 : yesIndex > 0 ? 0 : -1;
    const noTokenId = noIndex >= 0 ? tokenIds[noIndex] ?? "" : "";
    if (!yesTokenId) return null;

    return {
        seriesId: args.seriesId,
        symbol: args.symbol,
        outcomeInterval: args.outcomeInterval,
        eventSlug,
        marketId,
        conditionId,
        marketSlug,
        eventStartTs,
        eventEndTs: endTs,
        yesTokenId,
        noTokenId,
    };
}

export function normalizeGammaEvent(args: {
    symbol: SecondMarketSymbol;
    seriesId: string;
    outcomeInterval: PolymarketOutcomeInterval;
    event: RawEvent;
    snapshotTs?: number;
}): { events: SecondMarketPolymarketEvent[]; snapshots: PolymarketGammaSnapshotRow[] } {
    const markets = Array.isArray(args.event.markets) ? args.event.markets as RawMarket[] : [];
    const snapshotTs = args.snapshotTs ?? nowSec();
    const updatedAt = nowSec();
    const events: SecondMarketPolymarketEvent[] = [];
    const snapshots: PolymarketGammaSnapshotRow[] = [];

    for (const market of markets) {
        const event = normalizeMarketEvent({
            symbol: args.symbol,
            seriesId: args.seriesId,
            outcomeInterval: args.outcomeInterval,
            event: args.event,
            market,
        });
        if (!event) continue;

        const outcomes = parseStringArray(market.outcomes);
        const prices = parseStringArray(market.outcomePrices ?? market.outcome_prices).map((value) => Number(value));
        const yesIndex = chooseYesIndex(outcomes);
        const noIndex = yesIndex === 0 && prices.length > 1 ? 1 : yesIndex > 0 ? 0 : -1;
        const gammaYesPrice = Number.isFinite(prices[yesIndex]) ? prices[yesIndex]! : null;
        const gammaNoPrice = noIndex >= 0 && Number.isFinite(prices[noIndex]) ? prices[noIndex]! : null;
        const rawJsonHash = hashJson({ event: args.event, market });

        events.push(event);
        snapshots.push({
            series_id: event.seriesId,
            symbol: event.symbol,
            outcome_interval: event.outcomeInterval,
            market_id: event.marketId,
            condition_id: event.conditionId,
            market_slug: event.marketSlug,
            event_start_ts: event.eventStartTs,
            event_end_ts: event.eventEndTs,
            snapshot_ts: snapshotTs,
            gamma_yes_price: gammaYesPrice,
            gamma_no_price: gammaNoPrice,
            last_trade_price: parseNumber(market.lastTradePrice ?? market.last_trade_price),
            liquidity: parseNumber(market.liquidity),
            volume: parseNumber(market.volume),
            open_interest: parseNumber(market.openInterest ?? market.open_interest),
            active: parseBooleanInt(market.active),
            closed: parseBooleanInt(market.closed),
            remote_updated_at: parseIsoSec(market.updatedAt ?? market.updated_at),
            raw_json_hash: rawJsonHash,
            raw_json: null,
            updated_at: updatedAt,
        });
    }

    return { events, snapshots };
}

export async function fetchGammaEvents(args: {
    seriesId: string;
    active?: boolean;
    closed?: boolean;
    endDateMinSec?: number;
    limit?: number;
    offset?: number;
    signal?: AbortSignal;
}): Promise<RawEvent[]> {
    const url = new URL(GAMMA_EVENTS_URL);
    url.searchParams.set("series_id", args.seriesId);
    url.searchParams.set("active", args.active === false ? "false" : "true");
    url.searchParams.set("closed", args.closed === true ? "true" : "false");
    url.searchParams.set("order", "endDate");
    url.searchParams.set("ascending", "true");
    if (args.endDateMinSec !== undefined) {
        url.searchParams.set("end_date_min", new Date(Math.floor(args.endDateMinSec) * 1000).toISOString());
    }
    url.searchParams.set("limit", String(Math.max(1, Math.min(500, Math.floor(args.limit ?? 100)))));
    url.searchParams.set("offset", String(Math.max(0, Math.floor(args.offset ?? 0))));
    const response = await fetch(url, {
        headers: { Accept: "application/json" },
        signal: args.signal,
    });
    if (!response.ok) {
        throw new Error(`Gamma events fetch failed: HTTP ${response.status}`);
    }
    const payload = await response.json() as unknown;
    return Array.isArray(payload) ? payload as RawEvent[] : [];
}

export async function syncGammaSnapshots(db: DatabaseSync, args: {
    symbol: SecondMarketSymbol;
    outcomeInterval?: PolymarketOutcomeInterval;
    signal?: AbortSignal;
}): Promise<{ events: SecondMarketPolymarketEvent[]; upserted: number }> {
    const outcomeInterval = resolvePolymarketOutcomeInterval(args.outcomeInterval);
    const seriesId = getSecondMarketSeriesId(args.symbol, outcomeInterval);
    const intervalSec = getPolymarketOutcomeIntervalDurationSec(outcomeInterval);
    const snapshotTs = nowSec();
    const events = await fetchGammaEvents({
        seriesId,
        active: true,
        closed: false,
        endDateMinSec: snapshotTs - intervalSec,
        limit: 100,
        signal: args.signal,
    });
    const normalized = events.map((event) =>
        normalizeGammaEvent({
            symbol: args.symbol,
            seriesId,
            outcomeInterval,
            event,
            snapshotTs,
        })
    );
    const marketEvents = normalized.flatMap((item) => item.events);
    const snapshots = normalized
        .flatMap((item) => item.snapshots)
        .filter((snapshot) =>
            snapshot.event_start_ts <= snapshotTs && snapshotTs < snapshot.event_end_ts
        );
    return {
        events: marketEvents,
        upserted: upsertPolymarketGammaSnapshots(db, snapshots),
    };
}
