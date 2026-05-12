import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toBoolean } from "./lib/cli-args";

type SignalSide = "buy" | "sell";

type SignalRecord = {
    id: string;
    symbol: string;
    interval: string;
    strategyKey: string;
    side: SignalSide;
    action: string;
    barTime: number | null;
    detectedAtIso: string | null;
};

type ParsedSignalFeed = {
    generatedAtIso: string | null;
    cycleAtIso: string | null;
    pollSeconds: number;
    watchlistCount: number;
    signals: SignalRecord[];
};

type PaperPosition = {
    symbol: string;
    strategyKey: string;
    interval: string;
    entrySignalId: string;
    entryTimeIso: string;
    entryPrice: number;
    quantity: number;
    notionalUsd: number;
    entryFeeUsd: number;
    markPrice: number;
    floatingPnlUsd: number;
    lastSignalSeenIso: string;
};

type PaperClosedTrade = {
    id: string;
    symbol: string;
    strategyKey: string;
    interval: string;
    entryTimeIso: string;
    exitTimeIso: string;
    holdMinutes: number;
    entryPrice: number;
    exitPrice: number;
    quantity: number;
    notionalUsd: number;
    proceedsUsd: number;
    entryFeeUsd: number;
    exitFeeUsd: number;
    grossPnlUsd: number;
    netPnlUsd: number;
    exitReason: "sell_signal" | "signal_disappeared" | "manual";
};

type PaperPortfolio = {
    generatedAt: string;
    cycleAt: string;
    pollSeconds: number;
    settings: {
        initialBalanceUsd: number;
        notionalPerTradeUsd: number;
        minNotionalUsd: number;
        feeRate: number;
        closeOnSignalDisappear: boolean;
        defaultInterval: string;
        maxClosedTrades: number;
    };
    account: {
        initialBalanceUsd: number;
        cashBalanceUsd: number;
        realizedPnlUsd: number;
        realizedBalanceUsd: number;
        floatingPnlUsd: number;
        totalEquityUsd: number;
        todayPnlUsd: number;
        totalReturnPercent: number;
    };
    stats: {
        totalTrades: number;
        wins: number;
        losses: number;
        winRatePercent: number;
    };
    session: {
        currentDay: string;
        dayStartEquityUsd: number;
    };
    signalState: {
        sourceStatus: "ok" | "missing" | "error";
        lastSignalCycleAt: string | null;
        lastSignalGeneratedAt: string | null;
        watchlistCount: number;
        activeSignalCount: number;
    };
    openPositions: PaperPosition[];
    closedTrades: PaperClosedTrade[];
};

type TraderOptions = {
    signalPath: string;
    outPath: string;
    pollSeconds: number;
    initialBalanceUsd: number;
    notionalPerTradeUsd: number;
    minNotionalUsd: number;
    feeRate: number;
    closeOnSignalDisappear: boolean;
    defaultInterval: string;
    maxClosedTrades: number;
    once: boolean;
};

const DEFAULTS: TraderOptions = {
    signalPath: path.resolve("active_signals.json"),
    outPath: path.resolve("paper_portfolio.json"),
    pollSeconds: 5,
    initialBalanceUsd: 10_000,
    notionalPerTradeUsd: 1_000,
    minNotionalUsd: 50,
    feeRate: 0.001,
    closeOnSignalDisappear: true,
    defaultInterval: "15m",
    maxClosedTrades: 500,
    once: false,
};

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, Math.max(0, ms)));
}

function toNumberOr(value: unknown, fallback = 0): number {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
}

function printUsage(): void {
    console.log([
        "Usage:",
        "  npm run paper:trade",
        "",
        "Options:",
        "  --signals <path>              active signals json path (default: active_signals.json)",
        "  --out <path>                  output ledger path (default: paper_portfolio.json)",
        "  --poll-seconds <n>            poll cadence seconds (default: 5)",
        "  --initial-balance <usd>       account start balance (default: 10000)",
        "  --notional <usd>              per-trade notional (default: 1000)",
        "  --min-notional <usd>          minimum notional to open (default: 50)",
        "  --fee-rate <ratio>            fee ratio per side (default: 0.001 = 0.1%)",
        "  --close-on-disappear <bool>   close when BUY signal disappears (default: true)",
        "  --default-interval <value>    fallback interval (default: 15m)",
        "  --max-closed <n>              closed trades to keep (default: 500)",
        "  --once                        run one cycle and exit",
    ].join("\n"));
}

