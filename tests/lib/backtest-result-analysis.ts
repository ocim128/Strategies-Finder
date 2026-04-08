import type {
    BacktestExpectancyBreakdown,
    BacktestResult,
    ExpectancyBreakdownRow,
    ExpectancyBreakdownSection,
    ExitReasonBreakdown,
    ExitReasonRow,
    OHLCVData,
    PostEntryPathBucketStats,
    PostEntryPathOpenTradeProbability,
    PostEntryPathStats,
} from "./strategies/index";
import type { Trade } from "./types/strategies";
import { timeKey } from "./strategies/index";
import { getTimeIndex } from "./strategies/backtest/backtest-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";

const EXIT_REASON_LABELS: Record<string, string> = {
    signal: "Signal",
    stop_loss: "Stop Loss",
    take_profit: "Take Profit",
    trailing_stop: "Trailing Stop",
    time_stop: "Time Stop",
    partial: "Partial",
    probation_fail: "Weak-Start Guard",
    end_of_data: "End of Data",
};

export function buildPostEntryPathStats(
    result: BacktestResult,
    horizonMaxBars: number,
    ohlcvData: OHLCVData[]
): PostEntryPathStats {
    const horizonBars = Array.from({ length: horizonMaxBars }, (_, index) => index + 1);
    const createMoveBuckets = () => Array.from({ length: horizonMaxBars }, () => [] as number[]);
    const winMoves = createMoveBuckets();
    const loseMoves = createMoveBuckets();
    const allMoves = createMoveBuckets();

    const winDurationBars: number[] = [];
    const loseDurationBars: number[] = [];
    const allDurationBars: number[] = [];
    const winDurationMinutes: number[] = [];
    const loseDurationMinutes: number[] = [];
    const allDurationMinutes: number[] = [];

    const timeIndex = getTimeIndex(ohlcvData);

    for (const trade of result.trades) {
        const entryIndex = timeIndex.get(timeKey(trade.entryTime));
        if (entryIndex !== undefined && Number.isFinite(trade.entryPrice) && trade.entryPrice > 0) {
            for (let bar = 1; bar <= horizonMaxBars; bar++) {
                const targetIndex = entryIndex + bar;
                if (targetIndex >= ohlcvData.length) break;

                const targetClose = ohlcvData[targetIndex].close;
                if (!Number.isFinite(targetClose)) continue;

                const rawMovePct = ((targetClose - trade.entryPrice) / trade.entryPrice) * 100;
                const signedMovePct = trade.type === "short" ? -rawMovePct : rawMovePct;
                const bucketIndex = bar - 1;
                allMoves[bucketIndex].push(signedMovePct);
                if (trade.pnl > 0) {
                    winMoves[bucketIndex].push(signedMovePct);
                } else {
                    loseMoves[bucketIndex].push(signedMovePct);
                }
            }
        }

        collectTradeDuration(
            trade,
            timeIndex,
            winDurationBars,
            loseDurationBars,
            allDurationBars,
            winDurationMinutes,
            loseDurationMinutes,
            allDurationMinutes
        );
    }

    return {
        horizonBars,
        win: finalizePostEntryBucket(winMoves, winDurationBars, winDurationMinutes),
        lose: finalizePostEntryBucket(loseMoves, loseDurationBars, loseDurationMinutes),
        all: finalizePostEntryBucket(allMoves, allDurationBars, allDurationMinutes),
        openTradeProbability: estimateOpenTradeProbability(result.trades, timeIndex, horizonMaxBars, ohlcvData),
        exitReasonBreakdown: buildExitReasonBreakdown(result.trades),
    };
}

export function buildExpectancyBreakdown(result: BacktestResult): BacktestExpectancyBreakdown | undefined {
    const sections: ExpectancyBreakdownSection[] = [];
    const allTrades = result.trades;

    if (allTrades.length > 0) {
        const sideRows: ExpectancyBreakdownRow[] = [
            buildExpectancyRow("All Trades", allTrades),
        ];
        const longTrades = allTrades.filter((trade) => trade.type === "long");
        const shortTrades = allTrades.filter((trade) => trade.type === "short");

        if (longTrades.length > 0) {
            sideRows.push(buildExpectancyRow("Long Only", longTrades));
        }
        if (shortTrades.length > 0) {
            sideRows.push(buildExpectancyRow("Short Only", shortTrades));
        }

        sections.push({
            id: "side",
            title: "By Side",
            hint: "Expectancy is net PnL per trade. A high win rate can still lose if average losses are larger than average wins.",
            rows: sideRows,
        });
    }

    if (result.marketContext?.interval === "1m") {
        const minuteRows = buildFiveMinuteSessionMinuteRows(allTrades);
        if (minuteRows.length > 0) {
            sections.push({
                id: "session_minute",
                title: "By 5m Session Minute",
                hint: "For 1m execution, this shows whether minute 0-4 inside each rolling 5m block is helping or hurting expectancy.",
                rows: minuteRows,
            });
        }
    }

    const rangeRows = buildPriceRangePositionRows(allTrades);
    if (rangeRows.length > 0) {
        sections.push({
            id: "price_range_position",
            title: "By Entry Range Position",
            hint: "Higher buckets mean the entry fired closer to the top of the recent range. If expectancy dies there, that is late-chase behavior.",
            rows: rangeRows,
        });
    }

    return sections.length > 0 ? { sections } : undefined;
}

