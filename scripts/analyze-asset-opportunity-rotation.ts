/**
 * Leader-following rotation analysis for Asset Opportunity holdout archives.
 *
 * For each archive sort, simulates a single-asset "rotation" that follows the
 * sort's leader across the holdout sweep:
 *   - Walk holdouts chronologically (descending holdoutBars: the signal bar
 *     moves forward as the reserved OOS tail shrinks).
 *   - Hold the current leader while it remains inside the top-K pool
 *     (`--pool-k`, the candidate-pool depth; same asset on the next step costs
 *     nothing — this also de-duplicates the heavily overlapping forward windows).
 *   - When the held asset drops out of the pool, switch to the current rank-1
 *     pick and pay one round-trip cost (`--cost-bps`) for the change.
 *   - Realize each leader's entry forward PnL at `--horizon` bars once, at the
 *     step it was entered.
 *
 * Output per sort: turnover rate, gross rotation PnL (sum of entry returns),
 * total cost, net rotation PnL, average per entry, and the naive always-#1
 * average for reference.
 *
 * This is the same family of caveat as the holdout report:
 *   - Descriptive only; holdout windows overlap. The same-asset dedup is what
 *     keeps the chained path from double-counting a continuous hold, so the
 *     "rotation PnL" is an approximation of following the leader, not a true
 *     bar-by-bar equity curve (the archive stores only 5/12/15-bar forward PnL,
 *     not raw fills).
 *   - `--pool-k` is bounded by what the archive stored (topN, default 10). The
 *     Finder's `candidatePoolSize` is not persisted; set --pool-k to match the
 *     run's candidate pool, capped at the archived depth.
 *
 * No `npm run` entry by design — run via the sibling .bat:
 *   archive\asset opportunity\analyze-asset-opportunity-rotation.bat
 *
 * Direct usage:
 *   esno scripts/analyze-asset-opportunity-rotation.ts --archive-dir <dir>
 *   esno scripts/analyze-asset-opportunity-rotation.ts --pool-k 5 --cost-bps 10 --horizon 12 --min-entries 5
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
    readAssetOpportunityArchive,
    type AssetOpportunityArchiveRecord,
    type AssetOpportunityArchiveRow,
} from "./analyze-asset-opportunity-holdouts";

interface LeaderTenure {
    symbol: string;
    entryHoldoutBars: number;
    tenureSteps: number;
    entryPnl: number | null;
}

interface SortRotation {
    sortMetric: string;
    steps: number;
    entries: number;
    switches: number;
    turnoverPercent: number | null;
    averageEntryGross: number | null; // mean of entry forward PnLs (per position)
    averageEntryNet: number | null; // averageEntryGross minus per-entry switch cost
    totalCostPercent: number; // switches * costBps, in percent points (for reference)
    rankOneNaiveAverage: number | null; // mean of rank-1 forward PnL across all steps
    deltaVersusNaive: number | null; // averageEntryNet - rankOneNaiveAverage
    tenures: LeaderTenure[]; // chronological leader-tenure path
}

function getArgument(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

function deduplicateRecords(records: AssetOpportunityArchiveRecord[]): AssetOpportunityArchiveRecord[] {
    const latest = new Map<string, AssetOpportunityArchiveRecord>();
    for (const record of records) {
        const key = `${record.holdoutBars}|${record.sortMetric}`;
        const previous = latest.get(key);
        if (!previous || record.timestamp.localeCompare(previous.timestamp) >= 0) latest.set(key, record);
    }
    return [...latest.values()];
}

interface BatchRunGroup {
    batchRunId: string;
    records: AssetOpportunityArchiveRecord[];
    latestTimestamp: string;
}

function selectNewestBatchRun(records: AssetOpportunityArchiveRecord[], requested?: string): BatchRunGroup {
    const groups = new Map<string, BatchRunGroup>();
    for (const record of records) {
        let group = groups.get(record.batchRunId);
        if (!group) {
            group = { batchRunId: record.batchRunId, records: [], latestTimestamp: record.timestamp };
            groups.set(record.batchRunId, group);
        }
        group.records.push(record);
        if (record.timestamp.localeCompare(group.latestTimestamp) > 0) group.latestTimestamp = record.timestamp;
    }
    const selected = requested
        ? groups.get(requested)
        : [...groups.values()].sort((a, b) => b.latestTimestamp.localeCompare(a.latestTimestamp))[0];
    if (!selected) throw new Error(`Batch run not found: ${requested ?? "<auto>"}`);
    return { ...selected, records: deduplicateRecords(selected.records) };
}

/**
 * One holdout step's leader pool: the rank-1 symbol plus the set of symbols
 * inside the top-K pool, and the rank-1 forward PnL at the chosen horizon.
 */
