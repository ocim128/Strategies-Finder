import fs from "node:fs";
import path from "node:path";

type CliConfig = {
    seriesSlug: string;
    seriesId?: string;
    startDateMin: string;
    endDateMax?: string;
    pageSize: number;
    tradeConcurrency: number;
    maxTradePagesPerEvent: number;
    windowsRequired: number;
    outPath?: string;
};

type RawGammaSeries = {
    id?: unknown;
    slug?: unknown;
    title?: unknown;
    recurrence?: unknown;
    active?: unknown;
    closed?: unknown;
    volume?: unknown;
    volume24hr?: unknown;
    createdAt?: unknown;
    updatedAt?: unknown;
};

type RawGammaMarket = {
    conditionId?: unknown;
    volume?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    eventStartTime?: unknown;
};

type RawGammaEvent = {
    id?: unknown;
    slug?: unknown;
    title?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    closed?: unknown;
    markets?: unknown;
};

type RawTrade = {
    size?: unknown;
    price?: unknown;
    timestamp?: unknown;
};

type SeriesInfo = {
    id: string;
    slug: string;
    title: string;
    recurrence: string;
    active: boolean;
    closed: boolean;
    volume: number;
    volume24hr: number;
    createdAt?: string;
    updatedAt?: string;
};

type EventMeta = {
    eventId: string;
    slug: string;
    title: string;
    startTs: number;
    endTs: number;
    conditionId: string;
    gammaVolume: number;
};

type EventCoverage = {
    eventId: string;
    slug: string;
    endTs: number;
    gammaVolume: number;
    tradesCount: number;
    sumTradeSize: number;
    sumTradeNotional: number;
    coverageRatioBySize: number;
    coverageRatioByNotional: number;
    tradePagesFetched: number;
    offsetLimited?: boolean;
    error?: string;
};

type IntegrityReport = {
    generatedAt: string;
    config: CliConfig;
    series: SeriesInfo;
    universe: {
        totalEvents: number;
        earliestEventEnd: string;
        latestEventEnd: string;
        nonZeroVolumeEvents: number;
        nonZeroVolumePercent: number;
    };
    ingestion: {
        medianTradesPerEvent: number;
        medianTradesPerNonZeroEvent: number;
        ratioDistributionBySize: RatioDistribution;
        ratioDistributionByNotional: RatioDistribution;
        coverage95MajorityBySize: boolean;
        coverage95MajorityByNotional: boolean;
        failedCoverageEvents: number;
        offsetLimitedEvents: number;
        ingestionIncomplete: boolean;
        gapReason?: string;
    };
    gating: {
        datasetAtLeast1000Events: boolean;
        coverageAtLeast95Majority: boolean;
        walkForwardWindowsAtLeastRequired: boolean;
        noEdgeVerdictAllowed: boolean;
    };
};

type RatioDistribution = {
    count: number;
    min: number;
    p10: number;
    p25: number;
    p50: number;
    p75: number;
    p90: number;
    max: number;
    buckets: Record<string, number>;
    coverageAtLeast95Count: number;
    coverageAtLeast95Percent: number;
};

function defaultStartDateIso(): string {
    return "2020-01-01T00:00:00Z";
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run poly:integrity -- [options]",
        "",
        "Options:",
        "  --series-slug <slug>        default: btc-up-or-down-5m",
        "  --series-id <id>            optional override",
        "  --start-date <iso>          default: 2020-01-01T00:00:00Z",
        "  --end-date <iso>            optional",
        "  --page-size <n>             default: 500",
        "  --trade-concurrency <n>     default: 12",
        "  --max-trade-pages <n>       default: 40",
        "  --windows-required <n>      default: 5",
        "  --out <file>                optional JSON report output",
    ].join("\n"));
}

