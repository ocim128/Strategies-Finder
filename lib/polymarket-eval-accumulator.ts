import type { Trade } from "./types/strategies";
import type { PolymarketEvalResult, PolymarketEvalRow } from "./types/polymarket-outcomes";
import { resolvePolymarketBacktestResolutionExitPrice } from "./polymarket-backtest-slippage";

type Prediction = "yes" | "no";
type SkipBasis = "evaluatedEvents" | "predictionsTaken";

export type PolymarketScoredPrediction = {
    tradeType: Trade["type"];
    eventStartTs: number;
    eventEndTs: number;
    eventSlug: string;
    actualOutcomeUp: 0 | 1;
    marketEntryPrice: number | null;
    signalBarIndex?: number;
    signalTime?: number;
    entryOffset?: number;
};

export type PolymarketEvalAccumulatorOptions = {
    evaluatedEvents: number;
    resolvedUpCount: number;
    predictionsTaken: number;
    backtestSlippageCents?: number;
    includeRows?: boolean;
    strategyKey?: string;
    entryOffset?: number;
    duplicateTradesIgnored?: number;
    ignoredSignals?: number;
    skipBasis?: SkipBasis;
};

function predictionForTradeType(tradeType: Trade["type"]): Prediction {
    return tradeType === "long" ? "yes" : "no";
}

function isWinningPrediction(prediction: Prediction, actualOutcomeUp: 0 | 1): boolean {
    return prediction === "yes" ? actualOutcomeUp === 1 : actualOutcomeUp === 0;
}

function profitFactor(grossProfit: number, grossLoss: number): number {
    if (!Number.isFinite(grossProfit) || grossProfit <= 0) return 0;
    if (!Number.isFinite(grossLoss) || grossLoss <= 0) return Infinity;
    return grossProfit / grossLoss;
}

export class PolymarketEvalAccumulator {
    private readonly rows: PolymarketEvalRow[] = [];
    private wins = 0;
    private losses = 0;
    private longPredictions = 0;
    private shortPredictions = 0;
    private scoredLongPredictions = 0;
    private scoredShortPredictions = 0;
    private longWins = 0;
    private shortWins = 0;
    private missingOutcomeRows = 0;
    private entryPriceFilteredPredictions = 0;
    private entryTimeFilteredPredictions = 0;
    private pricedPredictions = 0;
    private totalEntryPrice = 0;
    private totalWinningExitPrice = 0;
    private totalPayout = 0;
    private grossProfit = 0;
    private grossLoss = 0;

    constructor(private readonly options: PolymarketEvalAccumulatorOptions) {}

    recordPrediction(tradeType: Trade["type"]): void {
        if (tradeType === "long") {
            this.longPredictions++;
        } else {
            this.shortPredictions++;
        }
    }

    recordMissingOutcome(): void {
        this.missingOutcomeRows++;
    }

    recordEntryPriceFiltered(): void {
        this.entryPriceFilteredPredictions++;
    }

    recordEntryTimeFiltered(): void {
        this.entryTimeFilteredPredictions++;
    }