function parseArgs(argv: string[]): TraderOptions & { help?: boolean } {
    const options: TraderOptions = { ...DEFAULTS };
    const positional: string[] = [];

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const next = argv[i + 1];
        if (arg === "--help" || arg === "-h") return { ...options, help: true };
        if (arg === "--signals") { options.signalPath = path.resolve(String(next ?? options.signalPath)); i++; continue; }
        if (arg === "--out") { options.outPath = path.resolve(String(next ?? options.outPath)); i++; continue; }
        if (arg === "--poll-seconds") { options.pollSeconds = Math.max(2, Math.floor(toNumberOr(next, options.pollSeconds))); i++; continue; }
        if (arg === "--initial-balance") { options.initialBalanceUsd = Math.max(100, toNumberOr(next, options.initialBalanceUsd)); i++; continue; }
        if (arg === "--notional") { options.notionalPerTradeUsd = Math.max(1, toNumberOr(next, options.notionalPerTradeUsd)); i++; continue; }
        if (arg === "--min-notional") { options.minNotionalUsd = Math.max(1, toNumberOr(next, options.minNotionalUsd)); i++; continue; }
        if (arg === "--fee-rate") { options.feeRate = Math.max(0, toNumberOr(next, options.feeRate)); i++; continue; }
        if (arg === "--close-on-disappear") { options.closeOnSignalDisappear = toBoolean(next, options.closeOnSignalDisappear); i++; continue; }
        if (arg === "--default-interval") { options.defaultInterval = String(next ?? options.defaultInterval).trim() || options.defaultInterval; i++; continue; }
        if (arg === "--max-closed") { options.maxClosedTrades = Math.max(10, Math.floor(toNumberOr(next, options.maxClosedTrades))); i++; continue; }
        if (arg === "--once") { options.once = true; continue; }
        positional.push(arg);
    }

    if (positional[0]) options.signalPath = path.resolve(positional[0]);
    if (positional[1]) options.outPath = path.resolve(positional[1]);
    if (positional[2]) options.pollSeconds = Math.max(2, Math.floor(toNumberOr(positional[2], options.pollSeconds)));

    return options;
}

function createEmptyPortfolio(options: TraderOptions): PaperPortfolio {
    const now = new Date().toISOString();
    const day = now.slice(0, 10);
    return {
        generatedAt: now,
        cycleAt: now,
        pollSeconds: options.pollSeconds,
        settings: {
            initialBalanceUsd: options.initialBalanceUsd,
            notionalPerTradeUsd: options.notionalPerTradeUsd,
            minNotionalUsd: options.minNotionalUsd,
            feeRate: options.feeRate,
            closeOnSignalDisappear: options.closeOnSignalDisappear,
            defaultInterval: options.defaultInterval,
            maxClosedTrades: options.maxClosedTrades,
        },
        account: {
            initialBalanceUsd: options.initialBalanceUsd,
            cashBalanceUsd: options.initialBalanceUsd,
            realizedPnlUsd: 0,
            realizedBalanceUsd: options.initialBalanceUsd,
            floatingPnlUsd: 0,
            totalEquityUsd: options.initialBalanceUsd,
            todayPnlUsd: 0,
            totalReturnPercent: 0,
        },
        stats: {
            totalTrades: 0,
            wins: 0,
            losses: 0,
            winRatePercent: 0,
        },
        session: {
            currentDay: day,
            dayStartEquityUsd: options.initialBalanceUsd,
        },
        signalState: {
            sourceStatus: "missing",
            lastSignalCycleAt: null,
            lastSignalGeneratedAt: null,
            watchlistCount: 0,
            activeSignalCount: 0,
        },
        openPositions: [],
        closedTrades: [],
    };
}

