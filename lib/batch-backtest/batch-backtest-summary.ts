import { computePerformanceVerdict } from "../finder/finder-universe-metrics";
import type { Time } from "../types/strategies";
import {
    formatNullableAdaptivePercentPoints as formatPercent,
    formatNullableAdaptiveSignedPercentPoints as formatSignedPercent,
    formatNullableFixed as formatNumber,
    formatNullableCurrency as formatCurrency,
    formatProfitFactor,
} from "../ui-formatters";
import { computeBuyAndHoldPct, computeCurrentMaxActiveCandidates, computeOpenTradeAssetScores } from "./batch-row-scalars";
import type { CurrentMaxActiveCandidate } from "./batch-row-scalars";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";
import { aggregateYearlyPnl, formatYearlyPnl, getBatchRowYearlyPnl } from "./batch-yearly-pnl";
import type { TradeGateStats } from "./trade-gate";

export { computeBuyAndHoldPct, computeCurrentMaxActiveCandidates, computeOpenTradeAssetScores } from "./batch-row-scalars";
export type { CurrentMaxActiveCandidate } from "./batch-row-scalars";

interface BatchOverallStats {
    completedRows: BatchBacktestSymbolResult[];
    resultRows: BatchBacktestSymbolResult[];
    // Audit: only `.length` of these four categories is ever consumed
    // downstream (verified: no caller indexes into the arrays). They are
    // counters, not row buckets — kept as `number` so the single-pass
    // summarizer below avoids the prior 4 separate `.filter(...)` allocations
    // over the same result set (the Copy Results path blocks the UI thread on
    // 1k–2k row runs and was halving allocations to no benefit).
    profitableCount: number;
    losingCount: number;
    noTradeCount: number;
    failedCount: number;
    totalNet: number;
    totalTrades: number;
    totalWinningTrades: number;
    grossProfit: number;
    grossLossAbs: number;
    verdictCounts: Map<string, number>;
    tradeGateStats: TradeGateStats | null;
}

/**
 * Structured label/value cells for the Batch run-state summary grid. The pipe
 * form remains the clipboard/Copy surface. Returns null when no row produced a
 * result.
 */
export function buildBatchSummaryCells(
    results: readonly BatchBacktestSymbolResult[],
): ReadonlyArray<readonly [string, string]> | null {
    const stats = summarizeBatchResults(results);
    if (stats.resultRows.length === 0) return null;
    const cells: Array<readonly [string, string]> = [
        ["Tested", `${stats.resultRows.length}`],
        ["Profitable", `${stats.profitableCount}`],
        ["Losing", `${stats.losingCount}`],
        ["Net", formatCurrency(stats.totalNet)],
        ["Trades", `${stats.totalTrades}`],
        ["Avg/Trade", formatCurrency(resolveAggregateExpectancy(stats))],
    ];
    if (stats.tradeGateStats) {
        cells.push(["Gate", `${stats.tradeGateStats.admitted} admitted / ${stats.tradeGateStats.rejectedByGate} rejected / ${stats.tradeGateStats.blocked} blocked`]);
    }
    return cells;
}

