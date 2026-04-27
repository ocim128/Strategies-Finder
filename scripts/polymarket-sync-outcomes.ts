/**
 * polymarket-sync-outcomes.ts
 *
 * Fetches closed supported Polymarket outcome sessions and upserts resolved outcome rows
 * into the local SQLite DB via the Vite /api/sqlite/store-polymarket-outcomes
 * endpoint.
 *
 * Usage (run while `npm run dev` is active so the Vite server is up):
 *
 *   npx esno scripts/polymarket-sync-outcomes.ts [options]
 *   ..\..\..\node_modules\.bin\esno scripts/polymarket-sync-outcomes.ts [options]
 *   npm run poly:sync-outcomes   (default BTC sync only)
 *   npm run poly:sync-outcomes:all
 *   npm run poly:sync-outcomes:repair
 *   npm run poly:sync-outcomes:repair:all
 *
 * Options:
 *   --symbol <symbol>      Resolve series id from symbol (BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT)
 *   --interval <value>     Native outcome session: 5m, 15m, or 1h
 *   --all                  Sync all supported symbols in sequence
 *   --series-id <id>       Polymarket series id override (default: 10684, BTC up/down 5m)
 *   --start-date <iso>     Inclusive lower bound for event end date
 *   --end-date <iso>       Inclusive upper bound for event end date
 *   --max-events <n>       Max closed events to store after pagination (default: 10000)
 *   --page-size <n>        Pagination page size (default: 500)
 *   --concurrency <n>      Parallel history fetch workers (default: 8)
 *   --vite-origin <url>    Base URL of local Vite dev server (default: http://localhost:5173)
 *   --out <file>           Optional JSON audit output path
 *   --dry-run              Fetch and print without writing to SQLite
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { planPolymarketEventSync } from "../lib/polymarket-sync-utils";
import {
    BTC_5M_POLYMARKET_SERIES_ID,
    getPolymarketSeriesIdForSymbol,
    getSupportedPolymarket5mSymbolsLabel,
    SUPPORTED_POLYMARKET_SYMBOLS,
    type SupportedPolymarketSymbol,
} from "../lib/polymarket-btc5m";
import {
    DEFAULT_POLYMARKET_OUTCOME_INTERVAL,
    getPolymarketOutcomeIntervalDurationSec,
    POLYMARKET_OUTCOME_INTERVALS,
    resolvePolymarketOutcomeInterval,
    type PolymarketOutcomeInterval,
} from "../lib/polymarket-outcome-interval";

// ─── Types ────────────────────────────────────────────────────────────────

type CliConfig = {
    seriesId: string;
    symbol?: string;
    allSymbols: boolean;
    outcomeInterval: PolymarketOutcomeInterval;
    hasExplicitOutcomeInterval: boolean;
    startDateMin: string;
    endDateMax?: string;
    maxEvents: number;
    pageSize: number;
    concurrency: number;
    refreshRecent: number;
    viteOrigin: string;
    outPath?: string;
    dryRun: boolean;
};

type NpmConfigEnv = {
    symbol?: string;
    seriesId?: string;
    allSymbols?: boolean;
    outcomeInterval?: string;
    startDate?: string;
    endDate?: string;
    maxEvents?: number;
    pageSize?: number;
    concurrency?: number;
    refreshRecent?: number;
    viteOrigin?: string;
    outPath?: string;
    dryRun?: boolean;
};

type RawMarket = {
    slug?: unknown;
    outcomes?: unknown;
    outcomePrices?: unknown;
    clobTokenIds?: unknown;
};

type RawEvent = {
    slug?: unknown;
    endDate?: unknown;
    markets?: unknown;
};

type SeriesEvent = {
    slug: string;
    endTs: number;             // unix-s
    marketSlug: string;
    upTokenId: string;
    noTokenId: string;
    settleUp: 0 | 1;
};

type HistoryPoint = { t: number; p: number };

/** Matches PolymarketOutcomeRow from lib/types/polymarket-outcomes.ts */
type OutcomeRow = {
    series_id: string;
    event_slug: string;
    market_slug: string;
    interval: string;
    event_start_ts: number;
    event_end_ts: number;
    yes_token_id: string;
    no_token_id: string;
    yes_open_price: number | null;
    yes_entry_minute_1_price: number | null;
    yes_entry_minute_2_price: number | null;
    yes_entry_minute_3_price: number | null;
    yes_entry_minute_4_price: number | null;
    resolved_outcome_up: 0 | 1;
    resolution_source: string;
    updated_at: number;
};

