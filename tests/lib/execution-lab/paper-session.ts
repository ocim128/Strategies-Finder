import type { Time } from "lightweight-charts";
import { resolvePolymarketEntryCutoff } from "../polymarket-entry-cutoff";
import { isPolymarketEntryPriceFiltered } from "../polymarket-entry-price-filter";
import { clampPolymarketProtectionCents } from "../polymarket-protection-settings";
import { parseTimeToUnixSeconds } from "../time-normalization";
import type { Trade } from "../types/strategies";
import type { PolymarketOutcomeRow } from "../types/polymarket-outcomes";
import type { PolymarketClob1sQuoteRow, SecondMarketSide } from "../second-market/types";
import {
    type ExecutionLabBaseRecord,
    type ExecutionLabLiveUiConfig,
    type ExecutionLabClosedPaperTrade,
    type ExecutionLabBacktestExitReason,
    type ExecutionLabEvaluatedSignal,
    type ExecutionLabOpenPaperPosition,
    type ExecutionLabPaperExitReason,
    type ExecutionLabPaperMarker,
    type ExecutionLabPaperState,
    type ExecutionLabPaperTickInput,
    type ExecutionLabPaperTickResult,
    type ExecutionLabRecord,
    type ExecutionLabSessionSnapshot,
    type PaperEntryRecord,
    type PaperExitRecord,
    type PaperResolutionPendingRecord,
    type PaperUnfilledRecord,
    type SessionStartRecord,
    type SessionStopRecord,
    type SignalSeenRecord,
} from "./execution-lab-model";
import { executionLabTradeExecutionTimeSec } from "./trade-quote-times";

type EventRef = {
    seriesId: string;
    eventStartTs: number;
    eventEndTs: number;
    marketSlug: string;
    conditionId: string;
    yesTokenId: string;
    noTokenId: string;
};

type FillRef = {
    quote: PolymarketClob1sQuoteRow;
    quoteTs: number;
    price: number;
};

function baseRecord(snapshot: ExecutionLabSessionSnapshot, recordedAtIso: string): ExecutionLabBaseRecord {
    return {
        recordType: "",
        sessionId: snapshot.sessionId,
        recordedAtIso,
        symbol: snapshot.symbol,
        interval: "1s",
        strategyKey: snapshot.strategyKey,
    };
}

function toSec(time: Trade["entryTime"]): number | null {
    return parseTimeToUnixSeconds(time);
}

function tradeExecutionTimeSec(snapshot: ExecutionLabSessionSnapshot, time: Trade["entryTime"]): number | null {
    return executionLabTradeExecutionTimeSec({
        backtestSettings: snapshot.backtestSettings,
        time,
    });
}

function eventKey(event: EventRef): string {
    return `${event.seriesId}:${event.eventStartTs}`;
}

function signalFingerprint(snapshot: ExecutionLabSessionSnapshot, signal: ExecutionLabEvaluatedSignal): string {
    const price = Number(signal.signal.price.toFixed(8));
    return `signal:${snapshot.strategyKey}|${snapshot.symbol}|${signal.signalType}|${signal.signalTimeSec}|${price}`;
}

function tradeDirectionToSide(direction: "long" | "short"): SecondMarketSide {
    return direction === "long" ? "yes" : "no";
}

function priceForSide(quote: PolymarketClob1sQuoteRow, side: SecondMarketSide, orderSide: "buy" | "sell"): number | null {
    const price = side === "yes"
        ? (orderSide === "buy" ? quote.yes_ask : quote.yes_bid)
        : (orderSide === "buy" ? quote.no_ask : quote.no_bid);
    return price !== null && Number.isFinite(price) && price >= 0 && price <= 1 ? price : null;
}