export function formatBatchOverallSummary(results: readonly BatchBacktestSymbolResult[]): string[] {
    const stats = summarizeBatchResults(results);
    const yearlyLines = [...stats.completedRows]
        .sort((a, b) => a.symbol.localeCompare(b.symbol))
        .map((row) => {
            const yearlyPnl = formatYearlyPnl(getBatchRowYearlyPnl(row));
            return `YEARLY | ${row.symbol} | ${yearlyPnl || "n/a"}`;
    });
    if (stats.resultRows.length === 0) {
        return [
            ...(stats.completedRows.length > 0 ? ["PORTFOLIO YEARLY | n/a"] : []),
            `SUMMARY | Pairs ${stats.completedRows.length} | No completed backtests`,
            ...yearlyLines,
        ];
    }

    const tradeWinRate = stats.totalTrades > 0
        ? (stats.totalWinningTrades / stats.totalTrades) * 100
        : null;
    const aggregateExpectancy = resolveAggregateExpectancy(stats);
    const aggregateProfitFactor = resolveAggregateProfitFactor(stats);
    const verdictText = formatVerdictCounts(stats.verdictCounts);
    const best = maxBy(stats.resultRows, (row) => row.result?.netProfit ?? Number.NEGATIVE_INFINITY);
    const worst = minBy(stats.resultRows, (row) => row.result?.netProfit ?? Number.POSITIVE_INFINITY);

    const portfolioYearlyPnl = formatYearlyPnl(
        aggregateYearlyPnl(stats.resultRows.map((row) => getBatchRowYearlyPnl(row))),
    );
    const lines = [
        `PORTFOLIO YEARLY | ${portfolioYearlyPnl || "n/a"}`,
        [
            "SUMMARY",
            `Pairs ${stats.completedRows.length}`,
            `Tested ${stats.resultRows.length}`,
            `Profitable ${stats.profitableCount}/${stats.resultRows.length} (${formatPercent((stats.profitableCount / stats.resultRows.length) * 100)})`,
            `Losing ${stats.losingCount}`,
            `No Trades ${stats.noTradeCount}`,
            `Failed ${stats.failedCount}`,
            verdictText,
        ].filter(Boolean).join(" | "),
        [
            "SUMMARY",
            `Total Net ${formatCurrency(stats.totalNet)}`,
            `Avg Net/Pair ${formatCurrency(stats.totalNet / stats.resultRows.length)}`,
            `Median Net ${formatCurrency(medianMetric(stats.resultRows, (row) => row.result?.netProfit ?? null))}`,
            best ? `Best ${best.symbol} ${formatCurrency(best.result!.netProfit)}` : "",
            worst ? `Worst ${worst.symbol} ${formatCurrency(worst.result!.netProfit)}` : "",
        ].filter(Boolean).join(" | "),
        [
            "SUMMARY",
            `Trades ${stats.totalTrades}`,
            `Trade WR ${formatPercent(tradeWinRate)}`,
            `Avg/Trade ${formatCurrency(aggregateExpectancy)}`,
            `PF ${formatProfitFactor(aggregateProfitFactor ?? Number.NaN)}`,
            `Median Trades ${formatNumber(medianMetric(stats.resultRows, (row) => row.result?.totalTrades ?? null), 0)}`,
            `Median AvgTrade ${formatCurrency(medianMetric(stats.resultRows, (row) => row.result?.avgTrade ?? null))}`,
            `Median Sharpe ${formatNumber(medianMetric(stats.resultRows, (row) => row.result?.sharpeRatio ?? null), 2)}`,
            `Median DD ${formatPercent(medianMetric(stats.resultRows, (row) => row.result?.maxDrawdownPercent ?? null))}`,
        ].join(" | "),
        [
            "SUMMARY",
            `Median Hold ${formatHoldSummary(medianMetric(stats.resultRows, (row) => row.tradeSummary?.avgHoldBars ?? null), medianMetric(stats.resultRows, (row) => row.tradeSummary?.avgHoldDays ?? null))}`,
            `Median MaxHold ${formatHoldSummary(medianMetric(stats.resultRows, (row) => row.tradeSummary?.maxHoldBars ?? null), medianMetric(stats.resultRows, (row) => row.tradeSummary?.maxHoldDays ?? null))}`,
            `Median Exposure ${formatPercent(medianMetric(stats.resultRows, (row) => row.tradeSummary?.exposurePercent ?? null))}`,
        ].join(" | "),
    ];
    lines.push(...yearlyLines);
    if (stats.tradeGateStats) {
        lines.push(`TRADE_GATE | Evaluated ${stats.tradeGateStats.signalsEvaluated} | Admitted ${stats.tradeGateStats.admitted} | Rejected ${stats.tradeGateStats.rejectedByGate} | Blocked ${stats.tradeGateStats.blocked}`);
    }

    const bhRows = buildBuyHoldRows(stats.resultRows);
    if (bhRows.length > 0) {
        const medStrat = median(bhRows.map((r) => r.strat));
        const medBh = median(bhRows.map((r) => r.bh));
        const medAlpha = median(bhRows.map((r) => r.alpha));
        const avgAlpha = mean(bhRows.map((r) => r.alpha));
        lines.push(
            [
                "SUMMARY",
                `B&H Compare ${bhRows.length}/${stats.resultRows.length} pairs`,
                `Med Strat ${formatSignedPercent(medStrat)}`,
                `Med B&H ${formatSignedPercent(medBh)}`,
                `Med Alpha ${formatSignedPercent(medAlpha)}`,
                `Avg Alpha ${formatSignedPercent(avgAlpha)}`,
            ].join(" | "),
        );

        const regime = summarizeRegimeSplit(bhRows);
        lines.push(
            [
                "REGIME",
                `Uptrend ${regime.up.count} pairs | Strat ${formatSignedPercent(regime.up.avgStrat)} | B&H ${formatSignedPercent(regime.up.avgBh)} | Alpha ${formatSignedPercent(regime.up.avgAlpha)}`,
                `Down ${regime.down.count} pairs | Strat ${formatSignedPercent(regime.down.avgStrat)} | B&H ${formatSignedPercent(regime.down.avgBh)} | Alpha ${formatSignedPercent(regime.down.avgAlpha)}`,
            ].join(" | "),
        );

        const sortedBySymbol = [...bhRows].sort((a, b) => a.symbol.localeCompare(b.symbol));
        for (const row of sortedBySymbol) {
            lines.push(
                `B&H | ${row.symbol} | Strat ${formatSignedPercent(row.strat)} | B&H ${formatSignedPercent(row.bh)} | Alpha ${formatSignedPercent(row.alpha)}`,
            );
        }
    }

    const concentration = summarizeProfitConcentration(stats.resultRows);
    lines.push(
        [
            "CONCENTRATION",
            `Net $${concentration.totalNet.toFixed(0)}`,
            `Top1 ${formatPercent(concentration.top1Share * 100)}`,
            `Top3 ${formatPercent(concentration.top3Share * 100)}`,
            `Top10 ${formatPercent(concentration.top10Share * 100)}`,
            concentration.effectiveN !== null ? `EffN ${concentration.effectiveN.toFixed(1)}` : "EffN --",
        ].join(" | "),
    );

    const robustness = summarizeRobustness(stats.resultRows);
    lines.push(
        [
            "ROBUSTNESS",
            `Sharpe>1 ${robustness.sharpeGt1}/${robustness.total}`,
            `Sharpe>2 ${robustness.sharpeGt2}/${robustness.total}`,
            `THIN ${robustness.thin} (${formatPercent((robustness.thin / Math.max(1, robustness.total)) * 100)})`,
            `Sample-adequate ${robustness.total - robustness.thin}`,
        ].join(" | "),
    );

    const scores = computeOpenTradeAssetScores(stats.resultRows);
    if (scores.length > 0) {
        lines.push(
            `OPEN_SCORE | ${scores.map((s) => `${s.asset} ${formatSignedScore(s.score)}`).join(", ")}`,
        );
        const openConcentration = summarizeOpenScoreConcentration(scores);
        lines.push(
            [
                "OPEN_SCORE",
                `EffN ${openConcentration.effectiveN.toFixed(1)}`,
                `Top3 ${openConcentration.top3Assets.join(", ")} = ${formatPercent(openConcentration.top3Share * 100)} gross`,
            ].join(" | "),
        );
        const maxActiveCandidates = computeCurrentMaxActiveCandidates(stats.resultRows, scores);
        if (maxActiveCandidates.length > 0) {
            lines.push(
                `MAX_ACTIVE NOW | ${maxActiveCandidates.map((candidate) =>
                    `${candidate.asset} score=${formatSignedScore(candidate.score)} activePairs=${candidate.activePairs}`,
                ).join(" | ")}`,
            );
            // TOP_RAW NOW / TOP_MEAN NOW are live-snapshot parallels of the
            // historical-replay arms. Both reuse the positives pool already
            // assembled by computeCurrentMaxActiveCandidates (which returns
            // every positive asset with its activePairs count, NOT just the
            // MAX_ACTIVE winners) — re-derive the full positive list with
            // the same scoring, then pick by the arm's key. All tied winners
            // are surfaced (mirrors MAX_ACTIVE NOW's no-arbitrary-tiebreak
            // rule). See docs/batch-backtest-server-side.md for the arm
            // semantics and current-snapshot context.
            const positivesWithCoverage = computeOpenScorePositivesWithCoverage(stats.resultRows, scores);
            const topRawNow = pickTopPositive(positivesWithCoverage, (c) => c.score);
            if (topRawNow.length > 0) {
                lines.push(
                    `TOP_RAW NOW | ${topRawNow.map((candidate) =>
                        `${candidate.asset} score=${formatSignedScore(candidate.score)} activePairs=${candidate.activePairs}`,
                    ).join(" | ")}`,
                );
            }
            const topMeanNow = pickTopPositive(positivesWithCoverage, (c) =>
                candidateMean(c),
            );
            if (topMeanNow.length > 0) {
                lines.push(
                    `TOP_MEAN NOW | ${topMeanNow.map((candidate) =>
                        `${candidate.asset} mean=${formatMeanScore(candidateMean(candidate))} score=${formatSignedScore(candidate.score)} activePairs=${candidate.activePairs}`,
                    ).join(" | ")}`,
                );
            }
        }
    }

    return lines;
}

