import {
    getEffectivePolymarketSeriesId,
    getEffectivePolymarket5mSeriesId,
    isSupportedPolymarketOutcomeRun,
    loadPolymarketOutcomesForTimeRange,
    loadPolymarket5mOutcomesForTimeRange,
    resolvePolymarketOutcomeSymbol,
    supportsPolymarketOutcomeBridgeRun,
    isSupportedPolymarketMultiIntervalRun,
} from "./polymarket-btc5m";
import { parseTimeToUnixSeconds } from "./time-normalization";
import {
    type MappedPolymarketTrade as LegacyMappedPolymarketTrade,
    findContainingEvent,
    calculateEntryOffset as calculateMinuteEntryOffset,
    deduplicateByEvent as deduplicateByEventLegacy,
    filterByEntryOffset as filterByEntryOffsetLegacy,
    mapTradesToEvents,
    selectTradesForScoring as selectTradesForScoringLegacy,
} from "./polymarket-1m-5m-bridge";
import type { BacktestResult, OHLCVData, Trade } from "./types/strategies";
import type {
    BacktestPolymarketTimingProfileEntry,
    PolymarketEvalResult,
    PolymarketEvalRow,
    PolymarketOutcomeRow,
    BacktestPolymarketTradeSummary,
    PolymarketMarketEntryStatus,
} from "./types/polymarket-outcomes";
import type { PolymarketPricePoint } from "./local-sqlite-polymarket-api";
import { ensurePricePointsForOutcomes } from "./polymarket-price-points-ingest";
import { resolveEffectivePolymarketExitMode, isSignalExitSameEventMode } from "./polymarket-exit-mode";
import {
    isActualPolymarketEntryMinuteMode,
    type PolymarketEntrySelectionMode,
} from "./polymarket-entry-selection-mode";
import { evaluateSignalExitTrades, buildTradeAnnotationFromSignalExitResult } from "./polymarket-signal-exit-evaluator";
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
} from "./polymarket-post-signal-limit-entry";
import {
    DEFAULT_POLYMARKET_OUTCOME_INTERVAL,
    getPolymarketOutcomeIntervalDurationSec,
    resolvePolymarketOutcomeInterval,
    type PolymarketOutcomeInterval,
} from "./polymarket-outcome-interval";

function clampProbability(value: number | null): number | null {
    if (value === null || !Number.isFinite(value)) {
        return null;
    }
    if (value <= 0) return 0;
    if (value >= 1) return 1;
    return value;
}

function getYesPriceForOffset(outcome: PolymarketOutcomeRow, entryOffset: number): number | null {
    switch (entryOffset) {
        case 0:
            return outcome.yes_open_price;
        case 1:
            return outcome.yes_entry_minute_1_price;
        case 2:
            return outcome.yes_entry_minute_2_price;
        case 3:
            return outcome.yes_entry_minute_3_price;
        case 4:
            return outcome.yes_entry_minute_4_price;
        default:
            return null;
    }
}

export function getTradeMarketEntryPrice(
    outcome: PolymarketOutcomeRow,
    prediction: "yes" | "no",
    entryOffset = 0
): number | null {
    const yesPrice = clampProbability(getYesPriceForOffset(outcome, entryOffset));
    if (yesPrice === null) {
        return null;
    }
    return prediction === "yes"
        ? yesPrice
        : clampProbability(1 - yesPrice);
}

function getTradeMarketSidePrices(
    outcome: PolymarketOutcomeRow,
    entryOffset = 0
): {
    marketYesPrice: number | null;
    marketNoPrice: number | null;
} {
    const yesPrice = clampProbability(getYesPriceForOffset(outcome, entryOffset));
    return {
        marketYesPrice: yesPrice,
        marketNoPrice: yesPrice === null ? null : clampProbability(1 - yesPrice),
    };
}

function getTradePayoutFromPrice(
    marketEntryPrice: number | null,
    isWin: boolean
): number | null {
    if (marketEntryPrice === null || !Number.isFinite(marketEntryPrice)) {
        return null;
    }
    return isWin ? (1 - marketEntryPrice) : -marketEntryPrice;
}

function getProfitFactorFromPayoutTotals(grossProfit: number, grossLoss: number): number {
    if (!Number.isFinite(grossProfit) || grossProfit <= 0) {
        return 0;
    }
    if (!Number.isFinite(grossLoss) || grossLoss <= 0) {
        return Infinity;
    }
    return grossProfit / grossLoss;
}

type AnnotationContext = {
    symbol: string;
    interval: string;
    executionModel?: string;
    chartData: OHLCVData[];
    outcomeSymbol?: string;
    outcomeInterval?: PolymarketOutcomeInterval;
    polymarketEntrySelectionMode?: PolymarketEntrySelectionMode;
    polymarketExitMode?: "resolve_hold" | "signal_exit_same_event";
};

export interface PolymarketAnnotationRunOptions {
    selectedOffset?: number;
    pricePoints?: PolymarketPricePoint[];
    entrySelectionMode?: PolymarketEntrySelectionMode;
    limitEntry?: PolymarketPostSignalLimitEntrySettings;
}

export type PolymarketTradeEvaluationContext = {
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>;
    executionBarIndexByTs: Map<number, number>;
    evaluatedEvents: number;
    resolvedUpCount: number;
};

/**
 * Extended context for 1m -> 5m bridge evaluation.
 */
export type PolymarketBridgeEvaluationContext = {
    /** All outcome rows for containment lookup */
    outcomes: readonly PolymarketOutcomeRow[];
    /** Execution bar index by timestamp */
    executionBarIndexByTs: Map<number, number>;
    /** Evaluated events count from outcomes */
    evaluatedEvents: number;
    /** Resolved UP count from outcomes */
    resolvedUpCount: number;
};

export function filterTradesByPreviousClosedTradeExitReason(
    trades: readonly Trade[],
    previousExitReason: NonNullable<Trade["exitReason"]>
): Trade[] {
    const filteredTrades: Trade[] = [];

    for (let index = 1; index < trades.length; index += 1) {
        const currentTrade = trades[index];
        const priorTrade = trades[index - 1];
        const resolvedPreviousExitReason = priorTrade?.exitReason ?? "signal";

        if (resolvedPreviousExitReason === "end_of_data") {
            continue;
        }

        if (resolvedPreviousExitReason === previousExitReason) {
            filteredTrades.push(currentTrade);
        }
    }

    return filteredTrades;
}

function buildPolymarketEvaluationIndexContext(
    chartData: OHLCVData[],
    outcomes: PolymarketOutcomeRow[]
): Pick<PolymarketTradeEvaluationContext, "executionBarIndexByTs" | "evaluatedEvents" | "resolvedUpCount"> {
    const executionBarIndexByTs = new Map<number, number>();
    const validTargetTs = new Set<number>();

    for (let i = 0; i < chartData.length; i++) {
        const ts = parseTimeToUnixSeconds(chartData[i]?.time);
        if (ts === null) continue;
        if (!executionBarIndexByTs.has(ts)) {
            executionBarIndexByTs.set(ts, i);
        }
        if (i > 0) {
            validTargetTs.add(ts);
        }
    }

    let evaluatedEvents = 0;
    let resolvedUpCount = 0;
    for (const row of outcomes) {
        if (!validTargetTs.has(row.event_start_ts)) continue;
        evaluatedEvents++;
        resolvedUpCount += row.resolved_outcome_up;
    }

    return {
        executionBarIndexByTs,
        evaluatedEvents,
        resolvedUpCount,
    };
}

