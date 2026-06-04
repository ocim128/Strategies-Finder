import { parseTimeToUnixSeconds } from "../time-normalization";
import { isPolymarketEntryPriceFiltered } from "../polymarket-entry-price-filter";
import { resolvePolymarketEntryCutoff } from "../polymarket-entry-cutoff";
import {
    clampPolymarketPostSignalLimitEntryPriceCents,
    clampPolymarketPostSignalLimitExitPriceCents,
    clampPolymarketPostSignalLimitOffsetCents,
    findPostSignalLimitEntryFill,
    findPostSignalLimitExitFill,
    resolvePolymarketLimitExitTargetPrice,
    resolvePolymarketPostSignalLimitEntryMode,
    resolvePolymarketPostSignalLimitExitMode,
    type PolymarketPostSignalLimitEntrySettings,
} from "../polymarket-post-signal-limit-entry";
import type { Trade } from "../types/strategies";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import { isChartExitSameEventMode, type PolymarketExitMode } from "../polymarket-exit-mode";
import type { PolymarketPricePoint } from "../local-sqlite-polymarket-api";
import { clampPolymarketEntryDelayBars } from "../polymarket-entry-delay";
import {
    applyPolymarketBacktestEntrySlippage,
    applyPolymarketBacktestExitSlippage,
    clampPolymarketBacktestSlippageCents,
} from "../polymarket-backtest-slippage";
import {
    DEFAULT_MAX_QUOTE_AGE_SEC,
    findContainingPolymarketEvent,
    getClobQuoteTimeSec,
    getClobSidePrice,
} from "./alignment";
import {
    clampPolymarketProtectionCents,
    hasActivePolymarketProtection,
    resolveEffectivePolymarketProtectionSettings,
    type PolymarketProtectionSettingFields,
} from "../polymarket-protection-settings";
import { getPolymarketSidePrice } from "../polymarket-price-points";
import type {
    PolymarketClob1sQuoteRow,
    SecondMarketAlignmentMode,
    SecondMarketBacktestSummary,
    SecondMarketFillSource,
    SecondMarketSide,
    SecondMarketTradeResult,
} from "./types";

type Fill = {
    price: number;
    quoteTs: number;
};

type ProtectionExitFill = {
    price: number;
    quoteTs: number;
    source: "protection_take_profit" | "protection_stop_loss";
    targetPrice: number | null;
};

type TimedMarketExitFill = {
    price: number;
    quoteTs: number;
    source: "target" | "protection_take_profit" | "protection_stop_loss";
    targetPrice: number | null;
    status?: SecondMarketTradeResult["exitStatus"];
};

export const SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE = "second_market_clob_unresolved";

type IndexedQuote = {
    quote: PolymarketClob1sQuoteRow;
    quoteTs: number;
};

type SecondMarketQuoteIndex = {
    quotesByEvent: Map<string, IndexedQuote[]>;
    quotesByYesEvent: Map<string, IndexedQuote[]>;
    pricePointsByKey: Map<string, PolymarketPricePoint[]>;
};

const quoteIndexCache = new WeakMap<readonly PolymarketClob1sQuoteRow[], SecondMarketQuoteIndex>();

function quoteEventKey(args: {
    seriesId: string;
    eventStartTs: number;
    yesTokenId: string;
    noTokenId: string;
}): string {
    return `${args.seriesId}|${args.eventStartTs}|${args.yesTokenId}|${args.noTokenId}`;
}

function quoteYesEventKey(args: {
    seriesId: string;
    eventStartTs: number;
    yesTokenId: string;
}): string {
    return `${args.seriesId}|${args.eventStartTs}|${args.yesTokenId}`;
}

function sortIndexedQuoteBuckets(buckets: Iterable<IndexedQuote[]>): void {
    for (const bucket of buckets) {
        bucket.sort((left, right) =>
            left.quoteTs - right.quoteTs
            || (left.quote.source_ts_ms ?? 0) - (right.quote.source_ts_ms ?? 0)
            || left.quote.sample_ts - right.quote.sample_ts
        );
    }
}

function pushIndexedQuote(map: Map<string, IndexedQuote[]>, key: string, quote: IndexedQuote): void {
    const bucket = map.get(key);
    if (bucket) {
        bucket.push(quote);
    } else {
        map.set(key, [quote]);
    }
}

function buildQuoteIndex(quotes: readonly PolymarketClob1sQuoteRow[]): SecondMarketQuoteIndex {
    const quotesByEvent = new Map<string, IndexedQuote[]>();
    const quotesByYesEvent = new Map<string, IndexedQuote[]>();
    for (const quote of quotes) {
        const quoteTs = getClobQuoteTimeSec(quote);
        if (quoteTs === null) continue;
        const indexed = { quote, quoteTs };
        const keyParts = {
            seriesId: quote.series_id,
            eventStartTs: quote.event_start_ts,
            yesTokenId: quote.yes_token_id,
        };
        pushIndexedQuote(quotesByEvent, quoteEventKey({ ...keyParts, noTokenId: quote.no_token_id }), indexed);
        pushIndexedQuote(quotesByYesEvent, quoteYesEventKey(keyParts), indexed);
    }

    sortIndexedQuoteBuckets(quotesByEvent.values());
    sortIndexedQuoteBuckets(quotesByYesEvent.values());

    return {
        quotesByEvent,
        quotesByYesEvent,
        pricePointsByKey: new Map(),
    };
}

