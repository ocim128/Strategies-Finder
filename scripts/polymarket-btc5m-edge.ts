import fs from "node:fs";
import path from "node:path";
import {
    defaultStartDateIso,
    fetchJsonWithRetry,
    parseIsoSec,
    parseNumber,
    parseStringArray,
    runPool,
} from "./lib/polymarket-research";

type CliConfig = {
    seriesId: string;
    startDateMin: string;
    endDateMax?: string;
    maxEvents: number;
    pageSize: number;
    concurrency: number;
    fee: number;
    trainRatio: number;
    minTrainTrades: number;
    minTestTrades: number;
    entryMinutes: number[];
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

type Sample = {
    slug: string;
    endTs: number;
    entryMinute: number;
    entryPrice: number;
    settleUp: number;
    d1: number;
    d2: number;
    d3: number;
    d4: number;
    pnlUp: number;
    pnlDown: number;
};

type RuleFamily =
    | "always_up"
    | "always_down"
    | "mom_d1"
    | "mom_d3"
    | "rev_d1"
    | "rev_d3"
    | "cont"
    | "cont_rev"
    | "level_mom"
    | "level_rev"
    | "lin_mom"
    | "lin_rev";

type Rule = {
    id: string;
    family: RuleFamily;
    entryMinute: number;
    threshold: number;
    w1?: number;
    w2?: number;
};

type Metrics = {
    trades: number;
    wins: number;
    winRate: number;
    totalPnl: number;
    avgPnl: number;
    sharpe: number;
    maxDrawdown: number;
};

type RuleResult = {
    rule: Rule;
    train: Metrics;
    test: Metrics;
    robustScore: number;
};

const DEFAULT_SERIES_ID = "10684";
const DEFAULT_ENTRY_MINUTES = [1, 2, 3, 4];

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run poly:edge -- [options]",
        "",
        "Options:",
        "  --series-id <id>            Polymarket series id (default: 10684, BTC up/down 5m)",
        "  --start-date <iso>          Inclusive lower bound, e.g. 2026-02-01T00:00:00Z",
        "  --end-date <iso>            Inclusive upper bound for event end date",
        "  --max-events <n>            Max closed events to evaluate (default: 1200)",
        "  --page-size <n>             Pagination size (default: 500)",
        "  --concurrency <n>           History fetch workers (default: 10)",
        "  --fee <points>              Entry friction in probability points (default: 0.003)",
        "  --train-ratio <0-1>         Chronological train split (default: 0.7)",
        "  --min-train-trades <n>      Min train trades per rule (default: 80)",
        "  --min-test-trades <n>       Min test trades per rule (default: 40)",
        "  --entry-minutes <list>      Comma-separated, default: 1,2,3,4",
        "  --out <file>                Optional JSON output path",
        "",
        "Example:",
        "  npm run poly:edge -- --start-date 2026-02-01T00:00:00Z --max-events 1500 --fee 0.004",
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
    let maxEvents = 1200;
    let pageSize = 500;
    let concurrency = 10;
    let fee = 0.003;
    let trainRatio = 0.7;
    let minTrainTrades = 80;
    let minTestTrades = 40;
    let outPath: string | undefined;
    let entryMinutes = [...DEFAULT_ENTRY_MINUTES];
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
            maxEvents = Math.max(1, Math.floor(parseNumber(next, maxEvents)));
            i++;
            continue;
        }
        if (arg === "--page-size") {
            pageSize = Math.max(1, Math.floor(parseNumber(next, pageSize)));
            i++;
            continue;
        }
        if (arg === "--concurrency") {
            concurrency = Math.max(1, Math.floor(parseNumber(next, concurrency)));
            i++;
            continue;
        }
        if (arg === "--fee") {
            fee = Math.max(0, parseNumber(next, fee));
            i++;
            continue;
        }
        if (arg === "--train-ratio") {
            trainRatio = Math.min(0.95, Math.max(0.5, parseNumber(next, trainRatio)));
            i++;
            continue;
        }
        if (arg === "--min-train-trades") {
            minTrainTrades = Math.max(1, Math.floor(parseNumber(next, minTrainTrades)));
            i++;
            continue;
        }
        if (arg === "--min-test-trades") {
            minTestTrades = Math.max(1, Math.floor(parseNumber(next, minTestTrades)));
            i++;
            continue;
        }
        if (arg === "--entry-minutes") {
            const parsed = String(next ?? "")
                .split(",")
                .map((v) => Number(v.trim()))
                .filter((v) => Number.isFinite(v) && v >= 1 && v <= 10)
                .map((v) => Math.floor(v));
            if (parsed.length > 0) entryMinutes = Array.from(new Set(parsed)).sort((a, b) => a - b);
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

    // Windows npm can strip unknown flags and leave only values. Support positional fallback.
    if (positional.length > 0) {
        if (positional[0]) startDateMin = positional[0];
        if (positional[1]) maxEvents = Math.max(1, Math.floor(parseNumber(positional[1], maxEvents)));
        if (positional[2]) concurrency = Math.max(1, Math.floor(parseNumber(positional[2], concurrency)));
        if (positional[3]) minTrainTrades = Math.max(1, Math.floor(parseNumber(positional[3], minTrainTrades)));
        if (positional[4]) minTestTrades = Math.max(1, Math.floor(parseNumber(positional[4], minTestTrades)));
        if (positional[5]) outPath = positional[5];
    }

    return {
        seriesId,
        startDateMin,
        endDateMax,
        maxEvents,
        pageSize,
        concurrency,
        fee,
        trainRatio,
        minTrainTrades,
        minTestTrades,
        entryMinutes,
        outPath,
    };
}