export function createPolymarketTradeEvaluationContext(
    chartData: OHLCVData[],
    outcomes: PolymarketOutcomeRow[]
): PolymarketTradeEvaluationContext {
    const shared = buildPolymarketEvaluationIndexContext(chartData, outcomes);
    return {
        outcomeByStartTs: new Map(outcomes.map((row) => [Number(row.event_start_ts), row] as const)),
        ...shared,
    };
}

export function createPolymarketBridgeEvaluationContext(
    chartData: OHLCVData[],
    outcomes: PolymarketOutcomeRow[]
): PolymarketBridgeEvaluationContext {
    const shared = buildPolymarketEvaluationIndexContext(chartData, outcomes);
    return {
        outcomes,
        ...shared,
    };
}

function buildAnnotatedTrade(
    trade: Trade,
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>
): Trade {
    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
    if (entryTs === null) {
        return { ...trade, polymarketOutcome: null };
    }

    const outcome = outcomeByStartTs.get(entryTs);
    if (!outcome) {
        return { ...trade, polymarketOutcome: null };
    }

    const prediction = trade.type === "long" ? "yes" : "no";
    const isWin = prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;

    return {
        ...trade,
        polymarketOutcome: {
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            marketSlug: outcome.market_slug || outcome.event_slug,
            prediction,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin,
            ...getTradeMarketSidePrices(outcome),
            marketEntryPrice: getTradeMarketEntryPrice(outcome, prediction),
        },
    };
}

/**
 * Build an annotated trade for 1m -> 5m bridge evaluation.
 * Uses containment-based event lookup instead of exact timestamp match.
 */
function buildAnnotatedTradeForBridge(
    trade: Trade,
    outcomes: readonly PolymarketOutcomeRow[],
    selectedOffset?: number,
    entrySelectionMode: PolymarketEntrySelectionMode = "fixed_offset"
): Trade {
    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
    if (entryTs === null) {
        return { ...trade, polymarketOutcome: null };
    }

    const outcome = findContainingEvent(entryTs, outcomes);
    if (!outcome) {
        return { ...trade, polymarketOutcome: null };
    }

    const entryOffset = calculateMinuteEntryOffset(entryTs, outcome.event_start_ts);
    if (entryOffset < 0 || entryOffset > 4) {
        return { ...trade, polymarketOutcome: null };
    }

    // Filter by selected offset if specified
    if (!isActualPolymarketEntryMinuteMode(entrySelectionMode) && selectedOffset !== undefined && entryOffset !== selectedOffset) {
        return { ...trade, polymarketOutcome: null };
    }

    const prediction = trade.type === "long" ? "yes" : "no";
    const isWin = prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;

    return {
        ...trade,
        polymarketOutcome: {
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            marketSlug: outcome.market_slug || outcome.event_slug,
            prediction,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin,
            ...getTradeMarketSidePrices(outcome, entryOffset),
            marketEntryPrice: getTradeMarketEntryPrice(outcome, prediction, entryOffset),
            entryOffset,
        },
    };
}

function calculateEntryOffsetWithinSession(entryTs: number, outcome: PolymarketOutcomeRow): number {
    if (entryTs < outcome.event_start_ts || entryTs >= outcome.event_end_ts) {
        return -1;
    }
    return Math.floor((entryTs - outcome.event_start_ts) / 60);
}

function buildPricePointsByEventStart(
    pricePoints: readonly PolymarketPricePoint[]
): Map<number, PolymarketPricePoint[]> {
    const byEventStart = new Map<number, PolymarketPricePoint[]>();
    for (const point of pricePoints) {
        let rows = byEventStart.get(point.event_start_ts);
        if (!rows) {
            rows = [];
            byEventStart.set(point.event_start_ts, rows);
        }
        rows.push(point);
    }
    for (const rows of byEventStart.values()) {
        rows.sort((left, right) => left.ts - right.ts);
    }
    return byEventStart;
}

function selectPricePointOutcomesForTrades(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[]
): PolymarketOutcomeRow[] {
    const byEventStart = new Map<number, PolymarketOutcomeRow>();
    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;

        const outcome = findContainingEvent(entryTs, outcomes);
        if (outcome) {
            byEventStart.set(outcome.event_start_ts, outcome);
        }
    }
    return Array.from(byEventStart.values());
}

function findFirstPricePointAtOrAfterEntry(
    outcome: PolymarketOutcomeRow,
    entryTs: number,
    pricePointsByEventStart: Map<number, PolymarketPricePoint[]>
): PolymarketPricePoint | null {
    const rows = pricePointsByEventStart.get(outcome.event_start_ts);
    if (!rows || rows.length === 0) {
        return null;
    }
    for (const row of rows) {
        if (row.ts < entryTs) {
            continue;
        }
        if (row.ts >= outcome.event_end_ts) {
            break;
        }
        return row;
    }
    return null;
}

function buildAnnotatedTradeForNativeSession(
    trade: Trade,
    outcomes: readonly PolymarketOutcomeRow[],
    pricePointsByEventStart: Map<number, PolymarketPricePoint[]>
): Trade {
    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
    if (entryTs === null) {
        return { ...trade, polymarketOutcome: null };
    }

    const outcome = findContainingEvent(entryTs, outcomes);
    if (!outcome) {
        return { ...trade, polymarketOutcome: null };
    }

    const entryOffset = calculateEntryOffsetWithinSession(entryTs, outcome);
    const prediction = trade.type === "long" ? "yes" : "no";
    const isWin = prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;
    const entryPricePoint = findFirstPricePointAtOrAfterEntry(outcome, entryTs, pricePointsByEventStart);
    const marketYesPrice = clampProbability(entryPricePoint?.yes_price ?? null);
    const marketNoPrice = clampProbability(entryPricePoint?.no_price ?? (
        marketYesPrice === null ? null : 1 - marketYesPrice
    ));
    const marketEntryPrice = prediction === "yes" ? marketYesPrice : marketNoPrice;

    return {
        ...trade,
        polymarketOutcome: {
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            marketSlug: outcome.market_slug || outcome.event_slug,
            prediction,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin,
            marketYesPrice,
            marketNoPrice,
            marketEntryPrice,
            entryOffset: entryOffset >= 0 ? entryOffset : undefined,
        },
    };
}

function buildSkippedAnnotatedTradeForBridge(
    trade: Trade,
    mappedTrade: LegacyMappedPolymarketTrade,
    reason: "duplicate" | "filtered"
): Trade {
    const prediction = trade.type === "long" ? "yes" : "no";
    return {
        ...trade,
        polymarketOutcome: {
            eventStartTs: mappedTrade.outcome.event_start_ts,
            eventEndTs: mappedTrade.outcome.event_end_ts,
            eventSlug: mappedTrade.outcome.event_slug,
            marketSlug: mappedTrade.outcome.market_slug || mappedTrade.outcome.event_slug,
            prediction,
            actualOutcomeUp: mappedTrade.outcome.resolved_outcome_up,
            isWin: null,
            entryOffset: mappedTrade.entryOffset,
            evaluationMode: "resolve_hold",
            marketExitSource: reason,
            isProfitable: null,
            marketEntryPrice: null,
            marketExitPrice: null,
            marketExitTs: null,
            marketPnl: null,
        },
    };
}

