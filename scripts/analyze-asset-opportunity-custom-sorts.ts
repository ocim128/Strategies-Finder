/**
 * Custom-sort stability test for Asset Opportunity holdout archives.
 *
 * Rationale (2026-08-17): every built-in archive sort ranks by ONE in-search
 * aggregate, and the Finder's search optimizes those aggregates per symbol — so
 * single-metric tops are overfit extremes and measured UNSTABLE. A robust sort
 * must aggregate independent judgments instead of trusting one optimized number.
 *
 * Custom sorts computed OFFLINE from the union pool of each file's 14 sort
 * blocks (top-10 each => ~50 unique candidates per file with full metrics):
 *   - consensus_strategies   symbol scored by DISTINCT strategies that placed it
 *                            in any top-10 (tie: mean avgTrade)
 *   - consensus_rank_weighted symbol scored by sum of (11 - rank) over all top-10
 *                            appearances (tie: distinct strategies)
 *   - consensus_min2_avgtrade symbols with >=2 distinct strategies AND >=2 sorts,
 *                            ranked by mean avgTrade
 *   - loss_quality           candidates with totalTrades >= 15 ranked by avgLoss
 *                            ASC (tie: avgTrade DESC) — meaningful when the loss
 *                            side is NOT pinned (no-SL runs); degenerate control
 *                            when SL pins losses
 *   - recurrence_batch       symbols present in >= PRESENCE-RATE of ALL files'
 *                            top-10s (batch-level rule: uses the whole sweep,
 *                            deployment-realistic same-day)
 *
 * Judged with the same pre-stated verdicts as the stability tool:
 *   STABLE+ = boot p5 > 0 AND >= 60% files positive; WEAK+ = boot p50 > 0 AND
 *   >= 55%; else UNSTABLE. Holdout windows overlap: stability indicators, not
 *   independent-sample p-values.
 *
 * Direct usage:
 *   esno scripts/analyze-asset-opportunity-custom-sorts.ts \
 *     --archive-dir "archive/asset opportunity" --horizon 12 --top-k 1,2,3
 */
import fs from "node:fs";
import path from "node:path";

const ARCHIVE_FILE_PATTERN = /^oos-holdout-(\d+)-bars\.txt$/;
const BLOCK_SEPARATOR = "=".repeat(80);
const BLOCK_PATTERN = new RegExp(
    `^${BLOCK_SEPARATOR}\\nTimestamp: ([^\\n]+)\\nBatch run id: ([^\\n]+)\\nOOS holdout: (\\d+) bars\\nArchive sort: ([^\\n]+)\\n(?:Forward measurement: ([^\\n]+)\\n)?(?:Archive baseline: ([^\\n]+)\\n)?(?:Next-exit archive baseline: ([^\\n]+)\\n)?${BLOCK_SEPARATOR}\\n([\\s\\S]*?)(?=\\n${BLOCK_SEPARATOR}\\n|$)`,
    "gm",
);
const MIN_TRADES_FOR_LOSS_QUALITY = 15;
const TSTAT_MIN_TRADES = 2;
let tstatMinTradesOverride: number | null = null;
const RECURRENCE_PRESENCE_RATE = 0.4;

interface SelectionPerformance {
    avgTrade?: number | null;
    avgLoss?: number | null;
    avgWin?: number | null;
    winRate?: number | null;
    totalTrades?: number | null;
    maxDrawdownPercent?: number | null;
}

interface ArchiveRow {
    rank?: number;
    symbol?: string;
    strategyId?: string;
    candidateFingerprint?: string;
    selectionPerformance?: SelectionPerformance | null;
    forwardOosPerformance?: {
        horizons?: Array<{ bars: number; pnlPercent?: number | null; sampleSize?: number | null }>;
    } | null;
}

interface FileData {
    holdoutBars: number;
    timestamp: string;
    batchRunId: string;
    baselineByHorizon: Map<number, number>;
    rows: ArchiveRow[];
    sortNames: string[];
}