type ExistingOutcomeSlugRow = {
    event_slug?: unknown;
};

export type OutcomeSyncTarget = {
    symbol?: SupportedPolymarketSymbol;
    outcomeInterval: PolymarketOutcomeInterval;
    seriesId: string;
};

type OutcomeSyncSummary = {
    symbol?: string;
    outcomeInterval: PolymarketOutcomeInterval;
    seriesId: string;
    events: number;
    syncEvents: number;
    rows: number;
    withHistory: number;
    upserted: number;
    skippedExisting: number;
    refreshedExisting: number;
    missingEvents: number;
};

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_SERIES_ID: string = BTC_5M_POLYMARKET_SERIES_ID;
const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const CLOB_HISTORY_URL = "https://clob.polymarket.com/prices-history";

// ─── CLI ──────────────────────────────────────────────────────────────────

function defaultStartDateIso(daysBack: number): string {
    const now = new Date();
    return new Date(now.getTime() - daysBack * 86_400_000).toISOString();
}

function parseNumber(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function readNpmConfigEnv(): NpmConfigEnv {
    const env = process.env;
    const readString = (...keys: string[]): string | undefined => {
        for (const key of keys) {
            const value = env[key];
            if (typeof value === "string" && value.trim()) {
                return value.trim();
            }
        }
        return undefined;
    };
    const readBoolean = (...keys: string[]): boolean | undefined => {
        const raw = readString(...keys);
        if (!raw) return undefined;
        const normalized = raw.trim().toLowerCase();
        if (["1", "true", "yes"].includes(normalized)) return true;
        if (["0", "false", "no"].includes(normalized)) return false;
        return undefined;
    };

    return {
        symbol: readString("npm_config_symbol"),
        seriesId: readString("npm_config_series_id", "npm_config_seriesid"),
        allSymbols: readBoolean("npm_config_all", "npm_config_all_symbols", "npm_config_allsymbols"),
        outcomeInterval: readString("npm_config_interval", "npm_config_outcome_interval", "npm_config_outcomeinterval"),
        startDate: readString("npm_config_start_date", "npm_config_startdate"),
        endDate: readString("npm_config_end_date", "npm_config_enddate"),
        maxEvents: parseNumber(readString("npm_config_max_events", "npm_config_maxevents"), Number.NaN),
        pageSize: parseNumber(readString("npm_config_page_size", "npm_config_pagesize"), Number.NaN),
        concurrency: parseNumber(readString("npm_config_concurrency"), Number.NaN),
        refreshRecent: parseNumber(readString("npm_config_refresh_recent", "npm_config_refreshrecent"), Number.NaN),
        viteOrigin: readString("npm_config_vite_origin", "npm_config_viteorigin"),
        outPath: readString("npm_config_out"),
        dryRun: readBoolean("npm_config_dry_run", "npm_config_dryrun"),
    };
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run poly:sync-outcomes",
        "  npm run poly:sync-outcomes:all",
        "  npm run poly:sync-outcomes:repair",
        "  npm run poly:sync-outcomes:repair:all",
        "  ..\\..\\..\\node_modules\\.bin\\esno scripts\\polymarket-sync-outcomes.ts [options]",
        "",
        "Options:",
        `  --symbol <symbol>      Resolve the native session series id from symbol (${getSupportedPolymarket5mSymbolsLabel()})`,
        "  --interval <value>     Native outcome session: 5m, 15m, or 1h (default: 5m)",
        "  --all                  Sync all supported symbols; expands to 5m/15m/1h unless --interval is explicit",
        "  --series-id <id>       Polymarket series id override (default: 10684, BTC up/down 5m)",
        "  --start-date <iso>     Lower bound for event end date (default: now-30d)",
        "  --end-date <iso>       Upper bound for event end date",
        "  --max-events <n>       Max closed events to store after pagination (default: 10000)",
        "  --page-size <n>        Pagination page size (default: 500)",
        "  --concurrency <n>      Parallel history fetch workers (default: 8)",
        "  --refresh-recent <n>   Re-fetch the latest N events even if already stored (default: 0)",
        "  --vite-origin <url>    Vite dev server base (default: http://localhost:5173)",
        "  --out <file>           Optional JSON audit output path",
        "  --dry-run              Fetch and print without writing to SQLite",
        "",
        "Notes:",
        "  Requires the Vite dev server to be running (`npm run dev`) unless --dry-run is used.",
        "  Use the direct `esno` command above when you need named flags like --symbol.",
        "  Existing rows are skipped by default. Use `--refresh-recent <n>` or the `:repair` scripts to rewrite recent checkpoints after sync logic changes.",
        "  event_start_ts = event_end_ts - session duration.",
        "  YES prices are sampled at: open, +1m, +2m, +3m, +4m.",
        "  resolved_outcome_up = 1 if outcomePrices[YES] >= 0.5 (hard settlement).",
        "  --all cannot be combined with --symbol or --series-id.",
    ].join("\n"));
}