function chooseUpIndex(outcomes: string[]): number {
    const norm = outcomes.map((v) => v.trim().toLowerCase());
    const directUp = norm.findIndex((v) => v === "up" || v === "yes" || v.includes("up"));
    if (directUp >= 0) return directUp;
    const yesLike = norm.findIndex((v) => v === "yes");
    if (yesLike >= 0) return yesLike;
    return 0;
}

function normalizeEvent(raw: RawEvent): SeriesEvent | null {
    const slug = typeof raw.slug === "string" ? raw.slug.trim() : "";
    if (!slug) return null;

    const endTs = parseIsoSec(raw.endDate);
    if (!endTs || endTs <= 0) return null;

    const markets = Array.isArray(raw.markets) ? raw.markets as RawMarket[] : [];
    if (markets.length === 0) return null;
    const market = markets[0];

    const outcomes = parseStringArray(market.outcomes);
    const clobTokenIds = parseStringArray(market.clobTokenIds);
    const outcomePrices = parseStringArray(market.outcomePrices);
    if (clobTokenIds.length === 0 || outcomePrices.length === 0) return null;

    const upIdx = chooseUpIndex(outcomes);
    const upTokenId = clobTokenIds[upIdx] ?? clobTokenIds[0];
    const settleUpRaw = Number(outcomePrices[upIdx] ?? outcomePrices[0]);
    if (!Number.isFinite(settleUpRaw)) return null;

    // Closed markets should settle hard to 0/1; tolerate tiny float noise.
    const settleUp = settleUpRaw >= 0.5 ? 1 : 0;
    if (!upTokenId) return null;

    return { slug, endTs, upTokenId, settleUp };
}