function findEventForTime(args: {
    seriesId: string;
    symbol: string;
    ts: number;
    outcomes: readonly PolymarketOutcomeRow[];
    quotes: readonly PolymarketClob1sQuoteRow[];
}): EventRef | null {
    const quote = args.quotes.find((row) =>
        row.series_id === args.seriesId
        && row.symbol === args.symbol
        && row.event_start_ts <= args.ts
        && args.ts < row.event_end_ts
        && row.yes_token_id.length > 0
    );
    if (quote) {
        return {
            seriesId: quote.series_id,
            eventStartTs: quote.event_start_ts,
            eventEndTs: quote.event_end_ts,
            marketSlug: quote.market_slug,
            conditionId: quote.condition_id,
            yesTokenId: quote.yes_token_id,
            noTokenId: quote.no_token_id,
        };
    }

    const outcome = args.outcomes.find((row) =>
        row.series_id === args.seriesId
        && row.event_start_ts <= args.ts
        && args.ts < row.event_end_ts
    );
    if (!outcome) return null;
    return {
        seriesId: outcome.series_id,
        eventStartTs: outcome.event_start_ts,
        eventEndTs: outcome.event_end_ts,
        marketSlug: outcome.market_slug,
        conditionId: "",
        yesTokenId: outcome.yes_token_id,
        noTokenId: outcome.no_token_id,
    };
}

function findExactFill(args: {
    event: EventRef;
    symbol: string;
    ts: number;
    side: SecondMarketSide;
    orderSide: "buy" | "sell";
    quotes: readonly PolymarketClob1sQuoteRow[];
}): FillRef | null {
    let best: PolymarketClob1sQuoteRow | null = null;
    for (const quote of args.quotes) {
        if (quote.series_id !== args.event.seriesId) continue;
        if (quote.symbol !== args.symbol) continue;
        if (quote.event_start_ts !== args.event.eventStartTs) continue;
        if (quote.yes_token_id !== args.event.yesTokenId) continue;
        if (args.event.noTokenId && quote.no_token_id !== args.event.noTokenId) continue;
        if (quote.sample_ts !== args.ts) continue;
        if (!best || (quote.source_ts_ms ?? 0) > (best.source_ts_ms ?? 0)) best = quote;
    }
    if (!best) return null;
    const price = priceForSide(best, args.side, args.orderSide);
    return price === null ? null : { quote: best, quoteTs: best.sample_ts, price };
}

function findFillsInRange(args: {
    event: EventRef;
    symbol: string;
    afterTs: number;
    throughTs: number;
    side: SecondMarketSide;
    orderSide: "buy" | "sell";
    quotes: readonly PolymarketClob1sQuoteRow[];
}): FillRef[] {
    const bestByTs = new Map<number, PolymarketClob1sQuoteRow>();
    for (const quote of args.quotes) {
        if (quote.series_id !== args.event.seriesId) continue;
        if (quote.symbol !== args.symbol) continue;
        if (quote.event_start_ts !== args.event.eventStartTs) continue;
        if (quote.yes_token_id !== args.event.yesTokenId) continue;
        if (args.event.noTokenId && quote.no_token_id !== args.event.noTokenId) continue;
        if (quote.sample_ts <= args.afterTs || quote.sample_ts > args.throughTs) continue;
        if (quote.sample_ts >= args.event.eventEndTs) continue;
        const existing = bestByTs.get(quote.sample_ts);
        if (!existing || (quote.source_ts_ms ?? 0) > (existing.source_ts_ms ?? 0)) {
            bestByTs.set(quote.sample_ts, quote);
        }
    }

    const fills: FillRef[] = [];
    const sortedTs = [...bestByTs.keys()].sort((left, right) => left - right);
    for (const ts of sortedTs) {
        const quote = bestByTs.get(ts)!;
        const price = priceForSide(quote, args.side, args.orderSide);
        if (price !== null) fills.push({ quote, quoteTs: quote.sample_ts, price });
    }
    return fills;
}

function findResolvedOutcome(event: EventRef, outcomes: readonly PolymarketOutcomeRow[]): PolymarketOutcomeRow | null {
    return outcomes.find((row) =>
        row.series_id === event.seriesId
        && row.event_start_ts === event.eventStartTs
        && row.yes_token_id === event.yesTokenId
        && (!event.noTokenId || row.no_token_id === event.noTokenId)
        && row.resolution_source !== "second_market_clob_unresolved"
    ) ?? null;
}

function resolutionExitPrice(outcome: PolymarketOutcomeRow, side: SecondMarketSide): number {
    if (outcome.resolved_outcome_up === 1) return side === "yes" ? 1 : 0;
    return side === "yes" ? 0 : 1;
}