    recordScoredPrediction(input: PolymarketScoredPrediction): void {
        const prediction = predictionForTradeType(input.tradeType);
        const isWin = isWinningPrediction(prediction, input.actualOutcomeUp);
        const marketExitPrice = resolvePolymarketBacktestResolutionExitPrice(
            isWin,
            this.options.backtestSlippageCents ?? 0
        );
        const payout = input.marketEntryPrice === null || !Number.isFinite(input.marketEntryPrice)
            ? null
            : marketExitPrice - input.marketEntryPrice;

        if (input.tradeType === "long") {
            this.scoredLongPredictions++;
        } else {
            this.scoredShortPredictions++;
        }

        if (isWin) {
            this.wins++;
            if (input.tradeType === "long") {
                this.longWins++;
            } else {
                this.shortWins++;
            }
        } else {
            this.losses++;
        }

        if (input.marketEntryPrice !== null && payout !== null) {
            this.pricedPredictions++;
            this.totalEntryPrice += input.marketEntryPrice;
            this.totalWinningExitPrice += resolvePolymarketBacktestResolutionExitPrice(
                true,
                this.options.backtestSlippageCents ?? 0
            );
            this.totalPayout += payout;
            if (payout > 0) {
                this.grossProfit += payout;
            } else if (payout < 0) {
                this.grossLoss += Math.abs(payout);
            }
        }

        if (this.options.includeRows !== false) {
            this.rows.push({
                eventStartTs: input.eventStartTs,
                eventEndTs: input.eventEndTs,
                eventSlug: input.eventSlug,
                signalBarIndex: input.signalBarIndex ?? -1,
                signalTime: input.signalTime ?? input.eventStartTs,
                prediction,
                actualOutcomeUp: input.actualOutcomeUp,
                isWin,
                signalReason: undefined,
                strategyKey: this.options.strategyKey,
                entryOffset: input.entryOffset,
            });
        }
    }

    toResult(): PolymarketEvalResult {
        const scoredPredictions = this.wins + this.losses;
        const avgEntryPrice = this.pricedPredictions > 0 ? this.totalEntryPrice / this.pricedPredictions : 0;
        const breakEvenWinRate = this.totalWinningExitPrice > 0 ? this.totalEntryPrice / this.totalWinningExitPrice : 0;
        const expectancy = this.pricedPredictions > 0 ? this.totalPayout / this.pricedPredictions : 0;
        const skipBasis = this.options.skipBasis === "predictionsTaken"
            ? this.options.predictionsTaken
            : this.options.evaluatedEvents;

        return {
            evaluatedEvents: this.options.evaluatedEvents,
            predictionsTaken: this.options.predictionsTaken,
            scoredPredictions,
            pricedPredictions: this.pricedPredictions,
            profitFactor: profitFactor(this.grossProfit, this.grossLoss),
            grossProfit: this.grossProfit,
            grossLoss: this.grossLoss,
            wins: this.wins,
            losses: this.losses,
            skips: Math.max(0, skipBasis - scoredPredictions),
            winRate: scoredPredictions > 0 ? this.wins / scoredPredictions : 0,
            coverage: this.options.evaluatedEvents > 0 ? scoredPredictions / this.options.evaluatedEvents : 0,
            longPredictions: this.longPredictions,
            shortPredictions: this.shortPredictions,
            longWins: this.longWins,
            shortWins: this.shortWins,
            longWinRate: this.scoredLongPredictions > 0 ? this.longWins / this.scoredLongPredictions : 0,
            shortWinRate: this.scoredShortPredictions > 0 ? this.shortWins / this.scoredShortPredictions : 0,
            alwaysYesBaselineWinRate: this.options.evaluatedEvents > 0
                ? this.options.resolvedUpCount / this.options.evaluatedEvents
                : 0,
            alwaysNoBaselineWinRate: this.options.evaluatedEvents > 0
                ? (this.options.evaluatedEvents - this.options.resolvedUpCount) / this.options.evaluatedEvents
                : 0,
            avgEntryPrice,
            breakEvenWinRate,
            expectancy,
            edgeVsBreakEven: (scoredPredictions > 0 ? this.wins / scoredPredictions : 0) - breakEvenWinRate,
            missingOutcomeRows: this.missingOutcomeRows,
            ignoredSignals: this.options.ignoredSignals ?? 0,
            entryOffset: this.options.entryOffset,
            duplicateTradesIgnored: this.options.duplicateTradesIgnored,
            entryPriceFilteredPredictions: this.entryPriceFilteredPredictions > 0 ? this.entryPriceFilteredPredictions : undefined,
            entryTimeFilteredPredictions: this.entryTimeFilteredPredictions > 0 ? this.entryTimeFilteredPredictions : undefined,
            rows: this.rows,
        };
    }
}