/**
 * Live-snapshot helper for TOP_RAW NOW / TOP_MEAN NOW. Returns the full
 * positive-score candidate list (every asset with raw score > 0) along with
 * its currently-open pair count. Mirrors {@link computeCurrentMaxActiveCandidates}
 * minus the max-activePairs filter.
 */
function computeOpenScorePositivesWithCoverage(
    rows: readonly BatchBacktestSymbolResult[],
    /**
     * Optional pre-computed asset scores for the same `rows` (e.g. the
     * OPEN_SCORE summary line). When supplied, the O(N)
     * `computeOpenTradeAssetScores(rows)` call is skipped — important because
     * the Copy Results path used to recompute the same map three times.
     */
    scores?: { asset: string; score: number }[],
): CurrentMaxActiveCandidate[] {
    const activePairsByAsset = new Map<string, number>();
    for (const row of rows) {
        const rowScores = row.openTradeAssetScores ?? computeOpenTradeAssetScores([row]);
        const assetsInOpenPair = new Set(rowScores.filter((entry) => entry.score !== 0).map((entry) => entry.asset));
        for (const asset of assetsInOpenPair) {
            activePairsByAsset.set(asset, (activePairsByAsset.get(asset) ?? 0) + 1);
        }
    }
    return (scores ?? computeOpenTradeAssetScores(rows))
        .filter((entry) => entry.score > 0)
        .map((entry) => ({
            ...entry,
            activePairs: activePairsByAsset.get(entry.asset) ?? 0,
        }));
}