function findProtectionExitForPosition(
    state: ExecutionLabPaperState,
    input: ExecutionLabPaperTickInput,
    position: ExecutionLabOpenPaperPosition,
    latestAllowedTs: number | null
): { reason: Extract<ExecutionLabPaperExitReason, "polymarket_take_profit" | "polymarket_stop_loss">; fill: FillRef; exitPrice: number } | null {
    const throughTs = latestAllowedTs === null
        ? input.latestCandleTimeSec
        : Math.min(input.latestCandleTimeSec, latestAllowedTs);
    if (throughTs <= position.entryQuoteTs) {
        return null;
    }
    const settings = state.snapshot.backtestSettings;
    const takeProfitCents = clampPolymarketProtectionCents(settings.polymarketProtectionTakeProfitCents);
    const stopLossCents = clampPolymarketProtectionCents(settings.polymarketProtectionStopLossCents);
    const takeProfitTarget = settings.polymarketProtectionTakeProfitEnabled === true && takeProfitCents > 0
        ? position.entryPrice + takeProfitCents / 100
        : null;
    const stopLossTrigger = settings.polymarketProtectionStopLossEnabled === true && stopLossCents > 0
        ? position.entryPrice - stopLossCents / 100
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

    const fills = findFillsInRange({
        event: eventFromPosition(position),
        symbol: state.snapshot.outcomeSymbol,
        afterTs: position.entryQuoteTs,
        throughTs,
        side: position.side,
        orderSide: "sell",
        quotes: input.quotes,
    });
    for (const fill of fills) {
        if (normalizedStopLossTrigger !== null && fill.price <= normalizedStopLossTrigger) {
            return { reason: "polymarket_stop_loss", fill, exitPrice: fill.price };
        }
        if (normalizedTakeProfitTarget !== null && fill.price >= normalizedTakeProfitTarget) {
            return { reason: "polymarket_take_profit", fill, exitPrice: normalizedTakeProfitTarget };
        }
    }
    return null;
}

function isExecutableBacktestExit(reason: Trade["exitReason"]): reason is ExecutionLabBacktestExitReason {
    return Boolean(reason) && reason !== "end_of_data" && reason !== "partial";
}

function shouldHoldPolymarketLegToResolution(snapshot: ExecutionLabSessionSnapshot): boolean {
    return snapshot.exitMode === "resolve_hold";
}

function findSignalForTrade(trade: Trade, signals: readonly ExecutionLabEvaluatedSignal[]): ExecutionLabEvaluatedSignal | null {
    const entryTs = toSec(trade.entryTime);
    if (entryTs === null) return null;
    const expectedSignalType = trade.type === "long" ? "buy" : "sell";
    let best: ExecutionLabEvaluatedSignal | null = null;
    for (const signal of signals) {
        if (signal.signalType !== expectedSignalType) continue;
        if (signal.signalTimeSec > entryTs) continue;
        if (!best || signal.signalTimeSec > best.signalTimeSec) best = signal;
    }
    return best;
}

function buildTradeId(snapshot: ExecutionLabSessionSnapshot, args: {
    event: EventRef;
    side: SecondMarketSide;
    signalTimeSec: number;
    entryTimeSec: number;
}): string {
    return [
        snapshot.sessionId,
        snapshot.strategyKey,
        snapshot.symbol,
        args.event.eventStartTs,
        args.side,
        args.signalTimeSec,
        args.entryTimeSec,
    ].join("|");
}

function eventFromPosition(position: ExecutionLabOpenPaperPosition): EventRef {
    return {
        seriesId: position.seriesId,
        eventStartTs: position.eventStartTs,
        eventEndTs: position.eventEndTs,
        marketSlug: position.marketSlug,
        conditionId: position.conditionId,
        yesTokenId: position.yesTokenId,
        noTokenId: position.noTokenId,
    };
}

function logOnce(state: ExecutionLabPaperState, key: string, records: ExecutionLabRecord[], record: ExecutionLabRecord): void {
    if (state.loggedFingerprints.has(key)) return;
    state.loggedFingerprints.add(key);
    records.push(record);
}