function buildLimitEntrySidePrices(
    prediction: "yes" | "no",
    limitPrice: number
): {
    marketYesPrice: number | null;
    marketNoPrice: number | null;
} {
    return prediction === "yes"
        ? { marketYesPrice: limitPrice, marketNoPrice: clampProbability(1 - limitPrice) }
        : { marketYesPrice: clampProbability(1 - limitPrice), marketNoPrice: limitPrice };
}

function buildLimitEntryAnnotatedTrade(args: {
    trade: Trade;
    outcome: PolymarketOutcomeRow;
    status: PolymarketMarketEntryStatus;
    limitPrice: number;
    fillTs?: number | null;
    entryImprovement?: number | null;
    exitTargetPrice?: number | null;
    exitStatus?: NonNullable<Trade["polymarketOutcome"]>["marketExitStatus"];
    exitPrice?: number | null;
    exitTs?: number | null;
    exitSource?: NonNullable<Trade["polymarketOutcome"]>["marketExitSource"];
}): Trade {
    const { trade, outcome, status, limitPrice } = args;
    const prediction = trade.type === "long" ? "yes" : "no";
    const isFilled = status === "filled";
    const isWin = prediction === "yes"
        ? outcome.resolved_outcome_up === 1
        : outcome.resolved_outcome_up === 0;
    const fallbackExitPrice = isFilled
        ? isWin ? 1 : 0
        : null;
    const marketExitPrice = isFilled
        ? args.exitPrice ?? fallbackExitPrice
        : null;
    const marketPnl = isFilled && marketExitPrice !== null
        ? marketExitPrice - limitPrice
        : null;
    const isProfitable = marketPnl === null
        ? null
        : marketPnl > 0
            ? true
            : marketPnl < 0
                ? false
                : null;
    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
    const entryOffset = entryTs === null ? -1 : calculateEntryOffsetWithinSession(entryTs, outcome);

    return {
        ...trade,
        polymarketOutcome: {
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            marketSlug: outcome.market_slug || outcome.event_slug,
            prediction,
            actualOutcomeUp: outcome.resolved_outcome_up,
            isWin: isFilled ? isWin : null,
            ...buildLimitEntrySidePrices(prediction, limitPrice),
            marketEntrySource: "limit",
            marketEntryStatus: status,
            marketEntryFillTs: isFilled ? args.fillTs ?? null : null,
            marketEntryLimitPrice: limitPrice,
            marketEntryImprovement: isFilled ? args.entryImprovement ?? null : null,
            marketEntryPrice: isFilled ? limitPrice : null,
            marketExitPrice,
            marketExitTs: isFilled ? args.exitTs ?? outcome.event_end_ts : null,
            marketExitSource: status === "duplicate" ? "duplicate" : isFilled ? args.exitSource ?? "resolution" : "missing",
            marketExitTargetPrice: args.exitTargetPrice,
            marketExitStatus: args.exitStatus,
            marketPnl,
            evaluationMode: "resolve_hold",
            isProfitable,
            entryOffset: entryOffset >= 0 ? entryOffset : undefined,
        },
    };
}

function annotateTradesWithLimitEntryForRun(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[],
    pricePointsByEventStart: Map<number, PolymarketPricePoint[]>,
    settings: PolymarketPostSignalLimitEntrySettings
): Trade[] {
    const limitPriceCents = clampPolymarketPostSignalLimitEntryPriceCents(settings.priceCents);
    const fixedLimitPrice = limitPriceCents / 100;
    const priceMode = resolvePolymarketPostSignalLimitEntryMode(settings.priceMode);
    const offsetPrice = clampPolymarketPostSignalLimitOffsetCents(settings.offsetCents) / 100;
    const seenEvents = new Set<number>();
    const limitPriceByEventStart = new Map<number, number>();

    return trades.map((trade) => {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) {
            return { ...trade, polymarketOutcome: null };
        }

        const outcome = findContainingEvent(entryTs, outcomes);
        if (!outcome) {
            return { ...trade, polymarketOutcome: null };
        }

        if (seenEvents.has(outcome.event_start_ts)) {
            return buildLimitEntryAnnotatedTrade({
                trade,
                outcome,
                status: "duplicate",
                limitPrice: limitPriceByEventStart.get(outcome.event_start_ts) ?? fixedLimitPrice,
            });
        }

        const side = trade.type === "long" ? "yes" : "no";
        const eventPoints = pricePointsByEventStart.get(outcome.event_start_ts) ?? [];
        const fill = findPostSignalLimitEntryFill(eventPoints, {
            side,
            startTs: entryTs,
            eventEndTs: outcome.event_end_ts,
            limitPrice: fixedLimitPrice,
            priceMode,
            offsetPrice,
        });
        const resolvedLimitPrice = fill.limitPrice ?? fixedLimitPrice;
        limitPriceByEventStart.set(outcome.event_start_ts, resolvedLimitPrice);
        if (fill.status === "filled") {
            seenEvents.add(outcome.event_start_ts);
        }
        const exitTargetPrice = fill.status === "filled" && settings.exitEnabled
            ? resolvePolymarketLimitExitTargetPrice(resolvedLimitPrice, settings)
            : null;
        const exitFill = fill.status === "filled" && settings.exitEnabled
            ? findPostSignalLimitExitFill(eventPoints, {
                side,
                startTs: fill.fillTs ?? entryTs,
                eventEndTs: outcome.event_end_ts,
                targetPrice: exitTargetPrice,
            })
            : null;

        return buildLimitEntryAnnotatedTrade({
            trade,
            outcome,
            status: fill.status,
            limitPrice: resolvedLimitPrice,
            fillTs: fill.fillTs,
            entryImprovement: fill.entryImprovement,
            exitTargetPrice,
            exitStatus: exitFill?.status,
            exitPrice: exitFill?.status === "filled" ? exitFill.fillPrice : undefined,
            exitTs: exitFill?.status === "filled" ? exitFill.fillTs : undefined,
            exitSource: exitFill?.status === "filled" ? "target" : undefined,
        });
    });
}

function summarizeLimitEntryTrades(
    trades: readonly Trade[],
    settings?: PolymarketPostSignalLimitEntrySettings
): Pick<
    BacktestPolymarketTradeSummary,
    | "targetExitedTrades"
    | "limitEntryEnabled"
    | "limitEntryMode"
    | "limitEntryPriceCents"
    | "limitEntryOffsetCents"
    | "limitEntryAttempts"
    | "limitEntryFilledTrades"
    | "limitEntryMissedTrades"
    | "limitEntryNotTouchedTrades"
    | "limitEntryLastMinuteOnlyTrades"
    | "limitEntryMissingPriceTrades"
    | "limitEntryInvalidWindowTrades"
    | "limitEntryFillRate"
    | "avgLimitEntryWaitSec"
    | "avgLimitEntryImprovement"
    | "limitExitEnabled"
    | "limitExitMode"
    | "limitExitPriceCents"
    | "limitExitOffsetCents"
    | "limitExitFilledTrades"
    | "limitExitFallbackTrades"
    | "limitExitUnreachableTrades"