/** mean signed vote = score / activePairs (the TOP_MEAN arm's selection key). */
function candidateMean(candidate: CurrentMaxActiveCandidate): number {
    return candidate.activePairs > 0 ? candidate.score / candidate.activePairs : candidate.score;
}

/** Pick every candidate tied at the maximum of `key`, sorted by score then name. */
function pickTopPositive<T extends { score: number; asset: string }>(
    candidates: readonly T[],
    key: (c: T) => number,
): T[] {
    if (candidates.length === 0) return [];
    let maxValue = -Infinity;
    for (const c of candidates) {
        const k = key(c);
        if (k > maxValue) maxValue = k;
    }
    return candidates
        .filter((c) => key(c) === maxValue)
        .sort((a, b) => b.score - a.score || a.asset.localeCompare(b.asset));
}

function formatMeanScore(value: number): string {
    if (!Number.isFinite(value)) return "--";
    const rounded = Math.round(value * 100) / 100;
    return rounded >= 0 ? `+${rounded}` : `${rounded}`;
}

/**
 * Structured grid cells for one Batch result row (point 5 of the Batch UI
 * refactor): split into stable columns so the UI can render a scannable metric
 * grid instead of a pipe-delimited string. `error` is surfaced separately so
 * the grid can render it as a row-level note rather than mid-pipe text.
 */
