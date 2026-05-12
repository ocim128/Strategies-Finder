import fs from "node:fs";
import path from "node:path";
import {
    fetchJsonWithRetry,
    mean,
    parseIsoSec,
    parseStringArray,
    std,
} from "./lib/polymarket-research";

type CliConfig = {
    seriesId: string;
    symbol: string;
    startDateMin: string;
    endDateMax?: string;
    maxEvents: number;
    pageSize: number;
    concurrency: number;
    windows: number;
    minTrainEvents: number;
    minTestEvents: number;
    lookbackSec: number;
    impulseWindowSec: number;
    entryWindowSec: number;
    cooldownSec: number;
    impulseSigma: number;
    lagThreshold: number;
    maxPolyStalenessSec: number;
    sigmaGrid: number[];
    lagGrid: number[];
    permutations: number;
    outPath?: string;
};

type RawMarket = {
    outcomes?: unknown;
    clobTokenIds?: unknown;
};

type RawEvent = {
    slug?: unknown;
    endDate?: unknown;
    markets?: unknown;
};

type SeriesEvent = {
    eventId: string;
    slug: string;
    endTs: number;
    startTs: number;
    upTokenId: string;
};

type PricePoint = {
    t: number;
    p: number;
};

type EventFeature = {
    eventId: string;
    slug: string;
    startTs: number;
    endTs: number;
    outcomeUp: number;
    spotReturnEvent: number;
    spotReturnLast60: number;
    spotVolEvent: number;
    maxExcursionAbs: number;
    directionAcceleration30: number;
    pullbackVsBreakout: number;
    distanceMovedVsImpliedT1: number;
};

type CheckpointRow = {
    eventId: string;
    endTs: number;
    minuteToExpiry: 4 | 3 | 2 | 1;
    impliedProb: number;
    realizedUp: number;
    mispricingEdge: number;
    spotRemainingReturn: number;
    spotVolEvent: number;
    distanceFrom05: number;
    lateAccelerationAbs: number;
    spreadProxy: number;
    distanceMovedVsImplied: number;
};

type ImpulseCandidate = {
    eventId: string;
    endTs: number;
    impulseTs: number;
    inEntryWindow: boolean;
    zScore: number;
    direction: 1 | -1;
    entryProb: number;
    outcomeUp: number;
    preMove10s: number;
    entryAgeSec: number;
    latencySec: number | null;
};

type EventContext = {
    eventId: string;
    windowStart: number;
    endTs: number;
    outcomeUp: number;
    polySeries: number[];
    polyAgeSeries: number[];
};

type Dataset = {
    features: EventFeature[];
    checkpoints: CheckpointRow[];
    impulses: ImpulseCandidate[];
    contexts: EventContext[];
    metadata: {
        eventsFetched: number;
        eventsUsable: number;
    };
};

type TradeSignal = {
    eventId: string;
    eventIndex: number;
    endTs: number;
    impulseTs: number;
    direction: 1 | -1;
    entryProb: number;
    outcomeUp: number;
};

type TradeEval = {
    trades: number;
    expectancy: number;
    sharpe: number;
    hitRate: number;
};

type Window = {
    id: number;
    trainStart: number;
    trainEnd: number;
    testStart: number;
    testEnd: number;
};

type LatencySummary = {
    count: number;
    adjustedCount: number;
    unadjustedCount: number;
    meanSec: number;
    medianSec: number;
    p90Sec: number;
    bins: Record<string, number>;
};

type BucketEdge = {
    bucket: string;
    count: number;
    meanEdge: number;
};

type SensitivityRow = {
    sigma: number;
    lagY: number;
    fee: number;
    tradesAvg: number;
    expectancy: number;
    sharpe: number;
    hitRate: number;
    positiveWindowRate: number;
};

const DEFAULT_SERIES_ID = "10684";
const DEFAULT_SYMBOL = "BTCUSDT";
const FEES = [0.01, 0.02, 0.03] as const;
const CHECKPOINTS = [4, 3, 2, 1] as const;

function defaultStartDateIso(daysBack: number): string {
    const now = new Date();
    const past = new Date(now.getTime() - daysBack * 24 * 60 * 60 * 1000);
    return past.toISOString();
}

function parseNumber(raw: string | undefined, fallback: number): number {
    if (!raw) return fallback;
    const n = Number(raw);
    return Number.isFinite(n) ? n : fallback;
}