function getQuoteIndex(quotes: readonly PolymarketClob1sQuoteRow[]): SecondMarketQuoteIndex {
    const cached = quoteIndexCache.get(quotes);
    if (cached) return cached;
    const index = buildQuoteIndex(quotes);
    quoteIndexCache.set(quotes, index);
    return index;
}

function findQuoteBucket(args: {
    seriesId: string;
    eventStartTs: number;
    yesTokenId: string;
    noTokenId: string;
    quoteIndex: SecondMarketQuoteIndex;
}): IndexedQuote[] | undefined {
    return args.noTokenId
        ? args.quoteIndex.quotesByEvent.get(quoteEventKey(args))
        : args.quoteIndex.quotesByYesEvent.get(quoteYesEventKey(args));
}

function quoteCacheKey(args: {
    seriesId: string;
    eventStartTs: number;
    yesTokenId: string;
    noTokenId: string;
}): string {
    return args.noTokenId ? quoteEventKey(args) : `${quoteYesEventKey(args)}|*`;
}

function isFillAgeUsable(ageSec: number, mode: SecondMarketAlignmentMode, maxQuoteAgeSec: number): boolean {
    if (ageSec < 0) return false;
    return mode === "strict" ? ageSec === 0 : ageSec <= maxQuoteAgeSec;
}

function findQuoteFill(args: {
    seriesId: string;
    eventStartTs: number;
    yesTokenId: string;
    noTokenId: string;
    fillTs: number;
    side: SecondMarketSide;
    orderSide: "buy" | "sell";
    mode: SecondMarketAlignmentMode;
    maxQuoteAgeSec: number;
    fillSource: SecondMarketFillSource;
    quoteIndex: SecondMarketQuoteIndex;
}): Fill | null {
    const bucket = findQuoteBucket(args);
    if (!bucket || bucket.length === 0) return null;

    let low = 0;
    let high = bucket.length;
    while (low < high) {
        const mid = Math.floor((low + high) / 2);
        if (bucket[mid]!.quoteTs <= args.fillTs) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }

    const best = bucket[low - 1] ?? null;
    if (!best) return null;
    const ageSec = args.fillTs - best.quoteTs;
    if (!isFillAgeUsable(ageSec, args.mode, args.maxQuoteAgeSec)) return null;
    const price = getClobSidePrice(best.quote, args.side, args.orderSide, args.fillSource);
    return price === null ? null : { price, quoteTs: best.quoteTs };
}

function buildClobPricePoints(args: {
    seriesId: string;
    eventStartTs: number;
    yesTokenId: string;
    noTokenId: string;
    orderSide: "buy" | "sell";
    fillSource: SecondMarketFillSource;
    quoteIndex: SecondMarketQuoteIndex;
}): PolymarketPricePoint[] {
    const eventKey = quoteCacheKey(args);
    const cacheKey = `${eventKey}|${args.orderSide}|${args.fillSource}`;
    const cached = args.quoteIndex.pricePointsByKey.get(cacheKey);
    if (cached) return cached;

    const pointByTs = new Map<number, { point: PolymarketPricePoint; sourceTsMs: number }>();
    const bucket = findQuoteBucket(args) ?? [];
    for (const item of bucket) {
        const quote = item.quote;
        const quoteTs = item.quoteTs;
        const sourceTsMs = quote.source_ts_ms ?? 0;
        const existing = pointByTs.get(quoteTs);
        if (existing && existing.sourceTsMs >= sourceTsMs) {
            continue;
        }
        pointByTs.set(quoteTs, {
            sourceTsMs,
            point: {
                series_id: quote.series_id,
                event_start_ts: quote.event_start_ts,
                event_end_ts: quote.event_end_ts,
                market_slug: quote.market_slug,
                yes_token_id: quote.yes_token_id,
                no_token_id: quote.no_token_id,
                ts: quoteTs,
                yes_price: getClobSidePrice(quote, "yes", args.orderSide, args.fillSource),
                no_price: getClobSidePrice(quote, "no", args.orderSide, args.fillSource),
                updated_at: quote.updated_at,
            },
        });
    }
    const points = [...pointByTs.values()]
        .map((entry) => entry.point)
        .sort((left, right) => left.ts - right.ts);
    args.quoteIndex.pricePointsByKey.set(cacheKey, points);
    return points;
}

function resolveResolutionExitPrice(outcome: PolymarketOutcomeRow, side: SecondMarketSide): number | null {
    if (outcome.resolution_source === SECOND_MARKET_UNRESOLVED_OUTCOME_SOURCE) {
        return null;
    }
    if (outcome.resolved_outcome_up === 1) {
        return side === "yes" ? 1 : 0;
    }
    return side === "yes" ? 0 : 1;
}

