import { freemem } from "node:os";

export const TRADE_LEDGER_SWEEP_CHILD_HEAP_LIMIT_BYTES = 12_288 * 1024 * 1024;
export const TRADE_LEDGER_SWEEP_HEAP_ESTIMATE_BASE_BYTES = 512 * 1024 * 1024;
export const TRADE_LEDGER_SWEEP_RSS_ESTIMATE_BASE_BYTES = 768 * 1024 * 1024;
// F3 measured 9.01 GiB heap at 5,412,528 rows. 2,048 bytes/row is the
// rounded-up coefficient after adding an explicit ~21% margin over that point.
export const TRADE_LEDGER_SWEEP_HEAP_BYTES_PER_ROW = 2_048;
export const TRADE_LEDGER_SWEEP_RSS_BYTES_PER_ROW = 2_048;
export const TRADE_LEDGER_SWEEP_RUNTIME_HEAP_GUARD_FRACTION = 0.85;
export const TRADE_LEDGER_SWEEP_RUNTIME_HEAP_GUARD_MESSAGE = "runtime memory guard tripped - preflight underestimated; run refused";

export type LedgerSweepModeForRuntimeGuard = "load_once" | "isolated_per_rule";

export type LedgerSweepPreflightDecisionKind = "load_once" | "isolated_per_rule" | "refuse";

export interface LedgerSweepPreflightDecision {
    decision: LedgerSweepPreflightDecisionKind;
    reason: string;
    rows: number;
    estimatedHeapBytes: number;
    estimatedRssBytes: number;
    childHeapLimitBytes: number;
    freeSystemMemoryBytes: number;
    heapLoadOnceLimitBytes: number;
    rssLoadOnceLimitBytes: number;
    heapRefusalLimitBytes: number;
    rssRefusalLimitBytes: number;
}

export function ledgerSweepRuntimeHeapGuardLimitBytes(
    childHeapLimitBytes = TRADE_LEDGER_SWEEP_CHILD_HEAP_LIMIT_BYTES,
): number {
    return childHeapLimitBytes * TRADE_LEDGER_SWEEP_RUNTIME_HEAP_GUARD_FRACTION;
}

export function isLedgerSweepRuntimeHeapGuardTripped(
    heapUsedBytes: number,
    childHeapLimitBytes: number,
    mode: LedgerSweepModeForRuntimeGuard,
): boolean {
    return mode === "load_once"
        && Number.isFinite(heapUsedBytes)
        && heapUsedBytes >= ledgerSweepRuntimeHeapGuardLimitBytes(childHeapLimitBytes);
}

export function resolveLedgerSweepPreflight(
    rows: number,
    freeSystemMemoryBytes = freemem(),
): LedgerSweepPreflightDecision {
    const estimatedHeapBytes = TRADE_LEDGER_SWEEP_HEAP_ESTIMATE_BASE_BYTES
        + rows * TRADE_LEDGER_SWEEP_HEAP_BYTES_PER_ROW;
    const estimatedRssBytes = TRADE_LEDGER_SWEEP_RSS_ESTIMATE_BASE_BYTES
        + rows * TRADE_LEDGER_SWEEP_RSS_BYTES_PER_ROW;
    const heapLoadOnceLimitBytes = TRADE_LEDGER_SWEEP_CHILD_HEAP_LIMIT_BYTES * 0.5;
    const rssLoadOnceLimitBytes = freeSystemMemoryBytes * 0.5;
    const heapRefusalLimitBytes = TRADE_LEDGER_SWEEP_CHILD_HEAP_LIMIT_BYTES * 0.7;
    const rssRefusalLimitBytes = freeSystemMemoryBytes * 0.75;
    const common = {
        rows,
        estimatedHeapBytes,
        estimatedRssBytes,
        childHeapLimitBytes: TRADE_LEDGER_SWEEP_CHILD_HEAP_LIMIT_BYTES,
        freeSystemMemoryBytes,
        heapLoadOnceLimitBytes,
        rssLoadOnceLimitBytes,
        heapRefusalLimitBytes,
        rssRefusalLimitBytes,
    };
    if (estimatedHeapBytes > heapRefusalLimitBytes || estimatedRssBytes > rssRefusalLimitBytes) {
        return {
            ...common,
            decision: "refuse",
            reason: estimatedHeapBytes > heapRefusalLimitBytes
                ? "estimated heap exceeds the 70% child-heap refusal boundary"
                : "estimated RSS exceeds the 75% free-system-memory refusal boundary",
        };
    }
    if (estimatedHeapBytes <= heapLoadOnceLimitBytes && estimatedRssBytes <= rssLoadOnceLimitBytes) {
        return {
            ...common,
            decision: "load_once",
            reason: "estimated heap and RSS are within the load-once boundaries",
        };
    }
    return {
        ...common,
        decision: "isolated_per_rule",
        reason: estimatedHeapBytes > heapLoadOnceLimitBytes
            ? "estimated heap exceeds the 50% load-once boundary; isolated rule workers reclaim between rules"
            : "estimated RSS exceeds the 50% free-system-memory load-once boundary; isolated rule workers reclaim between rules",
    };
}