function parseNumberList(raw: string | undefined, fallback: number[]): number[] {
    if (!raw) return fallback;
    const list = raw.split(",").map((x) => Number(x.trim())).filter((x) => Number.isFinite(x));
    return list.length > 0 ? list : fallback;
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run poly:cross -- [options]",
        "",
        "Options:",
        "  --series-id <id>          default: 10684",
        "  --symbol <symbol>         default: BTCUSDT",
        "  --start-date <iso>        default: now-14d",
        "  --end-date <iso>          optional",
        "  --max-events <n>          default: 4000",
        "  --page-size <n>           default: 500",
        "  --concurrency <n>         default: 8",
        "  --windows <n>             default: 6",
        "  --min-train-events <n>    default: 300",
        "  --min-test-events <n>     default: 120",
        "  --lookback-sec <n>        default: 60",
        "  --impulse-window-sec <n>  default: 120",
        "  --entry-window-sec <n>    default: 90",
        "  --cooldown-sec <n>        default: 5",
        "  --impulse-sigma <x>       default: 2.5",
        "  --lag-threshold <p>       default: 0.01",
        "  --max-poly-staleness <n>  default: 5 seconds",
        "  --sigma-grid <list>       default: 2,2.5,3",
        "  --lag-grid <list>         default: 0.005,0.01,0.02",
        "  --permutations <n>        default: 100",
        "  --out <file>              optional JSON output",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliConfig | null {
    if (argv.includes("--help") || argv.includes("-h")) {
        printUsage();
        return null;
    }

    let seriesId = DEFAULT_SERIES_ID;
    let symbol = DEFAULT_SYMBOL;
    let startDateMin = defaultStartDateIso(14);
    let endDateMax: string | undefined;
    let maxEvents = 4000;
    let pageSize = 500;
    let concurrency = 8;
    let windows = 6;
    let minTrainEvents = 300;
    let minTestEvents = 120;
    let lookbackSec = 60;
    let impulseWindowSec = 120;
    let entryWindowSec = 90;
    let cooldownSec = 5;
    let impulseSigma = 2.5;
    let lagThreshold = 0.01;
    let maxPolyStalenessSec = 5;
    let sigmaGrid = [2, 2.5, 3];
    let lagGrid = [0.005, 0.01, 0.02];
    let permutations = 100;
    let outPath: string | undefined;
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--series-id") {
            seriesId = String(next ?? "").trim() || seriesId;
            i++;
            continue;
        }
        if (arg === "--symbol") {
            symbol = String(next ?? "").trim().toUpperCase() || symbol;
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
        if (arg === "--max-events") {
            maxEvents = Math.max(100, Math.floor(parseNumber(next, maxEvents)));
            i++;
            continue;
        }
        if (arg === "--page-size") {
            pageSize = Math.max(50, Math.floor(parseNumber(next, pageSize)));
            i++;
            continue;
        }
        if (arg === "--concurrency") {
            concurrency = Math.max(1, Math.floor(parseNumber(next, concurrency)));
            i++;
            continue;
        }
        if (arg === "--windows") {
            windows = Math.max(2, Math.floor(parseNumber(next, windows)));
            i++;
            continue;
        }
        if (arg === "--min-train-events") {
            minTrainEvents = Math.max(100, Math.floor(parseNumber(next, minTrainEvents)));
            i++;
            continue;
        }
        if (arg === "--min-test-events") {
            minTestEvents = Math.max(50, Math.floor(parseNumber(next, minTestEvents)));
            i++;
            continue;
        }
        if (arg === "--lookback-sec") {
            lookbackSec = Math.max(10, Math.floor(parseNumber(next, lookbackSec)));
            i++;
            continue;
        }
        if (arg === "--impulse-window-sec") {
            impulseWindowSec = Math.max(30, Math.floor(parseNumber(next, impulseWindowSec)));
            i++;
            continue;
        }
        if (arg === "--entry-window-sec") {
            entryWindowSec = Math.max(30, Math.floor(parseNumber(next, entryWindowSec)));
            i++;
            continue;
        }
        if (arg === "--cooldown-sec") {
            cooldownSec = Math.max(1, Math.floor(parseNumber(next, cooldownSec)));
            i++;
            continue;
        }
        if (arg === "--impulse-sigma") {
            impulseSigma = Math.max(0.5, parseNumber(next, impulseSigma));
            i++;
            continue;
        }
        if (arg === "--lag-threshold") {
            lagThreshold = Math.max(0.0001, parseNumber(next, lagThreshold));
            i++;
            continue;
        }
        if (arg === "--max-poly-staleness") {
            maxPolyStalenessSec = Math.max(1, Math.floor(parseNumber(next, maxPolyStalenessSec)));
            i++;
            continue;
        }
        if (arg === "--sigma-grid") {
            sigmaGrid = parseNumberList(next, sigmaGrid).map((x) => Math.max(0.5, x));
            i++;
            continue;
        }
        if (arg === "--lag-grid") {
            lagGrid = parseNumberList(next, lagGrid).map((x) => Math.max(0.0001, x));
            i++;
            continue;
        }
        if (arg === "--permutations") {
            permutations = Math.max(10, Math.floor(parseNumber(next, permutations)));
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
        if (positional[0]) startDateMin = positional[0];
        if (positional[1]) maxEvents = Math.max(100, Math.floor(parseNumber(positional[1], maxEvents)));
        if (positional[2]) concurrency = Math.max(1, Math.floor(parseNumber(positional[2], concurrency)));
        if (positional[3]) windows = Math.max(2, Math.floor(parseNumber(positional[3], windows)));
        if (positional[4]) minTrainEvents = Math.max(100, Math.floor(parseNumber(positional[4], minTrainEvents)));
        if (positional[5]) minTestEvents = Math.max(50, Math.floor(parseNumber(positional[5], minTestEvents)));
        if (positional[6]) permutations = Math.max(10, Math.floor(parseNumber(positional[6], permutations)));
        if (positional[7]) outPath = positional[7];
    }

    return {
        seriesId,
        symbol,
        startDateMin,
        endDateMax,
        maxEvents,
        pageSize,
        concurrency,
        windows,
        minTrainEvents,
        minTestEvents,
        lookbackSec,
        impulseWindowSec,
        entryWindowSec,
        cooldownSec,
        impulseSigma,
        lagThreshold,
        maxPolyStalenessSec,
        sigmaGrid: Array.from(new Set(sigmaGrid)).sort((a, b) => a - b),
        lagGrid: Array.from(new Set(lagGrid)).sort((a, b) => a - b),
        permutations,
        outPath,
    };
}

function normalizeEvent(raw: RawEvent): SeriesEvent | null {
    const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
    const endTs = parseIsoSec(raw.endDate);
    if (!slug || !endTs) return null;
    const startTs = endTs - 300;
    const markets = Array.isArray(raw.markets) ? raw.markets as RawMarket[] : [];
    if (markets.length === 0) return null;
    const market = markets[0];
    const outcomes = parseStringArray(market.outcomes).map((v) => v.toLowerCase());
    const tokenIds = parseStringArray(market.clobTokenIds);
    if (tokenIds.length === 0) return null;
    let upIdx = outcomes.findIndex((v) => v === "up" || v === "yes" || v.includes("up"));
    if (upIdx < 0) upIdx = 0;
    const upTokenId = tokenIds[upIdx] ?? tokenIds[0];
    if (!upTokenId) return null;
    return {
        eventId: `${slug}__${endTs}`,
        slug,
        endTs,
        startTs,
        upTokenId,
    };
}

async function fetchSeriesEvents(cfg: CliConfig): Promise<SeriesEvent[]> {
    const out: SeriesEvent[] = [];
    let offset = 0;
    while (out.length < cfg.maxEvents) {
        const params = new URLSearchParams({
            series_id: cfg.seriesId,
            closed: "true",
            start_date_min: cfg.startDateMin,
            limit: String(cfg.pageSize),
            offset: String(offset),
        });
        if (cfg.endDateMax) params.set("end_date_max", cfg.endDateMax);
        const url = `https://gamma-api.polymarket.com/events?${params.toString()}`;
        const payload = await fetchJsonWithRetry<unknown>(url);
        if (!Array.isArray(payload) || payload.length === 0) break;
        for (const row of payload as RawEvent[]) {
            const event = normalizeEvent(row);
            if (event) out.push(event);
        }
        if (payload.length < cfg.pageSize) break;
        offset += payload.length;
    }
    const dedup = new Map<string, SeriesEvent>();
    for (const e of out) dedup.set(e.eventId, e);
    return Array.from(dedup.values()).sort((a, b) => a.endTs - b.endTs).slice(-cfg.maxEvents);
}

function normalizeHistory(payload: unknown): PricePoint[] {
    const rows = Array.isArray((payload as { history?: unknown[] }).history)
        ? ((payload as { history?: unknown[] }).history as unknown[])
        : [];
    const dedup = new Map<number, number>();
    for (const row of rows) {
        const rec = row as { t?: unknown; p?: unknown };
        const t = Math.floor(Number(rec.t));
        const p = Number(rec.p);
        if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
        if (p < 0 || p > 1) continue;
        dedup.set(t, p);
    }
    return Array.from(dedup.entries()).sort((a, b) => a[0] - b[0]).map(([t, p]) => ({ t, p }));
}

async function fetchPolyWindow(tokenId: string, startTs: number, endTs: number): Promise<PricePoint[]> {
    const q = new URLSearchParams({
        market: tokenId,
        startTs: String(startTs),
        endTs: String(endTs),
    });
    const nearUrl = `https://clob.polymarket.com/prices-history?${q.toString()}`;
    const near = normalizeHistory(await fetchJsonWithRetry<unknown>(nearUrl, 3));
    if (near.length > 0) return near;
    const fallbackUrl = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=max`;
    const fallback = normalizeHistory(await fetchJsonWithRetry<unknown>(fallbackUrl, 2));
    return fallback.filter((p) => p.t >= startTs && p.t <= endTs);
}

function normalizeBinanceKlines(payload: unknown): PricePoint[] {
    if (!Array.isArray(payload)) return [];
    const out: PricePoint[] = [];
    for (const row of payload) {
        if (!Array.isArray(row) || row.length < 5) continue;
        const openMs = Number(row[0]);
        const close = Number(row[4]);
        if (!Number.isFinite(openMs) || !Number.isFinite(close) || close <= 0) continue;
        out.push({ t: Math.floor(openMs / 1000), p: close });
    }
    return out.sort((a, b) => a.t - b.t);
}

async function fetchBinance1s(symbol: string, startTs: number, endTs: number): Promise<PricePoint[]> {
    const startMs = startTs * 1000;
    const endMs = endTs * 1000;
    const q = new URLSearchParams({
        symbol,
        interval: "1s",
        startTime: String(startMs),
        endTime: String(endMs),
        limit: "1000",
    });
    const url = `https://api.binance.com/api/v3/klines?${q.toString()}`;
    return normalizeBinanceKlines(await fetchJsonWithRetry<unknown>(url, 3));
}

function buildSecondSeries(startTs: number, endTs: number, points: PricePoint[]): number[] | null {
    if (endTs < startTs) return null;
    const n = endTs - startTs + 1;
    const arr = new Array<number>(n).fill(Number.NaN);
    for (const p of points) {
        if (p.t < startTs || p.t > endTs) continue;
        arr[p.t - startTs] = p.p;
    }
    let firstIdx = -1;
    for (let i = 0; i < n; i++) {
        if (Number.isFinite(arr[i])) {
            firstIdx = i;
            break;
        }
    }
    if (firstIdx < 0) return null;
    for (let i = 0; i < firstIdx; i++) arr[i] = arr[firstIdx];
    for (let i = firstIdx + 1; i < n; i++) {
        if (!Number.isFinite(arr[i])) arr[i] = arr[i - 1];
    }
    return arr;
}

function buildSecondSeriesWithAge(startTs: number, endTs: number, points: PricePoint[]): { prices: number[]; ages: number[] } | null {
    if (endTs < startTs) return null;
    const n = endTs - startTs + 1;
    const prices = new Array<number>(n).fill(Number.NaN);
    const hasTick = new Array<boolean>(n).fill(false);
    for (const p of points) {
        if (p.t < startTs || p.t > endTs) continue;
        const idx = p.t - startTs;
        prices[idx] = p.p;
        hasTick[idx] = true;
    }
    let firstIdx = -1;
    for (let i = 0; i < n; i++) {
        if (Number.isFinite(prices[i])) {
            firstIdx = i;
            break;
        }
    }
    if (firstIdx < 0) return null;
    for (let i = 0; i < firstIdx; i++) prices[i] = prices[firstIdx];
    for (let i = firstIdx + 1; i < n; i++) {
        if (!Number.isFinite(prices[i])) prices[i] = prices[i - 1];
    }
    const ages = new Array<number>(n).fill(1_000_000);
    ages[firstIdx] = hasTick[firstIdx] ? 0 : 1_000_000;
    for (let i = firstIdx + 1; i < n; i++) {
        ages[i] = hasTick[i] ? 0 : ages[i - 1] + 1;
    }
    return { prices, ages };
}

function seriesPrice(series: number[], startTs: number, ts: number): number {
    const idx = Math.max(0, Math.min(series.length - 1, ts - startTs));
    return series[idx];
}

function quantile(values: number[], q: number): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * q)));
    return sorted[idx];
}

