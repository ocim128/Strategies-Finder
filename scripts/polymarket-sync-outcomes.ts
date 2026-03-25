/**
 * polymarket-sync-outcomes.ts
 *
 * Fetches closed supported 5m Polymarket events and upserts resolved outcome rows
 * into the local SQLite DB via the Vite /api/sqlite/store-polymarket-outcomes
 * endpoint.
 *
 * Usage (run while `npm run dev` is active so the Vite server is up):
 *
 *   npx esno scripts/polymarket-sync-outcomes.ts [options]
 *   ..\..\..\node_modules\.bin\esno scripts/polymarket-sync-outcomes.ts [options]
 *   npm run poly:sync-outcomes   (default BTC sync only)
 *
 * Options:
 *   --symbol <symbol>      Resolve series id from symbol (BTCUSDT, ETHUSDT, SOLUSDT, XRPUSDT)
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
import { planPolymarketEventSync } from "../lib/polymarket-sync-utils";
import {
    BTC_5M_POLYMARKET_SERIES_ID,
    getPolymarket5mSeriesIdForSymbol,
    getSupportedPolymarket5mSymbolsLabel,
} from "../lib/polymarket-btc5m";

// ─── Types ────────────────────────────────────────────────────────────────

type CliConfig = {
    seriesId: string;
    symbol?: string;
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

// ─── Constants ────────────────────────────────────────────────────────────

const DEFAULT_SERIES_ID: string = BTC_5M_POLYMARKET_SERIES_ID;
const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const CLOB_HISTORY_URL = "https://clob.polymarket.com/prices-history";
const INTERVAL = "5m";
const EVENT_DURATION_SEC = 300; // 5 minutes

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

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run poly:sync-outcomes",
        "  ..\\..\\..\\node_modules\\.bin\\esno scripts\\polymarket-sync-outcomes.ts [options]",
        "",
        "Options:",
        `  --symbol <symbol>      Resolve the 5m series id from symbol (${getSupportedPolymarket5mSymbolsLabel()})`,
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
        "  event_start_ts = event_end_ts - 300 (5 minutes).",
        "  YES prices are sampled at: open, +1m, +2m, +3m, +4m.",
        "  resolved_outcome_up = 1 if outcomePrices[YES] >= 0.5 (hard settlement).",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliConfig | null {
    if (argv.includes("--help") || argv.includes("-h")) {
        printUsage();
        return null;
    }

    let seriesId: string = DEFAULT_SERIES_ID;
    let symbol: string | undefined;
    let startDateMin = defaultStartDateIso(30);
    let endDateMax: string | undefined;
    let maxEvents = 10000;
    let pageSize = 500;
    let concurrency = 8;
    let refreshRecent = 0;
    let viteOrigin = "http://localhost:5173";
    let outPath: string | undefined;
    let dryRun = false;

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--symbol") {
            const resolvedSymbol = String(next ?? "").trim().toUpperCase();
            const resolvedSeriesId = getPolymarket5mSeriesIdForSymbol(resolvedSymbol);
            if (!resolvedSeriesId) {
                throw new Error(`Unsupported Polymarket 5m symbol "${resolvedSymbol}". Use ${getSupportedPolymarket5mSymbolsLabel()}.`);
            }
            symbol = resolvedSymbol;
            seriesId = resolvedSeriesId;
            i++;
            continue;
        }
        if (arg === "--series-id") { seriesId = String(next ?? "").trim() || seriesId; i++; continue; }
        if (arg === "--start-date") { startDateMin = String(next ?? "").trim() || startDateMin; i++; continue; }
        if (arg === "--end-date") { endDateMax = String(next ?? "").trim() || undefined; i++; continue; }
        if (arg === "--max-events") { maxEvents = Math.max(1, Math.floor(parseNumber(next, maxEvents))); i++; continue; }
        if (arg === "--page-size") { pageSize = Math.max(1, Math.floor(parseNumber(next, pageSize))); i++; continue; }
        if (arg === "--concurrency") { concurrency = Math.max(1, Math.floor(parseNumber(next, concurrency))); i++; continue; }
        if (arg === "--refresh-recent") { refreshRecent = Math.max(0, Math.floor(parseNumber(next, refreshRecent))); i++; continue; }
        if (arg === "--vite-origin") { viteOrigin = String(next ?? "").trim() || viteOrigin; i++; continue; }
        if (arg === "--out") { outPath = String(next ?? "").trim() || undefined; i++; continue; }
        if (arg === "--dry-run") { dryRun = true; continue; }
    }

    return { seriesId, symbol, startDateMin, endDateMax, maxEvents, pageSize, concurrency, refreshRecent, viteOrigin, outPath, dryRun };
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

// ─── Row builder ──────────────────────────────────────────────────────────

function buildOutcomeRow(ev: SeriesEvent, points: HistoryPoint[], seriesId: string): OutcomeRow | null {
    const eventStartTs = ev.endTs - EVENT_DURATION_SEC;

    const open   = priceAtOrBefore(points, eventStartTs);
    const min1   = priceAtOrBefore(points, eventStartTs + 60);
    const min2   = priceAtOrBefore(points, eventStartTs + 120);
    const min3   = priceAtOrBefore(points, eventStartTs + 180);
    const min4   = priceAtOrBefore(points, eventStartTs + 240);

    if (open === undefined && min1 === undefined && min2 === undefined && min3 === undefined && min4 === undefined) {
        return null; // Skip if no history points matched
    }

    return {
        series_id: seriesId,
        event_slug: ev.slug,
        market_slug: ev.marketSlug,
        interval: INTERVAL,
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

// ─── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
    const cfg = parseArgs(process.argv.slice(2));
    if (!cfg) return;

    console.log("[poly:sync-outcomes] Fetching closed events...");
    console.log(`  series_id=${cfg.seriesId}${cfg.symbol ? ` (${cfg.symbol})` : ""}  start=${cfg.startDateMin}  max_events=${cfg.maxEvents}`);

    const events = await fetchSeriesEvents(cfg);
    console.log(`[poly:sync-outcomes] Got ${events.length} unique events`);
    if (events.length === 0) {
        console.error("[poly:sync-outcomes] No events found. Adjust --start-date, --symbol, or --series-id.");
        process.exitCode = 1;
        return;
    }

    let syncEvents = events;
    let skippedExisting = 0;
    let refreshedExisting = 0;
    let missingEvents = events.length;

    if (!cfg.dryRun) {
        const firstStartTs = events[0]!.endTs - EVENT_DURATION_SEC;
        const lastStartTs = events[events.length - 1]!.endTs - EVENT_DURATION_SEC;
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
            const eventStartTs = ev.endTs - EVENT_DURATION_SEC;
            const points = await fetchHistoryWindow(ev.upTokenId, eventStartTs, ev.endTs);
            const row = buildOutcomeRow(ev, points, cfg.seriesId);
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
            return;
        }
        console.error("[poly:sync-outcomes] No usable rows. Try widening the date range.");
        process.exitCode = 1;
        return;
    }

    if (!cfg.dryRun) {
        const BATCH = 500;
        let totalUpserted = 0;
        for (let i = 0; i < outcomeRows.length; i += BATCH) {
            const chunk = outcomeRows.slice(i, i + BATCH);
            try {
                const n = await storeRows(chunk, cfg.viteOrigin);
                totalUpserted += n;
                console.log(`[poly:sync-outcomes] Stored batch upserted=${n} (total so far: ${totalUpserted})`);
            } catch (err) {
                console.error(`[poly:sync-outcomes] Store batch failed: ${String(err)}`);
                process.exitCode = 1;
                return;
            }
        }
        console.log(`[poly:sync-outcomes] Done – total upserted=${totalUpserted}`);
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
}

main().catch(err => {
    console.error("[poly:sync-outcomes] Fatal:", String(err));
    process.exitCode = 1;
});