> {
    let attempts = 0;
    let filled = 0;
    let notTouched = 0;
    let lastMinuteOnly = 0;
    let missingPrice = 0;
    let invalidWindow = 0;
    let totalWaitSec = 0;
    let waitCount = 0;
    let totalImprovement = 0;
    let improvementCount = 0;
    let limitEntryPriceCents: number | undefined;
    let limitExitFilledTrades = 0;
    let limitExitFallbackTrades = 0;
    let limitExitUnreachableTrades = 0;
    const limitExitEnabled = settings?.exitEnabled === true;

    for (const trade of trades) {
        const outcome = trade.polymarketOutcome;
        if (!outcome || outcome.marketEntrySource !== "limit") {
            continue;
        }
        if (typeof outcome.marketEntryLimitPrice === "number" && Number.isFinite(outcome.marketEntryLimitPrice)) {
            limitEntryPriceCents = Math.round(outcome.marketEntryLimitPrice * 100);
        }
        const status = outcome.marketEntryStatus;
        if (!status || status === "duplicate") {
            continue;
        }

        attempts++;
        if (status === "filled") {
            filled++;
            if (limitExitEnabled) {
                if (outcome.marketExitSource === "target") {
                    limitExitFilledTrades++;
                } else {
                    limitExitFallbackTrades++;
                    if (outcome.marketExitStatus === "unreachable") {
                        limitExitUnreachableTrades++;
                    }
                }
            }
            const entryTs = parseTimeToUnixSeconds(trade.entryTime);
            if (entryTs !== null && typeof outcome.marketEntryFillTs === "number" && Number.isFinite(outcome.marketEntryFillTs)) {
                totalWaitSec += Math.max(0, outcome.marketEntryFillTs - entryTs);
                waitCount++;
            }
            if (typeof outcome.marketEntryImprovement === "number" && Number.isFinite(outcome.marketEntryImprovement)) {
                totalImprovement += outcome.marketEntryImprovement;
                improvementCount++;
            }
        } else if (status === "not_touched") {
            notTouched++;
        } else if (status === "last_minute_only") {
            lastMinuteOnly++;
        } else if (status === "missing_price_points") {
            missingPrice++;
        } else if (status === "invalid_window") {
            invalidWindow++;
        }
    }

    const missed = Math.max(0, attempts - filled);
    return {
        limitEntryEnabled: true,
        limitEntryMode: settings ? resolvePolymarketPostSignalLimitEntryMode(settings.priceMode) : undefined,
        limitEntryPriceCents: settings
            ? resolvePolymarketPostSignalLimitEntryMode(settings.priceMode) === "fixed_price"
                ? clampPolymarketPostSignalLimitEntryPriceCents(settings.priceCents)
                : undefined
            : limitEntryPriceCents,
        limitEntryOffsetCents: settings ? clampPolymarketPostSignalLimitOffsetCents(settings.offsetCents) : undefined,
        limitEntryAttempts: attempts,
        limitEntryFilledTrades: filled,
        limitEntryMissedTrades: missed,
        limitEntryNotTouchedTrades: notTouched,
        limitEntryLastMinuteOnlyTrades: lastMinuteOnly,
        limitEntryMissingPriceTrades: missingPrice,
        limitEntryInvalidWindowTrades: invalidWindow,
        limitEntryFillRate: attempts > 0 ? filled / attempts : 0,
        avgLimitEntryWaitSec: waitCount > 0 ? totalWaitSec / waitCount : undefined,
        avgLimitEntryImprovement: improvementCount > 0 ? totalImprovement / improvementCount : undefined,
        targetExitedTrades: limitExitEnabled ? limitExitFilledTrades : undefined,
        limitExitEnabled: limitExitEnabled || undefined,
        limitExitMode: limitExitEnabled ? resolvePolymarketPostSignalLimitExitMode(settings?.exitMode) : undefined,
        limitExitPriceCents: limitExitEnabled ? clampPolymarketPostSignalLimitExitPriceCents(settings?.exitPriceCents) : undefined,
        limitExitOffsetCents: limitExitEnabled ? clampPolymarketPostSignalLimitOffsetCents(settings?.exitOffsetCents) : undefined,
        limitExitFilledTrades: limitExitEnabled ? limitExitFilledTrades : undefined,
        limitExitFallbackTrades: limitExitEnabled ? limitExitFallbackTrades : undefined,
        limitExitUnreachableTrades: limitExitEnabled ? limitExitUnreachableTrades : undefined,
    };
}

export function annotateTradesWithPolymarketOutcomes(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[]
): Trade[] {
    const outcomeByStartTs = new Map(outcomes.map((row) => [Number(row.event_start_ts), row] as const));
    return trades.map((trade) => buildAnnotatedTrade(trade, outcomeByStartTs));
}

export function annotateTradesWithPolymarketOutcomesForRun(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[],
    interval: string,
    selectedOffset?: number,
    entrySelectionMode: PolymarketEntrySelectionMode = "fixed_offset",
    options?: {
        outcomeInterval?: PolymarketOutcomeInterval;
        pricePoints?: readonly PolymarketPricePoint[];
        limitEntry?: PolymarketPostSignalLimitEntrySettings;
    }
): Trade[] {
    const resolvedOutcomeInterval = resolvePolymarketOutcomeInterval(options?.outcomeInterval);
    if (resolvedOutcomeInterval === "5m" && options?.limitEntry?.enabled) {
        const pricePointsByEventStart = buildPricePointsByEventStart(options.pricePoints ?? []);
        return annotateTradesWithLimitEntryForRun(
            trades,
            outcomes,
            pricePointsByEventStart,
            options.limitEntry
        );
    }

    if (resolvedOutcomeInterval !== "5m") {
        const pricePointsByEventStart = buildPricePointsByEventStart(options?.pricePoints ?? []);
        return trades.map((trade) => buildAnnotatedTradeForNativeSession(
            trade,
            outcomes,
            pricePointsByEventStart
        ));
    }

    if (interval !== "1m") {
        return annotateTradesWithPolymarketOutcomes(trades, outcomes);
    }

    const mappedTrades = mapTradesToEvents(trades, outcomes);
    const mappedTradeByTrade = new Map(mappedTrades.map((mapped) => [mapped.trade, mapped] as const));
    const selectedTrades = selectTradesForScoringLegacy(trades, outcomes, "1m", selectedOffset, entrySelectionMode);
    const selectedTradeSet = new Set(selectedTrades.map((mapped: LegacyMappedPolymarketTrade) => mapped.trade));
    const isActualMinuteMode = isActualPolymarketEntryMinuteMode(entrySelectionMode);
    const resolvedOffset = selectedOffset ?? 0;

    return trades.map((trade) => {
        if (selectedTradeSet.has(trade)) {
            return buildAnnotatedTradeForBridge(trade, outcomes, selectedOffset, entrySelectionMode);
        }

        const mappedTrade = mappedTradeByTrade.get(trade);
        if (!mappedTrade) {
            return { ...trade, polymarketOutcome: null };
        }

        if (isActualMinuteMode) {
            return buildSkippedAnnotatedTradeForBridge(trade, mappedTrade, "duplicate");
        }

        if (mappedTrade.entryOffset !== resolvedOffset) {
            return buildSkippedAnnotatedTradeForBridge(trade, mappedTrade, "filtered");
        }

        return buildSkippedAnnotatedTradeForBridge(trade, mappedTrade, "duplicate");
    });
}