function parseNumber(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function parseArgs(argv: string[]): CliConfig | null {
    if (argv.includes("--help") || argv.includes("-h")) {
        printUsage();
        return null;
    }

    let seriesSlug = "btc-up-or-down-5m";
    let seriesId: string | undefined;
    let startDateMin = defaultStartDateIso();
    let endDateMax: string | undefined;
    let pageSize = 500;
    let tradeConcurrency = 12;
    let maxTradePagesPerEvent = 40;
    let windowsRequired = 5;
    let outPath: string | undefined;
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--series-slug") {
            seriesSlug = String(next ?? "").trim() || seriesSlug;
            i++;
            continue;
        }
        if (arg === "--series-id") {
            seriesId = String(next ?? "").trim() || undefined;
            i++;
            continue;
        }
        if (arg === "--start-date") {
            startDateMin = String(next ?? "").trim() || startDateMin;
            i++;
            continue;
        }
        if (arg === "--end-date") {
            endDateMax = String(next ?? "").trim() || undefined;
            i++;
            continue;
        }
        if (arg === "--page-size") {
            pageSize = Math.max(50, Math.min(500, Math.floor(parseNumber(next, pageSize))));
            i++;
            continue;
        }
        if (arg === "--trade-concurrency") {
            tradeConcurrency = Math.max(1, Math.floor(parseNumber(next, tradeConcurrency)));
            i++;
            continue;
        }
        if (arg === "--max-trade-pages") {
            maxTradePagesPerEvent = Math.max(1, Math.floor(parseNumber(next, maxTradePagesPerEvent)));
            i++;
            continue;
        }
        if (arg === "--windows-required") {
            windowsRequired = Math.max(1, Math.floor(parseNumber(next, windowsRequired)));
            i++;
            continue;
        }
        if (arg === "--out") {
            outPath = String(next ?? "").trim() || undefined;
            i++;
            continue;
        }
        if (!arg.startsWith("--")) positional.push(arg);
    }

    if (positional.length > 0) {
        if (positional[0]) seriesSlug = positional[0];
        if (positional[1]) startDateMin = positional[1];
        if (positional[2]) tradeConcurrency = Math.max(1, Math.floor(parseNumber(positional[2], tradeConcurrency)));
        if (positional[3]) maxTradePagesPerEvent = Math.max(1, Math.floor(parseNumber(positional[3], maxTradePagesPerEvent)));
        if (positional[4]) outPath = positional[4];
    }

    return {
        seriesSlug,
        seriesId,
        startDateMin,
        endDateMax,
        pageSize,
        tradeConcurrency,
        maxTradePagesPerEvent,
        windowsRequired,
        outPath,
    };
}

function parseIsoSec(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000);
}

function parseSeries(raw: RawGammaSeries): SeriesInfo | null {
    const id = String(raw.id ?? "").trim();
    const slug = String(raw.slug ?? "").trim();
    const title = String(raw.title ?? "").trim();
    const recurrence = String(raw.recurrence ?? "").trim().toLowerCase();
    if (!id || !slug || !title) return null;
    return {
        id,
        slug,
        title,
        recurrence,
        active: Boolean(raw.active),
        closed: Boolean(raw.closed),
        volume: Number(raw.volume ?? 0) || 0,
        volume24hr: Number(raw.volume24hr ?? 0) || 0,
        createdAt: typeof raw.createdAt === "string" ? raw.createdAt : undefined,
        updatedAt: typeof raw.updatedAt === "string" ? raw.updatedAt : undefined,
    };
}

function parseEvent(raw: RawGammaEvent): EventMeta | null {
    const id = String(raw.id ?? "").trim();
    const slug = String(raw.slug ?? "").trim();
    const title = String(raw.title ?? "").trim() || slug;
    const endTs = parseIsoSec(raw.endDate);
    if (!id || !slug || !endTs) return null;
    const markets = Array.isArray(raw.markets) ? raw.markets as RawGammaMarket[] : [];
    if (markets.length === 0) return null;
    const market = markets[0];
    const conditionId = String(market.conditionId ?? "").trim().toLowerCase();
    if (!conditionId) return null;
    const startTs = parseIsoSec(market.eventStartTime) ?? parseIsoSec(market.startDate) ?? parseIsoSec(raw.startDate) ?? (endTs - 300);
    const gammaVolume = Number(market.volume ?? 0) || 0;
    return {
        eventId: `${id}__${conditionId}`,
        slug,
        title,
        startTs,
        endTs,
        conditionId,
        gammaVolume,
    };
}

