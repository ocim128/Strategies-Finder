import fs from "node:fs";
import path from "node:path";
import {
    clamp01,
    correlation,
    fetchJsonWithRetry,
    mean,
    parseIsoSec,
    parseStringArray,
    sleep,
    std,
} from "./lib/polymarket-research";

type FeeLevel = 0.01 | 0.02 | 0.03;

type CliConfig = {
    seriesId: string;
    startDateMin: string;
    endDateMax?: string;
    maxTrades: number;
    maxEvents: number;
    pageSize: number;
    eventFetchConcurrency: number;
    windows: number;
    minTrainEvents: number;
    minTestEvents: number;
    minTradesPerEvent: number;
    permutations: number;
    slippage: number;
    outPath?: string;
};

type RawTrade = {
    proxyWallet?: unknown;
    side?: unknown;
    conditionId?: unknown;
    size?: unknown;
    price?: unknown;
    timestamp?: unknown;
    title?: unknown;
    slug?: unknown;
    outcome?: unknown;
    transactionHash?: unknown;
};

type Trade = {
    wallet: string;
    side: "BUY" | "SELL";
    conditionId: string;
    size: number;
    price: number;
    timestamp: number;
    title: string;
    slug: string;
    outcome: string;
    transactionHash: string;
};

type RawGammaMarket = {
    conditionId?: unknown;
    slug?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    eventStartTime?: unknown;
    outcomes?: unknown;
    outcomePrices?: unknown;
    closed?: unknown;
};

type RawGammaEvent = {
    id?: unknown;
    slug?: unknown;
    title?: unknown;
    description?: unknown;
    resolutionSource?: unknown;
    closed?: unknown;
    startDate?: unknown;
    endDate?: unknown;
    markets?: unknown;
};

type EventMeta = {
    eventId: string;
    slug: string;
    title: string;
    conditionId: string;
    startTs: number;
    endTs: number;
    outcomeUp: 0 | 1;
};

type EventTrade = {
    wallet: string;
    timestamp: number;
    notional: number;
    priceUp: number;
    directionUp: 1 | -1;
};

type EventRecord = {
    meta: EventMeta;
    trades: EventTrade[];
    randomPrices: number[];
};

type EventMetrics = {
    eventId: string;
    endTs: number;
    outcomeUp: 0 | 1;
    totalNotional: number;
    flowTop1Share: number;
    flowTop3Share: number;
    volumeSpikeLast60: number;
    lateDirectionalImbalance: number;
    latePriceMove: number;
    priceAccelerationVsBinance: number;
    overreactionToOutcome: number;
    distanceFromHalfAtT60: number;
    binanceMoveLast60: number;
    clusteringHhiFinal90: number;
    clusteringCorrelationFinal90: number;
    directionEntropyFinal90: number;
    overconfidenceHighExtreme: boolean;
    overconfidenceLowExtreme: boolean;
    overconfidenceReversal: boolean;
    fomoWorsePriceRateLast30: number;
    fomoSlippageVsFairLast30: number;
    crowdOverpaid: boolean;
    lateBuyersNegativeExpectancy: boolean;
    dominantWalletTimingHadEdge: boolean;
    dominantWalletShareLast60: number;
    repeatedWalletShare: number;
    lossChasingWalletShare: number;
    firstExtremePrice?: number;
    firstExtremeTs?: number;
    lateVwapPrice?: number;
};

type StrategyId =
    | "fade_extreme_probabilities"
    | "fade_late_spike_flat_binance"
    | "piggyback_positive_wallets"
    | "fade_retail_panic";

type TradeSignal = {
    strategy: StrategyId;
    bias: string;
    eventId: string;
    eventIndex: number;
    direction: 1 | -1;
    entryTs: number;
    entryPriceUp: number;
};

type Window = {
    id: number;
    trainStart: number;
    trainEnd: number;
    testStart: number;
    testEnd: number;
};

type TradeEval = {
    trades: number;
    expectancy: number;
    sharpe: number;
    hitRate: number;
};

type StrategyFeeResult = {
    strategy: StrategyId;
    bias: string;
    fee: FeeLevel;
    aggregate: TradeEval;
    byWindow: Array<{ windowId: number; eval: TradeEval }>;
    positiveWindowRate: number;
    permutationPValue: number;
};

type WalletSummary = {
    recurringWallets: number;
    positiveExpectancyRecurringWallets: number;
    lossChasingRate: number;
    streakAggressionRate: number;
};

const FEES: FeeLevel[] = [0.01, 0.02, 0.03];
const FEE_REF = 0.01;

function defaultStartDateIso(daysBack: number): string {
    const now = Date.now();
    return new Date(now - daysBack * 24 * 60 * 60 * 1000).toISOString();
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run poly:behavior -- [options]",
        "",
        "Options:",
        "  --start-date <iso>          default: now-30d",
        "  --end-date <iso>            optional",
        "  --series-id <id>            default: 10684 (BTC up/down 5m)",
        "  --max-events <n>            default: 5000",
        "  --max-trades <n>            default: 300000",
        "  --page-size <n>             default: 500",
        "  --event-concurrency <n>     default: 10",
        "  --windows <n>               default: 6",
        "  --min-train-events <n>      default: 120",
        "  --min-test-events <n>       default: 40",
        "  --min-trades-per-event <n>  default: 6",
        "  --permutations <n>          default: 200",
        "  --slippage <points>         default: 0.002",
        "  --out <file>                optional JSON output",
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
    let startDateMin = defaultStartDateIso(30);
    let endDateMax: string | undefined;
    let seriesId = "10684";
    let maxEvents = 5000;
    let maxTrades = 300000;
    let pageSize = 500;
    let eventFetchConcurrency = 10;
    let windows = 6;
    let minTrainEvents = 120;
    let minTestEvents = 40;
    let minTradesPerEvent = 6;
    let permutations = 200;
    let slippage = 0.002;
    let outPath: string | undefined;
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--start-date") { startDateMin = String(next ?? "").trim() || startDateMin; i++; continue; }
        if (arg === "--end-date") { endDateMax = String(next ?? "").trim() || undefined; i++; continue; }
        if (arg === "--series-id") { seriesId = String(next ?? "").trim() || seriesId; i++; continue; }
        if (arg === "--max-events") { maxEvents = Math.max(100, Math.floor(parseNumber(next, maxEvents))); i++; continue; }
        if (arg === "--max-trades") { maxTrades = Math.max(1000, Math.floor(parseNumber(next, maxTrades))); i++; continue; }
        if (arg === "--page-size") { pageSize = Math.max(50, Math.min(1000, Math.floor(parseNumber(next, pageSize)))); i++; continue; }
        if (arg === "--event-concurrency") { eventFetchConcurrency = Math.max(1, Math.floor(parseNumber(next, eventFetchConcurrency))); i++; continue; }
        if (arg === "--windows") { windows = Math.max(2, Math.floor(parseNumber(next, windows))); i++; continue; }
        if (arg === "--min-train-events") { minTrainEvents = Math.max(40, Math.floor(parseNumber(next, minTrainEvents))); i++; continue; }
        if (arg === "--min-test-events") { minTestEvents = Math.max(20, Math.floor(parseNumber(next, minTestEvents))); i++; continue; }
        if (arg === "--min-trades-per-event") { minTradesPerEvent = Math.max(2, Math.floor(parseNumber(next, minTradesPerEvent))); i++; continue; }
        if (arg === "--permutations") { permutations = Math.max(50, Math.floor(parseNumber(next, permutations))); i++; continue; }
        if (arg === "--slippage") { slippage = Math.max(0, parseNumber(next, slippage)); i++; continue; }
        if (arg === "--out") { outPath = String(next ?? "").trim() || undefined; i++; continue; }
        if (!arg.startsWith("--")) positional.push(arg);
    }

    if (positional.length > 0) {
        if (positional[0]) startDateMin = positional[0];
        if (positional[1]) maxTrades = Math.max(1000, Math.floor(parseNumber(positional[1], maxTrades)));
        if (positional[2]) windows = Math.max(2, Math.floor(parseNumber(positional[2], windows)));
        if (positional[3]) minTrainEvents = Math.max(40, Math.floor(parseNumber(positional[3], minTrainEvents)));
        if (positional[4]) minTestEvents = Math.max(20, Math.floor(parseNumber(positional[4], minTestEvents)));
        if (positional[5]) permutations = Math.max(50, Math.floor(parseNumber(positional[5], permutations)));
        if (positional[6]) outPath = positional[6];
    }

    return {
        seriesId,
        startDateMin,
        endDateMax,
        maxEvents,
        maxTrades,
        pageSize,
        eventFetchConcurrency,
        windows,
        minTrainEvents,
        minTestEvents,
        minTradesPerEvent,
        permutations,
        slippage,
        outPath,
    };
}