function toLogRet(a: number, b: number): number {
    const aa = Math.max(1e-12, a);
    const bb = Math.max(1e-12, b);
    return Math.log(aa / bb);
}

function priceSpreadProxy(polySeries: number[], windowStart: number, fromTs: number, toTs: number): number {
    if (toTs <= fromTs) return 0;
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    const a = Math.max(windowStart, fromTs);
    const b = Math.min(windowStart + polySeries.length - 1, toTs);
    for (let t = a; t <= b; t++) {
        const p = seriesPrice(polySeries, windowStart, t);
        if (p < lo) lo = p;
        if (p > hi) hi = p;
    }
    if (!Number.isFinite(lo) || !Number.isFinite(hi)) return 0;
    return Math.max(0, hi - lo);
}

function buildEventData(
    event: SeriesEvent,
    windowStart: number,
    polySeries: number[],
    polyAgeSeries: number[],
    spotSeries: number[],
    cfg: CliConfig
): {
    feature: EventFeature;
    checkpoints: CheckpointRow[];
    impulses: ImpulseCandidate[];
    context: EventContext;
} | null {
    const start = event.startTs;
    const end = event.endTs;

    const pStart = seriesPrice(spotSeries, windowStart, start);
    const pEnd = seriesPrice(spotSeries, windowStart, end);
    if (!Number.isFinite(pStart) || !Number.isFinite(pEnd) || pStart <= 0 || pEnd <= 0) return null;

    const outcomeUp = pEnd > pStart ? 1 : 0;
    const spotReturnEvent = (pEnd - pStart) / pStart;
    const pEndMinus60 = seriesPrice(spotSeries, windowStart, end - 60);
    const spotReturnLast60 = pEndMinus60 > 0 ? (pEnd - pEndMinus60) / pEndMinus60 : 0;

    const eventRets: number[] = [];
    let maxExcursionAbs = 0;
    for (let t = start + 1; t <= end; t++) {
        const p0 = seriesPrice(spotSeries, windowStart, t - 1);
        const p1 = seriesPrice(spotSeries, windowStart, t);
        eventRets.push(toLogRet(p1, p0));
        const excursion = Math.abs((p1 - pStart) / pStart);
        if (excursion > maxExcursionAbs) maxExcursionAbs = excursion;
    }
    const spotVolEvent = std(eventRets);

    const pEndMinus30 = seriesPrice(spotSeries, windowStart, end - 30);
    const pEndMinus60b = seriesPrice(spotSeries, windowStart, end - 60);
    const leg1 = pEndMinus60b > 0 ? (pEndMinus30 - pEndMinus60b) / pEndMinus60b : 0;
    const leg2 = pEndMinus30 > 0 ? (pEnd - pEndMinus30) / pEndMinus30 : 0;
    const directionAcceleration30 = leg2 - leg1;

    const dir = spotReturnEvent >= 0 ? 1 : -1;
    let continuation = 0;
    let pullback = 0;
    for (let t = end - 59; t <= end; t++) {
        const prev = seriesPrice(spotSeries, windowStart, t - 1);
        const curr = seriesPrice(spotSeries, windowStart, t);
        const r = prev > 0 ? (curr - prev) / prev : 0;
        if (dir > 0) {
            continuation += Math.max(0, r);
            pullback += Math.abs(Math.min(0, r));
        } else {
            continuation += Math.abs(Math.min(0, r));
            pullback += Math.max(0, r);
        }
    }
    const pullbackVsBreakout = continuation > 0 ? pullback / continuation : 0;

    const checkpoints: CheckpointRow[] = [];
    let distanceMovedVsImpliedT1 = 0;
    for (const minuteToExpiry of CHECKPOINTS) {
        const t = end - minuteToExpiry * 60;
        const impliedProb = seriesPrice(polySeries, windowStart, t);
        const spotEntry = seriesPrice(spotSeries, windowStart, t);
        if (!Number.isFinite(impliedProb) || !Number.isFinite(spotEntry) || spotEntry <= 0) continue;
        const realizedUp = pEnd > spotEntry ? 1 : 0;
        const spotRemainingReturn = (pEnd - spotEntry) / spotEntry;
        const distanceFrom05 = Math.abs(impliedProb - 0.5);
        const spreadProxy = priceSpreadProxy(polySeries, windowStart, t - 15, t);
        const impliedConfidence = Math.abs(impliedProb - 0.5) * 2;
        const distanceMovedVsImplied = Math.abs(spotRemainingReturn) - impliedConfidence;
        if (minuteToExpiry === 1) distanceMovedVsImpliedT1 = distanceMovedVsImplied;
        checkpoints.push({
            eventId: event.eventId,
            endTs: end,
            minuteToExpiry,
            impliedProb,
            realizedUp,
            mispricingEdge: realizedUp - impliedProb,
            spotRemainingReturn,
            spotVolEvent,
            distanceFrom05,
            lateAccelerationAbs: Math.abs(directionAcceleration30),
            spreadProxy,
            distanceMovedVsImplied,
        });
    }

    const impulses: ImpulseCandidate[] = [];
    const lookbackSec = cfg.lookbackSec;
    const impulseWindowSec = cfg.impulseWindowSec;
    const entryWindowSec = cfg.entryWindowSec;
    const lagThreshold = cfg.lagThreshold;
    for (let t = end - impulseWindowSec; t <= end - 1; t++) {
        const prev = seriesPrice(spotSeries, windowStart, t - 1);
        const curr = seriesPrice(spotSeries, windowStart, t);
        if (prev <= 0 || curr <= 0) continue;
        const r1s = (curr - prev) / prev;
        const retLookback: number[] = [];
        for (let s = t - lookbackSec + 1; s <= t - 1; s++) {
            const p0 = seriesPrice(spotSeries, windowStart, s - 1);
            const p1 = seriesPrice(spotSeries, windowStart, s);
            if (p0 <= 0 || p1 <= 0) continue;
            retLookback.push((p1 - p0) / p0);
        }
        const sigma = std(retLookback);
        if (!(sigma > 0)) continue;
        const zScore = r1s / sigma;
        const direction: 1 | -1 = zScore >= 0 ? 1 : -1;
        const entryProb = seriesPrice(polySeries, windowStart, t);
        const entryAgeSec = polyAgeSeries[Math.max(0, Math.min(polyAgeSeries.length - 1, t - windowStart))];
        const preProb = seriesPrice(polySeries, windowStart, Math.max(windowStart, t - 10));
        const preMove10s = direction * (entryProb - preProb);
        let latencySec: number | null = null;
        for (let s = t + 1; s <= end; s++) {
            const ps = seriesPrice(polySeries, windowStart, s);
            const move = direction * (ps - entryProb);
            const age = polyAgeSeries[Math.max(0, Math.min(polyAgeSeries.length - 1, s - windowStart))];
            if (move >= lagThreshold && age === 0) {
                latencySec = s - t;
                break;
            }
        }
        impulses.push({
            eventId: event.eventId,
            endTs: end,
            impulseTs: t,
            inEntryWindow: t >= end - entryWindowSec,
            zScore,
            direction,
            entryProb,
            outcomeUp,
            preMove10s,
            entryAgeSec,
            latencySec,
        });
    }

    const feature: EventFeature = {
        eventId: event.eventId,
        slug: event.slug,
        startTs: start,
        endTs: end,
        outcomeUp,
        spotReturnEvent,
        spotReturnLast60,
        spotVolEvent,
        maxExcursionAbs,
        directionAcceleration30,
        pullbackVsBreakout,
        distanceMovedVsImpliedT1,
    };

    return {
        feature,
        checkpoints,
        impulses,
        context: {
            eventId: event.eventId,
            windowStart,
            endTs: end,
            outcomeUp,
            polySeries,
            polyAgeSeries,
        },
    };
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

async function buildDataset(cfg: CliConfig): Promise<Dataset> {
    const events = await fetchSeriesEvents(cfg);
    let usable = 0;
    let processed = 0;
    const results = await runPool(events, cfg.concurrency, async (event) => {
        const windowStart = event.startTs - 600;
        const windowEnd = event.endTs + 60;
        try {
            const polyPoints = await fetchPolyWindow(event.upTokenId, windowStart, windowEnd);
            if (polyPoints.length < 5) return null;
            const poly = buildSecondSeriesWithAge(windowStart, windowEnd, polyPoints);
            if (!poly) return null;
            const spotPoints = await fetchBinance1s(cfg.symbol, windowStart, windowEnd);
            if (spotPoints.length < 100) return null;
            const spotSeries = buildSecondSeries(windowStart, windowEnd, spotPoints);
            if (!spotSeries) return null;
            const built = buildEventData(event, windowStart, poly.prices, poly.ages, spotSeries, cfg);
            if (!built) return null;
            usable += 1;
            return built;
        } catch {
            return null;
        } finally {
            processed += 1;
            if (processed % 200 === 0 || processed === events.length) {
                console.log(`[poly-cross] dataset progress ${processed}/${events.length}, usable=${usable}`);
            }
        }
    });

    const features: EventFeature[] = [];
    const checkpoints: CheckpointRow[] = [];
    const impulses: ImpulseCandidate[] = [];
    const contexts: EventContext[] = [];
    for (const row of results) {
        if (!row) continue;
        features.push(row.feature);
        checkpoints.push(...row.checkpoints);
        impulses.push(...row.impulses);
        contexts.push(row.context);
    }
    features.sort((a, b) => a.endTs - b.endTs);
    checkpoints.sort((a, b) => a.endTs - b.endTs || a.minuteToExpiry - b.minuteToExpiry);
    impulses.sort((a, b) => a.endTs - b.endTs || a.impulseTs - b.impulseTs);
    contexts.sort((a, b) => a.endTs - b.endTs);
    return {
        features,
        checkpoints,
        impulses,
        contexts,
        metadata: {
            eventsFetched: events.length,
            eventsUsable: usable,
        },
    };
}

function summarizeTradePnls(pnls: number[]): TradeEval {
    const n = pnls.length;
    if (n === 0) return { trades: 0, expectancy: 0, sharpe: 0, hitRate: 0 };
    const expectancy = mean(pnls);
    const wins = pnls.filter((p) => p > 0).length;
    const vol = std(pnls);
    const sharpe = vol > 0 ? (expectancy / vol) * Math.sqrt(n) : 0;
    return {
        trades: n,
        expectancy,
        sharpe,
        hitRate: wins / n,
    };
}

function createEventWindows(totalEvents: number, cfg: CliConfig): Window[] {
    const out: Window[] = [];
    if (totalEvents < cfg.minTrainEvents + cfg.minTestEvents) return out;
    const testSize = Math.max(cfg.minTestEvents, Math.floor((totalEvents - cfg.minTrainEvents) / (cfg.windows + 1)));
    let trainEnd = cfg.minTrainEvents;
    for (let i = 0; i < cfg.windows; i++) {
        const testStart = trainEnd;
        const testEnd = Math.min(totalEvents, testStart + testSize);
        if (testEnd - testStart < cfg.minTestEvents) break;
        out.push({
            id: i + 1,
            trainStart: 0,
            trainEnd,
            testStart,
            testEnd,
        });
        const remain = totalEvents - testEnd;
        if (remain < cfg.minTestEvents) break;
        trainEnd = Math.min(totalEvents - cfg.minTestEvents, trainEnd + Math.max(1, Math.floor(testSize * 0.7)));
    }
    return out;
}

function buildSignals(
    impulses: ImpulseCandidate[],
    eventIndexMap: Map<string, number>,
    sigma: number,
    lagY: number,
    cooldownSec: number,
    maxPolyStalenessSec: number
): TradeSignal[] {
    const byEvent = new Map<string, ImpulseCandidate[]>();
    for (const imp of impulses) {
        if (!imp.inEntryWindow) continue;
        if (Math.abs(imp.zScore) < sigma) continue;
        if (imp.preMove10s >= lagY) continue;
        if (imp.entryAgeSec > maxPolyStalenessSec) continue;
        const arr = byEvent.get(imp.eventId) ?? [];
        arr.push(imp);
        byEvent.set(imp.eventId, arr);
    }
    const out: TradeSignal[] = [];
    for (const [eventId, arr] of byEvent.entries()) {
        const idx = eventIndexMap.get(eventId);
        if (idx === undefined) continue;
        const sorted = [...arr].sort((a, b) => a.impulseTs - b.impulseTs);
        let lastTs = Number.NEGATIVE_INFINITY;
        for (const s of sorted) {
            if (s.impulseTs - lastTs < cooldownSec) continue;
            out.push({
                eventId: s.eventId,
                eventIndex: idx,
                endTs: s.endTs,
                impulseTs: s.impulseTs,
                direction: s.direction,
                entryProb: s.entryProb,
                outcomeUp: s.outcomeUp,
            });
            lastTs = s.impulseTs;
            break;
        }
    }
    return out.sort((a, b) => a.endTs - b.endTs || a.impulseTs - b.impulseTs);
}

function signalPnl(signal: TradeSignal, fee: number): number {
    if (signal.direction > 0) return signal.outcomeUp - signal.entryProb - fee;
    return signal.entryProb - signal.outcomeUp - fee;
}

function evaluateSignalsByWindow(signals: TradeSignal[], windows: Window[], fee: number): {
    aggregate: TradeEval;
    byWindow: Array<{ windowId: number; eval: TradeEval }>;
} {
    const byWindow: Array<{ windowId: number; eval: TradeEval }> = [];
    for (const w of windows) {
        const testSignals = signals.filter((s) => s.eventIndex >= w.testStart && s.eventIndex < w.testEnd);
        const pnls = testSignals.map((s) => signalPnl(s, fee));
        byWindow.push({ windowId: w.id, eval: summarizeTradePnls(pnls) });
    }
    const aggregate = {
        trades: Math.round(mean(byWindow.map((x) => x.eval.trades))),
        expectancy: mean(byWindow.map((x) => x.eval.expectancy)),
        sharpe: mean(byWindow.map((x) => x.eval.sharpe)),
        hitRate: mean(byWindow.map((x) => x.eval.hitRate)),
    };
    return { aggregate, byWindow };
}

function buildLatencySummary(rows: ImpulseCandidate[]): LatencySummary {
    const adjusted = rows.filter((r) => r.latencySec !== null).map((r) => r.latencySec as number);
    const bins: Record<string, number> = {
        "0-1s": 0,
        "2-5s": 0,
        "6-10s": 0,
        "11-30s": 0,
        "31+s": 0,
        "no_adjustment": rows.length - adjusted.length,
    };
    for (const x of adjusted) {
        if (x <= 1) bins["0-1s"] += 1;
        else if (x <= 5) bins["2-5s"] += 1;
        else if (x <= 10) bins["6-10s"] += 1;
        else if (x <= 30) bins["11-30s"] += 1;
        else bins["31+s"] += 1;
    }
    const sorted = [...adjusted].sort((a, b) => a - b);
    const medianSec = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.5)] : 0;
    const p90Sec = sorted.length ? sorted[Math.floor((sorted.length - 1) * 0.9)] : 0;
    return {
        count: rows.length,
        adjustedCount: adjusted.length,
        unadjustedCount: rows.length - adjusted.length,
        meanSec: mean(adjusted),
        medianSec,
        p90Sec,
        bins,
    };
}