function buildSignalSeenRecord(
    state: ExecutionLabPaperState,
    input: ExecutionLabPaperTickInput,
    signal: ExecutionLabEvaluatedSignal
): SignalSeenRecord {
    return {
        ...baseRecord(state.snapshot, input.recordedAtIso),
        recordType: "signal_seen",
        signalTimeSec: signal.signalTimeSec,
        signalType: signal.signalType,
        signalPrice: signal.signal.price,
        signalReason: signal.signal.reason,
        candleClose: input.latestCandle.close,
        latestCandleTimeSec: input.latestCandleTimeSec,
        feedLagSec: input.feedLagSec,
    };
}

function logSignalSeenForTrade(
    state: ExecutionLabPaperState,
    input: ExecutionLabPaperTickInput,
    records: ExecutionLabRecord[],
    signal: ExecutionLabEvaluatedSignal | null
): void {
    if (!signal) return;
    logOnce(state, signalFingerprint(state.snapshot, signal), records, buildSignalSeenRecord(state, input, signal));
}

function buildEntryRecord(state: ExecutionLabPaperState, input: ExecutionLabPaperTickInput, position: ExecutionLabOpenPaperPosition, fill: FillRef): PaperEntryRecord {
    return {
        ...baseRecord(state.snapshot, input.recordedAtIso),
        recordType: "paper_entry",
        tradeId: position.tradeId,
        eventStartTs: position.eventStartTs,
        eventEndTs: position.eventEndTs,
        marketSlug: position.marketSlug,
        side: position.side,
        chartDirection: position.chartDirection,
        signalTimeSec: position.signalTimeSec,
        entryTimeSec: position.entryTimeSec,
        entryQuoteTs: fill.quoteTs,
        entryPrice: position.entryPrice,
        stakeUsd: position.stakeUsd,
        shares: position.shares,
        yesBid: fill.quote.yes_bid,
        yesAsk: fill.quote.yes_ask,
        noBid: fill.quote.no_bid,
        noAsk: fill.quote.no_ask,
        quoteAgeMs: fill.quote.quote_age_ms,
    };
}

function buildUnfilledRecord(
    state: ExecutionLabPaperState,
    input: ExecutionLabPaperTickInput,
    args: {
        reason: PaperUnfilledRecord["reason"];
        tradeId?: string;
        signalTimeSec: number;
        entryTimeSec: number | null;
        expectedExitTimeSec?: number;
        expectedExitReason?: string;
        side: SecondMarketSide | null;
        entryPrice?: number;
        event?: EventRef | null;
    }
): PaperUnfilledRecord {
    return {
        ...baseRecord(state.snapshot, input.recordedAtIso),
        recordType: "paper_unfilled",
        reason: args.reason,
        tradeId: args.tradeId,
        signalTimeSec: args.signalTimeSec,
        entryTimeSec: args.entryTimeSec,
        expectedExitTimeSec: args.expectedExitTimeSec,
        expectedExitReason: args.expectedExitReason,
        side: args.side,
        entryPrice: args.entryPrice,
        eventStartTs: args.event?.eventStartTs,
        eventEndTs: args.event?.eventEndTs,
        marketSlug: args.event?.marketSlug,
    };
}

function buildExitRecord(
    state: ExecutionLabPaperState,
    input: ExecutionLabPaperTickInput,
    position: ExecutionLabOpenPaperPosition,
    exitReason: ExecutionLabPaperExitReason,
    exitTimeSec: number,
    exitQuoteTs: number | null,
    exitPrice: number
): PaperExitRecord {
    const pnlUsd = position.shares * (exitPrice - position.entryPrice);
    return {
        ...baseRecord(state.snapshot, input.recordedAtIso),
        recordType: "paper_exit",
        tradeId: position.tradeId,
        exitReason,
        exitTimeSec,
        exitQuoteTs,
        exitPrice,
        entryPrice: position.entryPrice,
        stakeUsd: position.stakeUsd,
        shares: position.shares,
        pnlUsd,
        roiPct: position.stakeUsd > 0 ? (pnlUsd / position.stakeUsd) * 100 : 0,
        marketSlug: position.marketSlug,
    };
}

