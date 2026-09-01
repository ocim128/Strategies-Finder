export type TradeLedgerSweepTerminalPhase = "running" | "done" | "cancelled" | "fatal";

/**
 * A sweep is completed only when its terminal phase is done. The explicit
 * `complete` flag is the current writer shape; terminalPhase-only summaries
 * are retained for legacy sweep artifacts.
 */
export function isCompletedTradeLedgerSweepTerminal(terminalPhase: TradeLedgerSweepTerminalPhase): boolean {
    return terminalPhase === "done";
}

export function isCompletedTradeLedgerSweepSummary(summary: Record<string, unknown>): boolean {
    const terminalPhase = summary.terminalPhase;
    if (terminalPhase !== undefined) {
        return terminalPhase === "done" && (summary.complete === undefined || summary.complete === true);
    }
    return summary.complete === true;
}
