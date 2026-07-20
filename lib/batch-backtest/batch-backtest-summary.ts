import { computePerformanceVerdict } from "../finder/finder-universe-metrics";
import type { Time } from "../types/strategies";
import { formatProfitFactor } from "../ui-formatters";
import { computeBuyAndHoldPct, computeCurrentMaxActiveCandidates, computeOpenTradeAssetScores } from "./batch-row-scalars";
import type { BatchBacktestSymbolResult } from "./batch-backtest-runner";

export { computeBuyAndHoldPct, computeCurrentMaxActiveCandidates, computeOpenTradeAssetScores } from "./batch-row-scalars";

interface BatchOverallStats {
    completedRows: BatchBacktestSymbolResult[];
    resultRows: BatchBacktestSymbolResult[];
    profitableRows: BatchBacktestSymbolResult[];
    losingRows: BatchBacktestSymbolResult[];
    noTradeRows: BatchBacktestSymbolResult[];
    failedRows: BatchBacktestSymbolResult[];
    totalNet: number;
    totalTrades: number;
    totalWinningTrades: number;
    grossProfit: number;
    grossLossAbs: number;
    verdictCounts: Map<string, number>;
}

export function formatBatchSummaryLine(results: readonly BatchBacktestSymbolResult[]): string {
    const stats = summarizeBatchResults(results);
    if (stats.resultRows.length === 0) {
        return `${stats.completedRows.length} pair${stats.completedRows.length === 1 ? "" : "s"}`;
    }
    return [
        `${stats.resultRows.length} tested`,
        `${stats.profitableRows.length} profitable`,
        `Net ${formatCurrency(stats.totalNet)}`,
        `Trades ${stats.totalTrades}`,
        `Avg/Trade ${formatCurrency(resolveAggregateExpectancy(stats))}`,
        `Med Exposure ${formatPercent(medianMetric(stats.resultRows, (row) => row.tradeSummary?.exposurePercent ?? null))}`,
    ].join(" | ");
}

/**
 * Structured label/value cells for the Batch run-state summary grid. Same
 * reductions as {@link formatBatchSummaryLine}, but as stable cells instead of
 * a pipe-delimited strip so the UI can render a scannable grid (the pipe form
 * stays the clipboard/Copy surface). Returns null when no row produced a result.
 */
export function buildBatchSummaryCells(
    results: readonly BatchBacktestSymbolResult[],
): ReadonlyArray<readonly [string, string]> | null {
    const stats = summarizeBatchResults(results);
    if (stats.resultRows.length === 0) return null;
    return [
        ["Tested", `${stats.resultRows.length}`],
        ["Profitable", `${stats.profitableRows.length}`],
        ["Losing", `${stats.losingRows.length}`],
        ["Net", formatCurrency(stats.totalNet)],
        ["Trades", `${stats.totalTrades}`],
        ["Avg/Trade", formatCurrency(resolveAggregateExpectancy(stats))],
    ];
}

export function formatBatchOverallSummary(results: readonly BatchBacktestSymbolResult[]): string[] {
    const stats = summarizeBatchResults(results);
    if (stats.resultRows.length === 0) {
        return [`SUMMARY | Pairs ${stats.completedRows.length} | No completed backtests`];
    }

    const tradeWinRate = stats.totalTrades > 0
        ? (stats.totalWinningTrades / stats.totalTrades) * 100
        : null;
    const aggregateExpectancy = resolveAggregateExpectancy(stats);
    const aggregateProfitFactor = resolveAggregateProfitFactor(stats);
    const verdictText = formatVerdictCounts(stats.verdictCounts);
    const best = maxBy(stats.resultRows, (row) => row.result?.netProfit ?? Number.NEGATIVE_INFINITY);
    const worst = minBy(stats.resultRows, (row) => row.result?.netProfit ?? Number.POSITIVE_INFINITY);

    const lines = [
        [
            "SUMMARY",
            `Pairs ${stats.completedRows.length}`,
            `Tested ${stats.resultRows.length}`,
            `Profitable ${stats.profitableRows.length}/${stats.resultRows.length} (${formatPercent((stats.profitableRows.length / stats.resultRows.length) * 100)})`,
            `Losing ${stats.losingRows.length}`,
            `No Trades ${stats.noTradeRows.length}`,
            `Failed ${stats.failedRows.length}`,
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
        const maxActiveCandidates = computeCurrentMaxActiveCandidates(stats.resultRows);
        if (maxActiveCandidates.length > 0) {
            lines.push(
                `MAX_ACTIVE NOW | ${maxActiveCandidates.map((candidate) =>
                    `${candidate.asset} score=${formatSignedScore(candidate.score)} activePairs=${candidate.activePairs}`,
                ).join(" | ")}`,
            );
        }
    }

    return lines;
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
        const strat = row.result.netProfitPercent;
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
    // Exclude cancelled-tail rows from the aggregate. They used to be marked
    // `no_trades` + a sentinel error and were filtered by that pair; now they
    // carry a dedicated `skipped` status (audit benchmark-rows finding), so
    // filter on the status directly. The legacy `error` check is kept as a
    // back-compat guard for snapshots produced before the status existed.
    const completedRows = results.filter((row) => row.status !== "skipped"
        && (row.status !== "no_trades" || row.error !== "Skipped (cancelled)."));
    const resultRows = completedRows.filter((row) => Boolean(row.result));
    const profitableRows = resultRows.filter((row) => row.result!.netProfit > 0);
    const losingRows = resultRows.filter((row) => row.result!.netProfit < 0);
    const noTradeRows = completedRows.filter((row) => row.status === "no_trades");
    const failedRows = completedRows.filter((row) => row.status === "load_failed" || row.status === "run_failed");
    const verdictCounts = new Map<string, number>();

    let totalNet = 0;
    let totalTrades = 0;
    let totalWinningTrades = 0;
    let grossProfit = 0;
    let grossLossAbs = 0;
    for (const row of resultRows) {
        const result = row.result!;
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
        profitableRows,
        losingRows,
        noTradeRows,
        failedRows,
        totalNet,
        totalTrades,
        totalWinningTrades,
        grossProfit,
        grossLossAbs,
        verdictCounts,
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

function formatCurrency(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}$${value.toFixed(2)}`;
}

function formatNumber(value: number | null | undefined, digits: number): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return value.toFixed(digits);
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

function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    return `${value.toFixed(value >= 10 ? 0 : 1)}%`;
}

function formatSignedPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) {
        return "--";
    }
    const sign = value >= 0 ? "+" : "";
    return `${sign}${value.toFixed(Math.abs(value) >= 10 ? 1 : 2)}%`;
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