function parseTrade(raw: RawTrade): { size: number; price: number; timestamp: number } | null {
    const size = Number(raw.size);
    const price = Number(raw.price);
    const timestamp = Math.floor(Number(raw.timestamp));
    if (!Number.isFinite(size) || size <= 0) return null;
    if (!Number.isFinite(price) || price < 0 || price > 1) return null;
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return { size, price, timestamp };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry<T>(url: string, retries = 4): Promise<T> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                const err = new Error(`HTTP ${res.status}: ${body.slice(0, 220)}`);
                const retryable = res.status === 429 || res.status >= 500;
                if (!retryable || attempt === retries) throw err;
                await sleep((attempt + 1) * 250);
                continue;
            }
            return await res.json() as T;
        } catch (error) {
            lastErr = error;
            if (attempt === retries) break;
            await sleep((attempt + 1) * 250);
        }
    }
    throw lastErr ?? new Error("Unknown request failure");
}

async function runPool<T, R>(
    items: T[],
    concurrency: number,
    worker: (item: T, index: number) => Promise<R>
): Promise<R[]> {
    const out: R[] = new Array(items.length);
    let index = 0;
    async function next(): Promise<void> {
        while (true) {
            const i = index;
            index += 1;
            if (i >= items.length) return;
            out[i] = await worker(items[i], i);
        }
    }
    const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => next());
    await Promise.all(workers);
    return out;
}

async function resolveSeries(cfg: CliConfig): Promise<SeriesInfo> {
    if (cfg.seriesId) {
        const all = await fetchJsonWithRetry<unknown>(`https://gamma-api.polymarket.com/series?limit=500&offset=0`, 4);
        if (Array.isArray(all)) {
            const found = all
                .map((row) => parseSeries(row as RawGammaSeries))
                .find((s) => s && s.id === cfg.seriesId);
            if (found) return found;
        }
    }

    const url = `https://gamma-api.polymarket.com/series?slug=${encodeURIComponent(cfg.seriesSlug)}`;
    const payload = await fetchJsonWithRetry<unknown>(url, 4);
    if (!Array.isArray(payload) || payload.length === 0) {
        throw new Error(`No series found for slug=${cfg.seriesSlug}`);
    }
    const parsed = payload
        .map((row) => parseSeries(row as RawGammaSeries))
        .filter((x): x is SeriesInfo => x !== null);
    if (parsed.length === 0) {
        throw new Error(`Series payload invalid for slug=${cfg.seriesSlug}`);
    }
    const exact = parsed.find((s) => s.slug === cfg.seriesSlug);
    return exact ?? parsed[0];
}

async function fetchAllSeriesEvents(seriesId: string, cfg: CliConfig): Promise<EventMeta[]> {
    const out: EventMeta[] = [];
    let offset = 0;
    while (true) {
        const q = new URLSearchParams({
            series_id: seriesId,
            closed: "true",
            start_date_min: cfg.startDateMin,
            limit: String(cfg.pageSize),
            offset: String(offset),
        });
        if (cfg.endDateMax) q.set("end_date_max", cfg.endDateMax);
        const url = `https://gamma-api.polymarket.com/events?${q.toString()}`;
        const payload = await fetchJsonWithRetry<unknown>(url, 4);
        if (!Array.isArray(payload) || payload.length === 0) break;
        for (const row of payload as RawGammaEvent[]) {
            const event = parseEvent(row);
            if (event) out.push(event);
        }
        if (payload.length < cfg.pageSize) break;
        offset += payload.length;
        if (out.length % 2500 === 0) {
            console.log(`[poly-integrity] event pagination progress events=${out.length}`);
        }
    }
    const dedup = new Map<string, EventMeta>();
    for (const event of out) dedup.set(event.eventId, event);
    return Array.from(dedup.values()).sort((a, b) => a.endTs - b.endTs);
}

