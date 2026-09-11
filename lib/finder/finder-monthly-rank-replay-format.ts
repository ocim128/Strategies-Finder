/**
 * Monthly Rank Replay — report text formatting shared by the Finder UI
 * renderer and Copy Results. Pure string builders so the displayed details
 * and the copied output can never disagree.
 *
 * Browser-safe: no server-only imports (the manager renders with this in the
 * tab; nothing here reaches Node APIs).
 */

import type {
    MonthlyRankReplayForwardOutcome,
    MonthlyRankReplayReport,
    MonthlyRankReplaySelection,
    MonthlyRankReplaySortSummary,
} from "./finder-monthly-rank-replay";

function formatScore(value: number | null | undefined): string {
    if (value === null || value === undefined) return "--";
    if (value === Number.POSITIVE_INFINITY) return "+Inf";
    if (value === Number.NEGATIVE_INFINITY) return "-Inf";
    return Number.isFinite(value) ? String(Math.round(value * 10000) / 10000) : "--";
}

function formatPercent(value: number | null | undefined): string {
    if (value === null || value === undefined || !Number.isFinite(value)) return "--";
    const sign = value > 0 ? "+" : "";
    return `${sign}${(Math.round(value * 100) / 100).toFixed(2)}%`;
}

function formatDirection(direction: MonthlyRankReplaySelection["direction"]): string {
    return direction === "ascending" ? "lower first" : "higher first";
}

/** One summary line per historical sort — mirrors the rendered table rows. */
export function formatMonthlyRankReplaySummaryRow(summary: MonthlyRankReplaySortSummary): string {
    const validityLabel = summary.validCheckpoints === 0
        ? "no valid observations"
        : `valid ${summary.coverage}`;
    return [
        `${summary.sortLabel} — rank #1`,
        validityLabel,
        `mean ${formatPercent(summary.meanForwardReturnPercent)}`,
        `median ${formatPercent(summary.medianForwardReturnPercent)}`,
        `pos ${summary.positiveWindows}/${summary.validCheckpoints}`,
        `worst ${formatPercent(summary.worstWindowReturnPercent)}`,
        `zero-trade ${summary.zeroTradeWindows}`,
        summary.excludedCounts.length > 0
            ? `excluded: ${summary.excludedCounts.map((entry) => `${entry.reason} x${entry.count}`).join(", ")}`
            : "excluded: none",
    ].join(" | ");
}

/** One line per selection (checkpoint × sort), including forward outcome. */
export function formatMonthlyRankReplaySelectionLine(
    selection: MonthlyRankReplaySelection,
    outcome: MonthlyRankReplayForwardOutcome | undefined,
): string {
    const parts: string[] = [
        selection.checkpointLabel,
        selection.sortLabel,
        `score ${formatScore(selection.score)}`,
    ];
    if (selection.status === "measured" && selection.strategyKey) {
        parts.push(
            `${selection.strategyName} (${selection.strategyKey})`,
            `params ${JSON.stringify(selection.params ?? {})}`,
        );
        if (selection.exitStrategyKey) {
            parts.push(`exit ${selection.exitStrategyKey} ${JSON.stringify(selection.exitStrategyParams ?? {})}`);
        }
        parts.push(
            `active ${selection.historicalActiveSymbols}`,
            `sharpe-contributors ${selection.historicalSharpeContributors}`,
        );
    } else {
        parts.push(`status ${selection.status}${selection.reason ? ` (${selection.reason})` : ""}`);
        return parts.join(" | ");
    }
    if (!outcome) {
        parts.push("forward outcome unavailable");
        return parts.join(" | ");
    }
    parts.push(
        `forward ${formatPercent(outcome.windowReturnPercent)}`,
        `trades ${outcome.totalTrades}`,
        `window ${outcome.forwardStartSec !== null ? new Date(outcome.forwardStartSec * 1000).toISOString().slice(0, 10) : "--"} → ${outcome.forwardEndSec !== null ? new Date(outcome.forwardEndSec * 1000).toISOString().slice(0, 10) : "--"}`,
    );
    if (outcome.status !== "measured") {
        parts.push(`${outcome.status}${outcome.reason ? ` (${outcome.reason})` : ""}`);
    }
    return parts.join(" | ");
}

/** Per-symbol scored detail for one forward outcome. */
export function formatMonthlyRankReplayOutcomeSymbols(outcome: MonthlyRankReplayForwardOutcome): string[] {
    return outcome.symbols.map((symbol) => [
        `  ${symbol.symbol}`,
        symbol.measurementBasis,
        `${formatPercent(symbol.returnPercent)}`,
        `trades ${symbol.totalTrades}`,
        `warmup ${symbol.warmupBars}`,
        symbol.scoredStartLabel && symbol.scoredEndLabel
            ? `scored ${symbol.scoredStartLabel.slice(0, 10)} → ${symbol.scoredEndLabel.slice(0, 10)}`
            : "",
        symbol.error ? `ERROR: ${symbol.error}` : "",
    ].filter(Boolean).join(" | "));
}

/**
 * Full Copy Results payload. Display and copy share these lines so they can
 * never describe different reports.
 */