function isProtectionTakeProfitEnabled(settings: Partial<PolymarketProtectionSettingFields> | undefined): boolean {
    return settings?.polymarketProtectionTakeProfitEnabled === true
        && clampPolymarketProtectionCents(settings.polymarketProtectionTakeProfitCents) > 0;
}

function isProtectionStopLossEnabled(settings: Partial<PolymarketProtectionSettingFields> | undefined): boolean {
    return settings?.polymarketProtectionStopLossEnabled === true
        && clampPolymarketProtectionCents(settings.polymarketProtectionStopLossCents) > 0;
}

function clampLimitPrice(value: number): number {
    return Math.round(Math.max(0.01, Math.min(0.99, value)) * 1_000_000) / 1_000_000;
}

function findProtectionExitFill(args: {
    eventPoints: readonly PolymarketPricePoint[];
    side: SecondMarketSide;
    entryPrice: number;
    startTs: number;
    eventEndTs: number;
    settings?: Partial<PolymarketProtectionSettingFields>;
    backtestSlippageCents: number;
    latestAllowedTs?: number | null;
}): ProtectionExitFill | null {
    const takeProfitEnabled = isProtectionTakeProfitEnabled(args.settings);
    const stopLossEnabled = isProtectionStopLossEnabled(args.settings);
    if (!takeProfitEnabled && !stopLossEnabled) {
        return null;
    }

    const takeProfitTarget = takeProfitEnabled
        ? args.entryPrice + clampPolymarketProtectionCents(args.settings?.polymarketProtectionTakeProfitCents) / 100
        : null;
    const stopLossTrigger = stopLossEnabled
        ? args.entryPrice - clampPolymarketProtectionCents(args.settings?.polymarketProtectionStopLossCents) / 100
        : null;
    const normalizedTakeProfitTarget = takeProfitTarget !== null && takeProfitTarget < 1
        ? Math.round(takeProfitTarget * 1_000_000_000) / 1_000_000_000
        : null;
    const normalizedStopLossTrigger = stopLossTrigger !== null && stopLossTrigger > 0
        ? Math.round(stopLossTrigger * 1_000_000_000) / 1_000_000_000
        : null;
    if (normalizedTakeProfitTarget === null && normalizedStopLossTrigger === null) {
        return null;
    }

    const latestAllowedTs = typeof args.latestAllowedTs === "number" && Number.isFinite(args.latestAllowedTs)
        ? args.latestAllowedTs
        : null;
    for (const point of args.eventPoints) {
        if (point.ts <= args.startTs) {
            continue;
        }
        if (point.ts >= args.eventEndTs || (latestAllowedTs !== null && point.ts > latestAllowedTs)) {
            break;
        }

        const price = getPolymarketSidePrice(point, args.side);
        if (price === null) {
            continue;
        }

        if (normalizedStopLossTrigger !== null && price <= normalizedStopLossTrigger) {
            return {
                price: applyPolymarketBacktestExitSlippage(price, args.backtestSlippageCents)!,
                quoteTs: point.ts,
                source: "protection_stop_loss",
                targetPrice: normalizedStopLossTrigger,
            };
        }
        if (normalizedTakeProfitTarget !== null && price >= normalizedTakeProfitTarget) {
            return {
                price: normalizedTakeProfitTarget,
                quoteTs: point.ts,
                source: "protection_take_profit",
                targetPrice: normalizedTakeProfitTarget,
            };
        }
    }
    return null;
}

function exitPriority(source: TimedMarketExitFill["source"]): number {
    if (source === "protection_stop_loss") return 0;
    if (source === "protection_take_profit") return 1;
    return 2;
}

function chooseEarlierTimedExit(
    left: TimedMarketExitFill | null,
    right: TimedMarketExitFill | null
): TimedMarketExitFill | null {
    if (!left) return right;
    if (!right) return left;
    if (left.quoteTs !== right.quoteTs) {
        return left.quoteTs < right.quoteTs ? left : right;
    }
    return exitPriority(left.source) <= exitPriority(right.source) ? left : right;
}

