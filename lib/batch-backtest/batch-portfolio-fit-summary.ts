/**
 * Portfolio Fit Mining — Copy/UI formatting pure helpers.
 *
 * Pure leaf module. Returns pipe-delimited string[] for the Copy button,
 * mirroring `formatBatchOverallSummary` in `batch-backtest-summary.ts`.
 * Kept separate so the service stays thin (AGENTS.md rule 6: keep
 * quantitative/formatting code out of BatchBacktestService).
 */
import type { BatchPortfolioFitResult, BatchPortfolioFitRow } from "./batch-portfolio-fit-types";

/**
 * Formats the Portfolio Fit result as pipe-delimited lines for the Copy button.
 * Section tag: `PORTFOLIO_FIT`. Includes a portfolio summary line, a per-row
 * evidence table, and an explicit experimental label.
 */
export function formatPortfolioFitSummary(result: BatchPortfolioFitResult): string[] {
    const lines: string[] = [];
    const accepted = result.rows.filter((r) => r.decision === "ADD" || r.decision === "ADD_SMALL");
    const deferred = result.rows.filter((r) => r.decision === "DEFER");
    const rejected = result.rows.filter((r) => r.decision === "REJECT");

    lines.push(
        `PORTFOLIO_FIT | Generated ${new Date(result.generatedAt).toISOString()} | asOf ${result.asOfTimeKey ?? "unknown"} | fingerprint ${shortFingerprint(result.fingerprint)} | engine ${result.engine}`,
    );
    lines.push(
        `PORTFOLIO_FIT | Candidates ${result.rows.length} | Accepted ${accepted.length} | Deferred ${deferred.length} | Rejected ${rejected.length}`,
    );
    const p = result.portfolio;
    lines.push(
        `PORTFOLIO_FIT | Allocated ${(p.allocatedFraction * 100).toFixed(1)}% | HistMeanBarRet ${fmtPct(p.expectedReturnPct, 4)} | HistBarVol ${fmtPct(p.volatilityPct)} | HistBarES ${fmtPct(p.expectedShortfallPct)} | GrossL ${(p.grossLongFraction * 100).toFixed(1)}% | GrossS ${(p.grossShortFraction * 100).toFixed(1)}%`,
    );
    const configuredKelly = result.configuredKellyFraction ?? "n/a";
    const resolvedKelly = result.kellyFraction ?? "unavailable";
    lines.push(
        `PORTFOLIO_FIT | Base allocation source ${result.baseAllocationSource} | Kelly configured ${configuredKelly} | Kelly resolved ${resolvedKelly}`,
    );
    lines.push("PORTFOLIO_FIT | Independent validation unavailable (historical Stability reconstruction not implemented)");
    lines.push("PORTFOLIO_FIT | EXPERIMENTAL - diagnostic only; do not treat as independently validated.");
    for (const warning of result.warnings) {
        lines.push(`PORTFOLIO_FIT | WARNING | ${warning}`);
    }
    lines.push("PORTFOLIO_FIT | --- Per-candidate evidence ---");
    for (const row of result.rows) {
        lines.push(formatPortfolioFitRow(row));
    }
    return lines;
}

function formatPortfolioFitRow(row: BatchPortfolioFitRow): string {
    return [
        "PORTFOLIO_FIT",
        `ROW | ${row.asset} | ${row.direction} | ${row.decision}`,
        `alloc ${(row.allocationFraction * 100).toFixed(2)}% | $${row.allocationAmount.toFixed(0)}`,
        `edge ${fmtPct(row.expectedEdgePct)}`,
        `vol ${fmtPct(row.volatilityPct)}`,
        `ES ${fmtPct(row.expectedShortfallPct)}`,
        `margVol ${fmtPct(row.marginalVolatilityPct)}`,
        `margES ${fmtPct(row.marginalExpectedShortfallPct)}`,
        `maxCorr ${row.maxAcceptedCorrelation !== null ? row.maxAcceptedCorrelation.toFixed(3) : "n/a"}`,
        `reasons [${row.reasonCodes.join(",")}]`,
        `allocationLimit [${row.allocationLimitReasonCodes.join(",")}]`,
    ].join(" | ");
}

function fmtPct(value: number | null, decimals = 2): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    return `${(value * 100).toFixed(decimals)}%`;
}

/** Stable, display-only FNV-1a digest; the full fingerprint remains in state. */
export function shortFingerprint(value: string | null): string {
    if (!value) return "--";
    let hash = 0x811c9dc5;
    for (let i = 0; i < value.length; i++) {
        hash ^= value.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}