async function fetchMarketTradeCoverage(event: EventMeta, cfg: CliConfig): Promise<EventCoverage> {
    if (event.gammaVolume <= 0) {
        return {
            eventId: event.eventId,
            slug: event.slug,
            endTs: event.endTs,
            gammaVolume: event.gammaVolume,
            tradesCount: 0,
            sumTradeSize: 0,
            sumTradeNotional: 0,
            coverageRatioBySize: 1,
            coverageRatioByNotional: 1,
            tradePagesFetched: 0,
        };
    }

    let offset = 0;
    let pages = 0;
    let tradesCount = 0;
    let sumTradeSize = 0;
    let sumTradeNotional = 0;
    let offsetLimited = false;
    while (pages < cfg.maxTradePagesPerEvent) {
        const q = new URLSearchParams({
            market: event.conditionId,
            limit: String(cfg.pageSize),
            offset: String(offset),
        });
        const url = `https://data-api.polymarket.com/trades?${q.toString()}`;
        let payload: unknown;
        try {
            payload = await fetchJsonWithRetry<unknown>(url, 4);
        } catch (error) {
            const message = String((error as Error)?.message ?? error ?? "").toLowerCase();
            if (message.includes("offset")) {
                offsetLimited = true;
                break;
            }
            return {
                eventId: event.eventId,
                slug: event.slug,
                endTs: event.endTs,
                gammaVolume: event.gammaVolume,
                tradesCount,
                sumTradeSize,
                sumTradeNotional,
                coverageRatioBySize: event.gammaVolume > 0 ? sumTradeSize / event.gammaVolume : 1,
                coverageRatioByNotional: event.gammaVolume > 0 ? sumTradeNotional / event.gammaVolume : 1,
                tradePagesFetched: pages,
                offsetLimited,
                error: message.slice(0, 220),
            };
        }
        if (!Array.isArray(payload) || payload.length === 0) break;
        pages += 1;
        for (const row of payload as RawTrade[]) {
            const trade = parseTrade(row);
            if (!trade) continue;
            tradesCount += 1;
            sumTradeSize += trade.size;
            sumTradeNotional += trade.size * trade.price;
        }
        if (payload.length < cfg.pageSize) break;
        offset += payload.length;
    }

    const coverageRatioBySize = event.gammaVolume > 0 ? sumTradeSize / event.gammaVolume : 1;
    const coverageRatioByNotional = event.gammaVolume > 0 ? sumTradeNotional / event.gammaVolume : 1;
    return {
        eventId: event.eventId,
        slug: event.slug,
        endTs: event.endTs,
        gammaVolume: event.gammaVolume,
        tradesCount,
        sumTradeSize,
        sumTradeNotional,
        coverageRatioBySize,
        coverageRatioByNotional,
        tradePagesFetched: pages,
        offsetLimited,
    };
}

function quantile(sortedAsc: number[], q: number): number {
    if (sortedAsc.length === 0) return 0;
    const clamped = Math.max(0, Math.min(1, q));
    const idx = Math.floor((sortedAsc.length - 1) * clamped);
    return sortedAsc[Math.max(0, Math.min(sortedAsc.length - 1, idx))] ?? 0;
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    if (sorted.length % 2 === 1) return sorted[(sorted.length - 1) / 2] ?? 0;
    const hi = sorted[sorted.length / 2] ?? 0;
    const lo = sorted[sorted.length / 2 - 1] ?? 0;
    return (lo + hi) / 2;
}