function buildSummary(
    results: readonly SecondMarketTradeResult[],
    evaluationMode: PolymarketExitMode,
    settings?: PolymarketPostSignalLimitEntrySettings,
    protectionSettings?: Partial<PolymarketProtectionSettingFields>,
    allowMultipleTradesPerEvent = false,
    entryDelayBars = 0,
    backtestSlippageCents = 0
): SecondMarketBacktestSummary {
    const scored = results.filter((result) => result.pnl !== null);
    const grossProfit = scored.reduce((sum, result) => sum + Math.max(0, result.pnl ?? 0), 0);
    const grossLoss = Math.abs(scored.reduce((sum, result) => sum + Math.min(0, result.pnl ?? 0), 0));
    const entryPrices = scored.map((result) => result.entryPrice).filter((value): value is number => value !== null);
    const exitPrices = scored.map((result) => result.exitPrice).filter((value): value is number => value !== null);
    const exactEntries = scored.filter((result) => {
        const entryTs = parseTimeToUnixSeconds(result.trade.entryTime);
        return entryTs !== null && result.entryQuoteTs === entryTs + entryDelayBars;
    }).length;
    const limitEntryEnabled = results.some((result) => result.entrySource === "limit");
    const limitEntryAttempts = results.filter((result) =>
        result.entrySource === "limit"
        && result.entryStatus !== undefined
        && result.entryStatus !== "duplicate"
    ).length;
    const limitEntryFilledTrades = results.filter((result) =>
        result.entrySource === "limit"
        && result.entryStatus === "filled"
    ).length;
    const limitEntryMissedTrades = Math.max(0, limitEntryAttempts - limitEntryFilledTrades);
    const limitEntryMissingPriceTrades = results.filter((result) =>
        result.entrySource === "limit"
        && result.entryStatus === "missing_price_points"
    ).length;
    const limitEntryWaits = results
        .filter((result) => result.entrySource === "limit" && result.entryStatus === "filled")
        .map((result) => {
            const entryTs = parseTimeToUnixSeconds(result.trade.entryTime);
            return entryTs !== null && result.entryQuoteTs !== null
                ? Math.max(0, result.entryQuoteTs - entryTs)
                : null;
        })
        .filter((value): value is number => value !== null);
    const limitEntryImprovements = results
        .map((result) => result.entryImprovement)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const limitExitEnabled = limitEntryEnabled && settings?.exitEnabled === true;
    const protectionTakeProfitEnabled = isProtectionTakeProfitEnabled(protectionSettings);
    const protectionStopLossEnabled = isProtectionStopLossEnabled(protectionSettings);
    const limitExitFilledTrades = results.filter((result) =>
        result.entrySource === "limit"
        && result.entryStatus === "filled"
        && result.exitSource === "target"
    ).length;
    const limitExitFallbackTrades = limitExitEnabled
        ? results.filter((result) =>
            result.entrySource === "limit"
            && result.entryStatus === "filled"
            && result.exitSource !== "target"
            && result.pnl !== null
        ).length
        : 0;
    return {
        evaluationMode,
        allowMultipleTradesPerEvent: allowMultipleTradesPerEvent || undefined,
        entryDelayBars: entryDelayBars > 0 ? entryDelayBars : undefined,
        backtestSlippageCents: backtestSlippageCents > 0 ? backtestSlippageCents : undefined,
        scoredTrades: scored.length,
        duplicateTradesIgnored: results.filter((result) => result.exitSource === "duplicate").length,
        entryPriceFilteredTrades: results.filter((result) => result.exitSource === "entry_price_filtered").length,
        entryTimeFilteredTrades: results.filter((result) => result.exitSource === "entry_time_filtered").length,
        missingOutcomeTrades: results.filter((result) => result.exitSource === "no_event").length,
        missingQuoteTrades: results.filter((result) =>
            result.exitSource === "missing"
            && (
                result.entrySource !== "limit"
                || result.entryStatus === "filled"
                || result.entryStatus === "missing_price_points"
                || !result.entryStatus
            )
        ).length,
        signalExitedTrades: scored.filter((result) => result.exitSource === "signal").length,
        targetExitedTrades: scored.filter((result) => result.exitSource === "target").length,
        protectionTakeProfitExitedTrades: scored.filter((result) => result.exitSource === "protection_take_profit").length,
        protectionStopLossExitedTrades: scored.filter((result) => result.exitSource === "protection_stop_loss").length,
        resolvedTrades: scored.filter((result) => result.exitSource === "resolution").length,
        netPnl: scored.reduce((sum, result) => sum + (result.pnl ?? 0), 0),
        grossProfit,
        grossLoss,
        profitFactor: grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Number.POSITIVE_INFINITY : 0,
        expectancy: scored.length > 0 ? scored.reduce((sum, result) => sum + (result.pnl ?? 0), 0) / scored.length : 0,
        avgEntryPrice: entryPrices.length > 0
            ? entryPrices.reduce((sum, value) => sum + value, 0) / entryPrices.length
            : null,
        avgExitPrice: exitPrices.length > 0
            ? exitPrices.reduce((sum, value) => sum + value, 0) / exitPrices.length
            : null,
        exactQuoteCoveragePct: scored.length > 0 ? (exactEntries / scored.length) * 100 : 0,
        limitEntryEnabled: limitEntryEnabled || undefined,
        limitEntryMode: limitEntryEnabled ? resolvePolymarketPostSignalLimitEntryMode(settings?.priceMode) : undefined,
        limitEntryPriceCents: limitEntryEnabled && resolvePolymarketPostSignalLimitEntryMode(settings?.priceMode) === "fixed_price"
            ? clampPolymarketPostSignalLimitEntryPriceCents(settings?.priceCents)
            : limitEntryEnabled
                ? results
                    .map((result) => result.entryLimitPrice)
                    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
                    .map((value) => Math.round(value * 100))[0]
                : undefined,
        limitEntryOffsetCents: limitEntryEnabled ? clampPolymarketPostSignalLimitOffsetCents(settings?.offsetCents) : undefined,
        limitEntryAttempts: limitEntryEnabled ? limitEntryAttempts : undefined,
        limitEntryFilledTrades: limitEntryEnabled ? limitEntryFilledTrades : undefined,
        limitEntryMissedTrades: limitEntryEnabled ? limitEntryMissedTrades : undefined,
        limitEntryNotTouchedTrades: limitEntryEnabled
            ? results.filter((result) => result.entrySource === "limit" && result.entryStatus === "not_touched").length
            : undefined,
        limitEntryLastMinuteOnlyTrades: limitEntryEnabled
            ? results.filter((result) => result.entrySource === "limit" && result.entryStatus === "last_minute_only").length
            : undefined,
        limitEntryMissingPriceTrades: limitEntryEnabled ? limitEntryMissingPriceTrades : undefined,
        limitEntryInvalidWindowTrades: limitEntryEnabled
            ? results.filter((result) => result.entrySource === "limit" && result.entryStatus === "invalid_window").length
            : undefined,
        limitEntryFillRate: limitEntryEnabled && limitEntryAttempts > 0 ? limitEntryFilledTrades / limitEntryAttempts : undefined,
        avgLimitEntryWaitSec: limitEntryEnabled && limitEntryWaits.length > 0
            ? limitEntryWaits.reduce((sum, value) => sum + value, 0) / limitEntryWaits.length
            : undefined,
        avgLimitEntryImprovement: limitEntryEnabled && limitEntryImprovements.length > 0
            ? limitEntryImprovements.reduce((sum, value) => sum + value, 0) / limitEntryImprovements.length
            : undefined,
        limitExitEnabled: limitExitEnabled || undefined,
        limitExitMode: limitExitEnabled ? resolvePolymarketPostSignalLimitExitMode(settings?.exitMode) : undefined,
        limitExitPriceCents: limitExitEnabled ? clampPolymarketPostSignalLimitExitPriceCents(settings?.exitPriceCents) : undefined,
        limitExitOffsetCents: limitExitEnabled ? clampPolymarketPostSignalLimitOffsetCents(settings?.exitOffsetCents) : undefined,
        limitExitFilledTrades: limitExitEnabled ? limitExitFilledTrades : undefined,
        limitExitFallbackTrades: limitExitEnabled ? limitExitFallbackTrades : undefined,
        limitExitUnreachableTrades: limitExitEnabled
            ? results.filter((result) => result.entrySource === "limit" && result.exitStatus === "unreachable").length
            : undefined,
        protectionTakeProfitEnabled: protectionTakeProfitEnabled || undefined,
        protectionTakeProfitCents: protectionTakeProfitEnabled
            ? clampPolymarketProtectionCents(protectionSettings?.polymarketProtectionTakeProfitCents)
            : undefined,
        protectionStopLossEnabled: protectionStopLossEnabled || undefined,
        protectionStopLossCents: protectionStopLossEnabled
            ? clampPolymarketProtectionCents(protectionSettings?.polymarketProtectionStopLossCents)
            : undefined,
    };
}

