import type { BatchDirectionForecastResult, BatchDirectionPathMetrics } from "./batch-signal-lifecycle-types";
import { parseTimeToUnixSeconds } from "../time-normalization";

export function formatDirectionForecastCopy(result: BatchDirectionForecastResult): string {
    const lines = [
        `DIRECTION FORECAST | Strategy ${result.strategyKey ?? "--"} | Interval ${result.interval} | Generated ${new Date(result.generatedAt).toISOString()}`,
        `RUN FINGERPRINT | ${result.fingerprint}`,
        "Asset | Symbol | State | Bias | Status | Freshness | Age | Agreement | Probability+ | Wilson | Median Return | IQR | Favorable | Adverse | Distance | Samples | Reason",
    ];
    for (const row of result.rows) {
        lines.push([
            row.asset,
            row.symbol,
            row.aggregateDirection?.toUpperCase() ?? "--",
            row.bias,
            row.status,
            row.freshness,
            formatInteger(row.lifecycleAge),
            `${row.agreementCount}/${row.oppositionCount}`,
            formatPercentFraction(row.probabilityPositive),
            `${formatPercentFraction(row.probabilityLower)}..${formatPercentFraction(row.probabilityUpper)}`,
            formatPercent(row.medianReturnPct),
            `${formatPercent(row.q1ReturnPct)}..${formatPercent(row.q3ReturnPct)}`,
            formatPercent(row.medianFavorableExcursionPct),
            formatPercent(row.medianAdverseExcursionPct),
            formatNumber(row.averageDistance),
            `${row.analogCount}/${row.candidateCount}`,
            row.reasonCode,
        ].join(" | "));
    }
    const selection = result.selectionPath;
    lines.push("");
    lines.push(`PATH | ${selection.status} | ${selection.reasonCode}`);
    lines.push(formatPath("Forecast", selection.path));
    lines.push(formatPath("Raw Agreement", selection.benchmarks.rawAgreement));
    lines.push(`Random | Median ${formatMoney(selection.benchmarks.randomMedianEquity)} | P05 ${formatMoney(selection.benchmarks.randomP05Equity)} | P95 ${formatMoney(selection.benchmarks.randomP95Equity)} | Cash ${formatMoney(selection.benchmarks.cashEquity)}`);
    lines.push(`QUALITY | ${selection.quality.status} | Percentile ${formatPercentFraction(selection.quality.selectedReturnPercentile)} | Excess ${formatPercent(selection.quality.excessVsEligibleMedianPct)} | Hit ${formatPercentFraction(selection.quality.selectionHitRate)} | Regret ${formatPercent(selection.quality.meanOpportunityRegretPct)} | Rank IC ${formatNumber(selection.quality.rankIc)} | Abstain ${formatPercentFraction(selection.quality.abstentionRate)} | Comparable ${selection.quality.comparableDecisions} | Unresolved ${selection.quality.excludedUnresolvedDecisions}`);
    lines.push("Dollar values are normalized research equity; FX, borrow, dividends, taxes, and corporate actions are not modeled.");
    return lines.join("\n");
}

function formatPath(label: string, path: BatchDirectionPathMetrics): string {
    return `${label} | ${formatTimeKey(path.testStartTimeKey)}..${formatTimeKey(path.testEndTimeKey)} | Realized ${formatMoney(path.realizedEquity)} | Marked ${formatMoney(path.markedEquity)} | Return ${formatPercent(path.returnPct)} | Max DD ${formatPercent(path.maxDrawdownPct)} | Trades ${path.trades} | Win ${formatPercentFraction(path.winRate)} | PF ${formatNumber(path.profitFactor)} | Exposure ${formatPercent(path.exposurePct)} | Turnover ${path.turnover} | Ruin ${path.ruin ? "YES" : "NO"} | ${formatWorstTrade(path)}`;
}

function formatWorstTrade(path: BatchDirectionPathMetrics): string {
    if (!path.worstTradeSymbol || !path.worstTradeBias) return "Worst --";
    return `Worst ${path.worstTradeSymbol} ${path.worstTradeBias} ${formatPercent(path.worstTradeReturnPct)} ${formatMoney(path.worstTradePnl)} ${formatTimeKey(path.worstTradeEntryTimeKey)}..${formatTimeKey(path.worstTradeExitTimeKey)}`;
}

function formatTimeKey(value: string | null): string {
    if (!value) return "--";
    const seconds = parseTimeToUnixSeconds(value);
    return seconds === null ? value : new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function formatMoney(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "--" : `$${value.toFixed(2)}`;
}

function formatPercent(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "--" : `${value.toFixed(2)}%`;
}

function formatPercentFraction(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "--" : `${(value * 100).toFixed(1)}%`;
}

function formatNumber(value: number | null): string {
    if (value === Number.POSITIVE_INFINITY) return "INF";
    return value === null || !Number.isFinite(value) ? "--" : value.toFixed(2);
}

function formatInteger(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "--" : String(Math.floor(value));
}