function closePositionFromRecord(
    state: ExecutionLabPaperState,
    position: ExecutionLabOpenPaperPosition,
    record: PaperExitRecord
): ExecutionLabClosedPaperTrade {
    const closed: ExecutionLabClosedPaperTrade = {
        tradeId: position.tradeId,
        side: position.side,
        chartDirection: position.chartDirection,
        entryTimeSec: position.entryTimeSec,
        exitTimeSec: record.exitTimeSec,
        entryPrice: record.entryPrice,
        exitPrice: record.exitPrice,
        stakeUsd: record.stakeUsd,
        shares: record.shares,
        pnlUsd: record.pnlUsd,
        roiPct: record.roiPct,
        exitReason: record.exitReason,
        marketSlug: record.marketSlug,
    };
    state.openPositions.delete(position.tradeId);
    state.pendingSettlements.delete(position.tradeId);
    state.closedTrades.push(closed);
    state.realizedPnlUsd += record.pnlUsd;
    state.totalClosed += 1;
    return closed;
}

function findOpenPositionForTrade(
    state: ExecutionLabPaperState,
    trade: Trade,
    entryTimeSec: number,
    side: SecondMarketSide
): ExecutionLabOpenPaperPosition | null {
    for (const position of state.openPositions.values()) {
        if (
            position.chartDirection === trade.type
            && position.side === side
            && position.entryTimeSec === entryTimeSec
        ) {
            return position;
        }
    }
    return null;
}

function entryMarker(position: ExecutionLabOpenPaperPosition): ExecutionLabPaperMarker {
    return {
        id: `entry:${position.tradeId}`,
        time: position.entryTimeSec as Time,
        kind: "entry",
        side: position.side,
        text: `PAPER ${position.side.toUpperCase()} @ ${position.entryPrice.toFixed(3)}`,
    };
}

function exitMarker(record: PaperExitRecord, side: SecondMarketSide): ExecutionLabPaperMarker {
    const pnl = record.pnlUsd >= 0 ? `+${record.pnlUsd.toFixed(2)}` : record.pnlUsd.toFixed(2);
    return {
        id: `exit:${record.tradeId}:${record.exitTimeSec}`,
        time: record.exitTimeSec as Time,
        kind: "exit",
        side,
        text: `EXIT ${record.exitPrice.toFixed(3)} (${pnl})`,
    };
}

export function createExecutionLabPaperState(snapshot: ExecutionLabSessionSnapshot): ExecutionLabPaperState {
    return {
        snapshot,
        lastProcessedCandleTimeSec: null,
        loggedFingerprints: new Set(),
        claimedEventKeys: new Set(),
        openPositions: new Map(),
        pendingSettlements: new Map(),
        closedTrades: [],
        realizedPnlUsd: 0,
        totalEntries: 0,
        totalClosed: 0,
    };
}

export function createSessionStartRecord(
    snapshot: ExecutionLabSessionSnapshot,
    liveConfig?: ExecutionLabLiveUiConfig
): SessionStartRecord {
    return {
        ...baseRecord(snapshot, snapshot.startedAtIso),
        recordType: "session_start",
        stakeUsd: snapshot.stakeUsd,
        strategyName: snapshot.strategyName,
        params: { ...snapshot.params },
        backtestSettings: { ...(snapshot.backtestSettings as Record<string, unknown>) },
        polymarketSettings: { ...snapshot.polymarketSettings },
        ...(liveConfig ? { liveConfig: { ...liveConfig } } : {}),
        allowMultipleTradesPerEvent: snapshot.allowMultipleTradesPerEvent,
    };
}

export function createSessionStopRecord(
    state: ExecutionLabPaperState,
    reason: SessionStopRecord["reason"],
    recordedAtIso: string,
    message?: string
): SessionStopRecord {
    return {
        ...baseRecord(state.snapshot, recordedAtIso),
        recordType: "session_stop",
        reason,
        ...(message ? { message } : {}),
        totalEntries: state.totalEntries,
        totalClosed: state.totalClosed,
        realizedPnlUsd: state.realizedPnlUsd,
    };
}

