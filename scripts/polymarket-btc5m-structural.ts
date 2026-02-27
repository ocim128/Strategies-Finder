import fs from "node:fs";
import path from "node:path";

type CliConfig = {
    seriesId: string;
    startDateMin: string;
    endDateMax?: string;
    maxEvents: number;
    pageSize: number;
    concurrency: number;
    windows: number;
    minTrainRows: number;
    minTestRows: number;
    permutations: number;
    outPath?: string;
};

type RawMarket = {
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
    endTs: number;
    upTokenId: string;
    settleUp: number;
};

type HistoryPoint = {
    t: number;
    p: number;
};

type DataRow = {
    slug: string;
    endTs: number;
    entryMinute: number;
    dayKey: string;
    minuteKey: number;
    mid_price: number;
    bid_ask_spread: number;
    orderbook_imbalance_top5: number;
    trade_aggressor_ratio: number;
    volume_delta: number;
    cumulative_volume_delta: number;
    short_term_realized_vol: number;
    time_to_expiry_decay_slope: number;
    distance_from_0_5: number;
    final_outcome_up: number;
    ret_to_expiry: number;
    mae_up: number;
    mae_down: number;
};

type Dataset = {
    rows: DataRow[];
    metadata: {
        note: string;
        proxyFeatures: string[];
        eventsFetched: number;
        eventsUsable: number;
    };
};

type SplitWindow = {
    id: number;
    trainStart: number;
    trainEnd: number;
    testStart: number;
    testEnd: number;
};

type ModelType = "logit" | "lpm" | "tree";
type FeeLevel = 0.01 | 0.02 | 0.03;

type TradeEval = {
    trades: number;
    expectancy: number;
    sharpe: number;
    hitRate: number;
};

type RegimeEval = {
    name: string;
    trades: number;
    expectancy: number;
    sharpe: number;
    hitRate: number;
};

type WindowResult = {
    windowId: number;
    model: ModelType;
    fee: FeeLevel;
    eval: TradeEval;
    regimes: RegimeEval[];
    coefficients?: number[];
};

type AggregateModelResult = {
    model: ModelType;
    fee: FeeLevel;
    oos: TradeEval;
    regimeAverages: RegimeEval[];
    edgeByBucket: Array<{ bucket: string; trades: number; avgEdge: number }>;
    permutationPValue: number;
};

type CoefStabilityRow = {
    feature: string;
    model: "logit" | "lpm";
    windows: number;
    meanCoef: number;
    stdCoef: number;
    signConsistency: number;
};

const DEFAULT_SERIES_ID = "10684";
const FEATURE_NAMES = [
    "mid_price",
    "bid_ask_spread",
    "orderbook_imbalance_top5",
    "trade_aggressor_ratio",
    "volume_delta",
    "cumulative_volume_delta",
    "short_term_realized_vol",
    "time_to_expiry_decay_slope",
    "distance_from_0_5",
] as const;

type FeatureName = typeof FEATURE_NAMES[number];

const PROXY_FEATURES = [
    "bid_ask_spread",
    "orderbook_imbalance_top5",
    "trade_aggressor_ratio",
    "volume_delta",
    "cumulative_volume_delta",
];

const FEES: FeeLevel[] = [0.01, 0.02, 0.03];

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

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run poly:structural -- [options]",
        "",
        "Options:",
        "  --series-id <id>          default: 10684 (BTC Up/Down 5m)",
        "  --start-date <iso>        default: now-21d",
        "  --end-date <iso>          optional event end-date max",
        "  --max-events <n>          default: 10000",
        "  --page-size <n>           default: 500",
        "  --concurrency <n>         default: 10",
        "  --windows <n>             default: 6",
        "  --min-train-rows <n>      default: 600",
        "  --min-test-rows <n>       default: 200",
        "  --permutations <n>        default: 100",
        "  --out <file>              optional JSON output file",
    ].join("\n"));
}

function parseArgs(argv: string[]): CliConfig | null {
    if (argv.includes("--help") || argv.includes("-h")) {
        printUsage();
        return null;
    }

    let seriesId = DEFAULT_SERIES_ID;
    let startDateMin = defaultStartDateIso(21);
    let endDateMax: string | undefined;
    let maxEvents = 10000;
    let pageSize = 500;
    let concurrency = 10;
    let windows = 6;
    let minTrainRows = 600;
    let minTestRows = 200;
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
        if (arg === "--min-train-rows") {
            minTrainRows = Math.max(100, Math.floor(parseNumber(next, minTrainRows)));
            i++;
            continue;
        }
        if (arg === "--min-test-rows") {
            minTestRows = Math.max(50, Math.floor(parseNumber(next, minTestRows)));
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
        if (!arg.startsWith("--")) {
            positional.push(arg);
        }
    }

    if (positional.length > 0) {
        if (positional[0]) startDateMin = positional[0];
        if (positional[1]) maxEvents = Math.max(100, Math.floor(parseNumber(positional[1], maxEvents)));
        if (positional[2]) concurrency = Math.max(1, Math.floor(parseNumber(positional[2], concurrency)));
        if (positional[3]) permutations = Math.max(10, Math.floor(parseNumber(positional[3], permutations)));
        if (positional[4]) outPath = positional[4];
    }

    return {
        seriesId,
        startDateMin,
        endDateMax,
        maxEvents,
        pageSize,
        concurrency,
        windows,
        minTrainRows,
        minTestRows,
        permutations,
        outPath,
    };
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchJsonWithRetry<T>(url: string, retries = 4): Promise<T> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, {
                headers: { Accept: "application/json" },
            });
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