export function parseArgs(argv: string[]): CliConfig | null {
    if (argv.includes("--help") || argv.includes("-h")) {
        printUsage();
        return null;
    }

    const npmConfig = readNpmConfigEnv();

    let seriesId: string = DEFAULT_SERIES_ID;
    let symbol: string | undefined = undefined;
    let allSymbols = npmConfig.allSymbols ?? false;
    let outcomeInterval = resolvePolymarketOutcomeInterval(npmConfig.outcomeInterval);
    let hasExplicitOutcomeInterval = Boolean(npmConfig.outcomeInterval);
    let startDateMin = npmConfig.startDate ?? defaultStartDateIso(30);
    let endDateMax: string | undefined = npmConfig.endDate;
    let maxEvents = Number.isFinite(npmConfig.maxEvents) ? Math.max(1, Math.floor(npmConfig.maxEvents!)) : 10000;
    let pageSize = Number.isFinite(npmConfig.pageSize) ? Math.max(1, Math.floor(npmConfig.pageSize!)) : 500;
    let concurrency = Number.isFinite(npmConfig.concurrency) ? Math.max(1, Math.floor(npmConfig.concurrency!)) : 8;
    let refreshRecent = Number.isFinite(npmConfig.refreshRecent) ? Math.max(0, Math.floor(npmConfig.refreshRecent!)) : 0;
    let viteOrigin = npmConfig.viteOrigin ?? "http://localhost:5173";
    let outPath: string | undefined = npmConfig.outPath;
    let dryRun = npmConfig.dryRun ?? false;
    let hasExplicitSymbol = false;
    let hasExplicitSeriesId = false;

    const applyOutcomeInterval = (raw: string | undefined): PolymarketOutcomeInterval => {
        const resolvedInterval = resolvePolymarketOutcomeInterval(raw);
        outcomeInterval = resolvedInterval;
        if (!hasExplicitSeriesId) {
            if (symbol) {
                const resolvedSeriesId = getPolymarketSeriesIdForSymbol(symbol, outcomeInterval);
                if (resolvedSeriesId) {
                    seriesId = resolvedSeriesId;
                }
            } else {
                const defaultSeriesId = getPolymarketSeriesIdForSymbol("BTCUSDT", outcomeInterval);
                if (defaultSeriesId) {
                    seriesId = defaultSeriesId;
                }
            }
        }
        return resolvedInterval;
    };

    const applySymbol = (raw: string | undefined): boolean => {
        const resolvedSymbol = String(raw ?? "").trim().toUpperCase();
        if (!resolvedSymbol) return false;
        const resolvedSeriesId = getPolymarketSeriesIdForSymbol(resolvedSymbol, outcomeInterval);
        if (!resolvedSeriesId) return false;
        symbol = resolvedSymbol;
        seriesId = resolvedSeriesId;
        return true;
    };

    const positionals: string[] = [];

    if (npmConfig.symbol) {
        hasExplicitSymbol = applySymbol(npmConfig.symbol);
    }
    if (npmConfig.outcomeInterval) {
        applyOutcomeInterval(npmConfig.outcomeInterval);
    }
    if (!hasExplicitSymbol && npmConfig.seriesId) {
        seriesId = npmConfig.seriesId;
        hasExplicitSeriesId = true;
    }

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--symbol") {
            const resolvedSymbol = String(next ?? "").trim().toUpperCase();
            if (!applySymbol(resolvedSymbol)) {
                throw new Error(`Unsupported Polymarket symbol "${resolvedSymbol}" for ${outcomeInterval}. Use ${getSupportedPolymarket5mSymbolsLabel()}.`);
            }
            hasExplicitSymbol = true;
            i++;
            continue;
        }
        if (arg === "--all") { allSymbols = true; continue; }
        if (arg === "--interval") {
            applyOutcomeInterval(String(next ?? ""));
            hasExplicitOutcomeInterval = true;
            i++;
            continue;
        }
        if (arg === "--series-id") { seriesId = String(next ?? "").trim() || seriesId; hasExplicitSeriesId = true; i++; continue; }
        if (arg === "--start-date") { startDateMin = String(next ?? "").trim() || startDateMin; i++; continue; }
        if (arg === "--end-date") { endDateMax = String(next ?? "").trim() || undefined; i++; continue; }
        if (arg === "--max-events") { maxEvents = Math.max(1, Math.floor(parseNumber(next, maxEvents))); i++; continue; }
        if (arg === "--page-size") { pageSize = Math.max(1, Math.floor(parseNumber(next, pageSize))); i++; continue; }
        if (arg === "--concurrency") { concurrency = Math.max(1, Math.floor(parseNumber(next, concurrency))); i++; continue; }
        if (arg === "--refresh-recent") { refreshRecent = Math.max(0, Math.floor(parseNumber(next, refreshRecent))); i++; continue; }
        if (arg === "--vite-origin") { viteOrigin = String(next ?? "").trim() || viteOrigin; i++; continue; }
        if (arg === "--out") { outPath = String(next ?? "").trim() || undefined; i++; continue; }
        if (arg === "--dry-run") { dryRun = true; continue; }
        if (!arg.startsWith("-")) {
            positionals.push(arg);
        }
    }

    if (positionals.length > 0) {
        if (!symbol && applySymbol(positionals[0])) {
            hasExplicitSymbol = true;
            positionals.shift();
        }
        if (!positionals.length && symbol && !argv.some(arg => arg.startsWith("--symbol"))) {
            console.warn(`[poly:sync-outcomes] Interpreting positional "${symbol}" as --symbol. Use the direct esno command or npm_config_* flags for unambiguous CLI forwarding.`);
        }
    }

    if (allSymbols && (hasExplicitSymbol || hasExplicitSeriesId)) {
        throw new Error("--all cannot be combined with --symbol or --series-id.");
    }

    return {
        seriesId,
        symbol,
        allSymbols,
        outcomeInterval,
        hasExplicitOutcomeInterval,
        startDateMin,
        endDateMax,
        maxEvents,
        pageSize,
        concurrency,
        refreshRecent,
        viteOrigin,
        outPath,
        dryRun,
    };
}