function collectTradeDuration(
    trade: Trade,
    timeIndex: Map<string, number>,
    winDurationBars: number[],
    loseDurationBars: number[],
    allDurationBars: number[],
    winDurationMinutes: number[],
    loseDurationMinutes: number[],
    allDurationMinutes: number[]
): void {
    const entryIndex = timeIndex.get(timeKey(trade.entryTime));
    const exitIndex = timeIndex.get(timeKey(trade.exitTime));
    if (entryIndex !== undefined && exitIndex !== undefined && exitIndex >= entryIndex) {
        const durationBars = exitIndex - entryIndex;
        allDurationBars.push(durationBars);
        if (trade.pnl > 0) {
            winDurationBars.push(durationBars);
        } else {
            loseDurationBars.push(durationBars);
        }
    }

    const entryMs = toEpochMs(trade.entryTime);
    const exitMs = toEpochMs(trade.exitTime);
    if (entryMs === null || exitMs === null) return;
    const durationMinutes = (exitMs - entryMs) / 60000;
    if (!Number.isFinite(durationMinutes) || durationMinutes < 0) return;

    allDurationMinutes.push(durationMinutes);
    if (trade.pnl > 0) {
        winDurationMinutes.push(durationMinutes);
    } else {
        loseDurationMinutes.push(durationMinutes);
    }
}

function buildExpectancyRow(label: string, trades: Trade[]): ExpectancyBreakdownRow {
    const winningTrades = trades.filter((trade) => trade.pnl > 0);
    const totalProfit = winningTrades.reduce((sum, trade) => sum + trade.pnl, 0);
    const losingTrades = trades.filter((trade) => trade.pnl <= 0);
    const totalLoss = Math.abs(losingTrades.reduce((sum, trade) => sum + trade.pnl, 0));
    const netProfit = totalProfit - totalLoss;
    const tradeCount = trades.length;
    const winRate = tradeCount > 0 ? (winningTrades.length / tradeCount) * 100 : 0;
    const expectancy = tradeCount > 0 ? netProfit / tradeCount : 0;
    const avgWin = winningTrades.length > 0 ? totalProfit / winningTrades.length : 0;
    const avgLoss = losingTrades.length > 0 ? totalLoss / losingTrades.length : 0;
    const profitFactor = totalLoss > 0 ? totalProfit / totalLoss : totalProfit > 0 ? Infinity : 0;

    const entryPrices = trades
        .map((trade) => trade.polymarketOutcome?.marketEntryPrice)
        .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
    const avgEntryPrice = entryPrices.length > 0 ? average(entryPrices) : null;
    const breakEvenWinRate = avgEntryPrice === null ? null : avgEntryPrice * 100;
    const edgeVsBreakEven = breakEvenWinRate === null ? null : winRate - breakEvenWinRate;

    return {
        label,
        tradeCount,
        winRate,
        netProfit,
        expectancy,
        avgWin,
        avgLoss,
        profitFactor,
        avgEntryPrice,
        breakEvenWinRate,
        edgeVsBreakEven,
    };
}

function buildFiveMinuteSessionMinuteRows(trades: Trade[]): ExpectancyBreakdownRow[] {
    const buckets = Array.from({ length: 5 }, (_, minute) => ({
        label: `Minute ${minute}`,
        trades: [] as Trade[],
    }));

    for (const trade of trades) {
        const entryTs = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTs === null) continue;
        const minuteOffset = Math.floor((((entryTs % 300) + 300) % 300) / 60);
        const bucket = buckets[minuteOffset];
        if (bucket) {
            bucket.trades.push(trade);
        }
    }

    return buckets
        .filter((bucket) => bucket.trades.length > 0)
        .map((bucket) => buildExpectancyRow(bucket.label, bucket.trades));
}