function bucketBy<T>(rows: T[], keyFn: (row: T) => string, edgeFn: (row: T) => number): BucketEdge[] {
    const map = new Map<string, number[]>();
    for (const r of rows) {
        const k = keyFn(r);
        const arr = map.get(k) ?? [];
        arr.push(edgeFn(r));
        map.set(k, arr);
    }
    return Array.from(map.entries())
        .map(([bucket, vals]) => ({ bucket, count: vals.length, meanEdge: mean(vals) }))
        .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

class XorShift {
    private state: number;
    constructor(seed = 20260216) {
        this.state = seed >>> 0;
        if (this.state === 0) this.state = 123456789;
    }
    next(): number {
        let x = this.state;
        x ^= x << 13;
        x ^= x >>> 17;
        x ^= x << 5;
        this.state = x >>> 0;
        return this.state / 0x100000000;
    }
}

function permutationTimingPValue(
    signals: TradeSignal[],
    contexts: Map<string, EventContext>,
    entryWindowSec: number,
    maxPolyStalenessSec: number,
    fee: number,
    permutations: number
): number {
    if (signals.length === 0 || permutations <= 0) return 1;
    const observed = mean(signals.map((s) => signalPnl(s, fee)));
    const rng = new XorShift(20260216 + Math.round(fee * 1000));
    let ge = 0;
    for (let i = 0; i < permutations; i++) {
        const pnls: number[] = [];
        for (const s of signals) {
            const ctx = contexts.get(s.eventId);
            if (!ctx) continue;
            const randTs = ctx.endTs - entryWindowSec + Math.floor(rng.next() * entryWindowSec);
            const randProb = seriesPrice(ctx.polySeries, ctx.windowStart, randTs);
            const randAge = ctx.polyAgeSeries[Math.max(0, Math.min(ctx.polyAgeSeries.length - 1, randTs - ctx.windowStart))];
            if (randAge > maxPolyStalenessSec) continue;
            const pnl = s.direction > 0
                ? ctx.outcomeUp - randProb - fee
                : randProb - ctx.outcomeUp - fee;
            pnls.push(pnl);
        }
        const permExp = mean(pnls);
        if (permExp >= observed) ge += 1;
    }
    return (ge + 1) / (permutations + 1);
}

async function main(): Promise<void> {
    const cfg = parseArgs(process.argv.slice(2));
    if (!cfg) return;

    console.log("[poly-cross] Building cross-market dataset...");
    const ds = await buildDataset(cfg);
    console.log(`[poly-cross] eventsFetched=${ds.metadata.eventsFetched}, usable=${ds.metadata.eventsUsable}, checkpoints=${ds.checkpoints.length}, impulses=${ds.impulses.length}`);
    if (ds.features.length < (cfg.minTrainEvents + cfg.minTestEvents)) {
        console.error("[poly-cross] Not enough usable events for walk-forward.");
        process.exitCode = 1;
        return;
    }

    const events = [...ds.features].sort((a, b) => a.endTs - b.endTs);
    const eventIndexMap = new Map<string, number>();
    for (let i = 0; i < events.length; i++) eventIndexMap.set(events[i].eventId, i);

    const windows = createEventWindows(events.length, cfg);
    if (windows.length === 0) {
        console.error("[poly-cross] No walk-forward windows formed.");
        process.exitCode = 1;
        return;
    }
    console.log(`[poly-cross] walk-forward windows=${windows.length}`);

    const contextsMap = new Map<string, EventContext>();
    for (const c of ds.contexts) contextsMap.set(c.eventId, c);

    const baselineImpulses = ds.impulses.filter((x) => Math.abs(x.zScore) >= cfg.impulseSigma);
    const latencyAll = buildLatencySummary(baselineImpulses);
    const latency60to120 = buildLatencySummary(
        baselineImpulses.filter((x) => x.impulseTs <= x.endTs - 60 && x.impulseTs >= x.endTs - 120)
    );
    const latency0to60 = buildLatencySummary(
        baselineImpulses.filter((x) => x.impulseTs > x.endTs - 60)
    );

    const volQ1 = quantile(ds.checkpoints.map((r) => r.spotVolEvent), 1 / 3);
    const volQ2 = quantile(ds.checkpoints.map((r) => r.spotVolEvent), 2 / 3);
    const accelQ1 = quantile(ds.checkpoints.map((r) => r.lateAccelerationAbs), 1 / 3);
    const accelQ2 = quantile(ds.checkpoints.map((r) => r.lateAccelerationAbs), 2 / 3);
    const spreadQ1 = quantile(ds.checkpoints.map((r) => r.spreadProxy), 1 / 3);
    const spreadQ2 = quantile(ds.checkpoints.map((r) => r.spreadProxy), 2 / 3);

    const mispricingByMinute = bucketBy(
        ds.checkpoints,
        (r) => `T-${r.minuteToExpiry}m`,
        (r) => r.mispricingEdge
    );
    const mispricingByVol = bucketBy(
        ds.checkpoints,
        (r) => (r.spotVolEvent <= volQ1 ? "low_vol" : r.spotVolEvent <= volQ2 ? "mid_vol" : "high_vol"),
        (r) => r.mispricingEdge
    );
    const mispricingByDist = bucketBy(
        ds.checkpoints,
        (r) => (r.distanceFrom05 <= 0.05 ? "near_0.5" : r.distanceFrom05 >= 0.2 ? "near_0.3_or_0.7" : "mid_distance"),
        (r) => r.mispricingEdge
    );
    const mispricingByAccel = bucketBy(
        ds.checkpoints,
        (r) => (r.lateAccelerationAbs <= accelQ1 ? "low_accel" : r.lateAccelerationAbs <= accelQ2 ? "mid_accel" : "high_accel"),
        (r) => r.mispricingEdge
    );
    const mispricingBySpread = bucketBy(
        ds.checkpoints,
        (r) => (r.spreadProxy <= spreadQ1 ? "tight_spread" : r.spreadProxy <= spreadQ2 ? "mid_spread" : "wide_spread"),
        (r) => r.mispricingEdge
    );

    const baselineSignals = buildSignals(
        ds.impulses,
        eventIndexMap,
        cfg.impulseSigma,
        cfg.lagThreshold,
        cfg.cooldownSec,
        cfg.maxPolyStalenessSec
    );
    const baselineByFee: Array<{
        fee: number;
        aggregate: TradeEval;
        byWindow: Array<{ windowId: number; eval: TradeEval }>;
        permutationPValue: number;
    }> = [];
    for (const fee of FEES) {
        const wr = evaluateSignalsByWindow(baselineSignals, windows, fee);
        const p = permutationTimingPValue(
            baselineSignals,
            contextsMap,
            cfg.entryWindowSec,
            cfg.maxPolyStalenessSec,
            fee,
            cfg.permutations
        );
        baselineByFee.push({
            fee,
            aggregate: wr.aggregate,
            byWindow: wr.byWindow,
            permutationPValue: p,
        });
    }

    const sensitivity: SensitivityRow[] = [];
    for (const sigma of cfg.sigmaGrid) {
        for (const lagY of cfg.lagGrid) {
            const signals = buildSignals(
                ds.impulses,
                eventIndexMap,
                sigma,
                lagY,
                cfg.cooldownSec,
                cfg.maxPolyStalenessSec
            );
            for (const fee of FEES) {
                const wr = evaluateSignalsByWindow(signals, windows, fee);
                const positiveWindowRate = mean(wr.byWindow.map((x) => (x.eval.expectancy > 0 ? 1 : 0)));
                sensitivity.push({
                    sigma,
                    lagY,
                    fee,
                    tradesAvg: wr.aggregate.trades,
                    expectancy: wr.aggregate.expectancy,
                    sharpe: wr.aggregate.sharpe,
                    hitRate: wr.aggregate.hitRate,
                    positiveWindowRate,
                });
            }
        }
    }

    const fee1Baseline = baselineByFee.find((x) => x.fee === 0.01);
    const strong = fee1Baseline
        ? fee1Baseline.aggregate.expectancy > 0 &&
          fee1Baseline.aggregate.sharpe > 0 &&
          fee1Baseline.permutationPValue < 0.05 &&
          mean(fee1Baseline.byWindow.map((w) => (w.eval.expectancy > 0 ? 1 : 0))) >= 0.6
        : false;

    const verdict = strong
        ? "Cross-market inefficiency detected (provisional)."
        : "No exploitable cross-market inefficiency detected.";

    console.log("\n[poly-cross] Baseline OOS summary:");
    for (const row of baselineByFee) {
        console.log(
            `fee=${(row.fee * 100).toFixed(0)}% ` +
            `exp=${row.aggregate.expectancy.toFixed(6)} ` +
            `sharpe=${row.aggregate.sharpe.toFixed(3)} ` +
            `hit=${(row.aggregate.hitRate * 100).toFixed(2)}% ` +
            `trades/win~${row.aggregate.trades} ` +
            `perm_p=${row.permutationPValue.toFixed(4)}`
        );
    }
    console.log(`[poly-cross] Verdict: ${verdict}`);

    const report = {
        generatedAt: new Date().toISOString(),
        config: cfg,
        coverage: {
            eventsFetched: ds.metadata.eventsFetched,
            eventsUsable: ds.metadata.eventsUsable,
            features: ds.features.length,
            checkpoints: ds.checkpoints.length,
            impulses: ds.impulses.length,
            windows,
        },
        eventFeatureSummary: {
            spotReturnEventMean: mean(ds.features.map((x) => x.spotReturnEvent)),
            spotReturnLast60Mean: mean(ds.features.map((x) => x.spotReturnLast60)),
            spotVolEventMean: mean(ds.features.map((x) => x.spotVolEvent)),
            maxExcursionAbsMean: mean(ds.features.map((x) => x.maxExcursionAbs)),
            directionAcceleration30Mean: mean(ds.features.map((x) => x.directionAcceleration30)),
            pullbackVsBreakoutMean: mean(ds.features.map((x) => x.pullbackVsBreakout)),
            distanceMovedVsImpliedT1Mean: mean(ds.features.map((x) => x.distanceMovedVsImpliedT1)),
        },
        latencyDistribution: {
            allLast120s: latencyAll,
            band60to120: latency60to120,
            band0to60: latency0to60,
        },
        mispricingDistribution: {
            overallMean: mean(ds.checkpoints.map((x) => x.mispricingEdge)),
            overallStd: std(ds.checkpoints.map((x) => x.mispricingEdge)),
            byMinute: mispricingByMinute,
            byVolatilityRegime: mispricingByVol,
            byDistanceFrom05: mispricingByDist,
            byLateAcceleration: mispricingByAccel,
            bySpreadSize: mispricingBySpread,
        },
        strategy: {
            baseline: {
                sigma: cfg.impulseSigma,
                lagY: cfg.lagThreshold,
                signals: baselineSignals.length,
                byFee: baselineByFee,
            },
            sensitivityMatrix: sensitivity,
        },
        verdict,
    };

    if (cfg.outPath) {
        const resolved = path.resolve(cfg.outPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(report, null, 2), "utf8");
        console.log(`[poly-cross] report written: ${resolved}`);
    }
}

main().catch((error) => {
    console.error("[poly-cross] fatal:", error);
    process.exitCode = 1;
});