function loadOrInitPortfolio(options: TraderOptions): PaperPortfolio {
    if (!fs.existsSync(options.outPath)) return createEmptyPortfolio(options);

    try {
        const raw = JSON.parse(fs.readFileSync(options.outPath, "utf8")) as Record<string, unknown>;
        if (!raw || typeof raw !== "object") return createEmptyPortfolio(options);
        const baseline = createEmptyPortfolio(options);

        const account = (raw.account && typeof raw.account === "object")
            ? raw.account as Record<string, unknown>
            : {};
        const stats = (raw.stats && typeof raw.stats === "object")
            ? raw.stats as Record<string, unknown>
            : {};
        const session = (raw.session && typeof raw.session === "object")
            ? raw.session as Record<string, unknown>
            : {};
        const signalState = (raw.signalState && typeof raw.signalState === "object")
            ? raw.signalState as Record<string, unknown>
            : {};

        baseline.account.initialBalanceUsd = Math.max(100, toNumberOr(account.initialBalanceUsd, options.initialBalanceUsd));
        baseline.account.cashBalanceUsd = toNumberOr(account.cashBalanceUsd, baseline.account.initialBalanceUsd);
        baseline.account.realizedPnlUsd = toNumberOr(account.realizedPnlUsd, 0);
        baseline.account.realizedBalanceUsd = toNumberOr(account.realizedBalanceUsd, baseline.account.initialBalanceUsd + baseline.account.realizedPnlUsd);
        baseline.account.floatingPnlUsd = toNumberOr(account.floatingPnlUsd, 0);
        baseline.account.totalEquityUsd = toNumberOr(account.totalEquityUsd, baseline.account.cashBalanceUsd);
        baseline.account.todayPnlUsd = toNumberOr(account.todayPnlUsd, 0);
        baseline.account.totalReturnPercent = toNumberOr(account.totalReturnPercent, 0);

        baseline.stats.totalTrades = Math.max(0, Math.floor(toNumberOr(stats.totalTrades, 0)));
        baseline.stats.wins = Math.max(0, Math.floor(toNumberOr(stats.wins, 0)));
        baseline.stats.losses = Math.max(0, Math.floor(toNumberOr(stats.losses, 0)));
        baseline.stats.winRatePercent = toNumberOr(stats.winRatePercent, 0);

        const sessionDay = typeof session.currentDay === "string" ? session.currentDay : baseline.session.currentDay;
        baseline.session.currentDay = sessionDay;
        baseline.session.dayStartEquityUsd = toNumberOr(session.dayStartEquityUsd, baseline.account.totalEquityUsd);

        baseline.signalState.sourceStatus = signalState.sourceStatus === "ok" || signalState.sourceStatus === "error" ? signalState.sourceStatus : "missing";
        baseline.signalState.lastSignalCycleAt = typeof signalState.lastSignalCycleAt === "string" ? signalState.lastSignalCycleAt : null;
        baseline.signalState.lastSignalGeneratedAt = typeof signalState.lastSignalGeneratedAt === "string" ? signalState.lastSignalGeneratedAt : null;
        baseline.signalState.watchlistCount = Math.max(0, Math.floor(toNumberOr(signalState.watchlistCount, 0)));
        baseline.signalState.activeSignalCount = Math.max(0, Math.floor(toNumberOr(signalState.activeSignalCount, 0)));

        baseline.openPositions = parseOpenPositions(raw.openPositions);
        baseline.closedTrades = parseClosedTrades(raw.closedTrades).slice(0, options.maxClosedTrades);
        return baseline;
    } catch {
        return createEmptyPortfolio(options);
    }
}

function parseOpenPositions(value: unknown): PaperPosition[] {
    if (!Array.isArray(value)) return [];
    const out: PaperPosition[] = [];
    for (const row of value) {
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        const symbol = String(rec.symbol ?? "").trim().toUpperCase();
        const strategyKey = String(rec.strategyKey ?? "").trim();
        if (!symbol || !strategyKey) continue;
        const entryPrice = toNumberOr(rec.entryPrice, NaN);
        const quantity = toNumberOr(rec.quantity, NaN);
        const notionalUsd = toNumberOr(rec.notionalUsd, NaN);
        const entryFeeUsd = toNumberOr(rec.entryFeeUsd, NaN);
        const markPrice = toNumberOr(rec.markPrice, entryPrice);
        const floatingPnlUsd = toNumberOr(rec.floatingPnlUsd, 0);
        if (!Number.isFinite(entryPrice) || !Number.isFinite(quantity) || !Number.isFinite(notionalUsd) || !Number.isFinite(entryFeeUsd)) continue;
        out.push({
            symbol,
            strategyKey,
            interval: String(rec.interval ?? "15m").trim() || "15m",
            entrySignalId: String(rec.entrySignalId ?? `${symbol}|${strategyKey}`),
            entryTimeIso: typeof rec.entryTimeIso === "string" ? rec.entryTimeIso : new Date().toISOString(),
            entryPrice,
            quantity,
            notionalUsd,
            entryFeeUsd,
            markPrice,
            floatingPnlUsd,
            lastSignalSeenIso: typeof rec.lastSignalSeenIso === "string" ? rec.lastSignalSeenIso : new Date().toISOString(),
        });
    }
    return out;
}