export interface ResultRowGrid {
    symbol: string;
    status: string;
    net: { text: string; sign: "profit" | "loss" | "neutral" };
    expectancy: { text: string; sign: "profit" | "loss" | "neutral" };
    profitFactor: string;
    sharpe: string;
    drawdown: string;
    trades: string;
    yearlyPnl: string;
    secondary: ReadonlyArray<readonly [string, string]>;
    error: string | null;
}

export function buildResultRowGrid(result: BatchBacktestSymbolResult): ResultRowGrid {
    const r = result.result;
    const secondary: Array<[string, string]> = [[ "Bars", `${result.barCount}` ]];
    if (r) {
        secondary.push(["Hold", formatHold(result)]);
        secondary.push(["Exposure", formatPercent(result.tradeSummary?.exposurePercent)]);
        secondary.push(["AvgTrade", formatCurrency(r.avgTrade)]);
        secondary.push(["WR", `${r.winRate.toFixed(0)}%`]);
        if (r.tradeGateStats) {
            secondary.push(["Gate", `E${r.tradeGateStats.signalsEvaluated} / A${r.tradeGateStats.admitted} / R${r.tradeGateStats.rejectedByGate} / B${r.tradeGateStats.blocked}`]);
        }
    }
    const range = formatTimeRange(result.firstTime, result.lastTime);
    if (range) secondary.push(["Range", range]);
    return {
        symbol: result.symbol,
        status: formatStatus(result.status),
        net: signedCurrencyCell(r?.netProfit),
        expectancy: signedCurrencyCell(r?.expectancy),
        profitFactor: r ? formatProfitFactor(r.profitFactor) : "--",
        sharpe: r && Number.isFinite(r.sharpeRatio) ? r.sharpeRatio.toFixed(2) : "--",
        drawdown: r && Number.isFinite(r.maxDrawdownPercent) ? `${r.maxDrawdownPercent.toFixed(2)}%` : "--",
        trades: r ? `${r.totalTrades}` : "--",
        yearlyPnl: (() => {
            const formatted = formatYearlyPnl(getBatchRowYearlyPnl(result));
            return formatted || "n/a";
        })(),
        secondary,
        error: result.error ?? null,
    };
}

function signedCurrencyCell(value: number | null | undefined): { text: string; sign: "profit" | "loss" | "neutral" } {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return { text: "--", sign: "neutral" };
    }
    const sign: "profit" | "loss" | "neutral" = value > 0 ? "profit" : value < 0 ? "loss" : "neutral";
    return { text: formatCurrency(value), sign };
}

export interface BuyHoldRow {
    symbol: string;
    strat: number;
    bh: number;
    alpha: number;
}

export function buildBuyHoldRows(rows: readonly BatchBacktestSymbolResult[]): BuyHoldRow[] {
    const out: BuyHoldRow[] = [];
    for (const row of rows) {
        if (!row.result) continue;
        const bh = row.buyHoldPct ?? computeBuyAndHoldPct(row.data);
        if (bh === null) continue;
        const strat = row.strategyComparisonPct ?? row.result.netProfitPercent;
        out.push({ symbol: row.symbol, strat, bh, alpha: strat - bh });
    }
    return out;
}

interface RegimeBucket {
    count: number;
    avgStrat: number;
    avgBh: number;
    avgAlpha: number;
}

export interface RegimeSplit {
    up: RegimeBucket;
    down: RegimeBucket;
}

export function summarizeRegimeSplit(rows: readonly BuyHoldRow[]): RegimeSplit {
    const up = rows.filter((r) => r.bh >= 0);
    const down = rows.filter((r) => r.bh < 0);
    return {
        up: summarizeRegimeBucket(up),
        down: summarizeRegimeBucket(down),
    };
}