function settlePendingPositions(
    state: ExecutionLabPaperState,
    input: ExecutionLabPaperTickInput,
    records: ExecutionLabRecord[],
    markers: ExecutionLabPaperMarker[]
): void {
    for (const position of Array.from(state.pendingSettlements.values())) {
        const outcome = findResolvedOutcome(eventFromPosition(position), input.outcomes);
        if (!outcome) continue;
        const exitPrice = resolutionExitPrice(outcome, position.side);
        const exitRecord = buildExitRecord(state, input, position, "resolution", outcome.event_end_ts, null, exitPrice);
        logOnce(state, `exit:${position.tradeId}:resolution:${outcome.event_end_ts}`, records, exitRecord);
        closePositionFromRecord(state, position, exitRecord);
        markers.push(exitMarker(exitRecord, position.side));
    }
}

function advanceOpenPosition(
    state: ExecutionLabPaperState,
    input: ExecutionLabPaperTickInput,
    records: ExecutionLabRecord[],
    markers: ExecutionLabPaperMarker[],
    position: ExecutionLabOpenPaperPosition,
    trade: Trade,
    signalTimeSec: number,
    entryTimeSec: number
): void {
    position.sourceTrade = trade;
    const exitReason = isExecutableBacktestExit(trade.exitReason) ? trade.exitReason : null;
    const exitTimeSec = exitReason === null ? null : tradeExecutionTimeSec(state.snapshot, trade.exitTime);
    const positionEvent = eventFromPosition(position);
    const holdToResolution = shouldHoldPolymarketLegToResolution(state.snapshot);
    const protectionLatestTs = exitTimeSec !== null && exitTimeSec < position.eventEndTs ? exitTimeSec : null;
    const protectionExit = holdToResolution
        ? null
        : findProtectionExitForPosition(state, input, position, protectionLatestTs);

    if (protectionExit) {
        const exitRecord = buildExitRecord(
            state,
            input,
            position,
            protectionExit.reason,
            protectionExit.fill.quoteTs,
            protectionExit.fill.quoteTs,
            protectionExit.exitPrice
        );
        logOnce(state, `exit:${position.tradeId}:${protectionExit.reason}:${protectionExit.fill.quoteTs}`, records, exitRecord);
        closePositionFromRecord(state, position, exitRecord);
        markers.push(exitMarker(exitRecord, position.side));
        return;
    }

    if (!holdToResolution && exitReason !== null && exitTimeSec !== null && exitTimeSec <= input.latestCandleTimeSec && exitTimeSec < position.eventEndTs) {
        const exitFill = findExactFill({
            event: positionEvent,
            symbol: state.snapshot.outcomeSymbol,
            ts: exitTimeSec,
            side: position.side,
            orderSide: "sell",
            quotes: input.quotes,
        });
        if (exitFill) {
            const exitRecord = buildExitRecord(state, input, position, exitReason, exitFill.quoteTs, exitFill.quoteTs, exitFill.price);
            logOnce(state, `exit:${position.tradeId}:${exitReason}:${exitFill.quoteTs}`, records, exitRecord);
            closePositionFromRecord(state, position, exitRecord);
            markers.push(exitMarker(exitRecord, position.side));
            return;
        }
        logOnce(
            state,
            `unfilled:missing_exit_quote:${position.tradeId}:${exitTimeSec}`,
            records,
            buildUnfilledRecord(state, input, {
                reason: "missing_exit_quote",
                tradeId: position.tradeId,
                signalTimeSec,
                entryTimeSec,
                expectedExitTimeSec: exitTimeSec,
                expectedExitReason: exitReason,
                side: position.side,
                event: positionEvent,
            })
        );
        state.openPositions.delete(position.tradeId);
        state.pendingSettlements.delete(position.tradeId);
        return;
    }

    if (input.latestCandleTimeSec < position.eventEndTs) return;
    const outcome = findResolvedOutcome(positionEvent, input.outcomes);
    if (!outcome) {
        const pendingRecord: PaperResolutionPendingRecord = {
            ...baseRecord(state.snapshot, input.recordedAtIso),
            recordType: "paper_resolution_pending",
            tradeId: position.tradeId,
            eventStartTs: position.eventStartTs,
            eventEndTs: position.eventEndTs,
            marketSlug: position.marketSlug,
        };
        logOnce(state, `pending:${position.tradeId}`, records, pendingRecord);
        state.openPositions.delete(position.tradeId);
        state.pendingSettlements.set(position.tradeId, position);
        return;
    }

    const exitPrice = resolutionExitPrice(outcome, position.side);
    const exitRecord = buildExitRecord(state, input, position, "resolution", outcome.event_end_ts, null, exitPrice);
    logOnce(state, `exit:${position.tradeId}:resolution:${outcome.event_end_ts}`, records, exitRecord);
    closePositionFromRecord(state, position, exitRecord);
    markers.push(exitMarker(exitRecord, position.side));
}