function ratioDistribution(values: number[]): RatioDistribution {
    const sorted = [...values].sort((a, b) => a - b);
    const buckets = {
        "<0.50": 0,
        "0.50-0.80": 0,
        "0.80-0.95": 0,
        "0.95-1.05": 0,
        ">1.05": 0,
    };
    for (const v of values) {
        if (v < 0.5) buckets["<0.50"] += 1;
        else if (v < 0.8) buckets["0.50-0.80"] += 1;
        else if (v < 0.95) buckets["0.80-0.95"] += 1;
        else if (v <= 1.05) buckets["0.95-1.05"] += 1;
        else buckets[">1.05"] += 1;
    }
    const coverageAtLeast95Count = values.filter((x) => x >= 0.95).length;
    const count = values.length;
    return {
        count,
        min: sorted[0] ?? 0,
        p10: quantile(sorted, 0.10),
        p25: quantile(sorted, 0.25),
        p50: quantile(sorted, 0.50),
        p75: quantile(sorted, 0.75),
        p90: quantile(sorted, 0.90),
        max: sorted[sorted.length - 1] ?? 0,
        buckets,
        coverageAtLeast95Count,
        coverageAtLeast95Percent: count > 0 ? coverageAtLeast95Count / count : 0,
    };
}

function toIso(ts: number): string {
    return new Date(ts * 1000).toISOString();
}