function summarizeRegimeBucket(rows: readonly BuyHoldRow[]): RegimeBucket {
    if (rows.length === 0) {
        return { count: 0, avgStrat: NaN, avgBh: NaN, avgAlpha: NaN };
    }
    return {
        count: rows.length,
        avgStrat: mean(rows.map((r) => r.strat)),
        avgBh: mean(rows.map((r) => r.bh)),
        avgAlpha: mean(rows.map((r) => r.alpha)),
    };
}

export interface ProfitConcentration {
    totalNet: number;
    top1Share: number;
    top3Share: number;
    top10Share: number;
    effectiveN: number | null;
}

export function summarizeProfitConcentration(rows: readonly BatchBacktestSymbolResult[]): ProfitConcentration {
    const nets = rows
        .map((r) => r.result?.netProfit ?? 0)
        .filter((v) => Number.isFinite(v));
    const totalNet = nets.reduce((sum, v) => sum + v, 0);
    const sortedDesc = [...nets].sort((a, b) => b - a);
    const grossPositive = sortedDesc.filter((v) => v > 0).reduce((sum, v) => sum + v, 0);

    const share = (topK: number): number => {
        if (grossPositive <= 0) return 0;
        const topSum = sortedDesc.slice(0, topK).filter((v) => v > 0).reduce((sum, v) => sum + v, 0);
        return topSum / grossPositive;
    };

    let effectiveN: number | null = null;
    if (grossPositive > 0) {
        const positiveShares = sortedDesc.filter((v) => v > 0).map((v) => v / grossPositive);
        const hhi = positiveShares.reduce((sum, s) => sum + s * s, 0);
        effectiveN = hhi > 0 ? 1 / hhi : null;
    }

    return {
        totalNet,
        top1Share: share(1),
        top3Share: share(3),
        top10Share: share(10),
        effectiveN,
    };
}

export interface RobustnessSummary {
    total: number;
    sharpeGt1: number;
    sharpeGt2: number;
    thin: number;
}

export function summarizeRobustness(rows: readonly BatchBacktestSymbolResult[]): RobustnessSummary {
    let total = 0;
    let sharpeGt1 = 0;
    let sharpeGt2 = 0;
    let thin = 0;
    for (const row of rows) {
        if (!row.result) continue;
        total += 1;
        const sharpe = row.result.sharpeRatio;
        if (Number.isFinite(sharpe) && sharpe > 1) sharpeGt1 += 1;
        if (Number.isFinite(sharpe) && sharpe > 2) sharpeGt2 += 1;
        if (row.result.totalTrades < 15) thin += 1;
    }
    return { total, sharpeGt1, sharpeGt2, thin };
}

export interface OpenScoreConcentration {
    effectiveN: number;
    top3Assets: string[];
    top3Share: number;
}

export function summarizeOpenScoreConcentration(scores: readonly { asset: string; score: number }[]): OpenScoreConcentration {
    const grossByAbs = scores.map((s) => Math.abs(s.score));
    const totalGross = grossByAbs.reduce((sum, v) => sum + v, 0);
    if (totalGross <= 0) {
        return { effectiveN: 0, top3Assets: [], top3Share: 0 };
    }
    const shares = grossByAbs.map((v) => v / totalGross);
    const hhi = shares.reduce((sum, s) => sum + s * s, 0);
    const effectiveN = hhi > 0 ? 1 / hhi : 0;

    const top3 = [...scores]
        .sort((a, b) => Math.abs(b.score) - Math.abs(a.score) || a.asset.localeCompare(b.asset))
        .slice(0, 3);
    const top3Gross = top3.reduce((sum, s) => sum + Math.abs(s.score), 0);
    return {
        effectiveN,
        top3Assets: top3.map((s) => `${s.asset} ${formatSignedScore(s.score)}`),
        top3Share: top3Gross / totalGross,
    };
}