interface HoldoutStep {
    holdoutBars: number;
    rankOneSymbol: string | null;
    pool: Set<string>;
    rankOnePnl: number | null; // forward PnL at --horizon for the rank-1 row
}

function buildHoldoutSteps(
    records: AssetOpportunityArchiveRecord[],
    sortMetric: string,
    poolK: number,
    horizon: number,
): HoldoutStep[] {
    const steps: HoldoutStep[] = [];
    for (const record of records.filter((r) => r.sortMetric === sortMetric)) {
        const rows = record.topResults.slice() as AssetOpportunityArchiveRow[];
        if (rows.length === 0) continue;
        // rank-1 = the row with the lowest rank value.
        let rankOne: AssetOpportunityArchiveRow | null = null;
        const pool = new Set<string>();
        for (const row of rows) {
            if (!row.symbol) continue;
            const rank = row.rank ?? Number.MAX_SAFE_INTEGER;
            if (rank <= poolK) pool.add(row.symbol);
            if (!rankOne || rank < (rankOne.rank ?? Number.MAX_SAFE_INTEGER)) rankOne = row;
        }
        const rankOneSymbol = rankOne?.symbol ?? null;
        const horizonMatch = rankOne?.forwardOosPerformance?.horizons?.find((h) => h.bars === horizon);
        const rankOnePnl = horizonMatch && horizonMatch.sampleSize >= 1 && horizonMatch.averagePnlPercent !== null
            ? horizonMatch.averagePnlPercent
            : null;
        steps.push({ holdoutBars: record.holdoutBars, rankOneSymbol, pool, rankOnePnl });
    }
    // Chronological order: descending holdoutBars (signal bar moves forward as
    // the reserved tail shrinks).
    steps.sort((a, b) => b.holdoutBars - a.holdoutBars);
    return steps;
}

function simulateRotation(steps: HoldoutStep[], costBps: number): SortRotation | null {
    if (steps.length === 0) return null;
    let held: string | null = null;
    let entries = 0;
    let switches = 0;
    let entryPnlSum = 0;
    let rankOnePnlSum = 0;
    let rankOnePnlCount = 0;
    const tenures: LeaderTenure[] = [];

    for (const step of steps) {
        if (step.rankOnePnl !== null) {
            rankOnePnlSum += step.rankOnePnl;
            rankOnePnlCount += 1;
        }
        const enterSymbol = held === null || !step.pool.has(held);
        if (enterSymbol) {
            const target = step.rankOneSymbol;
            if (target === null) {
                // No usable rank-1 this step; keep holding previous, extend its tenure.
                if (tenures.length > 0) tenures[tenures.length - 1]!.tenureSteps += 1;
                continue;
            }
            if (held !== null) switches += 1; // a real asset change (not the initial cash->asset)
            held = target;
            entries += 1;
            if (step.rankOnePnl !== null) entryPnlSum += step.rankOnePnl;
            tenures.push({ symbol: target, entryHoldoutBars: step.holdoutBars, tenureSteps: 1, entryPnl: step.rankOnePnl });
        } else if (tenures.length > 0) {
            // Continuation: same leader still in pool, extend its tenure.
            tenures[tenures.length - 1]!.tenureSteps += 1;
        }
    }

    const totalCostPercent = (switches * costBps) / 100; // bps -> percent points
    const turnoverPercent = steps.length > 1 ? (switches / (steps.length - 1)) * 100 : null;
    const averageEntryGross = entries > 0 ? entryPnlSum / entries : null;
    // Per-entry cost: each entry beyond the first corresponds to one switch.
    const perEntryCost = entries > 0 ? totalCostPercent / entries : 0;
    const averageEntryNet = averageEntryGross === null ? null : averageEntryGross - perEntryCost;
    return {
        sortMetric: "", // filled by caller
        steps: steps.length,
        entries,
        switches,
        turnoverPercent,
        averageEntryGross,
        averageEntryNet,
        totalCostPercent,
        rankOneNaiveAverage: rankOnePnlCount > 0 ? rankOnePnlSum / rankOnePnlCount : null,
        deltaVersusNaive: averageEntryNet !== null && rankOnePnlCount > 0
            ? averageEntryNet - (rankOnePnlSum / rankOnePnlCount)
            : null,
        tenures,
    };
}

function formatPercent(value: number | null): string {
    return value === null || !Number.isFinite(value) ? "n/a" : `${value.toFixed(2)}%`;
}