function buildPriceRangePositionRows(trades: Trade[]): ExpectancyBreakdownRow[] {
    const buckets: Array<{ label: string; min: number; max: number; trades: Trade[] }> = [
        { label: "0-20%", min: 0, max: 0.2, trades: [] },
        { label: "20-40%", min: 0.2, max: 0.4, trades: [] },
        { label: "40-60%", min: 0.4, max: 0.6, trades: [] },
        { label: "60-80%", min: 0.6, max: 0.8, trades: [] },
        { label: "80-100%", min: 0.8, max: 1.0000001, trades: [] },
    ];

    for (const trade of trades) {
        const position = (trade as any).entrySnapshot?.priceRangePos;
        if (typeof position !== "number" || !Number.isFinite(position)) continue;
        const clamped = Math.max(0, Math.min(1, position));
        const bucket = buckets.find((entry) => clamped >= entry.min && clamped < entry.max);
        if (bucket) {
            bucket.trades.push(trade);
        }
    }

    return buckets
        .filter((bucket) => bucket.trades.length > 0)
        .map((bucket) => buildExpectancyRow(bucket.label, bucket.trades));
}

function finalizePostEntryBucket(
    movesByBar: number[][],
    durationBars: number[],
    durationMinutes: number[]
): PostEntryPathBucketStats {
    return {
        avgSignedMovePctByBar: movesByBar.map((values) => average(values)),
        medianSignedMovePctByBar: movesByBar.map((values) => median(values)),
        maxSignedMovePctByBar: movesByBar.map((values) => maximum(values)),
        minSignedMovePctByBar: movesByBar.map((values) => minimum(values)),
        positiveRatePctByBar: movesByBar.map((values) => {
            if (values.length === 0) return null;
            const positiveCount = values.filter((value) => value > 0).length;
            return (positiveCount / values.length) * 100;
        }),
        sampleSizeByBar: movesByBar.map((values) => values.length),
        avgClosedTradeTimeBars: average(durationBars),
        avgClosedTradeTimeMinutes: average(durationMinutes),
    };
}