export function resolveOutcomeSyncTargets(config: Pick<CliConfig, "allSymbols" | "seriesId" | "symbol" | "outcomeInterval" | "hasExplicitOutcomeInterval">): OutcomeSyncTarget[] {
    if (config.allSymbols) {
        const intervals = config.hasExplicitOutcomeInterval
            ? [config.outcomeInterval]
            : [...POLYMARKET_OUTCOME_INTERVALS];
        return intervals.flatMap((outcomeInterval) => SUPPORTED_POLYMARKET_SYMBOLS.map((symbol) => ({
            symbol,
            outcomeInterval,
            seriesId: getPolymarketSeriesIdForSymbol(symbol, outcomeInterval)!,
        })));
    }

    return [{
        symbol: config.symbol as SupportedPolymarketSymbol | undefined,
        outcomeInterval: config.outcomeInterval,
        seriesId: config.seriesId,
    }];
}

// ─── Fetch helpers ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry<T>(url: string, retries = 4): Promise<T> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                const err = new Error(`HTTP ${res.status}: ${body.slice(0, 240)}`);
                if ((res.status !== 429 && res.status < 500) || attempt === retries) throw err;
                await sleep(300 * (attempt + 1));
                continue;
            }
            return await res.json() as T;
        } catch (error) {
            lastErr = error;
            if (attempt === retries) break;
            await sleep(300 * (attempt + 1));
        }
    }
    throw lastErr ?? new Error("Unknown fetch failure");
}

// ─── Event parsing ────────────────────────────────────────────────────────

function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map(v => String(v ?? "").trim()).filter(Boolean);
    if (typeof value === "string") {
        const trimmed = value.trim();
        if (!trimmed) return [];
        try {
            const p = JSON.parse(trimmed);
            if (Array.isArray(p)) return p.map(v => String(v ?? "").trim()).filter(Boolean);
        } catch { /* ignore */ }
    }
    return [];
}