function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((v) => String(v ?? "").trim()).filter(Boolean);
    if (typeof value === "string") {
        try {
            const parsed = JSON.parse(value);
            if (Array.isArray(parsed)) return parsed.map((v) => String(v ?? "").trim()).filter(Boolean);
        } catch {
            return [];
        }
    }
    return [];
}

function parseIsoSec(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    if (!Number.isFinite(ms)) return null;
    return Math.floor(ms / 1000);
}

function normalizeEvent(raw: RawEvent): SeriesEvent | null {
    const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
    const endTs = parseIsoSec(raw.endDate);
    if (!slug || !endTs) return null;
    const markets = Array.isArray(raw.markets) ? raw.markets as RawMarket[] : [];
    if (markets.length === 0) return null;
    const market = markets[0];
    const outcomes = parseStringArray(market.outcomes);
    const prices = parseStringArray(market.outcomePrices);
    const tokenIds = parseStringArray(market.clobTokenIds);
    if (prices.length === 0 || tokenIds.length === 0) return null;

    const norm = outcomes.map((v) => v.toLowerCase());
    let upIdx = norm.findIndex((v) => v === "up" || v === "yes" || v.includes("up"));
    if (upIdx < 0) upIdx = 0;
    const tokenId = tokenIds[upIdx] ?? tokenIds[0];
    const settleRaw = Number(prices[upIdx] ?? prices[0]);
    if (!tokenId || !Number.isFinite(settleRaw)) return null;

    return {
        slug,
        endTs,
        upTokenId: tokenId,
        settleUp: settleRaw >= 0.5 ? 1 : 0,
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
    for (const event of out) dedup.set(event.slug, event);
    return Array.from(dedup.values())
        .sort((a, b) => a.endTs - b.endTs)
        .slice(-cfg.maxEvents);
}

function normalizeHistory(payload: unknown): HistoryPoint[] {
    const rows = Array.isArray((payload as any)?.history) ? (payload as any).history : [];
    const dedup = new Map<number, number>();
    for (const row of rows) {
        const t = Math.floor(Number(row?.t));
        const p = Number(row?.p);
        if (!Number.isFinite(t) || !Number.isFinite(p)) continue;
        if (p < 0 || p > 1) continue;
        dedup.set(t, p);
    }
    return Array.from(dedup.entries())
        .sort((a, b) => a[0] - b[0])
        .map(([t, p]) => ({ t, p }));
}

async function fetchHistoryNearClose(tokenId: string, endTs: number): Promise<HistoryPoint[]> {
    const startTs = Math.max(0, endTs - 25 * 60);
    const q = new URLSearchParams({
        market: tokenId,
        startTs: String(startTs),
        endTs: String(endTs + 5),
    });
    const nearUrl = `https://clob.polymarket.com/prices-history?${q.toString()}`;
    const near = normalizeHistory(await fetchJsonWithRetry<unknown>(nearUrl, 3));
    if (near.length > 0) return near;
    const fallbackUrl = `https://clob.polymarket.com/prices-history?market=${encodeURIComponent(tokenId)}&interval=max`;
    return normalizeHistory(await fetchJsonWithRetry<unknown>(fallbackUrl, 3));
}

function priceAtOrBefore(points: HistoryPoint[], ts: number): number | undefined {
    let lo = 0;
    let hi = points.length - 1;
    let idx = -1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (points[mid].t <= ts) {
            idx = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return idx >= 0 ? points[idx].p : undefined;
}

function selectPoints(points: HistoryPoint[], startTs: number, endTs: number): HistoryPoint[] {
    return points.filter((p) => p.t >= startTs && p.t <= endTs);
}

function logReturn(a: number, b: number): number {
    const aa = Math.max(1e-6, Math.min(1 - 1e-6, a));
    const bb = Math.max(1e-6, Math.min(1 - 1e-6, b));
    return Math.log(aa / bb);
}

function computeTickStats(points: HistoryPoint[]): {
    upTicks: number;
    downTicks: number;
    totalTicks: number;
    range: number;
} {
    if (points.length < 2) {
        return { upTicks: 0, downTicks: 0, totalTicks: 0, range: 0 };
    }
    let up = 0;
    let down = 0;
    let minP = Number.POSITIVE_INFINITY;
    let maxP = Number.NEGATIVE_INFINITY;
    for (let i = 1; i < points.length; i++) {
        const d = points[i].p - points[i - 1].p;
        if (d > 0) up++;
        if (d < 0) down++;
        if (points[i].p < minP) minP = points[i].p;
        if (points[i].p > maxP) maxP = points[i].p;
    }
    if (!Number.isFinite(minP) || !Number.isFinite(maxP)) {
        minP = points[0].p;
        maxP = points[0].p;
    }
    return {
        upTicks: up,
        downTicks: down,
        totalTicks: up + down,
        range: Math.max(0, maxP - minP),
    };
}

function buildRowsForEvent(event: SeriesEvent, points: HistoryPoint[]): DataRow[] {
    const rows: DataRow[] = [];
    if (points.length === 0) return rows;

    for (let entryMinute = 1; entryMinute <= 4; entryMinute++) {
        const entryTs = event.endTs - entryMinute * 60;
        const p0 = priceAtOrBefore(points, entryTs);
        const p1 = priceAtOrBefore(points, entryTs - 60);
        const p2 = priceAtOrBefore(points, entryTs - 120);
        const p3 = priceAtOrBefore(points, entryTs - 180);
        const p4 = priceAtOrBefore(points, entryTs - 240);
        if ([p0, p1, p2, p3, p4].some((v) => v === undefined)) continue;

        const prevMinutePoints = selectPoints(points, entryTs - 60, entryTs);
        const prev4mPoints = selectPoints(points, entryTs - 240, entryTs);
        const pathToExpiry = selectPoints(points, entryTs, event.endTs);
        const pathPrices = pathToExpiry.map((p) => p.p);
        pathPrices.push(event.settleUp);

        const tick1 = computeTickStats(prevMinutePoints);
        const tick4 = computeTickStats(prev4mPoints);
        const upRatio = tick1.totalTicks > 0 ? tick1.upTicks / tick1.totalTicks : 0.5;
        const imbalance = tick1.totalTicks > 0 ? (tick1.upTicks - tick1.downTicks) / tick1.totalTicks : 0;
        const rv = Math.sqrt(
            logReturn(p0!, p1!) ** 2 +
            logReturn(p1!, p2!) ** 2 +
            logReturn(p2!, p3!) ** 2 +
            logReturn(p3!, p4!) ** 2
        );
        const decaySlope = ((p0! - p3!) / 180) * entryMinute;
        const minPath = Math.min(...pathPrices);
        const maxPath = Math.max(...pathPrices);
        const dayKey = new Date(event.endTs * 1000).toISOString().slice(0, 10);

        rows.push({
            slug: event.slug,
            endTs: event.endTs,
            entryMinute,
            dayKey,
            minuteKey: entryMinute,
            mid_price: p0!,
            // Proxy: minute tick range (no historical best bid/ask snapshots for closed events).
            bid_ask_spread: tick1.range,
            // Proxy: signed tick imbalance in prior minute.
            orderbook_imbalance_top5: imbalance,
            // Proxy: up-tick ratio in prior minute.
            trade_aggressor_ratio: upRatio,
            // Proxy: signed tick count delta in prior minute.
            volume_delta: tick1.upTicks - tick1.downTicks,
            // Proxy: signed tick count delta over prior 4m.
            cumulative_volume_delta: tick4.upTicks - tick4.downTicks,
            short_term_realized_vol: rv,
            time_to_expiry_decay_slope: decaySlope,
            distance_from_0_5: Math.abs(p0! - 0.5),
            final_outcome_up: event.settleUp,
            ret_to_expiry: event.settleUp - p0!,
            mae_up: minPath - p0!,
            mae_down: p0! - maxPath,
        });
    }

    return rows;
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
    const buckets: DataRow[][] = [];

    await runPool(events, cfg.concurrency, async (event) => {
        try {
            const points = await fetchHistoryNearClose(event.upTokenId, event.endTs);
            const rows = buildRowsForEvent(event, points);
            if (rows.length > 0) {
                buckets.push(rows);
                usable += 1;
            }
        } catch {
            // Skip failures.
        } finally {
            processed += 1;
            if (processed % 200 === 0 || processed === events.length) {
                console.log(`[poly-structural] dataset progress ${processed}/${events.length}, usable=${usable}`);
            }
        }
    });

    const rows = buckets.flat().sort((a, b) => a.endTs - b.endTs || a.entryMinute - b.entryMinute);
    return {
        rows,
        metadata: {
            note: "Microstructure fields without historical public endpoints are proxy-derived from tick direction/range in prices-history.",
            proxyFeatures: PROXY_FEATURES,
            eventsFetched: events.length,
            eventsUsable: usable,
        },
    };
}

function createWindows(totalRows: number, cfg: CliConfig): SplitWindow[] {
    const windows: SplitWindow[] = [];
    if (totalRows < (cfg.minTrainRows + cfg.minTestRows)) return windows;

    const span = Math.floor((totalRows - cfg.minTrainRows) / cfg.windows);
    const testSize = Math.max(cfg.minTestRows, Math.floor((totalRows - cfg.minTrainRows) / (cfg.windows + 1)));
    let trainEnd = cfg.minTrainRows;

    for (let i = 0; i < cfg.windows; i++) {
        const testStart = trainEnd;
        const testEnd = Math.min(totalRows, testStart + testSize);
        if ((testEnd - testStart) < cfg.minTestRows) break;
        windows.push({
            id: i + 1,
            trainStart: 0,
            trainEnd,
            testStart,
            testEnd,
        });
        trainEnd = Math.min(totalRows - cfg.minTestRows, trainEnd + Math.max(1, span));
        if (trainEnd <= testStart) break;
    }
    return windows;
}

function zscoreFit(rows: DataRow[], features: readonly FeatureName[]): { mean: number[]; std: number[] } {
    const mean = features.map((f) => rows.reduce((s, r) => s + r[f], 0) / Math.max(1, rows.length));
    const std = features.map((f, i) => {
        const variance = rows.reduce((s, r) => {
            const d = r[f] - mean[i];
            return s + d * d;
        }, 0) / Math.max(1, rows.length);
        return Math.sqrt(variance) || 1;
    });
    return { mean, std };
}

function vectorize(rows: DataRow[], features: readonly FeatureName[], scaler: { mean: number[]; std: number[] }): number[][] {
    return rows.map((r) => features.map((f, i) => (r[f] - scaler.mean[i]) / scaler.std[i]));
}

function sigmoid(x: number): number {
    if (x > 30) return 1;
    if (x < -30) return 0;
    return 1 / (1 + Math.exp(-x));
}

function trainLogit(X: number[][], y: number[], epochs = 300, lr = 0.05, l2 = 1e-4): number[] {
    const d = X[0]?.length ?? 0;
    const w = new Array(d + 1).fill(0);
    for (let epoch = 0; epoch < epochs; epoch++) {
        const grad = new Array(d + 1).fill(0);
        for (let i = 0; i < X.length; i++) {
            let z = w[d];
            const xi = X[i];
            for (let j = 0; j < d; j++) z += w[j] * xi[j];
            const p = sigmoid(z);
            const e = p - y[i];
            for (let j = 0; j < d; j++) grad[j] += e * xi[j];
            grad[d] += e;
        }
        const n = Math.max(1, X.length);
        for (let j = 0; j < d; j++) {
            grad[j] = grad[j] / n + l2 * w[j];
            w[j] -= lr * grad[j];
        }
        w[d] -= lr * (grad[d] / n);
    }
    return w;
}

function trainLpm(X: number[][], y: number[], epochs = 250, lr = 0.03, l2 = 1e-4): number[] {
    const d = X[0]?.length ?? 0;
    const w = new Array(d + 1).fill(0);
    for (let epoch = 0; epoch < epochs; epoch++) {
        const grad = new Array(d + 1).fill(0);
        for (let i = 0; i < X.length; i++) {
            let pred = w[d];
            const xi = X[i];
            for (let j = 0; j < d; j++) pred += w[j] * xi[j];
            const e = pred - y[i];
            for (let j = 0; j < d; j++) grad[j] += e * xi[j];
            grad[d] += e;
        }
        const n = Math.max(1, X.length);
        for (let j = 0; j < d; j++) {
            grad[j] = grad[j] / n + l2 * w[j];
            w[j] -= lr * grad[j];
        }
        w[d] -= lr * (grad[d] / n);
    }
    return w;
}

type TreeNode = {
    feature: number;
    threshold: number;
    left?: TreeNode;
    right?: TreeNode;
    prob?: number;
};

function gini(y: number[]): number {
    if (y.length === 0) return 0;
    const p = y.reduce((s, v) => s + v, 0) / y.length;
    return 1 - p * p - (1 - p) * (1 - p);
}

function chooseSplit(X: number[][], y: number[], minLeaf = 40): { feature: number; threshold: number } | null {
    const d = X[0]?.length ?? 0;
    let bestScore = Number.POSITIVE_INFINITY;
    let best: { feature: number; threshold: number } | null = null;
    for (let f = 0; f < d; f++) {
        const values = X.map((r) => r[f]).sort((a, b) => a - b);
        if (values.length < minLeaf * 2) continue;
        const qs = [0.2, 0.35, 0.5, 0.65, 0.8].map((q) => values[Math.floor((values.length - 1) * q)]);
        const uniq = Array.from(new Set(qs));
        for (const thr of uniq) {
            const leftY: number[] = [];
            const rightY: number[] = [];
            for (let i = 0; i < X.length; i++) {
                if (X[i][f] <= thr) leftY.push(y[i]);
                else rightY.push(y[i]);
            }
            if (leftY.length < minLeaf || rightY.length < minLeaf) continue;
            const score = (leftY.length * gini(leftY) + rightY.length * gini(rightY)) / X.length;
            if (score < bestScore) {
                bestScore = score;
                best = { feature: f, threshold: thr };
            }
        }
    }
    return best;
}

function buildTree(X: number[][], y: number[], depth: number, maxDepth: number): TreeNode {
    const p = y.length ? y.reduce((s, v) => s + v, 0) / y.length : 0.5;
    if (depth >= maxDepth || y.length < 80) return { feature: -1, threshold: 0, prob: p };
    const split = chooseSplit(X, y, 30);
    if (!split) return { feature: -1, threshold: 0, prob: p };

    const leftX: number[][] = [];
    const rightX: number[][] = [];
    const leftY: number[] = [];
    const rightY: number[] = [];
    for (let i = 0; i < X.length; i++) {
        if (X[i][split.feature] <= split.threshold) {
            leftX.push(X[i]);
            leftY.push(y[i]);
        } else {
            rightX.push(X[i]);
            rightY.push(y[i]);
        }
    }
    if (leftY.length < 20 || rightY.length < 20) return { feature: -1, threshold: 0, prob: p };
    return {
        feature: split.feature,
        threshold: split.threshold,
        left: buildTree(leftX, leftY, depth + 1, maxDepth),
        right: buildTree(rightX, rightY, depth + 1, maxDepth),
    };
}

function predictTree(node: TreeNode, x: number[]): number {
    if (node.prob !== undefined) return node.prob;
    if (x[node.feature] <= node.threshold) return predictTree(node.left!, x);
    return predictTree(node.right!, x);
}

function predictLinear(w: number[], X: number[][], logistic: boolean): number[] {
    const d = Math.max(0, w.length - 1);
    return X.map((x) => {
        let z = w[d];
        for (let j = 0; j < d; j++) z += w[j] * x[j];
        if (logistic) return sigmoid(z);
        return Math.max(0, Math.min(1, z));
    });
}

function tradePnl(probUp: number, row: DataRow, fee: number): { take: boolean; pnl: number; edge: number } {
    const edgeUp = probUp - row.mid_price - fee;
    const edgeDown = row.mid_price - probUp - fee;
    if (edgeUp <= 0 && edgeDown <= 0) return { take: false, pnl: 0, edge: 0 };
    if (edgeUp >= edgeDown) {
        return {
            take: true,
            pnl: row.final_outcome_up - row.mid_price - fee,
            edge: edgeUp,
        };
    }
    return {
        take: true,
        pnl: row.mid_price - row.final_outcome_up - fee,
        edge: edgeDown,
    };
}

function collectDecisionRows(
    rows: DataRow[],
    probs: number[],
    fee: number
): Array<{ action: 1 | -1; mid: number; outcome: number }> {
    const out: Array<{ action: 1 | -1; mid: number; outcome: number }> = [];
    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const p = probs[i];
        const edgeUp = p - row.mid_price - fee;
        const edgeDown = row.mid_price - p - fee;
        if (edgeUp <= 0 && edgeDown <= 0) continue;
        if (edgeUp >= edgeDown) out.push({ action: 1, mid: row.mid_price, outcome: row.final_outcome_up });
        else out.push({ action: -1, mid: row.mid_price, outcome: row.final_outcome_up });
    }
    return out;
}

function summarizePnL(pnls: number[]): TradeEval {
    const n = pnls.length;
    if (n === 0) return { trades: 0, expectancy: 0, sharpe: 0, hitRate: 0 };
    const mean = pnls.reduce((s, v) => s + v, 0) / n;
    const wins = pnls.filter((p) => p > 0).length;
    const varr = n > 1
        ? pnls.reduce((s, v) => s + (v - mean) * (v - mean), 0) / (n - 1)
        : 0;
    const std = Math.sqrt(Math.max(0, varr));
    const sharpe = std > 0 ? (mean / std) * Math.sqrt(n) : 0;
    return {
        trades: n,
        expectancy: mean,
        sharpe,
        hitRate: wins / n,
    };
}

function evaluateRows(rows: DataRow[], probs: number[], fee: FeeLevel, volMedian: number, trendDayMap: Map<string, boolean>): {
    eval: TradeEval;
    regimes: RegimeEval[];
    bucketRows: Array<{ bucket: string; edge: number; take: boolean }>;
} {
    const pnls: number[] = [];
    const regimePnls = new Map<string, number[]>();
    const bucketRows: Array<{ bucket: string; edge: number; take: boolean }> = [];

    function pushRegime(name: string, pnl: number): void {
        const arr = regimePnls.get(name) ?? [];
        arr.push(pnl);
        regimePnls.set(name, arr);
    }

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const decision = tradePnl(probs[i], row, fee);
        if (!decision.take) continue;
        pnls.push(decision.pnl);

        const highVol = row.short_term_realized_vol >= volMedian;
        pushRegime(highVol ? "high_vol" : "low_vol", decision.pnl);

        const trendDay = trendDayMap.get(row.dayKey) ?? false;
        pushRegime(trendDay ? "strong_trend_day" : "chop_day", decision.pnl);

        if (row.distance_from_0_5 <= 0.05) pushRegime("near_0_5", decision.pnl);
        if (row.distance_from_0_5 >= 0.2) pushRegime("near_0_3_or_0_7", decision.pnl);

        let bucket = "0.70-1.00";
        if (row.mid_price < 0.30) bucket = "0.00-0.30";
        else if (row.mid_price < 0.40) bucket = "0.30-0.40";
        else if (row.mid_price < 0.45) bucket = "0.40-0.45";
        else if (row.mid_price < 0.55) bucket = "0.45-0.55";
        else if (row.mid_price < 0.60) bucket = "0.55-0.60";
        else if (row.mid_price < 0.70) bucket = "0.60-0.70";
        bucketRows.push({ bucket, edge: decision.pnl, take: true });
    }

    const evalSummary = summarizePnL(pnls);
    const regimes = Array.from(regimePnls.entries()).map(([name, arr]) => ({
        name,
        ...summarizePnL(arr),
    }));
    return { eval: evalSummary, regimes, bucketRows };
}