function estimateOpenTradeProbability(
    trades: Trade[],
    timeIndex: Map<string, number>,
    horizonMaxBars: number,
    ohlcvData: OHLCVData[]
): PostEntryPathOpenTradeProbability {
    const openTrade = [...trades].reverse().find((trade) => trade.exitReason === "end_of_data");
    if (!openTrade) {
        return {
            hasOpenTrade: false,
            tradeType: null,
            barsHeld: null,
            basisBar: null,
            signedMovePct: null,
            winProbabilityPct: null,
            loseProbabilityPct: null,
            sampleSize: 0,
            matchedSampleSize: 0,
        };
    }

    const entryIndex = timeIndex.get(timeKey(openTrade.entryTime));
    const exitIndex = timeIndex.get(timeKey(openTrade.exitTime));
    if (entryIndex === undefined || exitIndex === undefined || exitIndex < entryIndex || openTrade.entryPrice <= 0) {
        return {
            hasOpenTrade: true,
            tradeType: openTrade.type,
            barsHeld: null,
            basisBar: null,
            signedMovePct: null,
            winProbabilityPct: null,
            loseProbabilityPct: null,
            sampleSize: 0,
            matchedSampleSize: 0,
        };
    }

    const barsHeld = exitIndex - entryIndex;
    if (barsHeld < 1) {
        return {
            hasOpenTrade: true,
            tradeType: openTrade.type,
            barsHeld,
            basisBar: null,
            signedMovePct: null,
            winProbabilityPct: null,
            loseProbabilityPct: null,
            sampleSize: 0,
            matchedSampleSize: 0,
        };
    }

    const basisBar = Math.min(horizonMaxBars, barsHeld);
    const probeIndex = entryIndex + basisBar;
    if (probeIndex >= ohlcvData.length || !Number.isFinite(ohlcvData[probeIndex].close)) {
        return {
            hasOpenTrade: true,
            tradeType: openTrade.type,
            barsHeld,
            basisBar,
            signedMovePct: null,
            winProbabilityPct: null,
            loseProbabilityPct: null,
            sampleSize: 0,
            matchedSampleSize: 0,
        };
    }

    const probeClose = ohlcvData[probeIndex].close;
    const rawProbeMovePct = ((probeClose - openTrade.entryPrice) / openTrade.entryPrice) * 100;
    const probeSignedMovePct = openTrade.type === "short" ? -rawProbeMovePct : rawProbeMovePct;

    const comparableTrades: Array<{ signedMovePct: number; isWin: boolean }> = [];
    for (const trade of trades) {
        if (trade.id === openTrade.id) continue;
        if (trade.exitReason === "end_of_data") continue;
        if (!Number.isFinite(trade.entryPrice) || trade.entryPrice <= 0) continue;

        const historicalEntryIndex = timeIndex.get(timeKey(trade.entryTime));
        if (historicalEntryIndex === undefined) continue;
        const historicalProbeIndex = historicalEntryIndex + basisBar;
        if (historicalProbeIndex >= ohlcvData.length) continue;

        const historicalClose = ohlcvData[historicalProbeIndex].close;
        if (!Number.isFinite(historicalClose)) continue;

        const rawMovePct = ((historicalClose - trade.entryPrice) / trade.entryPrice) * 100;
        const signedMovePct = trade.type === "short" ? -rawMovePct : rawMovePct;
        comparableTrades.push({ signedMovePct, isWin: trade.pnl > 0 });
    }

    if (comparableTrades.length === 0) {
        return {
            hasOpenTrade: true,
            tradeType: openTrade.type,
            barsHeld,
            basisBar,
            signedMovePct: probeSignedMovePct,
            winProbabilityPct: null,
            loseProbabilityPct: null,
            sampleSize: 0,
            matchedSampleSize: 0,
        };
    }

    const nearest = comparableTrades
        .map((sample) => ({
            ...sample,
            distance: Math.abs(sample.signedMovePct - probeSignedMovePct),
        }))
        .sort((a, b) => a.distance - b.distance);

    const matchedSampleSize = Math.max(8, Math.min(nearest.length, Math.round(nearest.length * 0.35)));
    const matched = nearest.slice(0, matchedSampleSize);
    const winCount = matched.filter((sample) => sample.isWin).length;
    const winProbabilityPct = matched.length > 0 ? (winCount / matched.length) * 100 : null;
    const loseProbabilityPct = winProbabilityPct === null ? null : 100 - winProbabilityPct;

    return {
        hasOpenTrade: true,
        tradeType: openTrade.type,
        barsHeld,
        basisBar,
        signedMovePct: probeSignedMovePct,
        winProbabilityPct,
        loseProbabilityPct,
        sampleSize: comparableTrades.length,
        matchedSampleSize: matched.length,
    };
}

function average(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    if (sorted.length % 2 === 0) {
        return (sorted[mid - 1] + sorted[mid]) / 2;
    }
    return sorted[mid];
}

function maximum(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((max, value) => (value > max ? value : max), values[0]);
}

function minimum(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((min, value) => (value < min ? value : min), values[0]);
}

function buildExitReasonBreakdown(trades: Trade[]): ExitReasonBreakdown | undefined {
    if (trades.length === 0) return undefined;

    const winTrades = trades.filter((trade) => trade.pnl > 0);
    const loseTrades = trades.filter((trade) => trade.pnl <= 0);

    const reasonCounts = new Map<string, { win: number; lose: number }>();
    for (const trade of trades) {
        const reason = trade.exitReason ?? "signal";
        if (!reasonCounts.has(reason)) {
            reasonCounts.set(reason, { win: 0, lose: 0 });
        }
        const counts = reasonCounts.get(reason)!;
        if (trade.pnl > 0) {
            counts.win++;
        } else {
            counts.lose++;
        }
    }

    const totalWins = winTrades.length;
    const totalLosses = loseTrades.length;

    const rows: ExitReasonRow[] = [];
    for (const [reason, counts] of reasonCounts) {
        const totalCount = counts.win + counts.lose;
        rows.push({
            reason: EXIT_REASON_LABELS[reason] ?? reason,
            winCount: counts.win,
            winPct: totalWins > 0 ? (counts.win / totalWins) * 100 : 0,
            loseCount: counts.lose,
            losePct: totalLosses > 0 ? (counts.lose / totalLosses) * 100 : 0,
            totalCount,
            totalPct: trades.length > 0 ? (totalCount / trades.length) * 100 : 0,
        });
    }

    rows.sort((a, b) => b.totalCount - a.totalCount);
    return { rows, totalWins, totalLosses };
}

function toEpochMs(time: Trade["entryTime"]): number | null {
    const unixSeconds = parseTimeToUnixSeconds(time);
    return unixSeconds === null ? null : unixSeconds * 1000;
}