function parseIsoSec(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

function chooseUpIndex(outcomes: string[]): number {
    const norm = outcomes.map(v => v.trim().toLowerCase());
    const upIdx = norm.findIndex(v => v === "up" || v === "yes" || v.includes("up"));
    return upIdx >= 0 ? upIdx : 0;
}

function normalizeEvent(raw: RawEvent): SeriesEvent | null {
    const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
    if (!slug) return null;

    const endTs = parseIsoSec(raw.endDate);
    if (!endTs || endTs <= 0) return null;

    const markets = Array.isArray(raw.markets) ? raw.markets as RawMarket[] : [];
    if (markets.length === 0) return null;

    let market = markets.find(m => typeof m.slug === "string" && m.slug.trim().toLowerCase() === slug.toLowerCase()) 
        ?? markets.find(m => {
            const outs = parseStringArray(m.outcomes).map(o => o.toLowerCase());
            return outs.includes("up") || outs.includes("yes");
        }) 
        ?? markets[0];

    const outcomes = parseStringArray(market.outcomes);
    const outcomePrices = parseStringArray(market.outcomePrices);
    const clobTokenIds = parseStringArray(market.clobTokenIds);

    if (clobTokenIds.length === 0 || outcomePrices.length === 0) return null;

    const upIdx = chooseUpIndex(outcomes);
    const upTokenId = clobTokenIds[upIdx] ?? clobTokenIds[0];
    // Attempt to find the complementary NO token
    const noIdx = upIdx === 0 && clobTokenIds.length > 1 ? 1 : (upIdx > 0 ? 0 : -1);
    const noTokenId = noIdx >= 0 ? (clobTokenIds[noIdx] ?? "") : "";

    const settleRaw = Number(outcomePrices[upIdx] ?? outcomePrices[0]);
    if (!upTokenId || !Number.isFinite(settleRaw)) return null;

    const marketSlug = typeof market.slug === "string" ? market.slug.trim() : "";

    return {
        slug,
        endTs,
        marketSlug,
        upTokenId,
        noTokenId,
        // Closed markets settle hard to 0/1; tolerate tiny float noise.
        settleUp: settleRaw >= 0.5 ? 1 : 0,
    };
}

// ─── Event fetching ───────────────────────────────────────────────────────

async function fetchSeriesEvents(cfg: CliConfig): Promise<SeriesEvent[]> {
    const out: SeriesEvent[] = [];
    let offset = 0;

    while (true) {
        const params = new URLSearchParams({
            series_id: cfg.seriesId,
            closed: "true",
            limit: String(cfg.pageSize),
            offset: String(offset),
            start_date_min: cfg.startDateMin,
        });
        if (cfg.endDateMax) params.set("end_date_max", cfg.endDateMax);

        const url = `${GAMMA_EVENTS_URL}?${params}`;
        const payload = await fetchJsonWithRetry<unknown>(url);
        if (!Array.isArray(payload) || payload.length === 0) break;

        for (const row of payload as RawEvent[]) {
            const ev = normalizeEvent(row);
            if (ev) out.push(ev);
        }

        if (payload.length < cfg.pageSize) break;
        offset += payload.length;
    }

    // Deduplicate by slug, sort chronologically, then keep the most recent rows.
    const dedup = new Map<string, SeriesEvent>();
    for (const ev of out) dedup.set(ev.slug, ev);
    return Array.from(dedup.values()).sort((a, b) => a.endTs - b.endTs).slice(-cfg.maxEvents);
}

// ─── Price history ────────────────────────────────────────────────────────

function normalizeHistory(payload: unknown): HistoryPoint[] {
    const rows = Array.isArray((payload as any)?.history) ? (payload as any).history as Array<{t?: unknown; p?: unknown}> : [];
    const dedup = new Map<number, number>();
    for (const row of rows) {
        const t = Math.floor(Number(row?.t));
        const p = Number(row?.p);
        if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
        if (p < 0 || p > 1) continue;
        dedup.set(t, p);
    }
    return Array.from(dedup.entries()).sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t, p }));
}