export function evaluateExecutionLabPaperTick(
    state: ExecutionLabPaperState,
    input: ExecutionLabPaperTickInput
): ExecutionLabPaperTickResult {
    const previousProcessedCandleTimeSec = state.lastProcessedCandleTimeSec;
    if (previousProcessedCandleTimeSec !== null && input.latestCandleTimeSec <= previousProcessedCandleTimeSec) {
        return { records: [], markers: [], acceptedEntries: [] };
    }
    state.lastProcessedCandleTimeSec = input.latestCandleTimeSec;

    const records: ExecutionLabRecord[] = [];
    const markers: ExecutionLabPaperMarker[] = [];
    const acceptedEntries: ExecutionLabOpenPaperPosition[] = [];
    settlePendingPositions(state, input, records, markers);

    const sortedTrades = input.trades.slice().sort((left, right) => {
        const leftTs = tradeExecutionTimeSec(state.snapshot, left.entryTime) ?? 0;
        const rightTs = tradeExecutionTimeSec(state.snapshot, right.entryTime) ?? 0;
        return leftTs - rightTs || left.id - right.id;
    });

    for (const trade of sortedTrades) {
        const entryTimeSec = tradeExecutionTimeSec(state.snapshot, trade.entryTime);
        if (entryTimeSec === null) continue;
        if (entryTimeSec > input.latestCandleTimeSec) continue;
        const side = tradeDirectionToSide(trade.type);
        const tradeSignal = findSignalForTrade(trade, input.signals);
        const signalTimeSec = tradeSignal?.signalTimeSec ?? entryTimeSec;
        const existingOpenPosition = findOpenPositionForTrade(state, trade, entryTimeSec, side);
        if (existingOpenPosition) {
            advanceOpenPosition(state, input, records, markers, existingOpenPosition, trade, signalTimeSec, entryTimeSec);
            continue;
        }
        const isHistoricalEntry = previousProcessedCandleTimeSec !== null && entryTimeSec <= previousProcessedCandleTimeSec;
        const event = findEventForTime({
            seriesId: state.snapshot.seriesId,
            symbol: state.snapshot.outcomeSymbol,
            ts: entryTimeSec,
            outcomes: input.outcomes,
            quotes: input.quotes,
        });

        if (!event) {
            if (isHistoricalEntry) continue;
            logSignalSeenForTrade(state, input, records, tradeSignal);
            logOnce(
                state,
                `unfilled:missing_event:${entryTimeSec}:${side}`,
                records,
                buildUnfilledRecord(state, input, { reason: "missing_event", signalTimeSec, entryTimeSec, side })
            );
            continue;
        }

        const tradeId = buildTradeId(state.snapshot, { event, side, signalTimeSec, entryTimeSec });
        const openPosition = state.openPositions.get(tradeId);
        const alreadyClosed = state.closedTrades.some((closed) => closed.tradeId === tradeId);
        const claimKey = eventKey(event);
        if (isHistoricalEntry && !openPosition) continue;

        if (!openPosition && !alreadyClosed) {
            logSignalSeenForTrade(state, input, records, tradeSignal);
            if (state.openPositions.size > 0) {
                logOnce(
                    state,
                    `unfilled:open_position:${tradeId}`,
                    records,
                    buildUnfilledRecord(state, input, { reason: "open_position", signalTimeSec, entryTimeSec, side, event })
                );
                continue;
            }

            if (!state.snapshot.allowMultipleTradesPerEvent && state.claimedEventKeys.has(claimKey)) {
                logOnce(
                    state,
                    `unfilled:duplicate:${tradeId}`,
                    records,
                    buildUnfilledRecord(state, input, { reason: "duplicate_event", signalTimeSec, entryTimeSec, side, event })
                );
                continue;
            }

            const entryCutoff = resolvePolymarketEntryCutoff({
                entryTimeSec,
                eventEndTs: event.eventEndTs,
                enabled: state.snapshot.backtestSettings.polymarketEntryCutoffEnabled,
                cutoffSeconds: state.snapshot.backtestSettings.polymarketEntryCutoffSeconds,
            });
            if (!entryCutoff.allowed) {
                logOnce(
                    state,
                    `unfilled:entry_too_close_to_close:${tradeId}`,
                    records,
                    buildUnfilledRecord(state, input, { reason: "entry_too_close_to_close", signalTimeSec, entryTimeSec, side, event })
                );
                continue;
            }

            const entryFill = findExactFill({
                event,
                symbol: state.snapshot.outcomeSymbol,
                ts: entryTimeSec,
                side,
                orderSide: "buy",
                quotes: input.quotes,
            });
            if (!entryFill) {
                logOnce(
                    state,
                    `unfilled:missing_entry_quote:${tradeId}`,
                    records,
                    buildUnfilledRecord(state, input, { reason: "missing_entry_quote", signalTimeSec, entryTimeSec, side, event })
                );
                continue;
            }
            if (isPolymarketEntryPriceFiltered(
                entryFill.price,
                state.snapshot.backtestSettings.polymarketEntryPriceFilterCents
            )) {
                logOnce(
                    state,
                    `unfilled:entry_price_filtered:${tradeId}`,
                    records,
                    buildUnfilledRecord(state, input, { reason: "entry_price_filtered", signalTimeSec, entryTimeSec, side, entryPrice: entryFill.price, event })
                );
                continue;
            }

            const shares = state.snapshot.stakeUsd / entryFill.price;
            if (!Number.isFinite(shares) || shares <= 0) {
                logOnce(
                    state,
                    `unfilled:invalid_price:${tradeId}`,
                    records,
                    buildUnfilledRecord(state, input, { reason: "invalid_price", signalTimeSec, entryTimeSec, side, entryPrice: entryFill.price, event })
                );
                continue;
            }

            const position: ExecutionLabOpenPaperPosition = {
                tradeId,
                sourceTrade: trade,
                seriesId: event.seriesId,
                eventStartTs: event.eventStartTs,
                eventEndTs: event.eventEndTs,
                marketSlug: event.marketSlug,
                conditionId: event.conditionId,
                yesTokenId: event.yesTokenId,
                noTokenId: event.noTokenId,
                side,
                chartDirection: trade.type,
                signalTimeSec,
                entryTimeSec,
                entryQuoteTs: entryFill.quoteTs,
                entryPrice: entryFill.price,
                stakeUsd: state.snapshot.stakeUsd,
                shares,
            };
            state.openPositions.set(tradeId, position);
            state.claimedEventKeys.add(claimKey);
            state.totalEntries += 1;
            logOnce(state, `entry:${tradeId}`, records, buildEntryRecord(state, input, position, entryFill));
            markers.push(entryMarker(position));
            acceptedEntries.push(position);
        }

        const position = state.openPositions.get(tradeId);
        if (!position) continue;
        advanceOpenPosition(state, input, records, markers, position, trade, signalTimeSec, entryTimeSec);
    }

    for (const position of Array.from(state.openPositions.values())) {
        if (input.latestCandleTimeSec < position.eventEndTs) continue;
        advanceOpenPosition(
            state,
            input,
            records,
            markers,
            position,
            position.sourceTrade,
            position.signalTimeSec,
            position.entryTimeSec
        );
    }

    return { records, markers, acceptedEntries };
}

export function buildEvaluatedSignals(signals: readonly { time: Time; type: string; price: number; reason?: string; barIndex?: number }[]): ExecutionLabEvaluatedSignal[] {
    const out: ExecutionLabEvaluatedSignal[] = [];
    for (const signal of signals) {
        if (signal.type !== "buy" && signal.type !== "sell") continue;
        const signalTimeSec = parseTimeToUnixSeconds(signal.time);
        if (signalTimeSec === null) continue;
        out.push({
            signal: signal as ExecutionLabEvaluatedSignal["signal"],
            signalTimeSec,
            signalType: signal.type,
        });
    }
    return out;
}
