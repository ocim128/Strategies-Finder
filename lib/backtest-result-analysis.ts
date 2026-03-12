import type {
    BacktestResult,
    ExitReasonBreakdown,
    ExitReasonRow,
    OHLCVData,
    PostEntryPathBucketStats,
    PostEntryPathOpenTradeProbability,
    PostEntryPathStats,
    SnapshotProfileRow,
    SnapshotProfileStats,
    Trade,
    TradeSnapshot,
} from "./strategies/index";
import { timeKey } from "./strategies/index";
import { getTimeIndex } from "./strategies/backtest/backtest-utils";
import { parseTimeToUnixSeconds } from "./time-normalization";

const SNAPSHOT_METRIC_DEFS: Array<{ key: keyof TradeSnapshot; label: string }> = [
    { key: "rsi", label: "RSI" },
    { key: "adx", label: "ADX" },
    { key: "atrPercent", label: "ATR %" },
    { key: "emaDistance", label: "EMA Distance %" },
    { key: "volumeRatio", label: "Volume Ratio" },
    { key: "priceRangePos", label: "Price Range Pos" },
    { key: "barsFromHigh", label: "Bars From High" },
    { key: "barsFromLow", label: "Bars From Low" },
    { key: "trendEfficiency", label: "Trend Efficiency" },
    { key: "atrRegimeRatio", label: "ATR Regime Ratio" },
    { key: "bodyPercent", label: "Body %" },
    { key: "wickSkew", label: "Wick Skew" },
    { key: "closeLocation", label: "Close Location" },
    { key: "oppositeWickPercent", label: "Opposite Wick %" },
    { key: "rangeAtrMultiple", label: "Range/ATR Multiple" },
    { key: "momentumConsistency", label: "Momentum Consistency" },
    { key: "breakQuality", label: "Break Quality" },
    { key: "entryQualityScore", label: "Entry Quality Score" },
    { key: "volumeTrend", label: "Volume Trend" },
    { key: "volumeBurst", label: "Volume Burst" },
    { key: "volumePriceDivergence", label: "Vol-Price Divergence" },
    { key: "volumeConsistency", label: "Volume Consistency" },
    { key: "tf60Perf", label: "60m Perf %" },
    { key: "tf90Perf", label: "90m Perf %" },
    { key: "tf120Perf", label: "120m Perf %" },
    { key: "tf480Perf", label: "480m Perf %" },
    { key: "tfConfluencePerf", label: "TF Confluence %" },
];

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
        snapshotProfile: buildSnapshotProfile(result.trades),
        exitReasonBreakdown: buildExitReasonBreakdown(result.trades),
    };
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

function buildSnapshotProfile(trades: Trade[]): SnapshotProfileStats | undefined {
    const withSnapshots = trades.filter((trade) => trade.entrySnapshot);
    if (withSnapshots.length === 0) return undefined;

    const winTrades = withSnapshots.filter((trade) => trade.pnl > 0);
    const loseTrades = withSnapshots.filter((trade) => trade.pnl <= 0);

    const rows: SnapshotProfileRow[] = [];

    for (const def of SNAPSHOT_METRIC_DEFS) {
        const winValues = extractSnapshotValues(winTrades, def.key);
        const loseValues = extractSnapshotValues(loseTrades, def.key);
        const allValues = extractSnapshotValues(withSnapshots, def.key);
        if (allValues.length === 0) continue;

        const winAvg = average(winValues);
        const loseAvg = average(loseValues);
        const allAvg = average(allValues);
        const delta = winAvg !== null && loseAvg !== null ? winAvg - loseAvg : null;

        let significance: number | null = null;
        if (delta !== null && allValues.length >= 3) {
            const computedStddev = stddev(allValues);
            if (computedStddev !== null && computedStddev > 0) {
                significance = Math.abs(delta) / computedStddev;
            }
        }

        rows.push({
            key: def.key,
            label: def.label,
            winAvg,
            loseAvg,
            allAvg,
            delta,
            significance,
        });
    }

    rows.sort((a, b) => (b.significance ?? -1) - (a.significance ?? -1));

    return {
        rows,
        winSampleSize: winTrades.length,
        loseSampleSize: loseTrades.length,
    };
}

function extractSnapshotValues(trades: Trade[], key: keyof TradeSnapshot): number[] {
    const values: number[] = [];
    for (const trade of trades) {
        const snapshot = trade.entrySnapshot;
        if (!snapshot) continue;
        const value = snapshot[key];
        if (typeof value === "number" && Number.isFinite(value)) {
            values.push(value);
        }
    }
    return values;
}

function stddev(values: number[]): number | null {
    if (values.length < 2) return null;
    const avg = values.reduce((sum, value) => sum + value, 0) / values.length;
    const variance = values.reduce((sum, value) => sum + (value - avg) ** 2, 0) / values.length;
    return Math.sqrt(variance);
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