async function fetchHistoryWindow(tokenId: string, startTs: number, endTs: number): Promise<HistoryPoint[]> {
    // Primary: time-windowed fetch.
    const q = new URLSearchParams({
        market: tokenId,
        startTs: String(Math.max(0, startTs - 60)),
        endTs: String(endTs + 60),
    });
    const url = `${CLOB_HISTORY_URL}?${q}`;
    const points = normalizeHistory(await fetchJsonWithRetry<unknown>(url, 3));
    if (points.length > 0) return points;

    // Fallback: full history.
    const fb = new URLSearchParams({ market: tokenId, interval: "max" });
    return normalizeHistory(await fetchJsonWithRetry<unknown>(`${CLOB_HISTORY_URL}?${fb}`, 3));
}

/** Last price at or before ts using binary search. */
function priceAtOrBefore(points: HistoryPoint[], ts: number): number | undefined {
    let lo = 0, hi = points.length - 1, idx = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].t <= ts) { idx = mid; lo = mid + 1; }
        else hi = mid - 1;
    }
    return idx >= 0 ? points[idx].p : undefined;
}

/** First price in [startTs, endTs) using binary search. */
function firstPriceInWindow(points: HistoryPoint[], startTs: number, endTs: number): number | undefined {
    let lo = 0;
    let hi = points.length - 1;
    let idx = points.length;

    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].t >= startTs) {
            idx = mid;
            hi = mid - 1;
        } else {
            lo = mid + 1;
        }
    }

    if (idx < points.length) {
        const point = points[idx];
        if (point.t < endTs) {
            return point.p;
        }
    }
    return undefined;
}

function resolveCheckpointPrice(points: HistoryPoint[], checkpointTs: number): number | undefined {
    return firstPriceInWindow(points, checkpointTs, checkpointTs + 60)
        ?? priceAtOrBefore(points, checkpointTs);
}

// ─── Row builder ──────────────────────────────────────────────────────────

export function buildOutcomeRow(
    ev: SeriesEvent,
    points: HistoryPoint[],
    seriesId: string,
    outcomeInterval: PolymarketOutcomeInterval = DEFAULT_POLYMARKET_OUTCOME_INTERVAL
): OutcomeRow | null {
    const eventDurationSec = getPolymarketOutcomeIntervalDurationSec(outcomeInterval);
    const eventStartTs = ev.endTs - eventDurationSec;

    // Match bucketed chart/open-entry semantics by preferring the first trade inside
    // each minute window instead of the last trade before the window starts.
    const open   = resolveCheckpointPrice(points, eventStartTs);
    const min1   = resolveCheckpointPrice(points, eventStartTs + 60);
    const min2   = resolveCheckpointPrice(points, eventStartTs + 120);
    const min3   = resolveCheckpointPrice(points, eventStartTs + 180);
    const min4   = resolveCheckpointPrice(points, eventStartTs + 240);

    if (open === undefined && min1 === undefined && min2 === undefined && min3 === undefined && min4 === undefined) {
        return null; // Skip if no history points matched
    }

    return {
        series_id: seriesId,
        event_slug: ev.slug,
        market_slug: ev.marketSlug,
        interval: outcomeInterval,
        event_start_ts: eventStartTs,
        event_end_ts: ev.endTs,
        yes_token_id: ev.upTokenId,
        no_token_id: ev.noTokenId,
        yes_open_price:            open  ?? null,
        yes_entry_minute_1_price:  min1  ?? null,
        yes_entry_minute_2_price:  min2  ?? null,
        yes_entry_minute_3_price:  min3  ?? null,
        yes_entry_minute_4_price:  min4  ?? null,
        resolved_outcome_up: ev.settleUp,
        resolution_source: "outcomePrices",
        updated_at: Math.floor(Date.now() / 1000),
    };
}

// ─── Concurrency pool ─────────────────────────────────────────────────────

async function runPool<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let idx = 0;
    const next = async (): Promise<void> => {
        while (true) {
            const cur = idx++;
            if (cur >= items.length) return;
            out[cur] = await worker(items[cur], cur);
        }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, next));
    return out;
}

// ─── Store helper ──────────────────────────────────────────────────────────

async function storeRows(rows: OutcomeRow[], viteOrigin: string): Promise<number> {
    const url = `${viteOrigin}/api/sqlite/store-polymarket-outcomes`;
    const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows }),
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`store-polymarket-outcomes failed (${res.status}): ${body.slice(0, 240)}`);
    }
    const payload = await res.json() as { ok: boolean; upserted?: number; error?: string };
    if (!payload.ok) throw new Error(payload.error ?? "store-polymarket-outcomes: ok=false");
    return payload.upserted ?? 0;
}