function summarizeBatchResults(results: readonly BatchBacktestSymbolResult[]): BatchOverallStats {
    // Single pass over `results` that buckets rows into the categories the
    // prior implementation produced via six separate `.filter(...)` passes.
    // `resultRows` is the only bucket whose array shape is still needed
    // downstream (every medianMetric / concentration / robustness selector
    // iterates it), so it is the only retained array. `completedRows`,
    // `profitable`, `losing`, `noTrade`, and `failed` are pure counters —
    // verified no caller indexes into them — so the rewrite halves
    // allocations and drops ~5 full passes on the Copy Results hot path.
    //
    // Exclude cancelled-tail rows from the aggregate. They used to be marked
    // `no_trades` + a sentinel error and were filtered by that pair; now they
    // carry a dedicated `skipped` status (audit benchmark-rows finding), so
    // filter on the status directly. The legacy `error` check is kept as a
    // back-compat guard for snapshots produced before the status existed.
    const completedRows: BatchBacktestSymbolResult[] = [];
    const resultRows: BatchBacktestSymbolResult[] = [];
    let profitableCount = 0;
    let losingCount = 0;
    let noTradeCount = 0;
    let failedCount = 0;
    let totalNet = 0;
    let totalTrades = 0;
    let totalWinningTrades = 0;
    let grossProfit = 0;
    let grossLossAbs = 0;
    const verdictCounts = new Map<string, number>();
    let tradeGateStats: TradeGateStats | null = null;

    for (const row of results) {
        if (row.status === "skipped") continue;
        if (row.status === "no_trades" && row.error === "Skipped (cancelled).") continue;
        completedRows.push(row);
        if (row.status === "no_trades") noTradeCount += 1;
        if (row.status === "load_failed" || row.status === "run_failed") failedCount += 1;
        if (!row.result) continue;
        resultRows.push(row);
        const result = row.result;
        if (result.tradeGateStats) {
            tradeGateStats ??= { signalsEvaluated: 0, admitted: 0, rejectedByGate: 0, blocked: 0 };
            tradeGateStats.signalsEvaluated += result.tradeGateStats.signalsEvaluated;
            tradeGateStats.admitted += result.tradeGateStats.admitted;
            tradeGateStats.rejectedByGate += result.tradeGateStats.rejectedByGate;
            tradeGateStats.blocked += result.tradeGateStats.blocked;
        }
        if (result.netProfit > 0) profitableCount += 1;
        else if (result.netProfit < 0) losingCount += 1;
        totalNet += result.netProfit;
        totalTrades += result.totalTrades;
        totalWinningTrades += result.winningTrades;
        grossProfit += Math.max(0, result.avgWin) * result.winningTrades;
        grossLossAbs += Math.max(0, result.avgLoss) * result.losingTrades;

        const verdict = computePerformanceVerdict(result, row.status).label;
        verdictCounts.set(verdict, (verdictCounts.get(verdict) ?? 0) + 1);
    }

    return {
        completedRows,
        resultRows,
        profitableCount,
        losingCount,
        noTradeCount,
        failedCount,
        totalNet,
        totalTrades,
        totalWinningTrades,
        grossProfit,
        grossLossAbs,
        verdictCounts,
        tradeGateStats,
    };
}

function resolveAggregateExpectancy(stats: BatchOverallStats): number | null {
    return stats.totalTrades > 0 ? stats.totalNet / stats.totalTrades : null;
}

function resolveAggregateProfitFactor(stats: BatchOverallStats): number | null {
    if (stats.grossLossAbs > 0) {
        return stats.grossProfit / stats.grossLossAbs;
    }
    return stats.grossProfit > 0 ? Infinity : null;
}

function formatStatus(status: BatchBacktestSymbolResult["status"]): string {
    switch (status) {
        case "profitable": return "Profitable";
        case "losing": return "Losing";
        case "flat": return "Flat";
        case "no_trades": return "No Trades";
        case "load_failed": return "Load Failed";
        case "run_failed": return "Run Failed";
        case "skipped": return "Skipped";
        default: return status;
    }
}