function parseClosedTrades(value: unknown): PaperClosedTrade[] {
    if (!Array.isArray(value)) return [];
    const out: PaperClosedTrade[] = [];
    for (const row of value) {
        if (!row || typeof row !== "object") continue;
        const rec = row as Record<string, unknown>;
        const symbol = String(rec.symbol ?? "").trim().toUpperCase();
        const strategyKey = String(rec.strategyKey ?? "").trim();
        if (!symbol || !strategyKey) continue;
        out.push({
            id: String(rec.id ?? `${symbol}|${Date.now()}`),
            symbol,
            strategyKey,
            interval: String(rec.interval ?? "15m").trim() || "15m",
            entryTimeIso: typeof rec.entryTimeIso === "string" ? rec.entryTimeIso : new Date().toISOString(),
            exitTimeIso: typeof rec.exitTimeIso === "string" ? rec.exitTimeIso : new Date().toISOString(),
            holdMinutes: toNumberOr(rec.holdMinutes, 0),
            entryPrice: toNumberOr(rec.entryPrice, 0),
            exitPrice: toNumberOr(rec.exitPrice, 0),
            quantity: toNumberOr(rec.quantity, 0),
            notionalUsd: toNumberOr(rec.notionalUsd, 0),
            proceedsUsd: toNumberOr(rec.proceedsUsd, 0),
            entryFeeUsd: toNumberOr(rec.entryFeeUsd, 0),
            exitFeeUsd: toNumberOr(rec.exitFeeUsd, 0),
            grossPnlUsd: toNumberOr(rec.grossPnlUsd, 0),
            netPnlUsd: toNumberOr(rec.netPnlUsd, 0),
            exitReason: rec.exitReason === "signal_disappeared" || rec.exitReason === "manual" ? rec.exitReason : "sell_signal",
        });
    }
    return out;
}

function parseSignalFeed(raw: unknown): ParsedSignalFeed | null {
    if (!raw || typeof raw !== "object") return null;
    const rec = raw as Record<string, unknown>;
    const rows = Array.isArray(rec.activeSignals) ? rec.activeSignals : [];
    const signals: SignalRecord[] = [];
    for (const row of rows) {
        if (!row || typeof row !== "object") continue;
        const signal = row as Record<string, unknown>;
        const symbol = String(signal.symbol ?? "").trim().toUpperCase();
        const strategyKey = String(signal.strategyKey ?? "").trim();
        if (!symbol || !strategyKey) continue;
        const sideText = String(signal.side ?? "").trim().toLowerCase();
        if (sideText !== "buy" && sideText !== "sell") continue;
        signals.push({
            id: String(signal.id ?? `${symbol}|${strategyKey}|${signals.length}`),
            symbol,
            strategyKey,
            interval: String(signal.interval ?? "15m").trim() || "15m",
            side: sideText,
            action: String(signal.action ?? "signal"),
            barTime: Number.isFinite(Number(signal.barTime)) ? Number(signal.barTime) : null,
            detectedAtIso: typeof signal.detectedAt === "string"
                ? signal.detectedAt
                : typeof signal.barTimeIso === "string"
                    ? signal.barTimeIso
                    : null,
        });
    }

    return {
        generatedAtIso: typeof rec.generatedAt === "string" ? rec.generatedAt : null,
        cycleAtIso: typeof rec.cycleAt === "string" ? rec.cycleAt : null,
        pollSeconds: Math.max(1, Math.floor(toNumberOr(rec.pollSeconds, 60))),
        watchlistCount: Array.isArray(rec.watchlist) ? rec.watchlist.length : 0,
        signals,
    };
}

function readSignalFeed(signalPath: string): ParsedSignalFeed | null {
    if (!fs.existsSync(signalPath)) return null;
    const raw = JSON.parse(fs.readFileSync(signalPath, "utf8"));
    return parseSignalFeed(raw);
}

