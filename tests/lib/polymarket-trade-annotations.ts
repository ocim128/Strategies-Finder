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
} from "./polymarket-1m-5m-bridge";
import type { BacktestResult, OHLCVData, Trade } from "./types/strategies";
import type {
    BacktestPolymarketTimingProfileEntry,
    PolymarketEvalResult,
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
import {
    buildSignalExitPolymarketTradeSummary,
    evaluateSignalExitTrades,
    buildTradeAnnotationFromSignalExitResult,
    indexSignalExitOutcomesForTrades,
} from "./polymarket-signal-exit-evaluator";
import { clampPolymarketEntryPriceFilterCents, isPolymarketEntryPriceFiltered } from "./polymarket-entry-price-filter";
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
import { PolymarketEvalAccumulator } from "./polymarket-eval-accumulator";
import {
    buildPolymarketOutcomeBase,
    getPolymarketPredictionForTrade,
    isPolymarketPredictionWin,
} from "./polymarket-outcome-annotation";

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

type AnnotationContext = {
    symbol: string;
    interval: string;
    executionModel?: string;
    chartData: OHLCVData[];
    outcomeSymbol?: string;
    outcomeInterval?: PolymarketOutcomeInterval;
    polymarketEntrySelectionMode?: PolymarketEntrySelectionMode;
    polymarketExitMode?: "resolve_hold" | "signal_exit_same_event";
    polymarketSignalExitAllowMultipleTradesPerEvent?: boolean;
};

export interface PolymarketAnnotationRunOptions {
    selectedOffset?: number;
    pricePoints?: PolymarketPricePoint[];
    entrySelectionMode?: PolymarketEntrySelectionMode;
    entryPriceFilterCents?: number;
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

function buildEntryPriceFilteredAnnotatedTrade(args: {
    trade: Trade;
    outcome: PolymarketOutcomeRow;
    prediction: "yes" | "no";
    marketEntryPrice: number | null;
    marketYesPrice?: number | null;
    marketNoPrice?: number | null;
    entryOffset?: number;
    marketEntrySource?: NonNullable<Trade["polymarketOutcome"]>["marketEntrySource"];
    marketEntryStatus?: NonNullable<Trade["polymarketOutcome"]>["marketEntryStatus"];
    marketEntryFillTs?: number | null;
    marketEntryLimitPrice?: number | null;
    marketEntryImprovement?: number | null;
}): Trade {
    return {
        ...args.trade,
        polymarketOutcome: {
            ...buildPolymarketOutcomeBase({ outcome: args.outcome, prediction: args.prediction, isWin: null }),
            marketYesPrice: args.marketYesPrice,
            marketNoPrice: args.marketNoPrice,
            marketEntryPrice: args.marketEntryPrice,
            marketEntrySource: args.marketEntrySource,
            marketEntryStatus: args.marketEntryStatus,
            marketEntryFillTs: args.marketEntryFillTs,
            marketEntryLimitPrice: args.marketEntryLimitPrice,
            marketEntryImprovement: args.marketEntryImprovement,
            entryOffset: args.entryOffset,
            evaluationMode: "resolve_hold",
            marketExitSource: "entry_price_filtered",
            isProfitable: null,
            marketExitPrice: null,
            marketExitTs: null,
            marketPnl: null,
        },
    };
}

function buildAnnotatedTrade(
    trade: Trade,
    outcomeByStartTs: Map<number, PolymarketOutcomeRow>,
    entryPriceFilterCents?: number
): Trade {
    const entryTs = parseTimeToUnixSeconds(trade.entryTime);
    if (entryTs === null) {
        return { ...trade, polymarketOutcome: null };
    }

    const outcome = outcomeByStartTs.get(entryTs);
    if (!outcome) {
        return { ...trade, polymarketOutcome: null };
    }

    const prediction = getPolymarketPredictionForTrade(trade);
    const isWin = isPolymarketPredictionWin(prediction, outcome);
    const sidePrices = getTradeMarketSidePrices(outcome);
    const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction);

    if (isPolymarketEntryPriceFiltered(marketEntryPrice, entryPriceFilterCents)) {
        return buildEntryPriceFilteredAnnotatedTrade({
            trade,
            outcome,
            prediction,
            ...sidePrices,
            marketEntryPrice,
        });
    }

    return {
        ...trade,
        polymarketOutcome: {
            ...buildPolymarketOutcomeBase({ outcome, prediction, isWin }),
            ...sidePrices,
            marketEntryPrice,
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
    entrySelectionMode: PolymarketEntrySelectionMode = "fixed_offset",
    entryPriceFilterCents?: number
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

    const prediction = getPolymarketPredictionForTrade(trade);
    const isWin = isPolymarketPredictionWin(prediction, outcome);
    const sidePrices = getTradeMarketSidePrices(outcome, entryOffset);
    const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction, entryOffset);

    if (isPolymarketEntryPriceFiltered(marketEntryPrice, entryPriceFilterCents)) {
        return buildEntryPriceFilteredAnnotatedTrade({
            trade,
            outcome,
            prediction,
            ...sidePrices,
            marketEntryPrice,
            entryOffset,
        });
    }

    return {
        ...trade,
        polymarketOutcome: {
            ...buildPolymarketOutcomeBase({ outcome, prediction, isWin }),
            ...sidePrices,
            marketEntryPrice,
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
    pricePointsByEventStart: Map<number, PolymarketPricePoint[]>,
    entryPriceFilterCents?: number
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
    const prediction = getPolymarketPredictionForTrade(trade);
    const isWin = isPolymarketPredictionWin(prediction, outcome);
    const entryPricePoint = findFirstPricePointAtOrAfterEntry(outcome, entryTs, pricePointsByEventStart);
    const marketYesPrice = clampProbability(entryPricePoint?.yes_price ?? null);
    const marketNoPrice = clampProbability(entryPricePoint?.no_price ?? (
        marketYesPrice === null ? null : 1 - marketYesPrice
    ));
    const marketEntryPrice = prediction === "yes" ? marketYesPrice : marketNoPrice;

    if (isPolymarketEntryPriceFiltered(marketEntryPrice, entryPriceFilterCents)) {
        return buildEntryPriceFilteredAnnotatedTrade({
            trade,
            outcome,
            prediction,
            marketYesPrice,
            marketNoPrice,
            marketEntryPrice,
            entryOffset: entryOffset >= 0 ? entryOffset : undefined,
        });
    }

    return {
        ...trade,
        polymarketOutcome: {
            ...buildPolymarketOutcomeBase({ outcome, prediction, isWin }),
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
    const prediction = getPolymarketPredictionForTrade(trade);
    return {
        ...trade,
        polymarketOutcome: {
            ...buildPolymarketOutcomeBase({ outcome: mappedTrade.outcome, prediction, isWin: null }),
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
    entryPriceFilterCents?: number;
}): Trade {
    const { trade, outcome, status, limitPrice } = args;
    const prediction = getPolymarketPredictionForTrade(trade);
    const isFilled = status === "filled";
    const isWin = isPolymarketPredictionWin(prediction, outcome);
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
    const sidePrices = buildLimitEntrySidePrices(prediction, limitPrice);
    const isEntryPriceFiltered = isFilled && isPolymarketEntryPriceFiltered(limitPrice, args.entryPriceFilterCents);

    return {
        ...trade,
        polymarketOutcome: {
            ...buildPolymarketOutcomeBase({ outcome, prediction, isWin: isFilled && !isEntryPriceFiltered ? isWin : null }),
            ...sidePrices,
            marketEntrySource: "limit",
            marketEntryStatus: status,
            marketEntryFillTs: isFilled ? args.fillTs ?? null : null,
            marketEntryLimitPrice: limitPrice,
            marketEntryImprovement: isFilled ? args.entryImprovement ?? null : null,
            marketEntryPrice: isFilled ? limitPrice : null,
            marketExitPrice: isEntryPriceFiltered ? null : marketExitPrice,
            marketExitTs: isEntryPriceFiltered ? null : isFilled ? args.exitTs ?? outcome.event_end_ts : null,
            marketExitSource: isEntryPriceFiltered
                ? "entry_price_filtered"
                : status === "duplicate" ? "duplicate" : isFilled ? args.exitSource ?? "resolution" : "missing",
            marketExitTargetPrice: isEntryPriceFiltered ? null : args.exitTargetPrice,
            marketExitStatus: isEntryPriceFiltered ? undefined : args.exitStatus,
            marketPnl: isEntryPriceFiltered ? null : marketPnl,
            evaluationMode: "resolve_hold",
            isProfitable: isEntryPriceFiltered ? null : isProfitable,
            entryOffset: entryOffset >= 0 ? entryOffset : undefined,
        },
    };
}

function annotateTradesWithLimitEntryForRun(
    trades: readonly Trade[],
    outcomes: readonly PolymarketOutcomeRow[],
    pricePointsByEventStart: Map<number, PolymarketPricePoint[]>,
    settings: PolymarketPostSignalLimitEntrySettings,
    entryPriceFilterCents?: number
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
        const isEntryPriceFiltered = fill.status === "filled"
            && isPolymarketEntryPriceFiltered(resolvedLimitPrice, entryPriceFilterCents);
        if (fill.status === "filled" && !isEntryPriceFiltered) {
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
            entryPriceFilterCents,
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
            if (limitExitEnabled && outcome.marketExitSource !== "entry_price_filtered") {
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
    outcomes: readonly PolymarketOutcomeRow[],
    entryPriceFilterCents?: number
): Trade[] {
    const outcomeByStartTs = new Map(outcomes.map((row) => [Number(row.event_start_ts), row] as const));
    return trades.map((trade) => buildAnnotatedTrade(trade, outcomeByStartTs, entryPriceFilterCents));
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
        entryPriceFilterCents?: number;
        limitEntry?: PolymarketPostSignalLimitEntrySettings;
    }
): Trade[] {
    const resolvedOutcomeInterval = resolvePolymarketOutcomeInterval(options?.outcomeInterval);
    const entryPriceFilterCents = clampPolymarketEntryPriceFilterCents(options?.entryPriceFilterCents);
    if (resolvedOutcomeInterval === "5m" && options?.limitEntry?.enabled) {
        const pricePointsByEventStart = buildPricePointsByEventStart(options.pricePoints ?? []);
        return annotateTradesWithLimitEntryForRun(
            trades,
            outcomes,
            pricePointsByEventStart,
            options.limitEntry,
            entryPriceFilterCents
        );
    }

    if (resolvedOutcomeInterval !== "5m") {
        const pricePointsByEventStart = buildPricePointsByEventStart(options?.pricePoints ?? []);
        return trades.map((trade) => buildAnnotatedTradeForNativeSession(
            trade,
            outcomes,
            pricePointsByEventStart,
            entryPriceFilterCents
        ));
    }

    if (interval !== "1m") {
        return annotateTradesWithPolymarketOutcomes(trades, outcomes, entryPriceFilterCents);
    }

    const mappedTrades = mapTradesToEvents(trades, outcomes);
    const mappedTradeByTrade = new Map(mappedTrades.map((mapped) => [mapped.trade, mapped] as const));
    const scoreableMappedTrades: LegacyMappedPolymarketTrade[] = [];
    const entryPriceFilteredTradeSet = new Set<Trade>();
    const isActualMinuteMode = isActualPolymarketEntryMinuteMode(entrySelectionMode);
    const resolvedOffset = selectedOffset ?? 0;

    for (const mapped of mappedTrades) {
        if (!isActualMinuteMode && mapped.entryOffset !== resolvedOffset) {
            continue;
        }

        const prediction = getPolymarketPredictionForTrade(mapped.trade);
        const marketEntryPrice = getTradeMarketEntryPrice(mapped.outcome, prediction, mapped.entryOffset);
        if (isPolymarketEntryPriceFiltered(marketEntryPrice, entryPriceFilterCents)) {
            entryPriceFilteredTradeSet.add(mapped.trade);
            continue;
        }
        scoreableMappedTrades.push(mapped);
    }

    const selectedTrades = deduplicateByEventLegacy(scoreableMappedTrades);
    const selectedTradeSet = new Set(selectedTrades.map((mapped: LegacyMappedPolymarketTrade) => mapped.trade));

    return trades.map((trade) => {
        const mappedTrade = mappedTradeByTrade.get(trade);
        if (!mappedTrade) {
            return { ...trade, polymarketOutcome: null };
        }

        if (entryPriceFilteredTradeSet.has(trade) || selectedTradeSet.has(trade)) {
            return buildAnnotatedTradeForBridge(trade, outcomes, selectedOffset, entrySelectionMode, entryPriceFilterCents);
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
    entryPriceFilterCents?: number;
}): PolymarketEvalResult {
    const { trades, strategyKey } = args;
    const context = args.context ?? createPolymarketTradeEvaluationContext(args.chartData, args.outcomes);
    const includeRows = args.includeRows !== false;
    const accumulator = new PolymarketEvalAccumulator({
        evaluatedEvents: context.evaluatedEvents,
        predictionsTaken: trades.length,
        resolvedUpCount: context.resolvedUpCount,
        includeRows,
        strategyKey,
    });

    for (const trade of trades) {
        accumulator.recordPrediction(trade.type);

        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) {
            accumulator.recordMissingOutcome();
            continue;
        }

        const outcome = context.outcomeByStartTs.get(entryTs);
        if (!outcome) {
            accumulator.recordMissingOutcome();
            continue;
        }

        const prediction = trade.type === "long" ? "yes" : "no";
        const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction);
        if (isPolymarketEntryPriceFiltered(marketEntryPrice, args.entryPriceFilterCents)) {
            accumulator.recordEntryPriceFiltered();
            continue;
        }
        const executionBarIndex = context.executionBarIndexByTs.get(entryTs);
        const signalBarIndex = executionBarIndex === undefined ? -1 : Math.max(0, executionBarIndex - 1);
        const signalTime = signalBarIndex >= 0
            ? (parseTimeToUnixSeconds(args.chartData[signalBarIndex]?.time) ?? entryTs)
            : entryTs;
        accumulator.recordScoredPrediction({
            tradeType: trade.type,
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            actualOutcomeUp: outcome.resolved_outcome_up,
            marketEntryPrice,
            signalBarIndex,
            signalTime,
        });
    }

    return accumulator.toResult();
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
    entryPriceFilterCents?: number;
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
        entryPriceFilterCents: args.entryPriceFilterCents,
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
    entryPriceFilterCents?: number;
}): PolymarketEvalResult {
    const { chartData, mappedTrades, outcomes, strategyKey, selectedOffset } = args;
    const includeRows = args.includeRows !== false;
    const context = args.context ?? createPolymarketBridgeEvaluationContext(chartData, outcomes);

    const filteredForOffset = filterByEntryOffsetLegacy(mappedTrades, selectedOffset);
    const priceEligibleForOffset: LegacyMappedPolymarketTrade[] = [];
    let entryPriceFilteredPredictions = 0;
    for (const mapped of filteredForOffset) {
        const prediction = mapped.trade.type === "long" ? "yes" : "no";
        const marketEntryPrice = getTradeMarketEntryPrice(mapped.outcome, prediction, mapped.entryOffset);
        if (isPolymarketEntryPriceFiltered(marketEntryPrice, args.entryPriceFilterCents)) {
            entryPriceFilteredPredictions++;
            continue;
        }
        priceEligibleForOffset.push(mapped);
    }
    const selected = deduplicateByEventLegacy(priceEligibleForOffset);
    const executionBarIndexByTs = context.executionBarIndexByTs;
    const predictionsTaken = Math.max(
        0,
        Number.isFinite(args.predictionsTaken) ? Number(args.predictionsTaken) : mappedTrades.length
    );
    const accumulator = new PolymarketEvalAccumulator({
        evaluatedEvents: context.evaluatedEvents,
        predictionsTaken,
        resolvedUpCount: context.resolvedUpCount,
        includeRows,
        strategyKey,
        entryOffset: selectedOffset,
        duplicateTradesIgnored: Math.max(0, priceEligibleForOffset.length - selected.length),
    });
    for (let index = 0; index < entryPriceFilteredPredictions; index += 1) {
        accumulator.recordEntryPriceFiltered();
    }

    for (const mapped of selected) {
        const { trade, outcome, entryOffset, entryTs } = mapped;
        accumulator.recordPrediction(trade.type);

        const prediction = trade.type === "long" ? "yes" : "no";
        const marketEntryPrice = getTradeMarketEntryPrice(outcome, prediction, entryOffset);
        const executionBarIndex = executionBarIndexByTs.get(entryTs);
        const signalBarIndex = executionBarIndex === undefined ? -1 : Math.max(0, executionBarIndex - 1);
        const signalTime = signalBarIndex >= 0
            ? (parseTimeToUnixSeconds(chartData[signalBarIndex]?.time) ?? entryTs)
            : entryTs;
        accumulator.recordScoredPrediction({
            tradeType: trade.type,
            eventStartTs: outcome.event_start_ts,
            eventEndTs: outcome.event_end_ts,
            eventSlug: outcome.event_slug,
            actualOutcomeUp: outcome.resolved_outcome_up,
            marketEntryPrice,
            signalBarIndex,
            signalTime,
            entryOffset,
        });
    }

    return accumulator.toResult();
}

export function buildPolymarketTimingProfileFor1mBridge(args: {
    chartData: OHLCVData[];
    trades: Trade[];
    outcomes: PolymarketOutcomeRow[];
    strategyKey?: string;
    entryPriceFilterCents?: number;
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
            entryPriceFilterCents: args.entryPriceFilterCents,
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

function isEntryPriceFilteredTrade(trade: Trade): boolean {
    return trade.polymarketOutcome?.marketExitSource === "entry_price_filtered";
}

function countEntryPriceFilteredTrades(trades: readonly Trade[]): number {
    return trades.filter(isEntryPriceFilteredTrade).length;
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
    | "entryPriceFilteredTrades"
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
        const entryPriceFilteredTrades = countEntryPriceFilteredTrades(args.trades);

        return {
            scoredTrades,
            missingOutcomeTrades,
            unscoredTrades: Math.max(0, totalTrades - scoredTrades),
            duplicateTradesIgnored: duplicateTradesIgnored > 0 ? duplicateTradesIgnored : undefined,
            entryPriceFilteredTrades: entryPriceFilteredTrades > 0 ? entryPriceFilteredTrades : undefined,
            entrySelectionMode: undefined,
            entryOffset: undefined,
            timingProfile: args.timingProfile,
            ...summarizeLimitEntryTrades(args.trades, args.limitEntry),
        };
    }

    if (resolvedOutcomeInterval !== "5m") {
        let scoredTrades = 0;
        let missingOutcomeTrades = 0;
        const uniqueEntryOffsets = new Set<number>();

        for (const trade of args.trades) {
            const outcome = trade.polymarketOutcome;
            if (!outcome) {
                missingOutcomeTrades++;
                continue;
            }
            if (outcome.isWin === null) {
                continue;
            }
            scoredTrades++;
            if (Number.isFinite(outcome.entryOffset)) {
                uniqueEntryOffsets.add(Math.max(0, Math.floor(Number(outcome.entryOffset))));
            }
        }

        return {
            scoredTrades,
            missingOutcomeTrades,
            unscoredTrades: Math.max(0, totalTrades - scoredTrades),
            entryPriceFilteredTrades: countEntryPriceFilteredTrades(args.trades) || undefined,
            entrySelectionMode: undefined,
            entryOffset: uniqueEntryOffsets.size === 1 ? [...uniqueEntryOffsets][0] : undefined,
            timingProfile: args.timingProfile ?? buildPolymarketTimingProfileForNativeSession(args.trades, resolvedOutcomeInterval),
        };
    }

    if (args.interval === "1m") {
        const entrySelectionMode = args.entrySelectionMode ?? "fixed_offset";
        const selectedOffset = args.selectedOffset ?? 0;
        const scoredTrades = args.trades.filter((trade) => (
            trade.polymarketOutcome
            && trade.polymarketOutcome.isWin !== null
            && trade.polymarketOutcome.marketExitSource !== "entry_price_filtered"
        )).length;
        const missingOutcomeTrades = args.trades.filter((trade) => !trade.polymarketOutcome).length;
        const duplicateTradesIgnored = args.trades.filter(
            (trade) => trade.polymarketOutcome?.marketExitSource === "duplicate"
        ).length;
        const entryPriceFilteredTrades = countEntryPriceFilteredTrades(args.trades);

        return {
            scoredTrades,
            missingOutcomeTrades,
            unscoredTrades: Math.max(0, totalTrades - scoredTrades),
            duplicateTradesIgnored: duplicateTradesIgnored > 0 ? duplicateTradesIgnored : undefined,
            entryPriceFilteredTrades: entryPriceFilteredTrades > 0 ? entryPriceFilteredTrades : undefined,
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
        if (isEntryPriceFilteredTrade(trade)) {
            continue;
        }

        scoredTrades++;
    }
    const entryPriceFilteredTrades = countEntryPriceFilteredTrades(args.trades);

    return {
        scoredTrades,
        missingOutcomeTrades,
        unscoredTrades: Math.max(0, totalTrades - scoredTrades),
        entryPriceFilteredTrades: entryPriceFilteredTrades > 0 ? entryPriceFilteredTrades : undefined,
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
    const entryPriceFilterCents = clampPolymarketEntryPriceFilterCents(options.entryPriceFilterCents);
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
                ? await ensurePricePointsForOutcomes(pricePointOutcomes, seriesId)
                : [];
        } catch {
            resolvedPricePoints = [];
        }
    }

    if (needsSignalExitPricePoints && resolvedPricePoints) {
        const outcomeByEntryTs = indexSignalExitOutcomesForTrades(result.trades, outcomes);
        const { results: exitResults, summary: exitSummary } = evaluateSignalExitTrades({
            trades: result.trades,
            outcomes,
            pricePoints: resolvedPricePoints,
            outcomeByEntryTs,
            allowMultipleTradesPerEvent: context.polymarketSignalExitAllowMultipleTradesPerEvent,
            entryPriceFilterCents,
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
            polymarketTradeSummary: buildSignalExitPolymarketTradeSummary({
                seriesId,
                outcomeSymbol: resolvedOutcomeSymbol,
                outcomeInterval: resolvedOutcomeInterval,
                outcomeRowsLoaded: outcomes.length,
                summary: exitSummary,
            }),
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
            entryPriceFilterCents,
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
            entryPriceFilterCents,
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