function entropy2(p: number): number {
    if (p <= 0 || p >= 1) return 0;
    return -(p * Math.log2(p) + (1 - p) * Math.log2(1 - p));
}

function pnlForDirection(direction: 1 | -1, entryPriceUp: number, outcomeUp: 0 | 1, fee: number, slippage: number): number {
    if (direction > 0) return outcomeUp - entryPriceUp - fee - slippage;
    return entryPriceUp - outcomeUp - fee - slippage;
}

function normalizeTrade(raw: RawTrade): Trade | null {
    const wallet = typeof raw.proxyWallet === "string" ? raw.proxyWallet.trim().toLowerCase() : "";
    const sideRaw = typeof raw.side === "string" ? raw.side.trim().toUpperCase() : "";
    const conditionId = typeof raw.conditionId === "string" ? raw.conditionId.trim().toLowerCase() : "";
    const slug = typeof raw.slug === "string" ? raw.slug.trim().toLowerCase() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : "";
    const outcome = typeof raw.outcome === "string" ? raw.outcome.trim() : "";
    const txHash = typeof raw.transactionHash === "string" ? raw.transactionHash.trim().toLowerCase() : "";
    const size = Number(raw.size);
    const price = Number(raw.price);
    const timestamp = Math.floor(Number(raw.timestamp));
    if (!wallet || !conditionId || !slug || !title || !outcome || !txHash) return null;
    if (sideRaw !== "BUY" && sideRaw !== "SELL") return null;
    if (!Number.isFinite(size) || size <= 0) return null;
    if (!Number.isFinite(price) || price < 0 || price > 1) return null;
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return {
        wallet,
        side: sideRaw,
        conditionId,
        size,
        price,
        timestamp,
        title,
        slug,
        outcome,
        transactionHash: txHash,
    };
}

function normalizeOutcomeLabel(label: string): "up" | "down" | "unknown" {
    const v = label.trim().toLowerCase();
    if (v === "up" || v === "yes" || v.includes("up")) return "up";
    if (v === "down" || v === "no" || v.includes("down")) return "down";
    return "unknown";
}

function toDirectionAndUpPrice(trade: Trade): { direction: 1 | -1; priceUp: number } | null {
    const outcome = normalizeOutcomeLabel(trade.outcome);
    if (outcome === "unknown") return null;
    if (outcome === "up") {
        return {
            direction: trade.side === "BUY" ? 1 : -1,
            priceUp: clamp01(trade.price),
        };
    }
    return {
        direction: trade.side === "BUY" ? -1 : 1,
        priceUp: clamp01(1 - trade.price),
    };
}