export function evaluatePolymarketBacktestTrades(args: {
    chartData: OHLCVData[];
    trades: Trade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
    context?: PolymarketTradeEvaluationContext;
    includeRows?: boolean;
}): PolymarketEvalResult {
    const { trades, strategyKey } = args;
    const context = args.context ?? createPolymarketTradeEvaluationContext(args.chartData, args.outcomes);
    const includeRows = args.includeRows !== false;
    const rows: PolymarketEvalRow[] = [];
    let wins = 0;
    let losses = 0;
    let longPredictions = 0;
    let shortPredictions = 0;
    let scoredLongPredictions = 0;
    let scoredShortPredictions = 0;
    let longWins = 0;
    let shortWins = 0;
    let missingOutcomeRows = 0;
    let pricedPredictions = 0;
    let totalEntryPrice = 0;
    let totalPayout = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    for (const trade of trades) {
        if (trade.type === "long") {
            longPredictions++;
        } else {
            shortPredictions++;
        }

        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) {
            missingOutcomeRows++;
            continue;
        }

        const outcome = context.outcomeByStartTs.get(entryTs);
        if (!outcome) {
            missingOutcomeRows++;
            continue;
        }

        const prediction = trade.type === "long" ? "yes" : "no";
        const isWin = prediction === "yes"
            ? outcome.resolved_outcome_up === 1
            : outcome.resolved_outcome_up === 0;
        const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction);
        const payout = getTradePayoutFromPrice(marketEntryPrice, isWin);

        if (trade.type === "long") {
            scoredLongPredictions++;
        } else {
            scoredShortPredictions++;
        }

        if (isWin) {
            wins++;
            if (trade.type === "long") longWins++;
            else shortWins++;
        } else {
            losses++;
        }

        if (marketEntryPrice !== null && payout !== null) {
            pricedPredictions++;
            totalEntryPrice += marketEntryPrice;
            totalPayout += payout;
            if (payout > 0) {
                grossProfit += payout;
            } else if (payout < 0) {
                grossLoss += Math.abs(payout);
            }
        }

        if (includeRows) {
            const executionBarIndex = context.executionBarIndexByTs.get(entryTs);
            const signalBarIndex = executionBarIndex === undefined ? -1 : Math.max(0, executionBarIndex - 1);
            const signalTime = signalBarIndex >= 0
                ? (parseTimeToUnixSeconds(args.chartData[signalBarIndex]?.time) ?? entryTs)
                : entryTs;
            rows.push({
                eventStartTs: outcome.event_start_ts,
                eventEndTs: outcome.event_end_ts,
                eventSlug: outcome.event_slug,
                signalBarIndex,
                signalTime,
                prediction,
                actualOutcomeUp: outcome.resolved_outcome_up,
                isWin,
                signalReason: undefined,
                strategyKey,
            });
        }
    }

    const predictionsTaken = trades.length;
    const scoredCount = includeRows ? rows.length : wins + losses;
    const avgEntryPrice = pricedPredictions > 0 ? totalEntryPrice / pricedPredictions : 0;
    const breakEvenWinRate = avgEntryPrice;
    const expectancy = pricedPredictions > 0 ? totalPayout / pricedPredictions : 0;

    return {
        evaluatedEvents: context.evaluatedEvents,
        predictionsTaken,
        scoredPredictions: scoredCount,
        pricedPredictions,
        profitFactor: getProfitFactorFromPayoutTotals(grossProfit, grossLoss),
        grossProfit,
        grossLoss,
        wins,
        losses,
        skips: Math.max(0, context.evaluatedEvents - scoredCount),
        winRate: scoredCount > 0 ? wins / scoredCount : 0,
        coverage: context.evaluatedEvents > 0 ? scoredCount / context.evaluatedEvents : 0,
        longPredictions,
        shortPredictions,
        longWins,
        shortWins,
        longWinRate: scoredLongPredictions > 0 ? longWins / scoredLongPredictions : 0,
        shortWinRate: scoredShortPredictions > 0 ? shortWins / scoredShortPredictions : 0,
        alwaysYesBaselineWinRate: context.evaluatedEvents > 0 ? context.resolvedUpCount / context.evaluatedEvents : 0,
        alwaysNoBaselineWinRate: context.evaluatedEvents > 0 ? (context.evaluatedEvents - context.resolvedUpCount) / context.evaluatedEvents : 0,
        avgEntryPrice,
        breakEvenWinRate,
        expectancy,
        edgeVsBreakEven: (scoredCount > 0 ? wins / scoredCount : 0) - breakEvenWinRate,
        missingOutcomeRows,
        ignoredSignals: 0,
        rows,
    };
}

/**
 * Evaluate Polymarket backtest trades for 1m -> 5m bridge runs.
 *
 * This function:
 * - Maps 1m trade entry times into containing 5m Polymarket events
 * - Filters trades by selected entry offset (0..4)
 * - Deduplicates multiple trades in the same event+offset bucket
 * - Scores only the first trade per event
 *
 * @param args - Evaluation arguments
 * @returns Polymarket evaluation result with offset-aware metrics
 */
export function evaluatePolymarketBacktestTrades1mBridge(args: {
    chartData: OHLCVData[];
    trades: Trade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
    selectedOffset: number;
    includeRows?: boolean;
    context?: PolymarketBridgeEvaluationContext;
}): PolymarketEvalResult {
    const { chartData, trades, outcomes, strategyKey, selectedOffset, context } = args;
    const includeRows = args.includeRows !== false;

    const mappedTrades = mapTradesToEvents(trades, outcomes);
    return evaluateMappedPolymarketBacktestTrades1mBridge({
        chartData,
        mappedTrades,
        outcomes,
        strategyKey,
        selectedOffset,
        includeRows,
        predictionsTaken: trades.length,
        context,
    });
}