export function evaluateSecondMarketTrades(args: {
    trades: readonly Trade[];
    outcomes: readonly PolymarketOutcomeRow[];
    quotes: readonly PolymarketClob1sQuoteRow[];
    evaluationMode?: PolymarketExitMode;
    allowMultipleTradesPerEvent?: boolean;
    mode?: SecondMarketAlignmentMode;
    maxQuoteAgeSec?: number;
    fillSource?: SecondMarketFillSource;
    entryPriceFilterCents?: number;
    entryCutoffEnabled?: boolean;
    entryCutoffSeconds?: number;
    entryDelayBars?: number;
    backtestSlippageCents?: number;
    limitEntry?: PolymarketPostSignalLimitEntrySettings;
    protection?: Partial<PolymarketProtectionSettingFields>;
}): { results: SecondMarketTradeResult[]; summary: SecondMarketBacktestSummary } {
    const evaluationMode = args.evaluationMode ?? "resolve_hold";
    const allowMultipleTradesPerEvent = args.allowMultipleTradesPerEvent === true;
    const mode = args.mode ?? "strict";
    const maxQuoteAgeSec = Math.max(0, Math.floor(args.maxQuoteAgeSec ?? DEFAULT_MAX_QUOTE_AGE_SEC));
    const fillSource = args.fillSource ?? "bid_ask";
    const entryDelayBars = clampPolymarketEntryDelayBars(args.entryDelayBars);
    const backtestSlippageCents = clampPolymarketBacktestSlippageCents(args.backtestSlippageCents, 0);
    const protectionSettings = resolveEffectivePolymarketProtectionSettings(evaluationMode, args.protection);
    const results: SecondMarketTradeResult[] = [];
    const seenEvents = new Set<string>();
    const quoteIndex = getQuoteIndex(args.quotes);
    let openPositionUntilTs: number | null = null;
    const limitEntryMode = resolvePolymarketPostSignalLimitEntryMode(args.limitEntry?.priceMode);
    const limitEntryOffsetCents = clampPolymarketPostSignalLimitOffsetCents(args.limitEntry?.offsetCents);
    const limitEntryEnabled = args.limitEntry?.enabled === true
        && !(limitEntryMode === "signal_offset" && limitEntryOffsetCents <= 0);
    const fixedLimitPrice = clampPolymarketPostSignalLimitEntryPriceCents(args.limitEntry?.priceCents) / 100;
    const configuredLimitPrice = limitEntryMode === "fixed_price" ? fixedLimitPrice : null;
    const limitExitEnabled = limitEntryEnabled && args.limitEntry?.exitEnabled === true;
    const protectionEnabled = hasActivePolymarketProtection(protectionSettings ?? {});

    for (const trade of args.trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;
        const entryFillTs = entryTs + entryDelayBars;
        const outcome = findContainingPolymarketEvent(entryTs, args.outcomes);
        const side: SecondMarketSide = trade.type === "long" ? "yes" : "no";
        if (!outcome) {
            results.push({
                trade,
                outcome: null,
                side: null,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: null,
                entryQuoteTs: null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "no_event",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        const eventKey = `${outcome.series_id}:${outcome.event_start_ts}`;
        if (openPositionUntilTs !== null && entryFillTs >= openPositionUntilTs) {
            openPositionUntilTs = null;
        }
        if (evaluationMode === "resolve_hold" && openPositionUntilTs !== null && entryFillTs < openPositionUntilTs) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "open_position" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryLimitPrice: limitEntryEnabled ? configuredLimitPrice : null,
                entryPrice: null,
                entryQuoteTs: null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "open_position",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }
        if (!allowMultipleTradesPerEvent && seenEvents.has(eventKey)) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "duplicate" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryLimitPrice: limitEntryEnabled ? configuredLimitPrice : null,
                entryPrice: null,
                entryQuoteTs: null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "duplicate",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        const rawExitTs = trade.exitReason === "end_of_data"
            ? null
            : parseTimeToUnixSeconds(trade.exitTime);
        const shouldUseChartExit = isChartExitSameEventMode(evaluationMode)
            ? trade.exitReason !== "end_of_data"
            : evaluationMode === "signal_exit_same_event" && trade.exitReason === "signal";
        const signalExitTs = shouldUseChartExit
            && rawExitTs !== null
            && rawExitTs < outcome.event_end_ts
            ? rawExitTs
            : null;
        const protectionLatestAllowedTs = rawExitTs !== null && rawExitTs < outcome.event_end_ts
            ? rawExitTs
            : null;

        const entryCutoff = resolvePolymarketEntryCutoff({
            entryTimeSec: entryFillTs,
            eventEndTs: outcome.event_end_ts,
            enabled: args.entryCutoffEnabled,
            cutoffSeconds: args.entryCutoffSeconds,
        });
        if (!entryCutoff.allowed || entryFillTs >= outcome.event_end_ts) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryLimitPrice: limitEntryEnabled ? configuredLimitPrice : null,
                entryPrice: null,
                entryQuoteTs: null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "entry_time_filtered",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        let entry: Fill | null = null;
        let entryLimitPrice: number | null = null;
        let entryImprovement: number | null = null;
        if (limitEntryEnabled && args.limitEntry) {
            const buyPricePoints = buildClobPricePoints({
                seriesId: outcome.series_id,
                eventStartTs: outcome.event_start_ts,
                yesTokenId: outcome.yes_token_id,
                noTokenId: outcome.no_token_id,
                orderSide: "buy",
                fillSource,
                quoteIndex,
            });
            const staleSignalEntry = limitEntryMode === "stale_signal_price"
                ? findQuoteFill({
                    seriesId: outcome.series_id,
                    eventStartTs: outcome.event_start_ts,
                    yesTokenId: outcome.yes_token_id,
                    noTokenId: outcome.no_token_id,
                    fillTs: entryTs,
                    side,
                    orderSide: "buy",
                    mode,
                    maxQuoteAgeSec,
                    fillSource,
                    quoteIndex,
                })
                : null;
            const signalOffsetEntry = limitEntryMode === "signal_offset"
                ? findQuoteFill({
                    seriesId: outcome.series_id,
                    eventStartTs: outcome.event_start_ts,
                    yesTokenId: outcome.yes_token_id,
                    noTokenId: outcome.no_token_id,
                    fillTs: entryFillTs,
                    side,
                    orderSide: "buy",
                    mode,
                    maxQuoteAgeSec,
                    fillSource,
                    quoteIndex,
                })
                : null;
            if (limitEntryMode === "stale_signal_price" && staleSignalEntry === null) {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "limit",
                    entryStatus: "missing_price_points",
                    entryMode: limitEntryMode,
                    entryOffsetCents: limitEntryOffsetCents,
                    entryPrice: null,
                    entryQuoteTs: null,
                    entryLimitPrice: null,
                    entryImprovement: null,
                    exitPrice: null,
                    exitQuoteTs: null,
                    exitSource: "missing",
                    pnl: null,
                    isProfitable: null,
                });
                continue;
            }
            if (limitEntryMode === "signal_offset" && signalOffsetEntry === null) {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "limit",
                    entryStatus: "missing_price_points",
                    entryMode: limitEntryMode,
                    entryOffsetCents: limitEntryOffsetCents,
                    entryPrice: null,
                    entryQuoteTs: null,
                    entryLimitPrice: null,
                    entryImprovement: null,
                    exitPrice: null,
                    exitQuoteTs: null,
                    exitSource: "missing",
                    pnl: null,
                    isProfitable: null,
                });
                continue;
            }
            const signalOffsetLimitPrice = signalOffsetEntry
                ? clampLimitPrice(signalOffsetEntry.price - limitEntryOffsetCents / 100)
                : null;
            const limitFill = findPostSignalLimitEntryFill(buyPricePoints, {
                side,
                startTs: entryFillTs,
                eventEndTs: outcome.event_end_ts,
                limitPrice: staleSignalEntry?.price ?? signalOffsetLimitPrice ?? fixedLimitPrice,
                priceMode: limitEntryMode === "stale_signal_price" || limitEntryMode === "signal_offset"
                    ? "fixed_price"
                    : limitEntryMode,
                offsetPrice: limitEntryMode === "signal_offset" ? 0 : limitEntryOffsetCents / 100,
                latestAllowedTs: signalExitTs,
            });
            entryLimitPrice = limitFill.limitPrice ?? staleSignalEntry?.price ?? signalOffsetLimitPrice ?? configuredLimitPrice;
            if (limitFill.status !== "filled" || limitFill.fillPrice === null || limitFill.fillTs === null) {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "limit",
                    entryStatus: limitFill.status,
                    entryMode: limitEntryMode,
                    entryOffsetCents: limitEntryOffsetCents,
                    entryPrice: null,
                    entryQuoteTs: null,
                    entryLimitPrice,
                    entryImprovement: null,
                    exitPrice: null,
                    exitQuoteTs: null,
                    exitSource: "missing",
                    pnl: null,
                    isProfitable: null,
                });
                continue;
            }
            entry = {
                price: limitFill.fillPrice,
                quoteTs: limitFill.fillTs,
            };
            entryImprovement = limitFill.entryImprovement;
        } else {
            if (signalExitTs !== null && entryFillTs > signalExitTs) {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "quote",
                    entryPrice: null,
                    entryQuoteTs: null,
                    exitPrice: null,
                    exitQuoteTs: null,
                    exitSource: "entry_time_filtered",
                    pnl: null,
                    isProfitable: null,
                });
                continue;
            }
            entry = findQuoteFill({
                seriesId: outcome.series_id,
                eventStartTs: outcome.event_start_ts,
                yesTokenId: outcome.yes_token_id,
                noTokenId: outcome.no_token_id,
                fillTs: entryFillTs,
                side,
                orderSide: "buy",
                mode,
                maxQuoteAgeSec,
                fillSource,
                quoteIndex,
            });
            if (!entry) {
                results.push({
                    trade,
                    outcome,
                    side,
                    entrySource: "quote",
                    entryPrice: null,
                    entryQuoteTs: null,
                    exitPrice: null,
                    exitQuoteTs: null,
                    exitSource: "missing",
                    pnl: null,
                    isProfitable: null,
                });
                continue;
            }
            entry = {
                ...entry,
                price: applyPolymarketBacktestEntrySlippage(entry.price, backtestSlippageCents)!,
            };
        }

        if (isPolymarketEntryPriceFiltered(entry.price, args.entryPriceFilterCents)) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "filled" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: entry.price,
                entryQuoteTs: entry.quoteTs,
                entryLimitPrice: limitEntryEnabled ? entryLimitPrice ?? entry.price : null,
                entryImprovement: limitEntryEnabled ? entryImprovement : null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "entry_price_filtered",
                pnl: null,
                isProfitable: null,
            });
            continue;
        }
        if (evaluationMode === "resolve_hold") {
            openPositionUntilTs = outcome.event_end_ts;
        }
        let exitTargetPrice: number | null = null;
        const sellPricePoints = limitExitEnabled || protectionEnabled
            ? buildClobPricePoints({
                seriesId: outcome.series_id,
                eventStartTs: outcome.event_start_ts,
                yesTokenId: outcome.yes_token_id,
                noTokenId: outcome.no_token_id,
                orderSide: "sell",
                fillSource,
                quoteIndex,
            })
            : [];
        const targetExit = limitExitEnabled && args.limitEntry
            ? (() => {
                exitTargetPrice = resolvePolymarketLimitExitTargetPrice(entry.price, args.limitEntry);
                return findPostSignalLimitExitFill(sellPricePoints, {
                    side,
                    startTs: entry.quoteTs,
                    eventEndTs: outcome.event_end_ts,
                    targetPrice: exitTargetPrice,
                });
            })()
            : null;
        const protectionExit = protectionEnabled
            ? findProtectionExitFill({
                eventPoints: sellPricePoints,
                side,
                entryPrice: entry.price,
                startTs: entry.quoteTs,
                eventEndTs: outcome.event_end_ts,
                settings: protectionSettings,
                backtestSlippageCents,
                latestAllowedTs: protectionLatestAllowedTs,
            })
            : null;
        const targetExitCandidate: TimedMarketExitFill | null = targetExit?.status === "filled"
            && targetExit.fillTs !== null
            && targetExit.fillPrice !== null
            ? {
                price: targetExit.fillPrice,
                quoteTs: targetExit.fillTs,
                source: "target",
                targetPrice: exitTargetPrice,
                status: targetExit.status,
            }
            : null;
        const timedExit = chooseEarlierTimedExit(protectionExit, targetExitCandidate);

        const exit = (() => {
            if (signalExitTs !== null) {
                if (timedExit && timedExit.quoteTs <= signalExitTs) {
                    return {
                        price: timedExit.price,
                        quoteTs: timedExit.quoteTs,
                        source: timedExit.source,
                        targetPrice: timedExit.targetPrice,
                        status: timedExit.status,
                    };
                }

                const fill = findQuoteFill({
                    seriesId: outcome.series_id,
                    eventStartTs: outcome.event_start_ts,
                    yesTokenId: outcome.yes_token_id,
                    noTokenId: outcome.no_token_id,
                    fillTs: signalExitTs,
                    side,
                    orderSide: "sell",
                    mode,
                    maxQuoteAgeSec,
                    fillSource,
                    quoteIndex,
                });
                return fill && fill.quoteTs >= entry.quoteTs
                    ? {
                        price: applyPolymarketBacktestExitSlippage(
                            fill.quoteTs === entry.quoteTs && backtestSlippageCents <= 0 ? entry.price : fill.price,
                            backtestSlippageCents
                        )!,
                        quoteTs: fill.quoteTs,
                        source: "signal" as const,
                        targetPrice: exitTargetPrice,
                        status: targetExit?.status,
                    }
                    : null;
            }

            if (timedExit) {
                return {
                    price: timedExit.price,
                    quoteTs: timedExit.quoteTs,
                    source: timedExit.source,
                    targetPrice: timedExit.targetPrice,
                    status: timedExit.status,
                };
            }

            const price = resolveResolutionExitPrice(outcome, side);
            return price === null
                ? null
                : {
                    price,
                    quoteTs: null,
                    source: "resolution" as const,
                    targetPrice: exitTargetPrice,
                    status: targetExit?.status,
                };
        })();

        if (!exit || exit.price === null) {
            results.push({
                trade,
                outcome,
                side,
                entrySource: limitEntryEnabled ? "limit" : "quote",
                entryStatus: limitEntryEnabled ? "filled" : undefined,
                entryMode: limitEntryEnabled ? limitEntryMode : undefined,
                entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
                entryPrice: entry.price,
                entryQuoteTs: entry.quoteTs,
                entryLimitPrice: limitEntryEnabled ? entryLimitPrice ?? entry.price : null,
                entryImprovement: limitEntryEnabled ? entryImprovement : null,
                exitPrice: null,
                exitQuoteTs: null,
                exitSource: "missing",
                exitTargetPrice,
                exitStatus: targetExit?.status,
                pnl: null,
                isProfitable: null,
            });
            continue;
        }

        if (!allowMultipleTradesPerEvent) {
            seenEvents.add(eventKey);
        }
        if (evaluationMode === "resolve_hold") {
            openPositionUntilTs = exit.quoteTs ?? outcome.event_end_ts;
        }
        const pnl = exit.price - entry.price;
        results.push({
            trade,
            outcome,
            side,
            entrySource: limitEntryEnabled ? "limit" : "quote",
            entryStatus: limitEntryEnabled ? "filled" : undefined,
            entryMode: limitEntryEnabled ? limitEntryMode : undefined,
            entryOffsetCents: limitEntryEnabled ? limitEntryOffsetCents : undefined,
            entryPrice: entry.price,
            entryQuoteTs: entry.quoteTs,
            entryLimitPrice: limitEntryEnabled ? entryLimitPrice ?? entry.price : null,
            entryImprovement: limitEntryEnabled ? entryImprovement : null,
            exitPrice: exit.price,
            exitQuoteTs: exit.quoteTs,
            exitSource: exit.source,
            exitTargetPrice: exit.targetPrice,
            exitStatus: exit.status,
            pnl,
            isProfitable: pnl > 0 ? true : pnl < 0 ? false : null,
        });
    }

    return {
        results,
        summary: buildSummary(
            results,
            evaluationMode,
            args.limitEntry,
            protectionSettings,
            allowMultipleTradesPerEvent,
            entryDelayBars,
            backtestSlippageCents
        ),
    };
}