async function loadExistingOutcomeSlugs(
    viteOrigin: string,
    seriesId: string,
    startTs: number,
    endTs: number,
    limit: number
): Promise<Set<string>> {
    const params = new URLSearchParams({
        seriesId,
        startTs: String(Math.floor(startTs)),
        endTs: String(Math.floor(endTs)),
        limit: String(Math.max(1, Math.floor(limit))),
    });
    const url = `${viteOrigin}/api/sqlite/load-polymarket-outcomes?${params.toString()}`;
    const res = await fetch(url, {
        headers: { Accept: "application/json" },
    });
    if (!res.ok) {
        const body = await res.text().catch(() => "");
        throw new Error(`load-polymarket-outcomes failed (${res.status}): ${body.slice(0, 240)}`);
    }
    const payload = await res.json() as { ok?: boolean; rows?: ExistingOutcomeSlugRow[]; error?: string };
    if (!payload.ok) {
        throw new Error(payload.error ?? "load-polymarket-outcomes: ok=false");
    }

    const existing = new Set<string>();
    for (const row of Array.isArray(payload.rows) ? payload.rows : []) {
        const slug = typeof row?.event_slug === "string" ? row.event_slug.trim() : "";
        if (slug) existing.add(slug);
    }
    return existing;
}

function resolveTargetOutPath(
    baseOutPath: string | undefined,
    target: OutcomeSyncTarget,
    targetCount: number
): string | undefined {
    if (!baseOutPath || targetCount <= 1 || !target.symbol) {
        return baseOutPath;
    }

    const ext = path.extname(baseOutPath);
    const stem = ext ? baseOutPath.slice(0, -ext.length) : baseOutPath;
    return `${stem}.${target.symbol.toLowerCase()}.${target.outcomeInterval}${ext}`;
}

// ─── Main ─────────────────────────────────────────────────────────────────