export function formatMonthlyRankReplayReportText(report: MonthlyRankReplayReport): string {
    const lines: string[] = [];
    const experiment = report.experiment;
    lines.push("Monthly Rank Replay — Forward outcomes of monthly historical rank #1");
    lines.push(
        `From year ${experiment.fromYear} | eval window L=${experiment.evalWindowBars} bars | forward H=${experiment.forwardBars} bars | interval ${experiment.interval} | engine ${experiment.engine} | sizing ${experiment.sizingMode}`,
    );
    lines.push(`Symbols (${experiment.symbols.length}): ${experiment.symbols.join(", ")}`);
    lines.push(`Strategies: ${experiment.strategyKeys.join(", ")}`);
    lines.push(`Replayed sorts (${experiment.replayedSorts.length}): ${experiment.replayedSorts.map((sort) => `${sort.label} [${formatDirection(sort.direction)}]`).join("; ")}`);
    if (experiment.excludedSorts.length > 0) {
        lines.push(`Excluded sorts: ${experiment.excludedSorts.map((sort) => `${sort.label} — ${sort.reason}`).join("; ")}`);
    }
    lines.push(
        `Candidate pool: seed ${experiment.candidatePool.seed ?? "n/a"}, requested ${experiment.candidatePool.requestedRunsPerStrategy}/strategy, actual unique normalized candidates ${experiment.candidatePool.actualCandidates}`,
    );
    lines.push(`Capital payload: ${JSON.stringify(experiment.capitalSettings)}`);
    lines.push("Conventions:");
    lines.push(`  checkpoint: ${experiment.conventions.checkpoint}`);
    lines.push(`  historical window: ${experiment.conventions.historicalWindow}`);
    lines.push(`  forward window: ${experiment.conventions.forwardWindow}`);
    lines.push(`  signal policy: ${experiment.conventions.signalPolicy}`);
    lines.push(`  accounting: ${experiment.conventions.accounting}`);
    lines.push(
        "Note: retrospective replay of the selected strategy library and symbol list; observations are overlapping H-bar windows, not calendar-month returns or evidence of live profitability.",
    );
    if (report.stoppedEarly) {
        lines.push(`INCOMPLETE: ${report.stoppedEarly.reason} after ${report.stoppedEarly.completedCheckpoints} measured checkpoints`);
    }
    if (report.fatal) {
        lines.push(`FATAL: ${report.fatal}`);
    }
    if (report.detailUnavailable) {
        lines.push("DETAIL UNAVAILABLE: per-checkpoint detail was not retained in this snapshot; summary rows only.");
    }

    lines.push("");
    lines.push("=== Coverage ===");
    for (const checkpoint of report.checkpoints) {
        const membership = checkpoint.retainedSymbols !== undefined
            ? `, ${checkpoint.retainedSymbols} symbols evaluated`
            : "";
        const excluded = checkpoint.excludedSymbols && checkpoint.excludedSymbols.length > 0
            ? `, excluded: ${checkpoint.excludedSymbols.map((entry) => `${entry.symbol} (${entry.reason})`).join("; ")}`
            : "";
        lines.push(`  ${checkpoint.label}: ${checkpoint.status}${checkpoint.reason ? ` — ${checkpoint.reason}` : ""} (${checkpoint.distinctWinners} distinct winners${membership}${excluded})`);
    }
    lines.push("Per-symbol data range:");
    for (const symbol of report.symbolCoverage) {
        lines.push(
            `  ${symbol.symbol}: bars ${symbol.bars}${symbol.firstOpenLabel ? `, first open ${symbol.firstOpenLabel.slice(0, 10)}` : ""}${symbol.lastCloseLabel ? `, last close ${symbol.lastCloseLabel.slice(0, 10)}` : ""}, warmup at first checkpoint ${symbol.warmupBarsAtFirstCheckpoint}${symbol.synthetic ? ", synthetic pair" : ""}${symbol.error ? `, ERROR: ${symbol.error}` : ""}`,
        );
    }

    lines.push("");
    lines.push("=== Summary (one row per historical sort; each uses its own valid checkpoints) ===");
    for (const summary of report.sortSummaries) {
        lines.push(`  ${formatMonthlyRankReplaySummaryRow(summary)}`);
    }

    if (!report.detailUnavailable) {
        lines.push("");
        lines.push("=== Monthly details ===");
        for (const checkpoint of report.checkpoints) {
            const selections = report.selections.filter((selection) => selection.checkpointIndex === checkpoint.index);
            if (selections.length === 0) continue;
            lines.push(`--- ${checkpoint.label} ---`);
            for (const selection of selections) {
                const outcome = selection.forwardOutcomeIndex !== undefined
                    ? report.forwardOutcomes[selection.forwardOutcomeIndex]
                    : undefined;
                lines.push(`  ${formatMonthlyRankReplaySelectionLine(selection, outcome)}`);
                if (outcome) {
                    for (const symbolLine of formatMonthlyRankReplayOutcomeSymbols(outcome)) {
                        lines.push(symbolLine);
                    }
                }
            }
        }
    }

    return lines.join("\n");
}