interface Pick {
    symbol: string;
    value: number | null;
    detail?: string;
}

function getArgument(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

function parseList(value: string | undefined, fallback: number[]): number[] {
    if (!value) return fallback;
    const parsed = value.split(",").map((item) => Math.floor(Number(item.trim()))).filter((item) => Number.isFinite(item) && item >= 1);
    return parsed.length > 0 ? [...new Set(parsed)].sort((left, right) => left - right) : fallback;
}

function createRng(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6D2B79F5) | 0;
        let t = Math.imul(state ^ (state >>> 15), 1 | state);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

function rowForwardPnl(row: ArchiveRow, horizonBars: number): number | null {
    const horizon = row.forwardOosPerformance?.horizons?.find((entry) => entry.bars === horizonBars);
    if (horizon && typeof horizon.pnlPercent === "number" && (horizon.sampleSize ?? 1) > 0) {
        return horizon.pnlPercent;
    }
    return null;
}

function loadFiles(archiveDirectory: string): FileData[] {
    const entries = fs.readdirSync(archiveDirectory)
        .map((file) => ({ file, match: file.match(ARCHIVE_FILE_PATTERN) }))
        .filter((entry): entry is { file: string; match: RegExpMatchArray } => entry.match !== null)
        .map((entry) => ({ bars: Number(entry.match[1]), file: entry.file }))
        .sort((left, right) => left.bars - right.bars);
    if (entries.length === 0) {
        throw new Error(`No oos-holdout-<N>-bars.txt files found in ${archiveDirectory}`);
    }
    const parsed = entries.map((entry) => {
        const text = fs.readFileSync(path.join(archiveDirectory, entry.file), "utf8");
        const baselineByHorizon = new Map<number, number>();
        const rows: ArchiveRow[] = [];
        const sortNames: string[] = [];
        let timestamp = "";
        let batchRunId = "";
        for (const match of text.matchAll(BLOCK_PATTERN)) {
            timestamp = match[1]!;
            batchRunId = match[2]!;
            sortNames.push(match[4]!);
            if (match[6] && baselineByHorizon.size === 0) {
                try {
                    const baseline = JSON.parse(match[6]) as { horizons?: Array<{ bars: number; averagePnlPercent?: number | null }> };
                    for (const horizon of baseline.horizons ?? []) {
                        if (typeof horizon.averagePnlPercent === "number") {
                            baselineByHorizon.set(horizon.bars, horizon.averagePnlPercent);
                        }
                    }
                } catch {
                    // Baseline parse failure: file is skipped downstream per-cell.
                }
            }
            try {
                rows.push(...(JSON.parse(match[8]!) as ArchiveRow[]));
            } catch {
                // Skip malformed block body.
            }
        }
        return { holdoutBars: entry.bars, timestamp, batchRunId, baselineByHorizon, rows, sortNames };
    });
    // Keep only the latest batch run (largest file count wins, then latest timestamp).
    const byRun = new Map<string, { files: FileData[]; latest: string }>();
    for (const file of parsed) {
        const group = byRun.get(file.batchRunId);
        if (!group) byRun.set(file.batchRunId, { files: [file], latest: file.timestamp });
        else {
            group.files.push(file);
            if (file.timestamp.localeCompare(group.latest) > 0) group.latest = file.timestamp;
        }
    }
    const selected = [...byRun.values()].sort((left, right) =>
        right.files.length - left.files.length || right.latest.localeCompare(left.latest),
    )[0];
    if (!selected) throw new Error("No archive blocks could be parsed.");
    return selected.files.sort((left, right) => left.holdoutBars - right.holdoutBars);
}

interface SymbolAggregate {
    symbol: string;
    rows: ArchiveRow[];
    distinctStrategies: Set<string>;
    distinctSorts: Set<string>;
    rankWeight: number;
    meanAvgTrade: number | null;
}

function buildSymbolAggregates(file: FileData): Map<string, SymbolAggregate> {
    const aggregates = new Map<string, SymbolAggregate>();
    const seenCandidates = new Set<string>();
    const sortNames = file.sortNames;
    for (const row of file.rows) {
        if (!row.symbol || typeof row.rank !== "number") continue;
        const candidateKey = `${row.symbol}|${row.strategyId ?? ""}|${row.candidateFingerprint ?? ""}`;
        if (seenCandidates.has(candidateKey)) continue;
        seenCandidates.add(candidateKey);
        let aggregate = aggregates.get(row.symbol);
        if (!aggregate) {
            aggregate = {
                symbol: row.symbol,
                rows: [],
                distinctStrategies: new Set<string>(),
                distinctSorts: new Set<string>(),
                rankWeight: 0,
                meanAvgTrade: null,
            };
            aggregates.set(row.symbol, aggregate);
        }
        aggregate.rows.push(row);
        if (row.strategyId) aggregate.distinctStrategies.add(row.strategyId);
        // Attribute the row to the sorts whose top-10 contains this rank slot.
        aggregate.distinctSorts.add(sortNames[(row.rank ?? 1) - 1] ?? `rank${row.rank}`);
        aggregate.rankWeight += Math.max(0, 11 - (row.rank ?? 10));
    }
    for (const aggregate of aggregates.values()) {
        const trades = aggregate.rows.map((row) => row.selectionPerformance?.avgTrade).filter((value): value is number => typeof value === "number");
        aggregate.meanAvgTrade = trades.length > 0 ? trades.reduce((sum, value) => sum + value, 0) / trades.length : null;
    }
    return aggregates;
}

function symbolPickValue(aggregate: SymbolAggregate, horizonBars: number): number | null {
    const values = aggregate.rows.map((row) => rowForwardPnl(row, horizonBars)).filter((value): value is number => value !== null);
    return values.length > 0 ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
}

function filterHoldoutsByStride(files: FileData[], stride: number): FileData[] {
    if (stride <= 1) return files;
    const kept: FileData[] = [];
    let nextTarget = -Infinity;
    for (const f of files) {
        if (f.holdoutBars >= nextTarget) {
            kept.push(f);
            nextTarget = f.holdoutBars + stride;
        }
    }
    return kept;
}

function computePoolBaseline(files: FileData[]): Map<number, Map<number, number>> {
    const byHoldout = new Map<number, Map<number, number>>();
    for (const file of files) {
        const horizonValues = new Map<number, number[]>();
        const seenCandidateKeys = new Set<string>();
        for (const row of file.rows) {
            const rowObj = row as { symbol?: string; strategyId?: string; candidateFingerprint?: string; forwardOosPerformance?: ArchiveRow["forwardOosPerformance"] };
            const key = `${rowObj.symbol ?? ""}|${rowObj.strategyId ?? ""}|${rowObj.candidateFingerprint ?? ""}`;
            if (seenCandidateKeys.has(key)) continue;
            seenCandidateKeys.add(key);
            for (const horizon of row.forwardOosPerformance?.horizons ?? []) {
                if (typeof horizon.bars === "number" && typeof horizon.pnlPercent === "number" && (horizon.sampleSize ?? 1) > 0) {
                    let values = horizonValues.get(horizon.bars);
                    if (!values) horizonValues.set(horizon.bars, values = []);
                    values.push(horizon.pnlPercent);
                }
            }
        }
        const horizonMeans = new Map<number, number>();
        for (const [horizon, values] of horizonValues) {
            if (values.length > 0) {
                horizonMeans.set(horizon, values.reduce((sum, v) => sum + v, 0) / values.length);
            }
        }
        byHoldout.set(file.holdoutBars, horizonMeans);
    }
    return byHoldout;
}

function rankPicks(picks: Pick[], topK: number, baseline: number, frictionPct = 0): number | null {
    const values = picks.slice(0, topK).map((pick) => pick.value).filter((value): value is number => value !== null && Number.isFinite(value));
    if (values.length === 0) return null;
    const selectedMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    return (selectedMean - frictionPct) - baseline;
}

interface UniqueCandidate {
    row: ArchiveRow;
    avgTrade: number | null;
    avgLoss: number | null;
    avgWin: number | null;
    winRate: number | null;
    trades: number | null;
    maxDrawdownPercent: number | null;
    netProfit: number | null;
    expectancy: number | null;
}

function uniqueCandidates(file: FileData): UniqueCandidate[] {
    const seen = new Set<string>();
    const result: UniqueCandidate[] = [];
    for (const row of file.rows) {
        if (!row.symbol) continue;
        const key = `${row.symbol}|${row.strategyId ?? ""}|${row.candidateFingerprint ?? ""}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const performance = row.selectionPerformance;
        result.push({
            row,
            avgTrade: typeof performance?.avgTrade === "number" ? performance.avgTrade : null,
            avgLoss: typeof performance?.avgLoss === "number" ? performance.avgLoss : null,
            avgWin: typeof performance?.avgWin === "number" ? performance.avgWin : null,
            winRate: typeof performance?.winRate === "number" ? performance.winRate : null,
            trades: typeof performance?.totalTrades === "number" ? performance.totalTrades : null,
            maxDrawdownPercent: typeof performance?.maxDrawdownPercent === "number" ? performance.maxDrawdownPercent : null,
            netProfit: typeof (performance as { netProfit?: number | null } | null | undefined)?.netProfit === "number" ? (performance as { netProfit: number }).netProfit : null,
            expectancy: typeof performance?.avgTrade === "number" ? performance.avgTrade : null,
        });
    }
    return result;
}

function customSortPicks(file: FileData, sortName: string, horizonBars: number): Pick[] {
    const aggregates = buildSymbolAggregates(file);
    switch (sortName) {
        case "consensus_strategies": {
            return [...aggregates.values()]
                .sort((left, right) =>
                    right.distinctStrategies.size - left.distinctStrategies.size
                    || (right.meanAvgTrade ?? Number.NEGATIVE_INFINITY) - (left.meanAvgTrade ?? Number.NEGATIVE_INFINITY))
                .map((aggregate) => ({ symbol: aggregate.symbol, value: symbolPickValue(aggregate, horizonBars) }));
        }
        case "consensus_rank_weighted": {
            return [...aggregates.values()]
                .sort((left, right) =>
                    right.rankWeight - left.rankWeight
                    || right.distinctStrategies.size - left.distinctStrategies.size)
                .map((aggregate) => ({ symbol: aggregate.symbol, value: symbolPickValue(aggregate, horizonBars) }));
        }
        case "consensus_min2_avgtrade": {
            return [...aggregates.values()]
                .filter((aggregate) => aggregate.distinctStrategies.size >= 2 && aggregate.distinctSorts.size >= 2)
                .sort((left, right) => (right.meanAvgTrade ?? Number.NEGATIVE_INFINITY) - (left.meanAvgTrade ?? Number.NEGATIVE_INFINITY))
                .map((aggregate) => ({ symbol: aggregate.symbol, value: symbolPickValue(aggregate, horizonBars) }));
        }
        case "loss_quality": {
            return uniqueCandidates(file)
                .filter((entry) => entry.trades !== null && entry.trades! >= MIN_TRADES_FOR_LOSS_QUALITY && entry.avgLoss !== null && entry.avgTrade !== null)
                .sort((left, right) => left.avgLoss! - right.avgLoss! || right.avgTrade! - left.avgTrade!)
                .map((entry) => ({ symbol: entry.row.symbol!, value: rowForwardPnl(entry.row, horizonBars), detail: entry.row.strategyId }));
        }
        case "tstat_edge": {
            // Binary-outcome t-stat of the per-trade edge: mean * sqrt(n) / sd.
            // Ranks by SIGNIFICANCE, not size — the Finder optimizes sizes, not t-stats.
            return uniqueCandidates(file)
                .map((entry) => {
                    const w = entry.winRate !== null ? entry.winRate / 100 : null;
                    if (w === null || entry.avgWin === null || entry.avgLoss === null || entry.avgTrade === null || entry.trades === null || entry.trades! < (tstatMinTradesOverride ?? TSTAT_MIN_TRADES)) {
                        return { entry, t: null as number | null };
                    }
                    const mean = entry.avgTrade!;
                    // Plain t-stat (app parity): the run's minimum-trade filter owns
                    // sample guarding; all-win (zero variance) maps to +Infinity.
                    const variance = w * (entry.avgWin! - mean) ** 2 + (1 - w) * (entry.avgLoss! + mean) ** 2;
                    if (variance <= 0) return { entry, t: mean > 0 ? Number.POSITIVE_INFINITY : null };
                    return { entry, t: (mean * Math.sqrt(entry.trades!)) / Math.sqrt(variance) };
                })
                .filter((item): item is { entry: UniqueCandidate; t: number } => item.t !== null)
                .sort((left, right) => right.t - left.t)
                .map((item) => ({ symbol: item.entry.row.symbol!, value: rowForwardPnl(item.entry.row, horizonBars) }));
        }
        case "efficiency_dd": {
            return uniqueCandidates(file)
                .filter((entry) => entry.avgTrade !== null && entry.maxDrawdownPercent !== null && entry.maxDrawdownPercent! > 0)
                .sort((left, right) => (right.avgTrade! / right.maxDrawdownPercent!) - (left.avgTrade! / left.maxDrawdownPercent!))
                .map((entry) => ({ symbol: entry.row.symbol!, value: rowForwardPnl(entry.row, horizonBars), detail: entry.row.strategyId }));
        }
        case "edge_per_loss": {
            return uniqueCandidates(file)
                .filter((entry) => entry.avgTrade !== null && entry.avgLoss !== null && entry.avgLoss! > 0)
                .sort((left, right) => (right.avgTrade! / right.avgLoss!) - (left.avgTrade! / left.avgLoss!))
                .map((entry) => ({ symbol: entry.row.symbol!, value: rowForwardPnl(entry.row, horizonBars), detail: entry.row.strategyId }));
        }
        case "param_plateau": {
            // Symbol scored by the most distinct parameter fingerprints a SINGLE strategy
            // uses for it in the pool (parameter-plateau robustness), tie: mean avgTrade.
            const byStrategy = new Map<string, Set<string>>();
            const seen = new Set<string>();
            for (const row of file.rows) {
                if (!row.symbol || !row.strategyId || !row.candidateFingerprint) continue;
                const candidateKey = `${row.symbol}|${row.strategyId}|${row.candidateFingerprint}`;
                if (seen.has(candidateKey)) continue;
                seen.add(candidateKey);
                const key = `${row.symbol}|${row.strategyId}`;
                let set = byStrategy.get(key);
                if (!set) byStrategy.set(key, set = new Set<string>());
                set.add(row.candidateFingerprint);
            }
            const plateauBySymbol = new Map<string, number>();
            for (const [key, fingerprints] of byStrategy) {
                const symbol = key.split("|")[0]!;
                plateauBySymbol.set(symbol, Math.max(plateauBySymbol.get(symbol) ?? 0, fingerprints.size));
            }
            return [...aggregates.values()]
                .filter((aggregate) => (plateauBySymbol.get(aggregate.symbol) ?? 0) >= 2)
                .sort((left, right) =>
                    (plateauBySymbol.get(right.symbol) ?? 0) - (plateauBySymbol.get(left.symbol) ?? 0)
                    || (right.meanAvgTrade ?? Number.NEGATIVE_INFINITY) - (left.meanAvgTrade ?? Number.NEGATIVE_INFINITY))
                .map((aggregate) => ({ symbol: aggregate.symbol, value: symbolPickValue(aggregate, horizonBars) }));
        }
        case "inverted_netProfit": {
            return uniqueCandidates(file)
                .filter((entry) => entry.netProfit !== null)
                .sort((left, right) => left.netProfit! - right.netProfit!)
                .map((entry) => ({ symbol: entry.row.symbol!, value: rowForwardPnl(entry.row, horizonBars), detail: entry.row.strategyId }));
        }
        case "inverted_expectancy": {
            return uniqueCandidates(file)
                .filter((entry) => entry.expectancy !== null && entry.trades !== null && entry.trades! >= (tstatMinTradesOverride ?? TSTAT_MIN_TRADES))
                .sort((left, right) => left.expectancy! - right.expectancy!)
                .map((entry) => ({ symbol: entry.row.symbol!, value: rowForwardPnl(entry.row, horizonBars), detail: entry.row.strategyId }));
        }
        case "inverted_averageGain": {
            return uniqueCandidates(file)
                .filter((entry) => entry.avgWin !== null && entry.trades !== null && entry.trades! >= (tstatMinTradesOverride ?? TSTAT_MIN_TRADES))
                .sort((left, right) => left.avgWin! - right.avgWin!)
                .map((entry) => ({ symbol: entry.row.symbol!, value: rowForwardPnl(entry.row, horizonBars), detail: entry.row.strategyId }));
        }
        default:
            return [];
    }
}

function mean(values: number[]): number {
    return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function percentile(values: number[], fraction: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
    return sorted[index]!;
}

function formatDelta(value: number): string {
    return Number.isFinite(value) ? `${value >= 0 ? "+" : ""}${value.toFixed(2)}%` : "n/a";
}

function formatRate(value: number): string {
    return Number.isFinite(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function main(): void {
    const argv = process.argv.slice(2);
    const archiveDirectory = getArgument(argv, "--archive-dir") ?? path.resolve(__dirname, "..", "archive", "asset opportunity");
    const topKList = parseList(getArgument(argv, "--top-k"), [1, 2, 3]);
    const sampleSize = Math.max(1, Math.floor(Number(getArgument(argv, "--sample-size") ?? 10) || 10));
    const iterations = Math.max(1, Math.floor(Number(getArgument(argv, "--iterations") ?? 2000) || 2000));
    const seed = Math.floor(Number(getArgument(argv, "--seed") ?? 42) || 42);
    tstatMinTradesOverride = Math.max(1, Math.floor(Number(getArgument(argv, "--tstat-min-trades") ?? Number.NaN) || Number.NaN)) || null;
    const outputPrefix = getArgument(argv, "--output-prefix");

    const frictionBps = Math.max(0, Number(getArgument(argv, "--friction-bps") ?? 0) || 0);
    const frictionPct = frictionBps / 100;
    const controlArg = (getArgument(argv, "--control") ?? "baseline").toLowerCase();
    const control: "baseline" | "random_pool" = controlArg === "random_pool" ? "random_pool" : "baseline";

    const minHoldoutBars = Math.floor(Number(getArgument(argv, "--min-holdout") ?? 0) || 0);
    const maxHoldoutBars = Math.floor(Number(getArgument(argv, "--max-holdout") ?? Number.POSITIVE_INFINITY) || Number.POSITIVE_INFINITY);
    const rawFiles = loadFiles(archiveDirectory).filter((file) => file.holdoutBars >= minHoldoutBars && file.holdoutBars <= maxHoldoutBars);
    const horizons = [...new Set(rawFiles.flatMap((file) => [...file.baselineByHorizon.keys()]))].sort((left, right) => left - right);
    const horizonFallback = horizons[0] ?? 12;
    const primaryHorizon = Math.max(1, Math.floor(Number(getArgument(argv, "--horizon") ?? horizonFallback) || horizonFallback));

    const overlappingFlag = argv.includes("--overlapping") || argv.includes("--all-holdouts");
    const strideArg = getArgument(argv, "--stride-bars");
    let strideBars = primaryHorizon;
    if (overlappingFlag) {
        strideBars = 1;
    } else if (strideArg !== undefined) {
        strideBars = strideArg.toLowerCase() === "auto" ? primaryHorizon : Math.max(1, Math.floor(Number(strideArg)) || 1);
    }

    const files = filterHoldoutsByStride(rawFiles, strideBars);
    const poolBaselines = computePoolBaseline(files);

    // Batch-level presence rates for recurrence_batch.
    const presenceBySymbol = new Map<string, number>();
    for (const file of files) {
        for (const symbol of new Set(file.rows.map((row) => row.symbol).filter((symbol): symbol is string => !!symbol))) {
            presenceBySymbol.set(symbol, (presenceBySymbol.get(symbol) ?? 0) + 1);
        }
    }
    const recurringSymbols = [...presenceBySymbol.entries()]
        .filter(([, count]) => count / files.length >= RECURRENCE_PRESENCE_RATE)
        .map(([symbol]) => symbol);

    const customSorts = [
        "consensus_strategies",
        "consensus_rank_weighted",
        "consensus_min2_avgtrade",
        "loss_quality",
        "tstat_edge",
        "efficiency_dd",
        "edge_per_loss",
        "param_plateau",
        "inverted_netProfit",
        "inverted_expectancy",
        "inverted_averageGain",
    ];
    const rng = createRng(seed);
    const lines: string[] = [];
    lines.push("Asset Opportunity Custom-Sort Stability");
    lines.push("=======================================");
    lines.push(`Batch run: ${files[0]?.batchRunId} | files: ${files.length} of ${rawFiles.length} | primary horizon: ${primaryHorizon} bars | top-K: ${topKList.join("/")}`);
    lines.push(`Stride: ${strideBars > 1 ? `${strideBars} bars (non-overlapping windows)` : "1 bar (all files)"} | Friction: ${frictionBps > 0 ? `${frictionBps} bps (${(frictionBps / 100).toFixed(2)}%)` : "0 bps"}`);
    lines.push(`Control: ${control === "random_pool" ? "Unique active candidate pool average" : "Universe all-candidate baseline"}`);
    lines.push(`Bootstrap: ${iterations} shuffles x ${Math.min(sampleSize, files.length)} files (seed ${seed}) | verdicts pre-stated (STABLE+/WEAK+/UNSTABLE)`);
    lines.push(`recurrence_batch presence bar: >= ${(RECURRENCE_PRESENCE_RATE * 100).toFixed(0)}% of files (${recurringSymbols.length} symbols qualify)`);
    lines.push(`Caveat: ${strideBars >= primaryHorizon ? "non-overlapping holdouts eliminate serial price overlap" : "holdout windows overlap; stability indicators, not independent p-values"}. Union-pool re-rank only reaches`);
    lines.push(`candidates already inside some sort's top-10 (~50/file) — candidates outside every top-10 are unreachable.`);
    lines.push("");
    lines.push(`CUSTOM SORT STABILITY (primary horizon ${primaryHorizon} bars)`);
    lines.push("Sort | K | Files | Mean | %Files+ | Boot p5 | Boot p50 | Boot p95 | Boot %+ | Verdict");

    const json: Record<string, unknown> = {
        archiveDirectory,
        batchRunId: files[0]?.batchRunId,
        strideBars,
        frictionBps,
        control,
        customSorts: [] as Array<Record<string, unknown>>,
        recurrenceSymbols: recurringSymbols,
    };

    const emitCell = (sortName: string, topK: number, deltas: number[]): void => {
        if (deltas.length === 0) return;
        const means: number[] = [];
        const size = Math.min(sampleSize, deltas.length);
        for (let index = 0; index < iterations; index += 1) {
            let sum = 0;
            for (let draw = 0; draw < size; draw += 1) {
                sum += deltas[Math.floor(rng() * deltas.length)]!;
            }
            means.push(sum / size);
        }
        const boot = { p5: percentile(means, 0.05), p50: percentile(means, 0.5), p95: percentile(means, 0.95), positiveRate: means.filter((value) => value > 0).length / means.length };
        const signStability = deltas.filter((value) => value > 0).length / deltas.length;
        const verdict = boot.p5 > 0 && signStability >= 0.6 ? "STABLE+" : boot.p50 > 0 && signStability >= 0.55 ? "WEAK+" : "UNSTABLE";
        lines.push([sortName, String(topK), String(deltas.length), formatDelta(mean(deltas)), formatRate(signStability), formatDelta(boot.p5), formatDelta(boot.p50), formatDelta(boot.p95), formatRate(boot.positiveRate), verdict].join(" | "));
        (json.customSorts as Array<Record<string, unknown>>).push({ sort: sortName, topK, files: deltas.length, mean: mean(deltas), signStability, bootstrap: boot, verdict });
    };

    for (const sortName of customSorts) {
        for (const topK of topKList) {
            const deltas: number[] = [];
            for (const file of files) {
                const baseline = control === "random_pool"
                    ? poolBaselines.get(file.holdoutBars)?.get(primaryHorizon)
                    : file.baselineByHorizon.get(primaryHorizon);
                if (baseline === undefined) continue;
                const delta = rankPicks(customSortPicks(file, sortName, primaryHorizon), topK, baseline, frictionPct);
                if (delta !== null) deltas.push(delta);
            }
            emitCell(sortName, topK, deltas);
        }
    }

    // recurrence_batch: batch-level picks (symbols present in >=40% of files).
    for (const topK of topKList) {
        const picksByPresence = recurringSymbols
            .map((symbol) => ({ symbol, count: presenceBySymbol.get(symbol) ?? 0 }))
            .sort((left, right) => right.count - left.count)
            .slice(0, topK)
            .map((entry) => entry.symbol);
        const deltas: number[] = [];
        for (const file of files) {
            const baseline = control === "random_pool"
                ? poolBaselines.get(file.holdoutBars)?.get(primaryHorizon)
                : file.baselineByHorizon.get(primaryHorizon);
            if (baseline === undefined) continue;
            const aggregates = buildSymbolAggregates(file);
            const values = picksByPresence
                .map((symbol) => aggregates.get(symbol))
                .filter((aggregate): aggregate is SymbolAggregate => !!aggregate)
                .map((aggregate) => symbolPickValue(aggregate, primaryHorizon))
                .filter((value): value is number => value !== null);
            if (values.length > 0) {
                const meanVal = values.reduce((sum, value) => sum + value, 0) / values.length;
                deltas.push((meanVal - frictionPct) - baseline);
            }
        }
        emitCell(`recurrence_batch [${picksByPresence.join(", ")}]`, topK, deltas);
    }

    if (argv.includes("--picks")) {
        const file = files[0]!;
        lines.push("", `PICKS — freshest search in this archive (holdout ${file.holdoutBars} bars; forward column is the archive's realized OOS, diagnostic only)`);
        for (const sortName of customSorts) {
            const picks = customSortPicks(file, sortName, primaryHorizon)
                .filter((pick) => pick.value !== null)
                .slice(0, 3);
            lines.push(`${sortName}: ${picks.length > 0 ? picks.map((pick) => `${pick.symbol}${pick.detail ? ` (${pick.detail})` : ""} [${formatDelta(pick.value!)}]`).join(", ") : "n/a"}`);
        }
        lines.push("(averageGain's own top ranks are visible in the Finder AO view; not repeated here.)");
    }

    const report = lines.join("\n");
    console.log(report);
    if (outputPrefix) {
        fs.writeFileSync(`${outputPrefix}.txt`, `${report}\n`);
        fs.writeFileSync(`${outputPrefix}.json`, `${JSON.stringify(json, null, 2)}\n`);
        console.log(`\nReports written to:\n  ${outputPrefix}.txt\n  ${outputPrefix}.json`);
    }
}

main();