async function fetchTrades(cfg: CliConfig): Promise<Trade[]> {
    const startTs = parseIsoSec(cfg.startDateMin);
    const endTs = cfg.endDateMax ? parseIsoSec(cfg.endDateMax) : null;
    if (!startTs) throw new Error(`Invalid --start-date: ${cfg.startDateMin}`);

    const out: Trade[] = [];
    const dedup = new Set<string>();
    let offset = 0;
    let pages = 0;
    let done = false;

    while (!done && out.length < cfg.maxTrades) {
        const q = new URLSearchParams({
            limit: String(cfg.pageSize),
            offset: String(offset),
        });
        let payload: unknown;
        try {
            payload = await fetchJsonWithRetry<unknown>(`https://data-api.polymarket.com/trades?${q.toString()}`, 5);
        } catch (error) {
            const message = String((error as Error)?.message ?? error ?? "");
            if (message.toLowerCase().includes("offset")) {
                console.log(`[poly-behavior] reached data-api offset limit at offset=${offset}; stopping pagination.`);
                break;
            }
            throw error;
        }
        if (!Array.isArray(payload) || payload.length === 0) break;
        pages += 1;
        for (const row of payload as RawTrade[]) {
            const trade = normalizeTrade(row);
            if (!trade) continue;
            const titleLower = trade.title.toLowerCase();
            if (!titleLower.includes("bitcoin") && !titleLower.includes("btc")) continue;
            if (trade.timestamp < startTs) {
                done = true;
                continue;
            }
            if (endTs && trade.timestamp > endTs) continue;
            const key = `${trade.conditionId}|${trade.transactionHash}|${trade.wallet}|${trade.timestamp}`;
            if (dedup.has(key)) continue;
            dedup.add(key);
            out.push(trade);
            if (out.length >= cfg.maxTrades) break;
        }
        offset += payload.length;
        if (pages % 20 === 0 || done || out.length >= cfg.maxTrades) {
            console.log(`[poly-behavior] trade pages=${pages}, kept=${out.length}`);
        }
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
}

function hasBitcoinContext(raw: RawGammaEvent): boolean {
    const title = typeof raw.title === "string" ? raw.title.toLowerCase() : "";
    const desc = typeof raw.description === "string" ? raw.description.toLowerCase() : "";
    const source = typeof raw.resolutionSource === "string" ? raw.resolutionSource.toLowerCase() : "";
    return title.includes("bitcoin") || title.includes("btc") || desc.includes("bitcoin") || source.includes("btc");
}

function resolveEventMeta(raw: RawGammaEvent, conditionIdWanted: string): EventMeta | null {
    if (!hasBitcoinContext(raw)) return null;
    const slug = typeof raw.slug === "string" ? raw.slug.trim().toLowerCase() : "";
    const title = typeof raw.title === "string" ? raw.title.trim() : slug;
    if (!slug) return null;
    const markets = Array.isArray(raw.markets) ? raw.markets as RawGammaMarket[] : [];
    if (markets.length === 0) return null;
    const market = markets.find((m) => String(m.conditionId ?? "").trim().toLowerCase() === conditionIdWanted)
        ?? markets.find((m) => String(m.slug ?? "").trim().toLowerCase() === slug)
        ?? markets[0];

    const conditionId = String(market.conditionId ?? "").trim().toLowerCase();
    if (!conditionId) return null;
    const endTs = parseIsoSec(market.endDate) ?? parseIsoSec(raw.endDate);
    if (!endTs) return null;
    const titleLower = title.toLowerCase();
    const slugLower = slug.toLowerCase();
    const likelyFiveMinute =
        slugLower.includes("5m") ||
        titleLower.includes("5m") ||
        titleLower.includes("5-minute") ||
        titleLower.includes("5 minute");
    const startCandidate = parseIsoSec(market.eventStartTime) ?? parseIsoSec(market.startDate) ?? parseIsoSec(raw.startDate);
    let startTs = startCandidate ?? (endTs - 300);
    let duration = endTs - startTs;
    if (!(duration >= 240 && duration <= 360)) {
        if (!likelyFiveMinute) return null;
        startTs = endTs - 300;
        duration = 300;
    }

    const outcomes = parseStringArray(market.outcomes).map((x) => x.toLowerCase());
    const prices = parseStringArray(market.outcomePrices).map((x) => Number(x));
    if (outcomes.length < 2 || prices.length < 2) return null;
    let upIdx = outcomes.findIndex((x) => x === "up" || x === "yes" || x.includes("up"));
    if (upIdx < 0) upIdx = 0;
    const up = prices[upIdx];
    const down = prices[1 - upIdx] ?? 1 - up;
    if (!Number.isFinite(up) || !Number.isFinite(down)) return null;
    let outcomeUp: 0 | 1 | null = null;
    if (up >= 0.99 || down <= 0.01) outcomeUp = 1;
    if (down >= 0.99 || up <= 0.01) outcomeUp = 0;
    if (outcomeUp === null) return null;
    const closed = Boolean(raw.closed) || Boolean(market.closed);
    if (!closed) return null;

    const eventId = `${String(raw.id ?? slug)}__${conditionId}`;
    return { eventId, slug, title, conditionId, startTs, endTs, outcomeUp };
}

async function fetchSeriesEventMetas(cfg: CliConfig): Promise<EventMeta[]> {
    const metas: EventMeta[] = [];
    let offset = 0;
    while (metas.length < cfg.maxEvents) {
        const q = new URLSearchParams({
            series_id: cfg.seriesId,
            closed: "true",
            start_date_min: cfg.startDateMin,
            limit: String(Math.min(500, cfg.pageSize)),
            offset: String(offset),
        });
        if (cfg.endDateMax) q.set("end_date_max", cfg.endDateMax);
        const url = `https://gamma-api.polymarket.com/events?${q.toString()}`;
        const payload = await fetchJsonWithRetry<unknown>(url, 4);
        if (!Array.isArray(payload) || payload.length === 0) break;
        for (const row of payload as RawGammaEvent[]) {
            const markets = Array.isArray(row.markets) ? row.markets as RawGammaMarket[] : [];
            if (markets.length === 0) continue;
            const conditionId = String(markets[0].conditionId ?? "").trim().toLowerCase();
            if (!conditionId) continue;
            const meta = resolveEventMeta(row, conditionId);
            if (meta) metas.push(meta);
            if (metas.length >= cfg.maxEvents) break;
        }
        if (payload.length < Math.min(500, cfg.pageSize)) break;
        offset += payload.length;
    }
    const dedup = new Map<string, EventMeta>();
    for (const m of metas) dedup.set(m.conditionId, m);
    return Array.from(dedup.values()).sort((a, b) => a.endTs - b.endTs).slice(-cfg.maxEvents);
}

async function fetchTradesForMarket(conditionId: string, pageSize: number, maxTrades: number): Promise<Trade[]> {
    const out: Trade[] = [];
    const dedup = new Set<string>();
    let offset = 0;
    while (out.length < maxTrades) {
        const q = new URLSearchParams({
            market: conditionId,
            limit: String(Math.min(500, pageSize)),
            offset: String(offset),
        });
        const url = `https://data-api.polymarket.com/trades?${q.toString()}`;
        let payload: unknown;
        try {
            payload = await fetchJsonWithRetry<unknown>(url, 4);
        } catch (error) {
            const msg = String((error as Error)?.message ?? error ?? "").toLowerCase();
            if (msg.includes("offset")) break;
            throw error;
        }
        if (!Array.isArray(payload) || payload.length === 0) break;
        for (const row of payload as RawTrade[]) {
            const trade = normalizeTrade(row);
            if (!trade) continue;
            const key = `${trade.transactionHash}|${trade.wallet}|${trade.timestamp}`;
            if (dedup.has(key)) continue;
            dedup.add(key);
            out.push(trade);
            if (out.length >= maxTrades) break;
        }
        if (payload.length < Math.min(500, pageSize)) break;
        offset += payload.length;
    }
    return out.sort((a, b) => a.timestamp - b.timestamp);
}

async function buildEventRecordsFromSeries(metas: EventMeta[], cfg: CliConfig): Promise<EventRecord[]> {
    const rows = await runPool(metas, cfg.eventFetchConcurrency, async (meta, i) => {
        const tradesRaw = await fetchTradesForMarket(meta.conditionId, cfg.pageSize, cfg.maxTrades).catch(() => [] as Trade[]);
        const trades: EventTrade[] = [];
        for (const trade of tradesRaw) {
            if (trade.timestamp < meta.startTs || trade.timestamp > meta.endTs) continue;
            const conv = toDirectionAndUpPrice(trade);
            if (!conv) continue;
            trades.push({
                wallet: trade.wallet,
                timestamp: trade.timestamp,
                notional: trade.size * trade.price,
                priceUp: conv.priceUp,
                directionUp: conv.direction,
            });
        }
        trades.sort((a, b) => a.timestamp - b.timestamp);
        if ((i + 1) % 200 === 0 || i + 1 === metas.length) {
            console.log(`[poly-behavior] market trades ${i + 1}/${metas.length}`);
        }
        if (trades.length < cfg.minTradesPerEvent) return null;
        const randomPrices = trades
            .filter((t) => t.timestamp >= meta.endTs - 120 && t.timestamp <= meta.endTs - 5)
            .map((t) => t.priceUp);
        return { meta, trades, randomPrices } as EventRecord;
    });
    return rows.filter((x): x is EventRecord => x !== null).sort((a, b) => a.meta.endTs - b.meta.endTs);
}

async function runPool<T, R>(items: T[], concurrency: number, worker: (item: T, index: number) => Promise<R>): Promise<R[]> {
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

async function buildEventRecords(trades: Trade[], cfg: CliConfig): Promise<EventRecord[]> {
    const tradesByCondition = new Map<string, Trade[]>();
    for (const trade of trades) {
        const arr = tradesByCondition.get(trade.conditionId) ?? [];
        arr.push(trade);
        tradesByCondition.set(trade.conditionId, arr);
    }
    const conditionIds = Array.from(tradesByCondition.keys());
    const slugByCondition = new Map<string, string>();
    for (const [conditionId, rows] of tradesByCondition.entries()) {
        if (rows[0]) slugByCondition.set(conditionId, rows[0].slug);
    }

    const metas = await runPool(conditionIds, cfg.eventFetchConcurrency, async (conditionId, i) => {
        const slug = slugByCondition.get(conditionId) ?? "";
        if (!slug) return null;
        const raw = await fetchJsonWithRetry<RawGammaEvent>(`https://gamma-api.polymarket.com/events/slug/${encodeURIComponent(slug)}`, 4)
            .catch(() => null);
        if ((i + 1) % 200 === 0 || i + 1 === conditionIds.length) {
            console.log(`[poly-behavior] metadata ${i + 1}/${conditionIds.length}`);
        }
        if (!raw) return null;
        return resolveEventMeta(raw, conditionId);
    });

    const metaByCondition = new Map<string, EventMeta>();
    for (const meta of metas) {
        if (meta) metaByCondition.set(meta.conditionId, meta);
    }

    const records: EventRecord[] = [];
    for (const [conditionId, rows] of tradesByCondition.entries()) {
        const meta = metaByCondition.get(conditionId);
        if (!meta) continue;
        const tradesNorm: EventTrade[] = [];
        const dedup = new Set<string>();
        for (const trade of rows) {
            if (trade.timestamp < meta.startTs || trade.timestamp > meta.endTs) continue;
            const key = `${trade.transactionHash}|${trade.wallet}|${trade.timestamp}`;
            if (dedup.has(key)) continue;
            dedup.add(key);
            const conv = toDirectionAndUpPrice(trade);
            if (!conv) continue;
            tradesNorm.push({
                wallet: trade.wallet,
                timestamp: trade.timestamp,
                notional: trade.size * trade.price,
                priceUp: conv.priceUp,
                directionUp: conv.direction,
            });
        }
        if (tradesNorm.length < cfg.minTradesPerEvent) continue;
        tradesNorm.sort((a, b) => a.timestamp - b.timestamp);
        const randomPrices = tradesNorm
            .filter((t) => t.timestamp >= meta.endTs - 120 && t.timestamp <= meta.endTs - 5)
            .map((t) => t.priceUp);
        records.push({ meta, trades: tradesNorm, randomPrices });
    }
    return records.sort((a, b) => a.meta.endTs - b.meta.endTs);
}

type BinancePoint = { openSec: number; close: number };

async function fetchBinance1mRange(startTs: number, endTs: number): Promise<Map<number, number>> {
    const out: BinancePoint[] = [];
    let cursorMs = Math.floor(startTs / 60) * 60 * 1000;
    const endMs = Math.floor(endTs / 60) * 60 * 1000;
    while (cursorMs <= endMs) {
        const q = new URLSearchParams({
            symbol: "BTCUSDT",
            interval: "1m",
            startTime: String(cursorMs),
            endTime: String(endMs),
            limit: "1000",
        });
        const url = `https://api.binance.com/api/v3/klines?${q.toString()}`;
        const payload = await fetchJsonWithRetry<unknown>(url, 4);
        if (!Array.isArray(payload) || payload.length === 0) break;
        let lastOpenMs = cursorMs;
        for (const row of payload) {
            if (!Array.isArray(row) || row.length < 5) continue;
            const openMs = Number(row[0]);
            const close = Number(row[4]);
            if (!Number.isFinite(openMs) || !Number.isFinite(close) || close <= 0) continue;
            out.push({ openSec: Math.floor(openMs / 1000), close });
            lastOpenMs = openMs;
        }
        const nextMs = lastOpenMs + 60_000;
        if (nextMs <= cursorMs) break;
        cursorMs = nextMs;
        if (payload.length < 1000) break;
        await sleep(40);
    }
    const map = new Map<number, number>();
    for (const point of out) map.set(point.openSec, point.close);
    return map;
}

function minuteCloseAtOrBefore(map: Map<number, number>, ts: number): number {
    const base = Math.floor(ts / 60) * 60;
    for (let back = 0; back <= 5; back++) {
        const v = map.get(base - back * 60);
        if (Number.isFinite(v)) return v as number;
    }
    return 0;
}

function computeEventMetrics(record: EventRecord, minuteMap: Map<number, number>, slippage: number): EventMetrics {
    const { meta, trades } = record;
    const end = meta.endTs;
    const last60Start = end - 60;
    const last90Start = end - 90;
    const last30Start = end - 30;
    const totalNotional = trades.reduce((s, t) => s + t.notional, 0);

    const byWallet = new Map<string, { total: number; last60: number; dirLast60: number; priceLast60: number }>();
    for (const tr of trades) {
        const rec = byWallet.get(tr.wallet) ?? { total: 0, last60: 0, dirLast60: 0, priceLast60: 0 };
        rec.total += tr.notional;
        if (tr.timestamp >= last60Start) {
            rec.last60 += tr.notional;
            rec.dirLast60 += tr.directionUp * tr.notional;
            rec.priceLast60 += tr.priceUp * tr.notional;
        }
        byWallet.set(tr.wallet, rec);
    }
    const walletTotals = Array.from(byWallet.values()).map((x) => x.total).sort((a, b) => b - a);
    const flowTop1Share = totalNotional > 0 ? (walletTotals[0] ?? 0) / totalNotional : 0;
    const top3 = (walletTotals[0] ?? 0) + (walletTotals[1] ?? 0) + (walletTotals[2] ?? 0);
    const flowTop3Share = totalNotional > 0 ? top3 / totalNotional : 0;

    const lateTrades = trades.filter((t) => t.timestamp >= last60Start);
    const earlyTrades = trades.filter((t) => t.timestamp < last60Start);
    const lateNotional = lateTrades.reduce((s, t) => s + t.notional, 0);
    const earlyNotional = earlyTrades.reduce((s, t) => s + t.notional, 0);
    const volumeSpikeLast60 = (earlyNotional / 4) > 0 ? lateNotional / (earlyNotional / 4) : (lateNotional > 0 ? 99 : 0);
    const lateDirectional = lateTrades.reduce((s, t) => s + t.directionUp * t.notional, 0);
    const lateDirectionalImbalance = lateNotional > 0 ? lateDirectional / lateNotional : 0;

    const pT60 = (() => {
        const prev = trades.filter((t) => t.timestamp <= last60Start);
        return prev.length > 0 ? prev[prev.length - 1].priceUp : 0.5;
    })();
    const pEnd = lateTrades.length > 0 ? lateTrades[lateTrades.length - 1].priceUp : (trades[trades.length - 1]?.priceUp ?? 0.5);
    const latePriceMove = pEnd - pT60;
    const overreactionToOutcome = Math.abs(pEnd - meta.outcomeUp);
    const distanceFromHalfAtT60 = Math.abs(pT60 - 0.5);
    const closeEnd = minuteCloseAtOrBefore(minuteMap, end);
    const closePrev = minuteCloseAtOrBefore(minuteMap, end - 60);
    const binanceMoveLast60 = (closeEnd > 0 && closePrev > 0) ? (closeEnd - closePrev) / closePrev : 0;
    const priceAccelerationVsBinance = Math.abs(latePriceMove) / (Math.abs(binanceMoveLast60) + 1e-6);

    const bins = new Array<number>(9).fill(0);
    let binCount = 0;
    let bullNotional = 0;
    let bearNotional = 0;
    for (const tr of trades) {
        if (tr.timestamp < last90Start) continue;
        const idx = Math.max(0, Math.min(8, Math.floor((tr.timestamp - last90Start) / 10)));
        bins[idx] += 1;
        binCount += 1;
        if (tr.directionUp > 0) bullNotional += tr.notional;
        else bearNotional += tr.notional;
    }
    const binsNorm = binCount > 0 ? bins.map((x) => x / binCount) : bins.map(() => 0);
    const clusteringHhiFinal90 = binsNorm.reduce((s, x) => s + x * x, 0);
    const dirTot = bullNotional + bearNotional;
    const pBull = dirTot > 0 ? bullNotional / dirTot : 0.5;
    const directionEntropyFinal90 = entropy2(pBull);

    let firstExtremePrice: number | undefined;
    let firstExtremeTs: number | undefined;
    for (const tr of trades) {
        if (tr.priceUp >= 0.8 || tr.priceUp <= 0.2) {
            firstExtremePrice = tr.priceUp;
            firstExtremeTs = tr.timestamp;
            break;
        }
    }
    const overconfidenceHighExtreme = firstExtremePrice !== undefined && firstExtremePrice >= 0.8;
    const overconfidenceLowExtreme = firstExtremePrice !== undefined && firstExtremePrice <= 0.2;
    const overconfidenceReversal = (overconfidenceHighExtreme && meta.outcomeUp === 0) || (overconfidenceLowExtreme && meta.outcomeUp === 1);

    const fairTrades = trades.filter((t) => t.timestamp >= end - 120 && t.timestamp < last30Start);
    const fairNotional = fairTrades.reduce((s, t) => s + t.notional, 0);
    const fairValue = fairNotional > 0 ? fairTrades.reduce((s, t) => s + t.priceUp * t.notional, 0) / fairNotional : 0.5;
    const last30Trades = trades.filter((t) => t.timestamp >= last30Start);
    const fomoSlips: number[] = [];
    let worse = 0;
    for (const tr of last30Trades) {
        const slip = tr.directionUp > 0 ? tr.priceUp - fairValue : fairValue - tr.priceUp;
        if (slip > 0) worse += 1;
        fomoSlips.push(slip);
    }
    const fomoWorsePriceRateLast30 = last30Trades.length > 0 ? worse / last30Trades.length : 0;
    const fomoSlippageVsFairLast30 = mean(fomoSlips);

    const lateVwapPrice = lateNotional > 0 ? lateTrades.reduce((s, t) => s + t.priceUp * t.notional, 0) / lateNotional : undefined;
    const crowdDirection: 1 | -1 = lateDirectional >= 0 ? 1 : -1;
    const crowdOverpaid = lateVwapPrice !== undefined && pnlForDirection(crowdDirection, lateVwapPrice, meta.outcomeUp, FEE_REF, slippage) < 0;
    const lateBuyerPnls = lateTrades.filter((t) => t.directionUp > 0).map((t) => pnlForDirection(1, t.priceUp, meta.outcomeUp, FEE_REF, slippage));
    const lateBuyersNegativeExpectancy = lateBuyerPnls.length > 0 && mean(lateBuyerPnls) < 0;

    let dominantWalletShareLast60 = 0;
    let dominantWalletTimingHadEdge = false;
    for (const rec of byWallet.values()) {
        if (lateNotional <= 0 || rec.last60 <= 0) continue;
        const share = rec.last60 / lateNotional;
        if (share <= dominantWalletShareLast60) continue;
        dominantWalletShareLast60 = share;
        const dir: 1 | -1 = rec.dirLast60 >= 0 ? 1 : -1;
        const entry = rec.last60 > 0 ? rec.priceLast60 / rec.last60 : 0.5;
        dominantWalletTimingHadEdge = pnlForDirection(dir, entry, meta.outcomeUp, FEE_REF, slippage) > 0;
    }

    return {
        eventId: meta.eventId,
        endTs: meta.endTs,
        outcomeUp: meta.outcomeUp,
        totalNotional,
        flowTop1Share,
        flowTop3Share,
        volumeSpikeLast60,
        lateDirectionalImbalance,
        latePriceMove,
        priceAccelerationVsBinance,
        overreactionToOutcome,
        distanceFromHalfAtT60,
        binanceMoveLast60,
        clusteringHhiFinal90,
        clusteringCorrelationFinal90: 0,
        directionEntropyFinal90,
        overconfidenceHighExtreme,
        overconfidenceLowExtreme,
        overconfidenceReversal,
        fomoWorsePriceRateLast30,
        fomoSlippageVsFairLast30,
        crowdOverpaid,
        lateBuyersNegativeExpectancy,
        dominantWalletTimingHadEdge,
        dominantWalletShareLast60,
        repeatedWalletShare: 0,
        lossChasingWalletShare: 0,
        firstExtremePrice,
        firstExtremeTs,
        lateVwapPrice,
    };
}

function annotateCrossEventWalletBehavior(metrics: EventMetrics[], records: EventRecord[], slippage: number): WalletSummary {
    const walletHistory = new Map<string, Array<{ eventIndex: number; endTs: number; notional: number; pnl: number }>>();
    for (let eventIndex = 0; eventIndex < records.length; eventIndex++) {
        const rec = records[eventIndex];
        const byWallet = new Map<string, { notional: number; dirNotional: number; priceNotional: number }>();
        for (const tr of rec.trades) {
            const row = byWallet.get(tr.wallet) ?? { notional: 0, dirNotional: 0, priceNotional: 0 };
            row.notional += tr.notional;
            row.dirNotional += tr.directionUp * tr.notional;
            row.priceNotional += tr.priceUp * tr.notional;
            byWallet.set(tr.wallet, row);
        }
        for (const [wallet, row] of byWallet.entries()) {
            const dir: 1 | -1 = row.dirNotional >= 0 ? 1 : -1;
            const entry = row.priceNotional / row.notional;
            const pnl = pnlForDirection(dir, entry, rec.meta.outcomeUp, FEE_REF, slippage);
            const arr = walletHistory.get(wallet) ?? [];
            arr.push({ eventIndex, endTs: rec.meta.endTs, notional: row.notional, pnl });
            walletHistory.set(wallet, arr);
        }
    }

    let recurringWallets = 0;
    let positiveExpectancyRecurringWallets = 0;
    let lossOpportunities = 0;
    let lossTriggers = 0;
    let streakOpp = 0;
    let streakTrig = 0;
    const chasingByEvent = new Map<number, Set<string>>();

    for (const [wallet, rows] of walletHistory.entries()) {
        rows.sort((a, b) => a.endTs - b.endTs);
        if (rows.length >= 5) {
            recurringWallets += 1;
            if (mean(rows.map((x) => x.pnl)) > 0) positiveExpectancyRecurringWallets += 1;
        }
        let lossStreak = 0;
        for (let i = 1; i < rows.length; i++) {
            const prev = rows[i - 1];
            const curr = rows[i];
            if (prev.pnl < 0) {
                lossOpportunities += 1;
                if (curr.notional > prev.notional * 1.2) {
                    lossTriggers += 1;
                    const set = chasingByEvent.get(curr.eventIndex) ?? new Set<string>();
                    set.add(wallet);
                    chasingByEvent.set(curr.eventIndex, set);
                }
                lossStreak += 1;
            } else {
                lossStreak = 0;
            }
            if (lossStreak >= 1) {
                streakOpp += 1;
                if (curr.notional > prev.notional * 1.2) streakTrig += 1;
            }
        }
    }

    const seenCount = new Map<string, number>();
    for (let eventIndex = 0; eventIndex < records.length; eventIndex++) {
        const rec = records[eventIndex];
        const metric = metrics[eventIndex];
        let repeatedNotional = 0;
        let chasingNotional = 0;
        const chasing = chasingByEvent.get(eventIndex) ?? new Set<string>();
        const walletVolume = new Map<string, number>();
        for (const tr of rec.trades) walletVolume.set(tr.wallet, (walletVolume.get(tr.wallet) ?? 0) + tr.notional);
        for (const [wallet, notional] of walletVolume.entries()) {
            const seen = seenCount.get(wallet) ?? 0;
            if (seen >= 3) repeatedNotional += notional;
            if (chasing.has(wallet)) chasingNotional += notional;
            seenCount.set(wallet, seen + 1);
        }
        metric.repeatedWalletShare = metric.totalNotional > 0 ? repeatedNotional / metric.totalNotional : 0;
        metric.lossChasingWalletShare = metric.totalNotional > 0 ? chasingNotional / metric.totalNotional : 0;
    }

    return {
        recurringWallets,
        positiveExpectancyRecurringWallets,
        lossChasingRate: lossOpportunities > 0 ? lossTriggers / lossOpportunities : 0,
        streakAggressionRate: streakOpp > 0 ? streakTrig / streakOpp : 0,
    };
}

function applyClusteringCorrelations(metrics: EventMetrics[], records: EventRecord[]): void {
    const vectors: number[][] = [];
    for (const rec of records) {
        const start = rec.meta.endTs - 90;
        const bins = new Array<number>(9).fill(0);
        let count = 0;
        for (const tr of rec.trades) {
            if (tr.timestamp < start) continue;
            const idx = Math.max(0, Math.min(8, Math.floor((tr.timestamp - start) / 10)));
            bins[idx] += 1;
            count += 1;
        }
        vectors.push(count > 0 ? bins.map((x) => x / count) : bins);
    }
    const avg = new Array<number>(9).fill(0);
    for (const vec of vectors) for (let i = 0; i < vec.length; i++) avg[i] += vec[i];
    for (let i = 0; i < avg.length; i++) avg[i] /= Math.max(1, vectors.length);
    for (let i = 0; i < metrics.length; i++) metrics[i].clusteringCorrelationFinal90 = correlation(vectors[i] ?? avg, avg);
}

function createWindows(total: number, cfg: CliConfig): Window[] {
    const out: Window[] = [];
    if (total < cfg.minTrainEvents + cfg.minTestEvents) return out;
    const testSize = Math.max(cfg.minTestEvents, Math.floor((total - cfg.minTrainEvents) / (cfg.windows + 1)));
    let trainEnd = cfg.minTrainEvents;
    for (let i = 0; i < cfg.windows; i++) {
        const testStart = trainEnd;
        const testEnd = Math.min(total, testStart + testSize);
        if (testEnd - testStart < cfg.minTestEvents) break;
        out.push({ id: i + 1, trainStart: 0, trainEnd, testStart, testEnd });
        const remain = total - testEnd;
        if (remain < cfg.minTestEvents) break;
        trainEnd = Math.min(total - cfg.minTestEvents, trainEnd + Math.max(1, Math.floor(testSize * 0.7)));
    }
    return out;
}

function evaluatePnls(pnls: number[]): TradeEval {
    if (pnls.length === 0) return { trades: 0, expectancy: 0, sharpe: 0, hitRate: 0 };
    const exp = mean(pnls);
    const vol = std(pnls);
    const wins = pnls.filter((x) => x > 0).length;
    return {
        trades: pnls.length,
        expectancy: exp,
        sharpe: vol > 0 ? (exp / vol) * Math.sqrt(pnls.length) : 0,
        hitRate: wins / pnls.length,
    };
}

function buildSelectedWallets(trainRecords: EventRecord[], slippage: number): Set<string> {
    const byWallet = new Map<string, Array<{ pnl: number; dir: number }>>();
    for (const rec of trainRecords) {
        const walletRows = new Map<string, { notional: number; dirNotional: number; priceNotional: number }>();
        for (const tr of rec.trades) {
            const row = walletRows.get(tr.wallet) ?? { notional: 0, dirNotional: 0, priceNotional: 0 };
            row.notional += tr.notional;
            row.dirNotional += tr.directionUp * tr.notional;
            row.priceNotional += tr.priceUp * tr.notional;
            walletRows.set(tr.wallet, row);
        }
        for (const [wallet, row] of walletRows.entries()) {
            const dir = row.dirNotional >= 0 ? 1 : -1;
            const entry = row.priceNotional / row.notional;
            const pnl = pnlForDirection(dir as 1 | -1, entry, rec.meta.outcomeUp, FEE_REF, slippage);
            const arr = byWallet.get(wallet) ?? [];
            arr.push({ pnl, dir });
            byWallet.set(wallet, arr);
        }
    }
    const selected = new Set<string>();
    for (const [wallet, rows] of byWallet.entries()) {
        const consistency = Math.abs(mean(rows.map((r) => r.dir)));
        if (rows.length >= 6 && mean(rows.map((r) => r.pnl)) > 0 && consistency >= 0.55) selected.add(wallet);
    }
    return selected;
}

function generateSignals(eventMetric: EventMetrics, eventRecord: EventRecord, eventIndex: number, selectedWallets: Set<string>): TradeSignal[] {
    const out: TradeSignal[] = [];
    if (eventMetric.firstExtremePrice !== undefined && eventMetric.firstExtremeTs !== undefined && eventMetric.firstExtremeTs >= eventMetric.endTs - 90) {
        out.push({
            strategy: "fade_extreme_probabilities",
            bias: "overconfidence_bias",
            eventId: eventMetric.eventId,
            eventIndex,
            direction: eventMetric.firstExtremePrice >= 0.8 ? -1 : 1,
            entryTs: eventMetric.firstExtremeTs,
            entryPriceUp: eventMetric.firstExtremePrice,
        });
    }
    if (
        eventMetric.lateVwapPrice !== undefined &&
        eventMetric.volumeSpikeLast60 >= 2 &&
        Math.abs(eventMetric.binanceMoveLast60) <= 0.0015 &&
        Math.abs(eventMetric.lateDirectionalImbalance) >= 0.12
    ) {
        out.push({
            strategy: "fade_late_spike_flat_binance",
            bias: "retail_panic_behavior",
            eventId: eventMetric.eventId,
            eventIndex,
            direction: eventMetric.lateDirectionalImbalance >= 0 ? -1 : 1,
            entryTs: eventMetric.endTs - 30,
            entryPriceUp: eventMetric.lateVwapPrice,
        });
    }

    if (selectedWallets.size > 0) {
        const last90Start = eventRecord.meta.endTs - 90;
        const byWallet = new Map<string, { notional: number; dirNotional: number; priceNotional: number }>();
        for (const tr of eventRecord.trades) {
            if (tr.timestamp < last90Start) continue;
            if (!selectedWallets.has(tr.wallet)) continue;
            const row = byWallet.get(tr.wallet) ?? { notional: 0, dirNotional: 0, priceNotional: 0 };
            row.notional += tr.notional;
            row.dirNotional += tr.directionUp * tr.notional;
            row.priceNotional += tr.priceUp * tr.notional;
            byWallet.set(tr.wallet, row);
        }
        let topWallet = "";
        let topNotional = 0;
        let topDir: 1 | -1 = 1;
        let topPrice = 0.5;
        const totalFinal90 = eventRecord.trades.filter((t) => t.timestamp >= last90Start).reduce((s, t) => s + t.notional, 0);
        for (const [wallet, row] of byWallet.entries()) {
            if (row.notional > topNotional) {
                topWallet = wallet;
                topNotional = row.notional;
                topDir = row.dirNotional >= 0 ? 1 : -1;
                topPrice = row.priceNotional / row.notional;
            }
        }
        const share = totalFinal90 > 0 ? topNotional / totalFinal90 : 0;
        if (topWallet && share >= 0.2) {
            out.push({
                strategy: "piggyback_positive_wallets",
                bias: "repeated_wallet_patterns",
                eventId: eventMetric.eventId,
                eventIndex,
                direction: topDir,
                entryTs: eventMetric.endTs - 45,
                entryPriceUp: clamp01(topPrice),
            });
        }
    }

    if (
        eventMetric.lateVwapPrice !== undefined &&
        eventMetric.volumeSpikeLast60 >= 2.5 &&
        eventMetric.priceAccelerationVsBinance >= 2 &&
        Math.abs(eventMetric.latePriceMove) >= 0.08 &&
        Math.abs(eventMetric.binanceMoveLast60) <= 0.003 &&
        eventMetric.distanceFromHalfAtT60 >= 0.2
    ) {
        out.push({
            strategy: "fade_retail_panic",
            bias: "end_of_event_fomo",
            eventId: eventMetric.eventId,
            eventIndex,
            direction: eventMetric.latePriceMove >= 0 ? -1 : 1,
            entryTs: eventMetric.endTs - 20,
            entryPriceUp: eventMetric.lateVwapPrice,
        });
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

function permutationPValue(signals: TradeSignal[], outcomeByEvent: Map<string, 0 | 1>, randomPricesByEvent: Map<string, number[]>, fee: number, slippage: number, permutations: number, seed: number): number {
    if (signals.length === 0 || permutations <= 0) return 1;
    const observed = mean(signals.map((s) => pnlForDirection(s.direction, s.entryPriceUp, outcomeByEvent.get(s.eventId) ?? 0, fee, slippage)));
    const rng = new XorShift(seed);
    let ge = 0;
    for (let p = 0; p < permutations; p++) {
        const rows: number[] = [];
        for (const sig of signals) {
            const outcome = outcomeByEvent.get(sig.eventId);
            const candidates = randomPricesByEvent.get(sig.eventId) ?? [];
            if (outcome === undefined || candidates.length === 0) continue;
            const idx = Math.floor(rng.next() * candidates.length);
            rows.push(pnlForDirection(sig.direction, candidates[idx], outcome, fee, slippage));
        }
        if (mean(rows) >= observed) ge += 1;
    }
    return (ge + 1) / (permutations + 1);
}

function isStableByFee(rows: StrategyFeeResult[]): boolean {
    const fee1 = rows.find((x) => x.fee === 0.01);
    if (!fee1) return false;
    return rows.every((x) => x.aggregate.expectancy > 0) &&
        fee1.aggregate.expectancy > 0 &&
        fee1.aggregate.sharpe > 0 &&
        fee1.positiveWindowRate >= 0.6 &&
        fee1.permutationPValue < 0.05;
}

async function main(): Promise<void> {
    const cfg = parseArgs(process.argv.slice(2));
    if (!cfg) return;

    console.log(`[poly-behavior] fetching series events series_id=${cfg.seriesId}...`);
    const seriesMetas = await fetchSeriesEventMetas(cfg);
    console.log(`[poly-behavior] series candidate events=${seriesMetas.length}`);

    let records: EventRecord[] = [];
    let trades: Trade[] = [];
    if (seriesMetas.length > 0) {
        records = await buildEventRecordsFromSeries(seriesMetas, cfg);
        console.log(`[poly-behavior] series-based events with trades=${records.length}`);
    }
    if (records.length === 0) {
        console.log("[poly-behavior] series path produced no usable events, falling back to global trade discovery.");
        trades = await fetchTrades(cfg);
        console.log(`[poly-behavior] fallback trades=${trades.length}`);
        if (trades.length > 0) {
            records = await buildEventRecords(trades, cfg);
        }
    }

    console.log(`[poly-behavior] btc5m events=${records.length}`);
    if (records.length < cfg.minTrainEvents + cfg.minTestEvents) {
        const verdict = "No stable trader-behavior exploitation edge detected.";
        console.log("[poly-behavior] not enough events for strict walk-forward; returning no-edge verdict.");
        console.log(`[poly-behavior] Verdict: ${verdict}`);
        const report = {
            generatedAt: new Date().toISOString(),
            config: cfg,
            coverage: {
                trades: trades.length > 0 ? trades.length : records.reduce((s, r) => s + r.trades.length, 0),
                seriesCandidates: seriesMetas.length,
                events: records.length,
                requiredMinEvents: cfg.minTrainEvents + cfg.minTestEvents,
                reason: "insufficient_btc_5m_events",
            },
            strategyResults: [] as StrategyFeeResult[],
            stableBiases: [] as Array<{ strategy: StrategyId; bias: string; byFee: StrategyFeeResult[] }>,
            verdict,
        };
        if (cfg.outPath) {
            const resolved = path.resolve(cfg.outPath);
            fs.mkdirSync(path.dirname(resolved), { recursive: true });
            fs.writeFileSync(resolved, JSON.stringify(report, null, 2), "utf8");
            console.log(`[poly-behavior] report written: ${resolved}`);
        }
        return;
    }

    const startTs = records[0].meta.startTs - 120;
    const endTs = records[records.length - 1].meta.endTs + 60;
    console.log(`[poly-behavior] fetching Binance range ${new Date(startTs * 1000).toISOString()}..${new Date(endTs * 1000).toISOString()}`);
    const minuteMap = await fetchBinance1mRange(startTs, endTs);
    console.log(`[poly-behavior] binance minute points=${minuteMap.size}`);

    const metrics = records.map((r) => computeEventMetrics(r, minuteMap, cfg.slippage));
    applyClusteringCorrelations(metrics, records);
    const walletSummary = annotateCrossEventWalletBehavior(metrics, records, cfg.slippage);

    const windows = createWindows(records.length, cfg);
    if (windows.length === 0) {
        console.error("[poly-behavior] windows=0");
        process.exitCode = 1;
        return;
    }
    console.log(`[poly-behavior] windows=${windows.length}`);

    const strategies: StrategyId[] = [
        "fade_extreme_probabilities",
        "fade_late_spike_flat_binance",
        "piggyback_positive_wallets",
        "fade_retail_panic",
    ];
    const outcomeByEvent = new Map<string, 0 | 1>();
    const randomPricesByEvent = new Map<string, number[]>();
    for (const rec of records) {
        outcomeByEvent.set(rec.meta.eventId, rec.meta.outcomeUp);
        randomPricesByEvent.set(rec.meta.eventId, rec.randomPrices);
    }

    const allSignals = new Map<StrategyId, TradeSignal[]>();
    const signalsByWindow = new Map<string, TradeSignal[]>();
    for (const s of strategies) allSignals.set(s, []);

    for (const window of windows) {
        const trainRecords = records.slice(window.trainStart, window.trainEnd);
        const testRecords = records.slice(window.testStart, window.testEnd);
        const selectedWallets = buildSelectedWallets(trainRecords, cfg.slippage);
        for (let i = 0; i < testRecords.length; i++) {
            const eventIndex = window.testStart + i;
            const generated = generateSignals(metrics[eventIndex], testRecords[i], eventIndex, selectedWallets);
            for (const sig of generated) {
                allSignals.get(sig.strategy)!.push(sig);
                const key = `${sig.strategy}#${window.id}`;
                const arr = signalsByWindow.get(key) ?? [];
                arr.push(sig);
                signalsByWindow.set(key, arr);
            }
        }
    }

    const strategyRows: StrategyFeeResult[] = [];
    for (const strategy of strategies) {
        const strategySignals = allSignals.get(strategy) ?? [];
        for (const fee of FEES) {
            const byWindow: Array<{ windowId: number; eval: TradeEval }> = [];
            for (const window of windows) {
                const signals = signalsByWindow.get(`${strategy}#${window.id}`) ?? [];
                const pnls = signals.map((s) => pnlForDirection(s.direction, s.entryPriceUp, outcomeByEvent.get(s.eventId) ?? 0, fee, cfg.slippage));
                byWindow.push({ windowId: window.id, eval: evaluatePnls(pnls) });
            }
            const aggregate: TradeEval = {
                trades: Math.round(mean(byWindow.map((x) => x.eval.trades))),
                expectancy: mean(byWindow.map((x) => x.eval.expectancy)),
                sharpe: mean(byWindow.map((x) => x.eval.sharpe)),
                hitRate: mean(byWindow.map((x) => x.eval.hitRate)),
            };
            const positiveWindowRate = mean(byWindow.map((x) => x.eval.expectancy > 0 ? 1 : 0));
            const pValue = permutationPValue(strategySignals, outcomeByEvent, randomPricesByEvent, fee, cfg.slippage, cfg.permutations, 20260216 + strategy.length + Math.floor(fee * 1000));
            strategyRows.push({
                strategy,
                bias: strategy === "fade_extreme_probabilities"
                    ? "overconfidence_bias"
                    : strategy === "fade_late_spike_flat_binance"
                        ? "retail_panic_behavior"
                        : strategy === "piggyback_positive_wallets"
                            ? "repeated_wallet_patterns"
                            : "end_of_event_fomo",
                fee,
                aggregate,
                byWindow,
                positiveWindowRate,
                permutationPValue: pValue,
            });
        }
    }

    const grouped = new Map<StrategyId, StrategyFeeResult[]>();
    for (const row of strategyRows) {
        const arr = grouped.get(row.strategy) ?? [];
        arr.push(row);
        grouped.set(row.strategy, arr);
    }
    for (const arr of grouped.values()) arr.sort((a, b) => a.fee - b.fee);

    const stableBiases = Array.from(grouped.entries())
        .filter(([, rows]) => isStableByFee(rows))
        .map(([strategy, rows]) => ({
            strategy,
            bias: rows[0]?.bias ?? "",
            byFee: rows,
        }));

    const overconfidenceRows = metrics.filter((m) => m.overconfidenceHighExtreme || m.overconfidenceLowExtreme);
    const summary = {
        flowTop1ShareAvg: mean(metrics.map((m) => m.flowTop1Share)),
        flowTop3ShareAvg: mean(metrics.map((m) => m.flowTop3Share)),
        crowdOverpaidRate: mean(metrics.map((m) => m.crowdOverpaid ? 1 : 0)),
        lateBuyersNegativeExpectancyRate: mean(metrics.map((m) => m.lateBuyersNegativeExpectancy ? 1 : 0)),
        dominantWalletEdgeRate: mean(metrics.map((m) => m.dominantWalletTimingHadEdge ? 1 : 0)),
        lossChasingRate: walletSummary.lossChasingRate,
        streakAggressionRate: walletSummary.streakAggressionRate,
        clusteringCorrelationAvg: mean(metrics.map((m) => m.clusteringCorrelationFinal90)),
        directionEntropyAvg: mean(metrics.map((m) => m.directionEntropyFinal90)),
        overconfidenceReversalRate: mean(overconfidenceRows.map((m) => m.overconfidenceReversal ? 1 : 0)),
        impliedExtremeProbAvg: mean(overconfidenceRows.map((m) => m.firstExtremePrice ?? 0.5)),
        realizedUpRateAtExtreme: mean(overconfidenceRows.map((m) => m.outcomeUp)),
        fomoWorsePriceRateAvg: mean(metrics.map((m) => m.fomoWorsePriceRateLast30)),
        fomoSlippageVsFairAvg: mean(metrics.map((m) => m.fomoSlippageVsFairLast30)),
    };

    console.log("\n[poly-behavior] OOS strategy summary:");
    for (const strategy of strategies) {
        const rows = grouped.get(strategy) ?? [];
        for (const row of rows) {
            console.log(
                `${strategy} fee=${(row.fee * 100).toFixed(0)}% ` +
                `exp=${row.aggregate.expectancy.toFixed(6)} ` +
                `sharpe=${row.aggregate.sharpe.toFixed(3)} ` +
                `hit=${(row.aggregate.hitRate * 100).toFixed(2)}% ` +
                `trades/win~${row.aggregate.trades} ` +
                `win_windows=${(row.positiveWindowRate * 100).toFixed(1)}% ` +
                `perm_p=${row.permutationPValue.toFixed(4)}`
            );
        }
    }

    const verdict = stableBiases.length > 0
        ? `Stable trader-behavior exploitation biases detected: ${stableBiases.map((x) => x.bias).join(", ")}`
        : "No stable trader-behavior exploitation edge detected.";
    console.log(`\n[poly-behavior] Verdict: ${verdict}`);

    const report = {
        generatedAt: new Date().toISOString(),
        config: cfg,
        coverage: {
            trades: trades.length > 0 ? trades.length : records.reduce((s, r) => s + r.trades.length, 0),
            seriesCandidates: seriesMetas.length,
            events: records.length,
            rangeStart: new Date(records[0].meta.startTs * 1000).toISOString(),
            rangeEnd: new Date(records[records.length - 1].meta.endTs * 1000).toISOString(),
            windows,
        },
        behavioralMetrics: summary,
        walletBehavior: walletSummary,
        strategyResults: strategyRows,
        stableBiases,
        verdict,
    };

    if (cfg.outPath) {
        const resolved = path.resolve(cfg.outPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(report, null, 2), "utf8");
        console.log(`[poly-behavior] report written: ${resolved}`);
    }
}

main().catch((error) => {
    console.error("[poly-behavior] fatal:", error);
    process.exitCode = 1;
});