function mean(values: number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
}

function std(values: number[]): number {
    if (values.length < 2) return 0;
    const m = mean(values);
    const variance = values.reduce((s, v) => s + (v - m) * (v - m), 0) / (values.length - 1);
    return Math.sqrt(Math.max(0, variance));
}

function createTrendDayMap(rows: DataRow[]): Map<string, boolean> {
    const byDay = new Map<string, number[]>();
    for (const row of rows) {
        const arr = byDay.get(row.dayKey) ?? [];
        arr.push(row.final_outcome_up);
        byDay.set(row.dayKey, arr);
    }
    const out = new Map<string, boolean>();
    for (const [day, vals] of byDay.entries()) {
        const upRate = mean(vals);
        out.set(day, upRate >= 0.58 || upRate <= 0.42);
    }
    return out;
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

function shuffledIndices(n: number, rng: XorShift): number[] {
    const arr = Array.from({ length: n }, (_, i) => i);
    for (let i = n - 1; i > 0; i--) {
        const j = Math.floor(rng.next() * (i + 1));
        const tmp = arr[i];
        arr[i] = arr[j];
        arr[j] = tmp;
    }
    return arr;
}

function meanPnlFromDecisionRows(
    rows: Array<{ action: 1 | -1; mid: number; outcome: number }>,
    fee: number,
    shuffledOutcomes?: number[]
): number {
    if (rows.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < rows.length; i++) {
        const d = rows[i];
        const outcome = shuffledOutcomes ? shuffledOutcomes[i] : d.outcome;
        const pnl = d.action === 1
            ? outcome - d.mid - fee
            : d.mid - outcome - fee;
        sum += pnl;
    }
    return sum / rows.length;
}

function trainAndEvalModel(
    model: ModelType,
    rows: DataRow[],
    windows: SplitWindow[]
): {
    byFee: Map<FeeLevel, {
        windowResults: WindowResult[];
        bucketRows: Array<{ bucket: string; edge: number }>;
        decisionRows: Array<{ action: 1 | -1; mid: number; outcome: number }>;
    }>;
    coefficientsByWindow: number[][];
} {
    const byFee = new Map<FeeLevel, {
        windowResults: WindowResult[];
        bucketRows: Array<{ bucket: string; edge: number }>;
        decisionRows: Array<{ action: 1 | -1; mid: number; outcome: number }>;
    }>();
    for (const fee of FEES) byFee.set(fee, { windowResults: [], bucketRows: [], decisionRows: [] });
    const coefficientsByWindow: number[][] = [];

    const trendDayMap = createTrendDayMap(rows);

    for (const window of windows) {
        const trainRows = rows.slice(window.trainStart, window.trainEnd);
        const testRows = rows.slice(window.testStart, window.testEnd);
        const yTrain = trainRows.map((r) => r.final_outcome_up);

        const scaler = zscoreFit(trainRows, FEATURE_NAMES);
        const XTrain = vectorize(trainRows, FEATURE_NAMES, scaler);
        const XTest = vectorize(testRows, FEATURE_NAMES, scaler);
        const volMedian = (() => {
            const vals = trainRows.map((r) => r.short_term_realized_vol).sort((a, b) => a - b);
            return vals[Math.floor(vals.length / 2)] ?? 0;
        })();

        let probs: number[] = [];
        let coef: number[] | undefined;
        if (model === "logit") {
            const w = trainLogit(XTrain, yTrain);
            probs = predictLinear(w, XTest, true);
            coef = w.slice(0, FEATURE_NAMES.length);
        } else if (model === "lpm") {
            const w = trainLpm(XTrain, yTrain);
            probs = predictLinear(w, XTest, false);
            coef = w.slice(0, FEATURE_NAMES.length);
        } else {
            const tree = buildTree(XTrain, yTrain, 0, 2);
            probs = XTest.map((x) => predictTree(tree, x));
        }
        if (coef) coefficientsByWindow.push(coef);

        for (const fee of FEES) {
            const res = evaluateRows(testRows, probs, fee, volMedian, trendDayMap);
            byFee.get(fee)!.windowResults.push({
                windowId: window.id,
                model,
                fee,
                eval: res.eval,
                regimes: res.regimes,
                coefficients: coef,
            });
            const bucketTarget = byFee.get(fee)!;
            for (const b of res.bucketRows) bucketTarget.bucketRows.push({ bucket: b.bucket, edge: b.edge });
            for (const d of collectDecisionRows(testRows, probs, fee)) bucketTarget.decisionRows.push(d);
        }
    }
    return { byFee, coefficientsByWindow };
}

function aggregateRegimes(results: WindowResult[]): RegimeEval[] {
    const map = new Map<string, TradeEval[]>();
    for (const r of results) {
        for (const regime of r.regimes) {
            const arr = map.get(regime.name) ?? [];
            arr.push({
                trades: regime.trades,
                expectancy: regime.expectancy,
                sharpe: regime.sharpe,
                hitRate: regime.hitRate,
            });
            map.set(regime.name, arr);
        }
    }
    return Array.from(map.entries()).map(([name, vals]) => ({
        name,
        trades: Math.round(mean(vals.map((v) => v.trades))),
        expectancy: mean(vals.map((v) => v.expectancy)),
        sharpe: mean(vals.map((v) => v.sharpe)),
        hitRate: mean(vals.map((v) => v.hitRate)),
    }));
}

function aggregateEdgeBuckets(bucketRows: Array<{ bucket: string; edge: number }>): Array<{ bucket: string; trades: number; avgEdge: number }> {
    const map = new Map<string, number[]>();
    for (const row of bucketRows) {
        const arr = map.get(row.bucket) ?? [];
        arr.push(row.edge);
        map.set(row.bucket, arr);
    }
    return Array.from(map.entries())
        .map(([bucket, vals]) => ({
            bucket,
            trades: vals.length,
            avgEdge: mean(vals),
        }))
        .sort((a, b) => a.bucket.localeCompare(b.bucket));
}

function aggregateTradeEval(results: WindowResult[]): TradeEval {
    return {
        trades: Math.round(mean(results.map((r) => r.eval.trades))),
        expectancy: mean(results.map((r) => r.eval.expectancy)),
        sharpe: mean(results.map((r) => r.eval.sharpe)),
        hitRate: mean(results.map((r) => r.eval.hitRate)),
    };
}

function coefficientStability(model: "logit" | "lpm", coefsByWindow: number[][]): CoefStabilityRow[] {
    const rows: CoefStabilityRow[] = [];
    for (let i = 0; i < FEATURE_NAMES.length; i++) {
        const vals = coefsByWindow.map((w) => w[i]).filter((v) => Number.isFinite(v));
        const pos = vals.filter((v) => v > 0).length;
        const neg = vals.filter((v) => v < 0).length;
        const nonZero = pos + neg;
        const signConsistency = nonZero === 0 ? 0 : Math.abs(pos - neg) / nonZero;
        rows.push({
            feature: FEATURE_NAMES[i],
            model,
            windows: vals.length,
            meanCoef: mean(vals),
            stdCoef: std(vals),
            signConsistency,
        });
    }
    return rows;
}

function formatPct(v: number): string {
    return `${(v * 100).toFixed(2)}%`;
}

async function main(): Promise<void> {
    const cfg = parseArgs(process.argv.slice(2));
    if (!cfg) return;

    console.log("[poly-structural] Building dataset from closed BTC 5m events...");
    const dataset = await buildDataset(cfg);
    const rows = dataset.rows;
    console.log(`[poly-structural] rows=${rows.length}, eventsFetched=${dataset.metadata.eventsFetched}, eventsUsable=${dataset.metadata.eventsUsable}`);
    if (rows.length < (cfg.minTrainRows + cfg.minTestRows)) {
        console.error("[poly-structural] Not enough rows for strict walk-forward.");
        process.exitCode = 1;
        return;
    }

    const windows = createWindows(rows.length, cfg);
    console.log(`[poly-structural] walk-forward windows=${windows.length}`);
    if (windows.length === 0) {
        console.error("[poly-structural] Could not form walk-forward windows with current settings.");
        process.exitCode = 1;
        return;
    }

    const aggregateResults: AggregateModelResult[] = [];
    const stabilityRows: CoefStabilityRow[] = [];

    for (const model of ["logit", "lpm", "tree"] as ModelType[]) {
        console.log(`[poly-structural] training model=${model}`);
        const fitted = trainAndEvalModel(model, rows, windows);

        let permPValueForFee1 = 1;
        if (cfg.permutations > 0) {
            const feeOneDecisions = fitted.byFee.get(0.01)!.decisionRows;
            const observed = meanPnlFromDecisionRows(feeOneDecisions, 0.01);
            const rng = new XorShift(20260216 + model.length);
            let ge = 0;
            const outcomes = feeOneDecisions.map((d) => d.outcome);
            for (let i = 0; i < cfg.permutations; i++) {
                const idx = shuffledIndices(outcomes.length, rng);
                const shuffled = idx.map((j) => outcomes[j]);
                const permExp = meanPnlFromDecisionRows(feeOneDecisions, 0.01, shuffled);
                if (permExp >= observed) ge += 1;
                if ((i + 1) % 20 === 0 || i + 1 === cfg.permutations) {
                    console.log(`[poly-structural] permutation model=${model} ${i + 1}/${cfg.permutations}`);
                }
            }
            permPValueForFee1 = (ge + 1) / (cfg.permutations + 1);
        }

        if (model === "logit" || model === "lpm") {
            stabilityRows.push(...coefficientStability(model, fitted.coefficientsByWindow));
        }

        for (const fee of FEES) {
            const wr = fitted.byFee.get(fee)!.windowResults;
            aggregateResults.push({
                model,
                fee,
                oos: aggregateTradeEval(wr),
                regimeAverages: aggregateRegimes(wr),
                edgeByBucket: aggregateEdgeBuckets(fitted.byFee.get(fee)!.bucketRows),
                permutationPValue: fee === 0.01 ? permPValueForFee1 : NaN,
            });
        }
    }

    console.log("\n[poly-structural] OOS summary by model and fee:");
    for (const row of aggregateResults) {
        console.log(
            `${row.model} fee=${(row.fee * 100).toFixed(0)}% ` +
            `exp=${row.oos.expectancy.toFixed(5)} ` +
            `sharpe=${row.oos.sharpe.toFixed(3)} ` +
            `hit=${formatPct(row.oos.hitRate)} ` +
            `trades/win~${row.oos.trades} ` +
            `${Number.isFinite(row.permutationPValue) ? `perm_p=${row.permutationPValue.toFixed(3)}` : ""}`
        );
    }

    const structuralPasses = aggregateResults.filter((r) =>
        r.fee === 0.01 &&
        r.oos.expectancy > 0 &&
        r.oos.sharpe > 0 &&
        Number.isFinite(r.permutationPValue) &&
        r.permutationPValue < 0.05
    );

    const robustByRegime = structuralPasses.filter((r) => {
        const keys = ["high_vol", "low_vol", "strong_trend_day", "chop_day", "near_0_5", "near_0_3_or_0_7"];
        const map = new Map(r.regimeAverages.map((x) => [x.name, x.expectancy]));
        return keys.every((k) => (map.get(k) ?? 0) > 0);
    });

    const verdict = robustByRegime.length > 0
        ? "Structural edge detected (provisional)."
        : "No structural edge detected.";

    console.log(`\n[poly-structural] Verdict: ${verdict}`);

    const report = {
        generatedAt: new Date().toISOString(),
        config: cfg,
        dataset: dataset.metadata,
        rowCount: rows.length,
        windows,
        aggregateResults,
        stabilityMatrix: stabilityRows,
        verdict,
    };

    if (cfg.outPath) {
        const resolved = path.resolve(cfg.outPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(report, null, 2), "utf8");
        console.log(`[poly-structural] report written: ${resolved}`);
    }
}

main().catch((error) => {
    console.error("[poly-structural] fatal:", error);
    process.exitCode = 1;
});