async function fetchCurrentClose(symbol: string, interval: string): Promise<number> {
    const klineParams = new URLSearchParams({
        symbol,
        interval,
        limit: "1",
    });
    const klineUrl = `https://api.binance.com/api/v3/klines?${klineParams.toString()}`;
    const klineResponse = await fetch(klineUrl);
    if (klineResponse.ok) {
        const payload = await klineResponse.json();
        if (Array.isArray(payload) && Array.isArray(payload[0]) && payload[0].length >= 5) {
            const close = Number(payload[0][4]);
            if (Number.isFinite(close) && close > 0) return close;
        }
    }

    const tickerParams = new URLSearchParams({ symbol });
    const tickerUrl = `https://api.binance.com/api/v3/ticker/price?${tickerParams.toString()}`;
    const tickerResponse = await fetch(tickerUrl);
    if (!tickerResponse.ok) {
        throw new Error(`[PaperTrader] Price fetch failed for ${symbol}: HTTP ${tickerResponse.status}`);
    }
    const ticker = await tickerResponse.json() as Record<string, unknown>;
    const price = Number(ticker.price);
    if (!Number.isFinite(price) || price <= 0) {
        throw new Error(`[PaperTrader] Invalid price payload for ${symbol}.`);
    }
    return price;
}

function calculateWinRate(stats: PaperPortfolio["stats"]): number {
    if (stats.totalTrades <= 0) return 0;
    return (stats.wins / stats.totalTrades) * 100;
}

function findOpenPositionIndex(positions: PaperPosition[], symbol: string): number {
    return positions.findIndex((position) => position.symbol === symbol);
}

function openPosition(
    portfolio: PaperPortfolio,
    signal: SignalRecord,
    entryPrice: number,
    nowIso: string
): boolean {
    if (!Number.isFinite(entryPrice) || entryPrice <= 0) return false;
    const affordable = Math.min(portfolio.settings.notionalPerTradeUsd, portfolio.account.cashBalanceUsd);
    if (affordable < portfolio.settings.minNotionalUsd) return false;

    const quantity = affordable / entryPrice;
    if (!Number.isFinite(quantity) || quantity <= 0) return false;

    const entryFeeUsd = affordable * portfolio.settings.feeRate;
    const totalDebit = affordable + entryFeeUsd;
    if (portfolio.account.cashBalanceUsd + 1e-9 < totalDebit) return false;

    portfolio.account.cashBalanceUsd -= totalDebit;
    portfolio.openPositions.push({
        symbol: signal.symbol,
        strategyKey: signal.strategyKey,
        interval: signal.interval || portfolio.settings.defaultInterval,
        entrySignalId: signal.id,
        entryTimeIso: nowIso,
        entryPrice,
        quantity,
        notionalUsd: affordable,
        entryFeeUsd,
        markPrice: entryPrice,
        floatingPnlUsd: -entryFeeUsd,
        lastSignalSeenIso: nowIso,
    });
    return true;
}

function closePosition(
    portfolio: PaperPortfolio,
    index: number,
    exitPrice: number,
    exitReason: PaperClosedTrade["exitReason"],
    nowIso: string
): void {
    const position = portfolio.openPositions[index];
    const proceedsUsd = position.quantity * exitPrice;
    const exitFeeUsd = proceedsUsd * portfolio.settings.feeRate;
    const grossPnlUsd = proceedsUsd - position.notionalUsd;
    const netPnlUsd = grossPnlUsd - position.entryFeeUsd - exitFeeUsd;
    const holdMinutes = Math.max(0, (Date.parse(nowIso) - Date.parse(position.entryTimeIso)) / 60000);

    portfolio.account.cashBalanceUsd += proceedsUsd - exitFeeUsd;
    portfolio.account.realizedPnlUsd += netPnlUsd;
    portfolio.account.realizedBalanceUsd = portfolio.account.initialBalanceUsd + portfolio.account.realizedPnlUsd;

    portfolio.stats.totalTrades += 1;
    if (netPnlUsd >= 0) portfolio.stats.wins += 1;
    else portfolio.stats.losses += 1;
    portfolio.stats.winRatePercent = calculateWinRate(portfolio.stats);

    const closed: PaperClosedTrade = {
        id: `${position.symbol}|${position.strategyKey}|${Date.parse(nowIso)}`,
        symbol: position.symbol,
        strategyKey: position.strategyKey,
        interval: position.interval,
        entryTimeIso: position.entryTimeIso,
        exitTimeIso: nowIso,
        holdMinutes,
        entryPrice: position.entryPrice,
        exitPrice,
        quantity: position.quantity,
        notionalUsd: position.notionalUsd,
        proceedsUsd,
        entryFeeUsd: position.entryFeeUsd,
        exitFeeUsd,
        grossPnlUsd,
        netPnlUsd,
        exitReason,
    };

    portfolio.closedTrades.unshift(closed);
    if (portfolio.closedTrades.length > portfolio.settings.maxClosedTrades) {
        portfolio.closedTrades = portfolio.closedTrades.slice(0, portfolio.settings.maxClosedTrades);
    }

    portfolio.openPositions.splice(index, 1);
}