function formatVerdictCounts(verdictCounts: ReadonlyMap<string, number>): string {
    const labels = ["STRONG", "SOLID", "MARGINAL", "WEAK", "THIN", "LOSING"];
    const parts = labels
        .map((label) => {
            const count = verdictCounts.get(label) ?? 0;
            return count > 0 ? `${label} ${count}` : "";
        })
        .filter(Boolean);
    return parts.length > 0 ? `Verdicts ${parts.join(", ")}` : "";
}

function medianMetric(
    rows: readonly BatchBacktestSymbolResult[],
    select: (row: BatchBacktestSymbolResult) => number | null | undefined,
): number | null {
    const values = rows
        .map(select)
        .filter((value): value is number => value !== null && value !== undefined && Number.isFinite(value))
        .sort((a, b) => a - b);
    if (values.length === 0) return null;
    const middle = Math.floor(values.length / 2);
    if (values.length % 2 === 1) return values[middle]!;
    return (values[middle - 1]! + values[middle]!) / 2;
}

function maxBy<T>(items: readonly T[], select: (item: T) => number): T | null {
    let best: T | null = null;
    let bestValue = Number.NEGATIVE_INFINITY;
    for (const item of items) {
        const value = select(item);
        if (value > bestValue) {
            best = item;
            bestValue = value;
        }
    }
    return best;
}

function minBy<T>(items: readonly T[], select: (item: T) => number): T | null {
    let best: T | null = null;
    let bestValue = Number.POSITIVE_INFINITY;
    for (const item of items) {
        const value = select(item);
        if (value < bestValue) {
            best = item;
            bestValue = value;
        }
    }
    return best;
}

function formatHoldSummary(bars: number | null, days: number | null): string {
    const barsText = formatHoldBars(bars);
    const daysText = formatHoldDuration(days);
    return daysText === "--" ? barsText : `${barsText} (${daysText})`;
}

function formatHold(result: BatchBacktestSymbolResult): string {
    const summary = result.tradeSummary;
    const bars = `${formatHoldBars(summary?.avgHoldBars)}/${formatHoldBars(summary?.maxHoldBars)}`;
    const days = `${formatHoldDuration(summary?.avgHoldDays)}/${formatHoldDuration(summary?.maxHoldDays)}`;
    return days === "--/--" ? bars : `${bars} (${days})`;
}

function formatHoldBars(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)}b`;
}

function formatHoldDuration(days: number | null | undefined): string {
    if (days === null || days === undefined || !Number.isFinite(days)) {
        return "--";
    }
    if (days >= 1) {
        return `${days.toFixed(days >= 10 ? 0 : 1)}d`;
    }
    const hours = days * 24;
    if (hours >= 1) {
        return `${hours.toFixed(hours >= 10 ? 0 : 1)}h`;
    }
    return `${Math.max(0, hours * 60).toFixed(0)}m`;
}

function formatTimeRange(firstTime?: Time, lastTime?: Time): string {
    if (!firstTime && !lastTime) return "";
    const firstLabel = firstTime ? formatTime(firstTime) : "?";
    const lastLabel = lastTime ? formatTime(lastTime) : "?";
    return `${firstLabel} -> ${lastLabel}`;
}

function formatTime(time: Time): string {
    if (typeof time === "string") return time;
    if (typeof time === "number") {
        const ms = time > 1_000_000_000_000 ? time : time * 1000;
        return new Date(ms).toISOString().slice(0, 10);
    }
    if (time && typeof time === "object" && "year" in time && "month" in time && "day" in time) {
        const month = String(time.month).padStart(2, "0");
        const day = String(time.day).padStart(2, "0");
        return `${time.year}-${month}-${day}`;
    }
    return String(time);
}

function mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    let sum = 0;
    for (const v of values) sum += v;
    return sum / values.length;
}

function median(values: readonly number[]): number {
    if (values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function formatSignedScore(value: number): string {
    if (!Number.isFinite(value)) return "--";
    return value >= 0 ? `+${value}` : `${value}`;
}