export function evaluateMappedPolymarketBacktestTrades1mBridge(args: {
    chartData: OHLCVData[];
    mappedTrades: readonly LegacyMappedPolymarketTrade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
    selectedOffset: number;
    includeRows?: boolean;
    predictionsTaken?: number;
    context?: PolymarketBridgeEvaluationContext;
}): PolymarketEvalResult {
    const { chartData, mappedTrades, outcomes, strategyKey, selectedOffset } = args;
    const includeRows = args.includeRows !== false;
    const context = args.context ?? createPolymarketBridgeEvaluationContext(chartData, outcomes);

    const filteredForOffset = filterByEntryOffsetLegacy(mappedTrades, selectedOffset);
    const selected = deduplicateByEventLegacy(filteredForOffset);
    const executionBarIndexByTs = context.executionBarIndexByTs;
    const evaluatedEvents = context.evaluatedEvents;
    const resolvedUpCount = context.resolvedUpCount;

    // Evaluate selected trades
    const rows: PolymarketEvalRow[] = [];
    let wins = 0;
    let losses = 0;
    let longPredictions = 0;
    let shortPredictions = 0;
    let scoredLongPredictions = 0;
    let scoredShortPredictions = 0;
    let longWins = 0;
    let shortWins = 0;
    let missingOutcomeRows = 0;
    let pricedPredictions = 0;
    let totalEntryPrice = 0;
    let totalPayout = 0;
    let grossProfit = 0;
    let grossLoss = 0;

    for (const mapped of selected) {
        const { trade, outcome, entryOffset, entryTs } = mapped;

        if (trade.type === "long") {
            longPredictions++;
        } else {
            shortPredictions++;
        }

        const prediction = trade.type === "long" ? "yes" : "no";
        const isWin = prediction === "yes"
            ? outcome.resolved_outcome_up === 1
            : outcome.resolved_outcome_up === 0;
        const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction, entryOffset);
        const payout = getTradePayoutFromPrice(marketEntryPrice, isWin);

        if (trade.type === "long") {
            scoredLongPredictions++;
        } else {
            scoredShortPredictions++;
        }

        if (isWin) {
            wins++;
            if (trade.type === "long") longWins++;
            else shortWins++;
        } else {
            losses++;
        }

        if (marketEntryPrice !== null && payout !== null) {
            pricedPredictions++;
            totalEntryPrice += marketEntryPrice;
            totalPayout += payout;
            if (payout > 0) {
                grossProfit += payout;
            } else if (payout < 0) {
                grossLoss += Math.abs(payout);
            }
        }

        if (includeRows) {
            const executionBarIndex = executionBarIndexByTs.get(entryTs);
            const signalBarIndex = executionBarIndex === undefined ? -1 : Math.max(0, executionBarIndex - 1);
            const signalTime = signalBarIndex >= 0
                ? (parseTimeToUnixSeconds(chartData[signalBarIndex]?.time) ?? entryTs)
                : entryTs;
            rows.push({
                eventStartTs: outcome.event_start_ts,
                eventEndTs: outcome.event_end_ts,
                eventSlug: outcome.event_slug,
                signalBarIndex,
                signalTime,
                prediction,
                actualOutcomeUp: outcome.resolved_outcome_up,
                isWin,
                signalReason: undefined,
                strategyKey,
                entryOffset,
            });
        }
    }

    const predictionsTaken = Math.max(
        0,
        Number.isFinite(args.predictionsTaken) ? Number(args.predictionsTaken) : mappedTrades.length
    );
    const scoredCount = includeRows ? rows.length : wins + losses;
    const duplicateTradesIgnored = Math.max(0, filteredForOffset.length - selected.length);
    const avgEntryPrice = pricedPredictions > 0 ? totalEntryPrice / pricedPredictions : 0;
    const breakEvenWinRate = avgEntryPrice;
    const expectancy = pricedPredictions > 0 ? totalPayout / pricedPredictions : 0;

    return {
        evaluatedEvents,
        predictionsTaken,
        scoredPredictions: scoredCount,
        pricedPredictions,
        profitFactor: getProfitFactorFromPayoutTotals(grossProfit, grossLoss),
        grossProfit,
        grossLoss,
        wins,
        losses,
        skips: Math.max(0, evaluatedEvents - scoredCount),
        winRate: scoredCount > 0 ? wins / scoredCount : 0,
        coverage: evaluatedEvents > 0 ? scoredCount / evaluatedEvents : 0,
        longPredictions,
        shortPredictions,
        longWins,
        shortWins,
        longWinRate: scoredLongPredictions > 0 ? longWins / scoredLongPredictions : 0,
        shortWinRate: scoredShortPredictions > 0 ? shortWins / scoredShortPredictions : 0,
        alwaysYesBaselineWinRate: evaluatedEvents > 0 ? resolvedUpCount / evaluatedEvents : 0,
        alwaysNoBaselineWinRate: evaluatedEvents > 0 ? (evaluatedEvents - resolvedUpCount) / evaluatedEvents : 0,
        avgEntryPrice,
        breakEvenWinRate,
        expectancy,
        edgeVsBreakEven: (scoredCount > 0 ? wins / scoredCount : 0) - breakEvenWinRate,
        missingOutcomeRows,
        ignoredSignals: 0,
        entryOffset: selectedOffset,
        duplicateTradesIgnored,
        rows,
    };
}

export function buildPolymarketTimingProfileFor1mBridge(args: {
    chartData: OHLCVData[];
    trades: Trade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
}): BacktestPolymarketTimingProfileEntry[] {
    const profile: BacktestPolymarketTimingProfileEntry[] = [];
    const context = createPolymarketBridgeEvaluationContext(args.chartData, args.outcomes);

    for (let offset = 0; offset <= 4; offset++) {
        const evaluation = evaluatePolymarketBacktestTrades1mBridge({
            chartData: args.chartData,
            trades: args.trades,
            outcomes: args.outcomes,
            strategyKey: args.strategyKey,
            selectedOffset: offset,
            includeRows: false,
            context,
        });

        profile.push({
            entryOffset: offset,
            scoredTrades: evaluation.scoredPredictions,
            wins: evaluation.wins,
            losses: evaluation.losses,
            winRate: evaluation.winRate,
            coverage: evaluation.coverage,
            missingOutcomeRows: evaluation.missingOutcomeRows,
            duplicateTradesIgnored: evaluation.duplicateTradesIgnored ?? 0,
        });
    }

    return profile;
}

export function buildPolymarketTimingProfileForNativeSession(
    trades: readonly Trade[],
    outcomeInterval: PolymarketOutcomeInterval
): BacktestPolymarketTimingProfileEntry[] {
    const durationMinutes = Math.max(1, Math.round(getPolymarketOutcomeIntervalDurationSec(outcomeInterval) / 60));
    const profile = Array.from({ length: durationMinutes }, (_, entryOffset) => ({
        entryOffset,
        scoredTrades: 0,
        wins: 0,
        losses: 0,
        winRate: 0,
        coverage: 0,
        missingOutcomeRows: 0,
        duplicateTradesIgnored: 0,
    }));

    let scoredTradesTotal = 0;
    for (const trade of trades) {
        const outcome = trade.polymarketOutcome;
        if (!outcome || outcome.isWin === null) {
            continue;
        }
        const entryOffset = Number.isFinite(outcome.entryOffset)
            ? Math.max(0, Math.floor(Number(outcome.entryOffset)))
            : -1;
        if (entryOffset < 0 || entryOffset >= durationMinutes) {
            continue;
        }
        const bucket = profile[entryOffset];
        bucket.scoredTrades += 1;
        if (outcome.isWin) {
            bucket.wins += 1;
        } else {
            bucket.losses += 1;
        }
        scoredTradesTotal += 1;
    }

    for (const bucket of profile) {
        bucket.winRate = bucket.scoredTrades > 0 ? bucket.wins / bucket.scoredTrades : 0;
        bucket.coverage = scoredTradesTotal > 0 ? bucket.scoredTrades / scoredTradesTotal : 0;
    }

    return profile;
}

export function summarizePolymarketTradesForRun(args: {
    trades: readonly Trade[];
    outcomes: readonly PolymarketOutcomeRow[];
    interval: string;
    selectedOffset?: number;
    entrySelectionMode?: PolymarketEntrySelectionMode;
    timingProfile?: BacktestPolymarketTimingProfileEntry[];
    outcomeInterval?: PolymarketOutcomeInterval;
    limitEntry?: PolymarketPostSignalLimitEntrySettings;
}): Pick<
    BacktestPolymarketTradeSummary,
    | "scoredTrades"
    | "missingOutcomeTrades"
    | "unscoredTrades"
    | "duplicateTradesIgnored"
    | "entryOffset"
    | "entrySelectionMode"
    | "timingProfile"
    | "targetExitedTrades"
    | "limitEntryEnabled"
    | "limitEntryMode"
    | "limitEntryPriceCents"
    | "limitEntryOffsetCents"
    | "limitEntryAttempts"
    | "limitEntryFilledTrades"
    | "limitEntryMissedTrades"
    | "limitEntryNotTouchedTrades"
    | "limitEntryLastMinuteOnlyTrades"
    | "limitEntryMissingPriceTrades"
    | "limitEntryInvalidWindowTrades"
    | "limitEntryFillRate"
    | "avgLimitEntryWaitSec"
    | "avgLimitEntryImprovement"
    | "limitExitEnabled"
    | "limitExitMode"
    | "limitExitPriceCents"
    | "limitExitOffsetCents"
    | "limitExitFilledTrades"
    | "limitExitFallbackTrades"
    | "limitExitUnreachableTrades"