async function runSingleSeriesSync(cfg: CliConfig): Promise<OutcomeSyncSummary> {
    const eventDurationSec = getPolymarketOutcomeIntervalDurationSec(cfg.outcomeInterval);
    console.log("[poly:sync-outcomes] Fetching closed events...");
    console.log(`  series_id=${cfg.seriesId}${cfg.symbol ? ` (${cfg.symbol})` : ""}  interval=${cfg.outcomeInterval}  start=${cfg.startDateMin}  max_events=${cfg.maxEvents}`);

    const events = await fetchSeriesEvents(cfg);
    console.log(`[poly:sync-outcomes] Got ${events.length} unique events`);
    if (events.length === 0) {
        throw new Error("No events found. Adjust --start-date, --symbol, or --series-id.");
    }

    let syncEvents = events;
    let skippedExisting = 0;
    let refreshedExisting = 0;
    let missingEvents = events.length;

    if (!cfg.dryRun) {
        const firstStartTs = events[0]!.endTs - eventDurationSec;
        const lastStartTs = events[events.length - 1]!.endTs - eventDurationSec;
        const existingSlugs = await loadExistingOutcomeSlugs(
            cfg.viteOrigin,
            cfg.seriesId,
            firstStartTs,
            lastStartTs,
            Math.max(events.length + cfg.refreshRecent + 100, 1000)
        );
        const plan = planPolymarketEventSync(events, existingSlugs, cfg.refreshRecent);
        syncEvents = plan.toFetch;
        skippedExisting = plan.skippedExisting;
        refreshedExisting = plan.refreshedExisting;
        missingEvents = plan.missing;
        console.log(
            `[poly:sync-outcomes] Sync plan missing=${missingEvents} refreshed=${refreshedExisting} skipped_existing=${skippedExisting}`
        );
        if (syncEvents.length === 0) {
            console.log("[poly:sync-outcomes] No missing outcome rows found in the requested range.");
        }
    }

    let processed = 0;
    let withHistory = 0;
    const outcomeRows: OutcomeRow[] = [];
    const buckets: (OutcomeRow | null)[] = [];

    await runPool(syncEvents, cfg.concurrency, async (ev, i) => {
        try {
            const eventStartTs = ev.endTs - eventDurationSec;
            const points = await fetchHistoryWindow(ev.upTokenId, eventStartTs, ev.endTs);
            const row = buildOutcomeRow(ev, points, cfg.seriesId, cfg.outcomeInterval);
            buckets[i] = row;
            if (row) withHistory++;
        } catch {
            buckets[i] = null;
        } finally {
            processed++;
            if (processed % 100 === 0 || processed === syncEvents.length) {
                console.log(`[poly:sync-outcomes] progress ${processed}/${syncEvents.length}, usable=${withHistory}`);
            }
        }
    });

    for (const row of buckets) {
        if (row) outcomeRows.push(row);
    }
    outcomeRows.sort((a, b) => a.event_start_ts - b.event_start_ts);

    console.log(`[poly:sync-outcomes] Built ${outcomeRows.length} outcome rows`);
    if (outcomeRows.length === 0) {
        if (syncEvents.length === 0) {
            return {
                symbol: cfg.symbol,
                outcomeInterval: cfg.outcomeInterval,
                seriesId: cfg.seriesId,
                events: events.length,
                syncEvents: 0,
                rows: 0,
                withHistory: 0,
                upserted: 0,
                skippedExisting,
                refreshedExisting,
                missingEvents,
            };
        }
        throw new Error("No usable rows. Try widening the date range.");
    }

    let totalUpserted = 0;
    if (!cfg.dryRun) {
        const BATCH = 500;
        for (let i = 0; i < outcomeRows.length; i += BATCH) {
            const chunk = outcomeRows.slice(i, i + BATCH);
            const n = await storeRows(chunk, cfg.viteOrigin);
            totalUpserted += n;
            console.log(`[poly:sync-outcomes] Stored batch upserted=${n} (total so far: ${totalUpserted})`);
        }
        console.log(`[poly:sync-outcomes] Done - total upserted=${totalUpserted}`);
    } else {
        console.log("[poly:sync-outcomes] --dry-run mode: skipping SQLite write");
        console.log(`[poly:sync-outcomes] Sample rows (first 3):`);
        for (const row of outcomeRows.slice(0, 3)) {
            console.log(" ", JSON.stringify(row));
        }
    }

    if (cfg.outPath) {
        const resolved = path.resolve(cfg.outPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify({
            generatedAt: new Date().toISOString(),
            config: cfg,
            counts: { events: events.length, withHistory, rows: outcomeRows.length },
            rows: outcomeRows,
        }, null, 2), "utf8");
        console.log(`[poly:sync-outcomes] Audit written to ${resolved}`);
    }

    return {
        symbol: cfg.symbol,
        outcomeInterval: cfg.outcomeInterval,
        seriesId: cfg.seriesId,
        events: events.length,
        syncEvents: syncEvents.length,
        rows: outcomeRows.length,
        withHistory,
        upserted: totalUpserted,
        skippedExisting,
        refreshedExisting,
        missingEvents,
    };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
    const cfg = parseArgs(argv);
    if (!cfg) return;

    const targets = resolveOutcomeSyncTargets(cfg);
    const summaries: OutcomeSyncSummary[] = [];

    for (let index = 0; index < targets.length; index++) {
        const target = targets[index]!;
        const targetCfg: CliConfig = {
            ...cfg,
            symbol: target.symbol,
            outcomeInterval: target.outcomeInterval,
            seriesId: target.seriesId,
            outPath: resolveTargetOutPath(cfg.outPath, target, targets.length),
        };

        if (targets.length > 1) {
            console.log(
                `[poly:sync-outcomes] Target ${index + 1}/${targets.length}: ${target.symbol} ${target.outcomeInterval} (series ${target.seriesId})`
            );
        }

        summaries.push(await runSingleSeriesSync(targetCfg));
    }

    if (summaries.length > 1) {
        const totalEvents = summaries.reduce((sum, summary) => sum + summary.events, 0);
        const totalRows = summaries.reduce((sum, summary) => sum + summary.rows, 0);
        const totalUpserted = summaries.reduce((sum, summary) => sum + summary.upserted, 0);
        console.log(
            `[poly:sync-outcomes] All targets complete symbols=${summaries.length} events=${totalEvents} rows=${totalRows} upserted=${totalUpserted}`
        );
    }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    main().catch(err => {
        console.error("[poly:sync-outcomes] Fatal:", String(err));
        process.exitCode = 1;
    });
}