async function main(): Promise<void> {
    const cfg = parseArgs(process.argv.slice(2));
    if (!cfg) return;

    const series = await resolveSeries(cfg);
    console.log(`[poly-integrity] series id=${series.id} slug=${series.slug} title=${series.title} recurrence=${series.recurrence} active=${series.active}`);

    const events = await fetchAllSeriesEvents(series.id, cfg);
    if (events.length === 0) {
        throw new Error("No events fetched for selected series.");
    }
    const earliest = events[0].endTs;
    const latest = events[events.length - 1].endTs;
    const nonZeroVolumeEvents = events.filter((e) => e.gammaVolume > 0).length;
    const nonZeroVolumePercent = nonZeroVolumeEvents / events.length;
    console.log(
        `[poly-integrity] total_events=${events.length} non_zero=${nonZeroVolumeEvents} ` +
        `(${(nonZeroVolumePercent * 100).toFixed(2)}%) range=${toIso(earliest)}..${toIso(latest)}`
    );

    const nonZeroEvents = events.filter((e) => e.gammaVolume > 0);
    const nonZeroCoverageRows = await runPool(nonZeroEvents, cfg.tradeConcurrency, async (event, idx) => {
        const row = await fetchMarketTradeCoverage(event, cfg);
        if ((idx + 1) % 200 === 0 || idx + 1 === nonZeroEvents.length) {
            console.log(`[poly-integrity] trade coverage progress ${idx + 1}/${nonZeroEvents.length}`);
        }
        return row;
    });
    const nonZeroById = new Map<string, EventCoverage>();
    for (const row of nonZeroCoverageRows) nonZeroById.set(row.eventId, row);
    const coverageRows = events.map((event) => {
        const row = nonZeroById.get(event.eventId);
        if (row) return row;
        return {
            eventId: event.eventId,
            slug: event.slug,
            endTs: event.endTs,
            gammaVolume: event.gammaVolume,
            tradesCount: 0,
            sumTradeSize: 0,
            sumTradeNotional: 0,
            coverageRatioBySize: 1,
            coverageRatioByNotional: 1,
            tradePagesFetched: 0,
        } satisfies EventCoverage;
    });

    const tradesPerEvent = coverageRows.map((r) => r.tradesCount);
    const failedCoverageEvents = coverageRows.filter((r) => Boolean(r.error) || Boolean(r.offsetLimited)).length;
    const nonZeroRows = coverageRows.filter((r) => r.gammaVolume > 0 && !r.error);
    const tradesPerNonZeroEvent = nonZeroRows.map((r) => r.tradesCount);
    const ratioBySize = nonZeroRows.map((r) => r.coverageRatioBySize);
    const ratioByNotional = nonZeroRows.map((r) => r.coverageRatioByNotional);
    const distBySize = ratioDistribution(ratioBySize);
    const distByNotional = ratioDistribution(ratioByNotional);
    const coverage95MajorityBySize = distBySize.coverageAtLeast95Percent >= 0.5;
    const coverage95MajorityByNotional = distByNotional.coverageAtLeast95Percent >= 0.5;
    const offsetLimitedEvents = coverageRows.filter((r) => Boolean(r.offsetLimited)).length;
    const ingestionIncomplete = !coverage95MajorityBySize || failedCoverageEvents > 0 || offsetLimitedEvents > 0;
    const gapReason = offsetLimitedEvents > 0
        ? "trade_api_offset_limit_reached_on_nonzero_events"
        : (failedCoverageEvents > 0
            ? "trade_coverage_fetch_failures_detected"
        : (!coverage95MajorityBySize
            ? "coverage_by_size_below_95_for_majority_of_non_zero_volume_events"
            : undefined));

    const datasetAtLeast1000Events = events.length >= 1000;
    const coverageAtLeast95Majority = coverage95MajorityBySize;
    const walkForwardWindowsAtLeastRequired = datasetAtLeast1000Events ? true : false;
    const noEdgeVerdictAllowed =
        datasetAtLeast1000Events &&
        coverageAtLeast95Majority &&
        walkForwardWindowsAtLeastRequired &&
        !ingestionIncomplete;

    const report: IntegrityReport = {
        generatedAt: new Date().toISOString(),
        config: cfg,
        series,
        universe: {
            totalEvents: events.length,
            earliestEventEnd: toIso(earliest),
            latestEventEnd: toIso(latest),
            nonZeroVolumeEvents,
            nonZeroVolumePercent,
        },
        ingestion: {
            medianTradesPerEvent: median(tradesPerEvent),
            medianTradesPerNonZeroEvent: median(tradesPerNonZeroEvent),
            ratioDistributionBySize: distBySize,
            ratioDistributionByNotional: distByNotional,
            coverage95MajorityBySize,
            coverage95MajorityByNotional,
            failedCoverageEvents,
            offsetLimitedEvents,
            ingestionIncomplete,
            gapReason,
        },
        gating: {
            datasetAtLeast1000Events,
            coverageAtLeast95Majority,
            walkForwardWindowsAtLeastRequired,
            noEdgeVerdictAllowed,
        },
    };

    console.log("\n[poly-integrity] Summary:");
    console.log(`series_id=${series.id} active=${series.active} recurrence=${series.recurrence}`);
    console.log(`events=${report.universe.totalEvents} earliest=${report.universe.earliestEventEnd} latest=${report.universe.latestEventEnd}`);
    console.log(`non_zero_volume=${report.universe.nonZeroVolumeEvents} (${(report.universe.nonZeroVolumePercent * 100).toFixed(2)}%)`);
    console.log(`median_trades_per_event=${report.ingestion.medianTradesPerEvent.toFixed(2)}`);
    console.log(`median_trades_per_non_zero_event=${report.ingestion.medianTradesPerNonZeroEvent.toFixed(2)}`);
    console.log(`coverage>=95% (size) on non-zero events=${(report.ingestion.ratioDistributionBySize.coverageAtLeast95Percent * 100).toFixed(2)}%`);
    console.log(`failed_coverage_events=${report.ingestion.failedCoverageEvents}`);
    console.log(`offset_limited_events=${offsetLimitedEvents}`);
    if (report.ingestion.ingestionIncomplete) {
        console.log(`[poly-integrity] Ingestion gap detected: ${report.ingestion.gapReason}`);
    } else {
        console.log("[poly-integrity] Ingestion coverage passes majority>=95% rule.");
    }

    if (cfg.outPath) {
        const resolved = path.resolve(cfg.outPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(report, null, 2), "utf8");
        console.log(`[poly-integrity] report written: ${resolved}`);
    }
}

main().catch((error) => {
    console.error("[poly-integrity] fatal:", error);
    process.exitCode = 1;
});