> {
    const totalTrades = args.trades.length;
    const resolvedOutcomeInterval = resolvePolymarketOutcomeInterval(args.outcomeInterval);
    const hasLimitEntryAnnotations = args.trades.some(
        (trade) => trade.polymarketOutcome?.marketEntrySource === "limit"
    );

    if (hasLimitEntryAnnotations) {
        const scoredTrades = args.trades.filter(
            (trade) => trade.polymarketOutcome?.marketEntrySource === "limit"
                && trade.polymarketOutcome.marketEntryStatus === "filled"
                && trade.polymarketOutcome.isWin !== null
        ).length;
        const missingOutcomeTrades = args.trades.filter((trade) => !trade.polymarketOutcome).length;
        const duplicateTradesIgnored = args.trades.filter(
            (trade) => trade.polymarketOutcome?.marketEntryStatus === "duplicate"
        ).length;

        return {
            scoredTrades,
            missingOutcomeTrades,
            unscoredTrades: Math.max(0, totalTrades - scoredTrades),
            duplicateTradesIgnored: duplicateTradesIgnored > 0 ? duplicateTradesIgnored : undefined,
            entrySelectionMode: undefined,
            entryOffset: undefined,
            timingProfile: args.timingProfile,
            ...summarizeLimitEntryTrades(args.trades, args.limitEntry),
        };
    }

    if (resolvedOutcomeInterval !== "5m") {
        let scoredTrades = 0;
        const uniqueEntryOffsets = new Set<number>();

        for (const trade of args.trades) {
            const outcome = trade.polymarketOutcome;
            if (!outcome || outcome.isWin === null) {
                continue;
            }
            scoredTrades++;
            if (Number.isFinite(outcome.entryOffset)) {
                uniqueEntryOffsets.add(Math.max(0, Math.floor(Number(outcome.entryOffset))));
            }
        }

        return {
            scoredTrades,
            missingOutcomeTrades: Math.max(0, totalTrades - scoredTrades),
            unscoredTrades: Math.max(0, totalTrades - scoredTrades),
            entrySelectionMode: undefined,
            entryOffset: uniqueEntryOffsets.size === 1 ? [...uniqueEntryOffsets][0] : undefined,
            timingProfile: args.timingProfile ?? buildPolymarketTimingProfileForNativeSession(args.trades, resolvedOutcomeInterval),
        };
    }

    if (args.interval === "1m") {
        const entrySelectionMode = args.entrySelectionMode ?? "fixed_offset";
        const selectedOffset = args.selectedOffset ?? 0;
        const mappedTrades = mapTradesToEvents(args.trades, args.outcomes);
        const selectedTrades = isActualPolymarketEntryMinuteMode(entrySelectionMode)
            ? deduplicateByEventLegacy(mappedTrades)
            : deduplicateByEventLegacy(filterByEntryOffsetLegacy(mappedTrades, selectedOffset));
        const scoredTrades = selectedTrades.length;
        const missingOutcomeTrades = Math.max(0, totalTrades - mappedTrades.length);
        const duplicateTradesIgnored = isActualPolymarketEntryMinuteMode(entrySelectionMode)
            ? Math.max(0, mappedTrades.length - selectedTrades.length)
            : Math.max(0, filterByEntryOffsetLegacy(mappedTrades, selectedOffset).length - selectedTrades.length);

        return {
            scoredTrades,
            missingOutcomeTrades,
            unscoredTrades: Math.max(0, totalTrades - scoredTrades),
            duplicateTradesIgnored: duplicateTradesIgnored > 0 ? duplicateTradesIgnored : undefined,
            entryOffset: isActualPolymarketEntryMinuteMode(entrySelectionMode) ? undefined : selectedOffset,
            entrySelectionMode,
            timingProfile: args.timingProfile,
        };
    }

    const outcomeByStartTs = new Map(args.outcomes.map((row) => [row.event_start_ts, row] as const));
    let scoredTrades = 0;
    let missingOutcomeTrades = 0;

    for (const trade of args.trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null || !outcomeByStartTs.has(entryTs)) {
            missingOutcomeTrades++;
            continue;
        }

        scoredTrades++;
    }

    return {
        scoredTrades,
        missingOutcomeTrades,
        unscoredTrades: missingOutcomeTrades,
        entrySelectionMode: undefined,
        entryOffset: undefined,
        timingProfile: args.timingProfile,
    };
}