async function runCycle(
    portfolio: PaperPortfolio,
    options: TraderOptions
): Promise<void> {
    const cycleAt = new Date().toISOString();
    const priceCache = new Map<string, number>();
    let feed: ParsedSignalFeed | null = null;
    let feedStatus: "ok" | "missing" | "error" = "missing";

    try {
        feed = readSignalFeed(options.signalPath);
        feedStatus = feed ? "ok" : "missing";
    } catch (error) {
        feedStatus = "error";
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[PaperTrader] Failed to parse signal feed: ${message}`);
    }

    const feedSignals = feed?.signals ?? [];
    const sortedSignals = feedSignals.slice().sort((a, b) => (b.barTime ?? 0) - (a.barTime ?? 0));
    const buyBySymbol = new Map<string, SignalRecord>();
    const sellBySymbol = new Map<string, SignalRecord>();

    for (const signal of sortedSignals) {
        if (signal.side === "buy") {
            if (!buyBySymbol.has(signal.symbol)) buyBySymbol.set(signal.symbol, signal);
        } else if (signal.side === "sell") {
            if (!sellBySymbol.has(signal.symbol)) sellBySymbol.set(signal.symbol, signal);
        }
    }

    const fetchPrice = async (symbol: string, interval: string): Promise<number> => {
        const cacheKey = `${symbol}|${interval}`;
        const cached = priceCache.get(cacheKey);
        if (cached !== undefined) return cached;
        const price = await fetchCurrentClose(symbol, interval);
        priceCache.set(cacheKey, price);
        return price;
    };

    for (let i = portfolio.openPositions.length - 1; i >= 0; i--) {
        const position = portfolio.openPositions[i];
        const sellSignal = sellBySymbol.get(position.symbol);
        const hasBuySignal = buyBySymbol.has(position.symbol);
        let exitReason: PaperClosedTrade["exitReason"] | null = null;

        if (sellSignal) {
            exitReason = "sell_signal";
        } else if (options.closeOnSignalDisappear && feedStatus === "ok" && !hasBuySignal) {
            exitReason = "signal_disappeared";
        }

        if (!exitReason) continue;
        try {
            const exitInterval = sellSignal?.interval || position.interval || options.defaultInterval;
            const exitPrice = await fetchPrice(position.symbol, exitInterval);
            closePosition(portfolio, i, exitPrice, exitReason, cycleAt);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[PaperTrader] Failed to close ${position.symbol}: ${message}`);
        }
    }

    for (const signal of buyBySymbol.values()) {
        if (sellBySymbol.has(signal.symbol)) continue;
        if (findOpenPositionIndex(portfolio.openPositions, signal.symbol) >= 0) {
            const existing = portfolio.openPositions[findOpenPositionIndex(portfolio.openPositions, signal.symbol)];
            if (existing) existing.lastSignalSeenIso = cycleAt;
            continue;
        }

        try {
            const entryPrice = await fetchPrice(signal.symbol, signal.interval || options.defaultInterval);
            const opened = openPosition(portfolio, signal, entryPrice, cycleAt);
            if (opened) {
                console.log(`[PaperTrader] OPEN ${signal.symbol} ${signal.strategyKey} qty=${(portfolio.openPositions[portfolio.openPositions.length - 1].quantity).toFixed(6)} @ ${entryPrice.toFixed(8)}`);
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[PaperTrader] Failed to open ${signal.symbol}: ${message}`);
        }
    }

    let floatingPnlUsd = 0;
    let markedNetValueUsd = 0;
    for (const position of portfolio.openPositions) {
        try {
            const markPrice = await fetchPrice(position.symbol, position.interval || options.defaultInterval);
            const markValueUsd = position.quantity * markPrice;
            const estimatedExitFeeUsd = markValueUsd * portfolio.settings.feeRate;
            const floating = (markValueUsd - position.notionalUsd) - estimatedExitFeeUsd;

            position.markPrice = markPrice;
            position.floatingPnlUsd = floating;
            floatingPnlUsd += floating;
            markedNetValueUsd += markValueUsd - estimatedExitFeeUsd;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            console.warn(`[PaperTrader] Mark price failed for ${position.symbol}: ${message}`);
            const fallbackValue = position.quantity * position.markPrice;
            const fallbackExitFee = fallbackValue * portfolio.settings.feeRate;
            markedNetValueUsd += fallbackValue - fallbackExitFee;
            floatingPnlUsd += position.floatingPnlUsd;
        }
    }

    portfolio.account.floatingPnlUsd = floatingPnlUsd;
    portfolio.account.realizedBalanceUsd = portfolio.account.initialBalanceUsd + portfolio.account.realizedPnlUsd;
    portfolio.account.totalEquityUsd = portfolio.account.cashBalanceUsd + markedNetValueUsd;
    portfolio.account.totalReturnPercent = portfolio.account.initialBalanceUsd > 0
        ? ((portfolio.account.totalEquityUsd - portfolio.account.initialBalanceUsd) / portfolio.account.initialBalanceUsd) * 100
        : 0;

    const day = cycleAt.slice(0, 10);
    if (portfolio.session.currentDay !== day) {
        portfolio.session.currentDay = day;
        portfolio.session.dayStartEquityUsd = portfolio.account.totalEquityUsd;
    }
    portfolio.account.todayPnlUsd = portfolio.account.totalEquityUsd - portfolio.session.dayStartEquityUsd;

    portfolio.signalState.sourceStatus = feedStatus;
    portfolio.signalState.lastSignalCycleAt = feed?.cycleAtIso ?? null;
    portfolio.signalState.lastSignalGeneratedAt = feed?.generatedAtIso ?? null;
    portfolio.signalState.watchlistCount = feed?.watchlistCount ?? 0;
    portfolio.signalState.activeSignalCount = feed?.signals.length ?? 0;

    portfolio.generatedAt = new Date().toISOString();
    portfolio.cycleAt = cycleAt;
    portfolio.pollSeconds = options.pollSeconds;
    portfolio.settings.notionalPerTradeUsd = options.notionalPerTradeUsd;
    portfolio.settings.minNotionalUsd = options.minNotionalUsd;
    portfolio.settings.feeRate = options.feeRate;
    portfolio.settings.closeOnSignalDisappear = options.closeOnSignalDisappear;
    portfolio.settings.defaultInterval = options.defaultInterval;
    portfolio.settings.maxClosedTrades = options.maxClosedTrades;
    portfolio.stats.winRatePercent = calculateWinRate(portfolio.stats);

    portfolio.openPositions.sort((a, b) => a.symbol.localeCompare(b.symbol));
    fs.writeFileSync(options.outPath, JSON.stringify(portfolio, null, 2), "utf8");

    const pnlSign = portfolio.account.todayPnlUsd >= 0 ? "+" : "";
    console.log(
        `[PaperTrader] equity=${portfolio.account.totalEquityUsd.toFixed(2)} today=${pnlSign}${portfolio.account.todayPnlUsd.toFixed(2)} open=${portfolio.openPositions.length} trades=${portfolio.stats.totalTrades} winRate=${portfolio.stats.winRatePercent.toFixed(1)}%`
    );
}

async function runPaperTrader(options: TraderOptions): Promise<void> {
    fs.mkdirSync(path.dirname(options.outPath), { recursive: true });
    const portfolio = loadOrInitPortfolio(options);
    portfolio.pollSeconds = options.pollSeconds;
    portfolio.settings.initialBalanceUsd = portfolio.account.initialBalanceUsd;

    let keepRunning = true;
    process.on("SIGINT", () => { keepRunning = false; });
    process.on("SIGTERM", () => { keepRunning = false; });

    while (keepRunning) {
        const started = Date.now();
        await runCycle(portfolio, options);
        if (options.once) break;
        const elapsed = Date.now() - started;
        const sleepMs = options.pollSeconds * 1000 - elapsed;
        if (sleepMs > 0) await wait(sleepMs);
    }
}

async function main(): Promise<void> {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
        printUsage();
        return;
    }
    await runPaperTrader(options);
    if (options.once) {
        process.exit(0);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error) => {
        const message = error instanceof Error ? error.stack || error.message : String(error);
        console.error(`paper-trader failed: ${message}`);
        process.exitCode = 1;
    });
}