function render(
    rotations: SortRotation[],
    batchRunId: string,
    poolK: number,
    costBps: number,
    horizon: number,
    minEntries: number,
): string {
    const lines: string[] = [
        "Asset Opportunity Leader-Following Rotation",
        "===========================================",
        `Archive batch run: ${batchRunId}`,
        `Pool depth (top-K): ${poolK} | Round-trip cost per switch: ${costBps} bps | Entry horizon: ${horizon} bars`,
        "",
        "Rule: hold the leader while it stays in the top-K pool; when it drops out, switch to",
        "rank-1 and pay one round-trip cost. Same-asset continuation costs nothing (and",
        "de-duplicates overlapping forward windows).",
        "",
        "Returns are per-entry averages (each leader's entry forward PnL, realized once),",
        "NOT a realizable equity curve — forward windows overlap ~horizon:1, so a true",
        "path PnL is not computable from the archive. Compare 'Avg entry net' to 'Rank1",
        "naive avg' (always-fresh-#1 per step); Δ > 0 means rotation beat fresh-#1.",
        "",
        `Δ is suppressed as "n/a" for sorts with fewer than ${minEntries} entries — a 1-2`,
        "leader path is one position's return, not a rotation signal. See LEADER TENURES",
        "below for the actual path (outliers like a single held name show up there).",
        "",
        "Sort | Steps | Entries | Switches | Turnover | Avg entry gross | Avg entry net | Total cost | Rank1 naive avg | Δ vs naive",
    ];
    const sorted = [...rotations].sort((a, b) => {
        const aOk = a.entries >= minEntries ? 1 : 0;
        const bOk = b.entries >= minEntries ? 1 : 0;
        if (aOk !== bOk) return bOk - aOk; // meaningful-Δ sorts first
        return (b.deltaVersusNaive ?? -Infinity) - (a.deltaVersusNaive ?? -Infinity);
    });
    for (const r of sorted) {
        const deltaShown = r.entries >= minEntries ? formatPercent(r.deltaVersusNaive) : "n/a";
        lines.push([
            r.sortMetric,
            String(r.steps),
            String(r.entries),
            String(r.switches),
            formatPercent(r.turnoverPercent),
            formatPercent(r.averageEntryGross),
            formatPercent(r.averageEntryNet),
            formatPercent(r.totalCostPercent),
            formatPercent(r.rankOneNaiveAverage),
            deltaShown,
        ].join(" | "));
    }

    lines.push("", "LEADER TENURES (chronological; entry holdout = holdoutBars at entry, descending = forward in time)");
    lines.push("Sort | Leader | Entry holdout | Tenure steps | Entry PnL");
    for (const r of rotations) {
        for (const t of r.tenures) {
            lines.push([
                r.sortMetric,
                t.symbol,
                String(t.entryHoldoutBars),
                String(t.tenureSteps),
                formatPercent(t.entryPnl),
            ].join(" | "));
        }
    }
    return `${lines.join("\n")}\n`;
}

function main(): void {
    const argv = process.argv.slice(2);
    const requestedBatchRunId = getArgument(argv, "--batch-run-id");
    const scriptDir = path.dirname(fileURLToPath(import.meta.url));
    const archiveDirectory = path.resolve(getArgument(argv, "--archive-dir") ?? path.resolve(scriptDir, "..", "archive", "asset opportunity"));
    const poolK = Math.max(1, Math.floor(Number(getArgument(argv, "--pool-k") ?? 10) || 10));
    const costBps = Math.max(0, Number(getArgument(argv, "--cost-bps") ?? 10) || 0);
    const horizon = Math.max(1, Math.floor(Number(getArgument(argv, "--horizon") ?? 12) || 12));
    const minEntries = Math.max(1, Math.floor(Number(getArgument(argv, "--min-entries") ?? 5) || 1));

    let records: AssetOpportunityArchiveRecord[];
    try {
        records = readAssetOpportunityArchive(archiveDirectory);
    } catch (error) {
        console.error(`[rotation] Could not read archive: ${error instanceof Error ? error.message : String(error)}`);
        process.exitCode = 1;
        return;
    }
    const selected = selectNewestBatchRun(records, requestedBatchRunId);
    const sortMetrics = [...new Set(selected.records.map((r) => r.sortMetric))].sort();

    const rotations: SortRotation[] = [];
    for (const sortMetric of sortMetrics) {
        const steps = buildHoldoutSteps(selected.records, sortMetric, poolK, horizon);
        const result = simulateRotation(steps, costBps);
        if (result) {
            result.sortMetric = sortMetric;
            rotations.push(result);
        }
    }

    if (rotations.length === 0) {
        console.error(`[rotation] No sorts analyzed (archive batch ${selected.batchRunId}).`);
        process.exitCode = 1;
        return;
    }

    console.log(render(rotations, selected.batchRunId, poolK, costBps, horizon, minEntries));
}

const invokedDirectly = process.argv[1] ? path.resolve(process.argv[1]) : "";
const thisFile = path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly === thisFile) main();