export async function annotateBacktestResultWithPolymarketOutcomes(
    result: BacktestResult,
    context: AnnotationContext,
    optionsOrSelectedOffset?: PolymarketAnnotationRunOptions | number,
    pricePointsArg?: PolymarketPricePoint[],
    entrySelectionModeArg: PolymarketEntrySelectionMode = "fixed_offset"
): Promise<BacktestResult> {
    const options: PolymarketAnnotationRunOptions = typeof optionsOrSelectedOffset === "number" || optionsOrSelectedOffset === undefined
        ? {
            selectedOffset: typeof optionsOrSelectedOffset === "number" ? optionsOrSelectedOffset : undefined,
            pricePoints: pricePointsArg,
            entrySelectionMode: entrySelectionModeArg,
        }
        : optionsOrSelectedOffset;
    const selectedOffset = options.selectedOffset;
    const pricePoints = options.pricePoints;
    const entrySelectionMode = options.entrySelectionMode ?? "fixed_offset";
    const limitEntry = options.limitEntry?.enabled && resolvePolymarketOutcomeInterval(context.outcomeInterval) === "5m"
        ? {
            enabled: true,
            priceMode: resolvePolymarketPostSignalLimitEntryMode(options.limitEntry.priceMode),
            priceCents: clampPolymarketPostSignalLimitEntryPriceCents(options.limitEntry.priceCents),
            offsetCents: clampPolymarketPostSignalLimitOffsetCents(options.limitEntry.offsetCents),
            exitEnabled: options.limitEntry.exitEnabled === true,
            exitMode: resolvePolymarketPostSignalLimitExitMode(options.limitEntry.exitMode),
            exitPriceCents: clampPolymarketPostSignalLimitExitPriceCents(options.limitEntry.exitPriceCents),
            exitOffsetCents: clampPolymarketPostSignalLimitOffsetCents(options.limitEntry.exitOffsetCents),
        }
        : undefined;
    const is1mRun = context.interval === "1m";
    const is5mRun = context.interval === "5m";
    const isMultiIntervalRun = ["15m", "1h", "4h"].includes(context.interval);
    const resolvedOutcomeSymbol = resolvePolymarketOutcomeSymbol(context.symbol, context.outcomeSymbol);
    const resolvedOutcomeInterval = resolvePolymarketOutcomeInterval(context.outcomeInterval);
    const isNativeOutcomeSession = resolvedOutcomeInterval !== DEFAULT_POLYMARKET_OUTCOME_INTERVAL;

    if (
        result.trades.length === 0 ||
        context.executionModel !== "next_open" ||
        context.chartData.length < 2 ||
        (!is5mRun && !is1mRun && !isMultiIntervalRun)
    ) {
        return result;
    }

    const isValidInterval = isNativeOutcomeSession
        ? isSupportedPolymarketOutcomeRun(context.symbol, context.interval, resolvedOutcomeInterval, resolvedOutcomeSymbol)
        : (
            isMultiIntervalRun
                ? isSupportedPolymarketMultiIntervalRun(context.symbol, context.interval, resolvedOutcomeSymbol)
                : supportsPolymarketOutcomeBridgeRun(context.symbol, context.interval, resolvedOutcomeSymbol)
        );
    
    if (!isValidInterval) {
        return result;
    }

    const seriesId = isNativeOutcomeSession
        ? getEffectivePolymarketSeriesId(context.symbol, resolvedOutcomeInterval, resolvedOutcomeSymbol)
        : getEffectivePolymarket5mSeriesId(context.symbol, resolvedOutcomeSymbol);
    if (!seriesId) {
        return result;
    }

    const targetTimes = result.trades
        .map((trade) => parseTimeToUnixSeconds(trade.entryTime))
        .filter((value): value is number => value !== null);
    if (targetTimes.length === 0) {
        return result;
    }

    const startTs = Math.min(...targetTimes);
    const endTs = Math.max(...targetTimes);
    const outcomes = isNativeOutcomeSession
        ? await loadPolymarketOutcomesForTimeRange(
            context.symbol,
            startTs,
            endTs,
            resolvedOutcomeSymbol,
            resolvedOutcomeInterval
        )
        : await loadPolymarket5mOutcomesForTimeRange(context.symbol, startTs, endTs, resolvedOutcomeSymbol);

    const effectiveExitMode = resolveEffectivePolymarketExitMode({
        requestedMode: context.polymarketExitMode,
        interval: context.interval,
        executionModel: context.executionModel,
        polymarketAnnotationEnabled: true,
    });
    const needsSignalExitPricePoints = isSignalExitSameEventMode(effectiveExitMode) && is1mRun;
    const needsPricePoints = needsSignalExitPricePoints || isNativeOutcomeSession || Boolean(limitEntry);

    let resolvedPricePoints = pricePoints;
    if (needsPricePoints && !resolvedPricePoints) {
        const pricePointOutcomes = selectPricePointOutcomesForTrades(result.trades, outcomes);
        try {
            resolvedPricePoints = pricePointOutcomes.length > 0
                ? await ensurePricePointsForOutcomes(pricePointOutcomes, seriesId, {
                    startTs,
                    endTs,
                })
                : [];
        } catch {
            resolvedPricePoints = [];
        }
    }

    if (needsSignalExitPricePoints && resolvedPricePoints) {
        const { results: exitResults, summary: exitSummary } = evaluateSignalExitTrades({
            trades: result.trades,
            outcomes,
            pricePoints: resolvedPricePoints,
            limitEntry,
        });

        const exitResultMap = new Map(exitResults.map((r) => [r.trade, r]));
        const annotatedTrades = result.trades.map((trade) => {
            const exitResult = exitResultMap.get(trade);
            if (!exitResult) {
                return { ...trade, polymarketOutcome: null };
            }
            return {
                ...trade,
                polymarketOutcome: buildTradeAnnotationFromSignalExitResult(exitResult),
            };
        });

        return {
            ...result,
            trades: annotatedTrades,
            polymarketTradeSummary: {
                seriesId,
                outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
                outcomeInterval: resolvedOutcomeInterval,
                outcomeRowsLoaded: outcomes.length,
                scoredTrades: exitSummary.scoredTrades,
                missingOutcomeTrades: exitSummary.missingOutcomeTrades,
                unscoredTrades: exitSummary.unscoredTrades,
                duplicateTradesIgnored: exitSummary.duplicateTradesIgnored > 0 ? exitSummary.duplicateTradesIgnored : undefined,
                evaluationMode: "signal_exit_same_event",
                profitableTrades: exitSummary.profitableTrades,
                losingTrades: exitSummary.losingTrades,
                neutralTrades: exitSummary.neutralTrades,
                targetExitedTrades: exitSummary.targetExitedTrades,
                signalExitedTrades: exitSummary.signalExitedTrades,
                resolvedTrades: exitSummary.resolvedTrades,
                missingPriceTrades: exitSummary.missingPriceTrades,
                netPnl: exitSummary.netPnl,
                grossProfit: exitSummary.grossProfit,
                grossLoss: exitSummary.grossLoss,
                profitFactor: exitSummary.profitFactor,
                expectancy: exitSummary.expectancy,
                avgEntryPrice: exitSummary.avgEntryPrice,
                avgExitPrice: exitSummary.avgExitPrice,
                limitEntryEnabled: exitSummary.limitEntryEnabled,
                limitEntryMode: exitSummary.limitEntryMode,
                limitEntryPriceCents: exitSummary.limitEntryPriceCents,
                limitEntryOffsetCents: exitSummary.limitEntryOffsetCents,
                limitEntryAttempts: exitSummary.limitEntryAttempts,
                limitEntryFilledTrades: exitSummary.limitEntryFilledTrades,
                limitEntryMissedTrades: exitSummary.limitEntryMissedTrades,
                limitEntryNotTouchedTrades: exitSummary.limitEntryNotTouchedTrades,
                limitEntryLastMinuteOnlyTrades: exitSummary.limitEntryLastMinuteOnlyTrades,
                limitEntryMissingPriceTrades: exitSummary.limitEntryMissingPriceTrades,
                limitEntryInvalidWindowTrades: exitSummary.limitEntryInvalidWindowTrades,
                limitEntryFillRate: exitSummary.limitEntryFillRate,
                avgLimitEntryWaitSec: exitSummary.avgLimitEntryWaitSec,
                avgLimitEntryImprovement: exitSummary.avgLimitEntryImprovement,
                limitExitEnabled: exitSummary.limitExitEnabled,
                limitExitMode: exitSummary.limitExitMode,
                limitExitPriceCents: exitSummary.limitExitPriceCents,
                limitExitOffsetCents: exitSummary.limitExitOffsetCents,
                limitExitFilledTrades: exitSummary.limitExitFilledTrades,
                limitExitFallbackTrades: exitSummary.limitExitFallbackTrades,
                limitExitUnreachableTrades: exitSummary.limitExitUnreachableTrades,
            },
        };
    }

    const trades = annotateTradesWithPolymarketOutcomesForRun(
        result.trades,
        outcomes,
        context.interval,
        selectedOffset,
        entrySelectionMode,
        {
            outcomeInterval: resolvedOutcomeInterval,
            pricePoints: resolvedPricePoints,
            limitEntry,
        }
    );
    const timingProfile = isNativeOutcomeSession
        ? buildPolymarketTimingProfileForNativeSession(trades, resolvedOutcomeInterval)
        : is1mRun
        ? buildPolymarketTimingProfileFor1mBridge({
            chartData: context.chartData,
            trades: result.trades,
            outcomes,
        })
        : undefined;
    const summary = summarizePolymarketTradesForRun({
        trades,
        outcomes,
        interval: context.interval,
        selectedOffset,
        entrySelectionMode,
        timingProfile,
        outcomeInterval: resolvedOutcomeInterval,
        limitEntry,
    });

    return {
        ...result,
        trades,
        polymarketTradeSummary: {
            seriesId,
            outcomeSymbol: resolvedOutcomeSymbol ?? undefined,
            outcomeInterval: resolvedOutcomeInterval,
            outcomeRowsLoaded: outcomes.length,
            evaluationMode: "resolve_hold",
            ...summary,
        },
    };
}
