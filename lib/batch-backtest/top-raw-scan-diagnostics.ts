import type { ScanFailureDiagnostics, ScanVote } from "./top-raw-scan-contract";

export const SCAN_FAILURE_LIMITS = Object.freeze({ groups: 8, examples: 3, reason: 320, pair: 160 });

/** Bounded independently of universe size and error-message cardinality. */
export function summarizeScanFailures(votes: Iterable<ScanVote>): ScanFailureDiagnostics {
    const result: ScanFailureDiagnostics = { schema: "top_raw_scan.failures.v1", total: 0, groups: [], otherCount: 0 };
    for (const vote of votes) {
        if (!vote.error) continue;
        result.total++;
        const reason = vote.error.trim().slice(0, SCAN_FAILURE_LIMITS.reason) || "Pair execution failed.";
        let group = result.groups.find(row => row.reason === reason);
        if (!group && result.groups.length < SCAN_FAILURE_LIMITS.groups) {
            group = { reason, count: 0, pairs: [] }; result.groups.push(group);
        }
        if (!group) { result.otherCount++; continue; }
        group.count++;
        if (group.pairs.length < SCAN_FAILURE_LIMITS.examples) group.pairs.push(vote.key.slice(0, SCAN_FAILURE_LIMITS.pair));
    }
    return result;
}

/** Optional additive v1 field: older results remain readable. Invalid additions
 * are discarded rather than rendering unbounded persisted/transport content. */
export function normalizeScanFailureDiagnostics(data: unknown, failed: number): ScanFailureDiagnostics | undefined {
    if (data === undefined) return undefined;
    const value = data as ScanFailureDiagnostics;
    const count = (n: unknown): n is number => typeof n === "number" && Number.isInteger(n) && n >= 0;
    if (!value || value.schema !== "top_raw_scan.failures.v1" || !count(value.total) || value.total !== failed
        || !count(value.otherCount) || !Array.isArray(value.groups) || value.groups.length > SCAN_FAILURE_LIMITS.groups
        || value.groups.some(row => !row || typeof row.reason !== "string" || row.reason.length > SCAN_FAILURE_LIMITS.reason
            || !count(row.count) || row.count < 1 || !Array.isArray(row.pairs) || row.pairs.length > Math.min(row.count, SCAN_FAILURE_LIMITS.examples)
            || row.pairs.some(pair => typeof pair !== "string" || pair.length > SCAN_FAILURE_LIMITS.pair))
        || value.groups.reduce((sum, row) => sum + row.count, value.otherCount) !== value.total) return undefined;
    return { schema: value.schema, total: value.total, otherCount: value.otherCount,
        groups: value.groups.map(row => ({ reason: row.reason, count: row.count, pairs: [...row.pairs] })) };
}