async function fetchSeriesEvents(cfg: CliConfig): Promise<SeriesEvent[]> {
    const out: SeriesEvent[] = [];
    let offset = 0;

    while (out.length < cfg.maxEvents) {
        const params = new URLSearchParams({
            series_id: cfg.seriesId,
            closed: "true",
            limit: String(cfg.pageSize),
            offset: String(offset),
            start_date_min: cfg.startDateMin,
        });
        if (cfg.endDateMax) params.set("end_date_max", cfg.endDateMax);

        const url = `https://gamma-api.polymarket.com/events?${params.toString()}`;
        const payload = await fetchJsonWithRetry<unknown>(url);
        if (!Array.isArray(payload) || payload.length === 0) break;

        for (const row of payload as RawEvent[]) {
            const normalized = normalizeEvent(row);
            if (normalized) out.push(normalized);
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

function normalizeHistoryPoints(payload: unknown): HistoryPoint[] {
    const response = payload as { history?: Array<{ t?: unknown; p?: unknown }> };
    const rows = Array.isArray(response?.history) ? response.history : [];
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

async function fetchMarketHistoryNearClose(tokenId: string, endTs: number): Promise<HistoryPoint[]> {
    const windowStart = Math.max(0, endTs - (25 * 60));
    const params = new URLSearchParams({
        market: tokenId,
        startTs: String(windowStart),
        endTs: String(endTs + 10),
    });
    const nearUrl = `https://clob.polymarket.com/prices-history?${params.toString()}`;
    const nearPayload = await fetchJsonWithRetry<unknown>(nearUrl, 3);
    const nearPoints = normalizeHistoryPoints(nearPayload);
    if (nearPoints.length > 0) return nearPoints;

    const fallbackParams = new URLSearchParams({
        market: tokenId,
        interval: "max",
    });
    const fullUrl = `https://clob.polymarket.com/prices-history?${fallbackParams.toString()}`;
    const fullPayload = await fetchJsonWithRetry<unknown>(fullUrl, 3);
    return normalizeHistoryPoints(fullPayload);
}

function priceAt(points: HistoryPoint[], ts: number): number | undefined {
    if (points.length === 0) return undefined;
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

function buildSamplesForEvent(event: SeriesEvent, points: HistoryPoint[], entryMinutes: number[], fee: number): Sample[] {
    const out: Sample[] = [];
    if (points.length === 0) return out;

    for (const entryMinute of entryMinutes) {
        const entryTs = event.endTs - entryMinute * 60;
        const p0Raw = priceAt(points, entryTs);
        const p1Raw = priceAt(points, entryTs - 60);
        const p2Raw = priceAt(points, entryTs - 120);
        const p3Raw = priceAt(points, entryTs - 180);
        if (p0Raw === undefined || p1Raw === undefined || p2Raw === undefined || p3Raw === undefined) continue;

        const p0 = Math.min(1, Math.max(0, p0Raw));
        const p1 = Math.min(1, Math.max(0, p1Raw));
        const p2 = Math.min(1, Math.max(0, p2Raw));
        const p3 = Math.min(1, Math.max(0, p3Raw));

        const d1 = p0 - p1;
        const d2 = p1 - p2;
        const d3 = p0 - p2;
        const d4 = p2 - p3;
        const pnlUp = event.settleUp - p0 - fee;
        const pnlDown = p0 - event.settleUp - fee;

        out.push({
            slug: event.slug,
            endTs: event.endTs,
            entryMinute,
            entryPrice: p0,
            settleUp: event.settleUp,
            d1,
            d2,
            d3,
            d4,
            pnlUp,
            pnlDown,
        });
    }

    return out;
}

function generateRules(entryMinutes: number[]): Rule[] {
    const deltaThresholds = [0, 0.0025, 0.005, 0.0075, 0.01, 0.015, 0.02, 0.03, 0.04, 0.05];
    const levelThresholds = [0, 0.01, 0.02, 0.03, 0.05, 0.08, 0.1, 0.15, 0.2];
    const linearWeights: Array<{ w1: number; w2: number }> = [
        { w1: 1, w2: 1 },
        { w1: 2, w2: 1 },
        { w1: 1, w2: 2 },
        { w1: 1, w2: -1 },
        { w1: 2, w2: -1 },
    ];

    const rules: Rule[] = [];
    for (const entryMinute of entryMinutes) {
        rules.push({
            id: `always_up@${entryMinute}m`,
            family: "always_up",
            entryMinute,
            threshold: 0,
        });
        rules.push({
            id: `always_down@${entryMinute}m`,
            family: "always_down",
            entryMinute,
            threshold: 0,
        });

        for (const thr of deltaThresholds) {
            rules.push({ id: `mom_d1@${entryMinute}m:thr=${thr}`, family: "mom_d1", entryMinute, threshold: thr });
            rules.push({ id: `mom_d3@${entryMinute}m:thr=${thr}`, family: "mom_d3", entryMinute, threshold: thr });
            rules.push({ id: `rev_d1@${entryMinute}m:thr=${thr}`, family: "rev_d1", entryMinute, threshold: thr });
            rules.push({ id: `rev_d3@${entryMinute}m:thr=${thr}`, family: "rev_d3", entryMinute, threshold: thr });
            rules.push({ id: `cont@${entryMinute}m:thr=${thr}`, family: "cont", entryMinute, threshold: thr });
            rules.push({ id: `cont_rev@${entryMinute}m:thr=${thr}`, family: "cont_rev", entryMinute, threshold: thr });

            for (const w of linearWeights) {
                rules.push({
                    id: `lin_mom@${entryMinute}m:w=${w.w1},${w.w2}:thr=${thr}`,
                    family: "lin_mom",
                    entryMinute,
                    threshold: thr,
                    w1: w.w1,
                    w2: w.w2,
                });
                rules.push({
                    id: `lin_rev@${entryMinute}m:w=${w.w1},${w.w2}:thr=${thr}`,
                    family: "lin_rev",
                    entryMinute,
                    threshold: thr,
                    w1: w.w1,
                    w2: w.w2,
                });
            }
        }

        for (const thr of levelThresholds) {
            rules.push({ id: `level_mom@${entryMinute}m:thr=${thr}`, family: "level_mom", entryMinute, threshold: thr });
            rules.push({ id: `level_rev@${entryMinute}m:thr=${thr}`, family: "level_rev", entryMinute, threshold: thr });
        }
    }
    return rules;
}

function signThreshold(value: number, threshold: number): number {
    if (value > threshold) return 1;
    if (value < -threshold) return -1;
    return 0;
}

function signalForRule(sample: Sample, rule: Rule): number {
    if (sample.entryMinute !== rule.entryMinute) return 0;
    switch (rule.family) {
        case "always_up":
            return 1;
        case "always_down":
            return -1;
        case "mom_d1":
            return signThreshold(sample.d1, rule.threshold);
        case "mom_d3":
            return signThreshold(sample.d3, rule.threshold);
        case "rev_d1":
            return -signThreshold(sample.d1, rule.threshold);
        case "rev_d3":
            return -signThreshold(sample.d3, rule.threshold);
        case "cont": {
            const s1 = Math.sign(sample.d1);
            const s2 = Math.sign(sample.d2);
            if (s1 !== 0 && s1 === s2 && Math.abs(sample.d1) >= rule.threshold && Math.abs(sample.d2) >= rule.threshold) {
                return s1;
            }
            return 0;
        }
        case "cont_rev": {
            const s1 = Math.sign(sample.d1);
            const s2 = Math.sign(sample.d2);
            if (s1 !== 0 && s1 === s2 && Math.abs(sample.d1) >= rule.threshold && Math.abs(sample.d2) >= rule.threshold) {
                return -s1;
            }
            return 0;
        }
        case "level_mom":
            return signThreshold(sample.entryPrice - 0.5, rule.threshold);
        case "level_rev":
            return -signThreshold(sample.entryPrice - 0.5, rule.threshold);
        case "lin_mom": {
            const score = (rule.w1 ?? 1) * sample.d1 + (rule.w2 ?? 1) * sample.d2;
            return signThreshold(score, rule.threshold);
        }
        case "lin_rev": {
            const score = (rule.w1 ?? 1) * sample.d1 + (rule.w2 ?? 1) * sample.d2;
            return -signThreshold(score, rule.threshold);
        }
        default:
            return 0;
    }
}

function evaluateMetrics(samples: Sample[], rule: Rule): Metrics {
    let trades = 0;
    let wins = 0;
    let totalPnl = 0;
    let sumSq = 0;
    let equity = 0;
    let peak = 0;
    let maxDrawdown = 0;

    for (const sample of samples) {
        const signal = signalForRule(sample, rule);
        if (signal === 0) continue;

        const pnl = signal > 0 ? sample.pnlUp : sample.pnlDown;
        trades += 1;
        if (pnl > 0) wins += 1;
        totalPnl += pnl;
        sumSq += pnl * pnl;

        equity += pnl;
        if (equity > peak) peak = equity;
        const dd = peak - equity;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }

    if (trades === 0) {
        return {
            trades: 0,
            wins: 0,
            winRate: 0,
            totalPnl: 0,
            avgPnl: 0,
            sharpe: 0,
            maxDrawdown: 0,
        };
    }

    const avgPnl = totalPnl / trades;
    const variance = trades > 1 ? Math.max(0, (sumSq - trades * avgPnl * avgPnl) / (trades - 1)) : 0;
    const stdDev = Math.sqrt(variance);
    const sharpe = stdDev > 0 ? (avgPnl / stdDev) * Math.sqrt(trades) : 0;

    return {
        trades,
        wins,
        winRate: wins / trades,
        totalPnl,
        avgPnl,
        sharpe,
        maxDrawdown,
    };
}

function formatNum(n: number, digits = 4): string {
    return Number.isFinite(n) ? n.toFixed(digits) : "NaN";
}

async function main(): Promise<void> {
    const cfg = parseArgs(process.argv.slice(2));
    if (!cfg) return;

    console.log("[poly-edge] Fetching closed series events...");
    console.log(`[poly-edge] series_id=${cfg.seriesId}, start_date_min=${cfg.startDateMin}, max_events=${cfg.maxEvents}`);
    const events = await fetchSeriesEvents(cfg);
    console.log(`[poly-edge] Retrieved ${events.length} unique events`);
    if (events.length === 0) {
        console.error("[poly-edge] No events found. Try adjusting --start-date or --series-id.");
        process.exitCode = 1;
        return;
    }

    let processed = 0;
    let withHistory = 0;
    let sampleCount = 0;
    const sampleBuckets: Sample[][] = [];

    await runPool(events, cfg.concurrency, async (event) => {
        try {
            const points = await fetchMarketHistoryNearClose(event.upTokenId, event.endTs);
            if (points.length > 0) {
                const samples = buildSamplesForEvent(event, points, cfg.entryMinutes, cfg.fee);
                if (samples.length > 0) {
                    sampleBuckets.push(samples);
                    withHistory += 1;
                    sampleCount += samples.length;
                }
            }
        } catch {
            // Ignore fetch failures; this is a broad brute-force scan.
        } finally {
            processed += 1;
            if (processed % 100 === 0 || processed === events.length) {
                console.log(`[poly-edge] progress ${processed}/${events.length} events, usable=${withHistory}, samples=${sampleCount}`);
            }
        }
    });

    const samples = sampleBuckets.flat().sort((a, b) => a.endTs - b.endTs);
    if (samples.length === 0) {
        console.error("[poly-edge] No usable samples. Try widening date range or lowering friction assumptions.");
        process.exitCode = 1;
        return;
    }

    const samplesByEntry = new Map<number, Sample[]>();
    for (const entryMinute of cfg.entryMinutes) {
        samplesByEntry.set(entryMinute, samples.filter((s) => s.entryMinute === entryMinute));
    }

    for (const entryMinute of cfg.entryMinutes) {
        const subset = samplesByEntry.get(entryMinute) ?? [];
        const split = Math.floor(subset.length * cfg.trainRatio);
        const train = subset.slice(0, split);
        const test = subset.slice(split);
        console.log(`[poly-edge] entry=${entryMinute}m samples=${subset.length} train=${train.length} test=${test.length}`);
    }

    const rules = generateRules(cfg.entryMinutes);
    console.log(`[poly-edge] Evaluating ${rules.length} rule candidates`);

    const results: RuleResult[] = [];
    for (const rule of rules) {
        const subset = samplesByEntry.get(rule.entryMinute) ?? [];
        if (subset.length < 2) continue;
        const split = Math.floor(subset.length * cfg.trainRatio);
        const trainSet = subset.slice(0, split);
        const testSet = subset.slice(split);

        const train = evaluateMetrics(trainSet, rule);
        const test = evaluateMetrics(testSet, rule);
        if (train.trades < cfg.minTrainTrades || test.trades < cfg.minTestTrades) continue;

        const robustScore = Math.min(train.avgPnl, test.avgPnl) * Math.sqrt(test.trades) - (0.05 * test.maxDrawdown);
        results.push({ rule, train, test, robustScore });
    }

    if (results.length === 0) {
        console.error("[poly-edge] No rules met minimum trade filters.");
        process.exitCode = 1;
        return;
    }

    const byRobust = [...results].sort((a, b) => b.robustScore - a.robustScore);
    const byTrain = [...results].sort((a, b) => b.train.totalPnl - a.train.totalPnl);
    const topTrainThenTest = byTrain.slice(0, 20).sort((a, b) => b.test.totalPnl - a.test.totalPnl);

    console.log("\nTop robust rules (train+test):");
    for (const [idx, row] of byRobust.slice(0, 12).entries()) {
        console.log([
            `${idx + 1}. ${row.rule.id}`,
            `score=${formatNum(row.robustScore, 5)}`,
            `train[t=${row.train.trades},wr=${formatNum(row.train.winRate * 100, 2)}%,avg=${formatNum(row.train.avgPnl, 5)},tot=${formatNum(row.train.totalPnl, 3)}]`,
            `test[t=${row.test.trades},wr=${formatNum(row.test.winRate * 100, 2)}%,avg=${formatNum(row.test.avgPnl, 5)},tot=${formatNum(row.test.totalPnl, 3)}]`,
        ].join(" | "));
    }

    console.log("\nTop train-selected rules, sorted by test total PnL:");
    for (const [idx, row] of topTrainThenTest.slice(0, 10).entries()) {
        console.log([
            `${idx + 1}. ${row.rule.id}`,
            `trainTot=${formatNum(row.train.totalPnl, 3)}`,
            `testTot=${formatNum(row.test.totalPnl, 3)}`,
            `testAvg=${formatNum(row.test.avgPnl, 5)}`,
            `testSharpe=${formatNum(row.test.sharpe, 3)}`,
        ].join(" | "));
    }

    const summary = {
        generatedAt: new Date().toISOString(),
        config: cfg,
        counts: {
            eventsFetched: events.length,
            eventsWithSamples: withHistory,
            totalSamples: samples.length,
            rulesEvaluated: rules.length,
            rulesPassingTradeFilters: results.length,
        },
        topRobust: byRobust.slice(0, 25),
        topTrainThenTest: topTrainThenTest.slice(0, 25),
    };

    if (cfg.outPath) {
        const resolved = path.resolve(cfg.outPath);
        fs.mkdirSync(path.dirname(resolved), { recursive: true });
        fs.writeFileSync(resolved, JSON.stringify(summary, null, 2), "utf8");
        console.log(`\n[poly-edge] Wrote JSON report: ${resolved}`);
    }
}

main().catch((error) => {
    console.error("[poly-edge] Fatal error:", error);
    process.exitCode = 1;
});
