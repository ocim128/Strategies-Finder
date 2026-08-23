/**
 * Decision-rule stability test for Asset Opportunity holdout archives.
 *
 * Question answered: is "view by SORT, take TOP-K, hold H bars" a stable
 * decision rule across holdout windows, or an artifact of a few files?
 *
 * Method (operator proposal + additions):
 *   - Per (file, sort, K, horizon): delta = mean forward PnL of rank<=K rows
 *     minus that block's all-candidate baseline average.
 *   - Bootstrap: repeatedly sample SAMPLE-SIZE random files (with replacement),
 *     record the subsample mean delta. Distribution => Boot p5/p50/p95, % positive.
 *   - Sign stability: share of ALL files whose delta was positive (no resampling).
 *   - Trimmed mean: drop the top/bottom 10% of files (outlier dependence).
 *   - Staleness test: split holdout sizes into quartiles; a rule that only works
 *     in small-holdout (fresh search) quartiles is search-recency dependent.
 *
 * Pre-stated verdict rule (defined before looking at output):
 *   STABLE+  : bootstrap p5 > 0 AND sign stability >= 60%
 *   WEAK+    : bootstrap p50 > 0 AND sign stability >= 55%
 *   UNSTABLE : otherwise
 *
 * Caveat: holdout windows overlap (adjacent files share most of their OOS
 * region), so these are stability indicators, not independent-sample p-values.
 *
 * Direct usage:
 *   esno scripts/analyze-asset-opportunity-stability.ts \
 *     --archive-dir "archive/asset opportunity" --sample-size 10 --iterations 2000 \
 *     --horizon 12 --top-k 1,2,3 --seed 42
 */
import fs from "node:fs";
import path from "node:path";

const ARCHIVE_FILE_PATTERN = /^oos-holdout-(\d+)-bars\.txt$/;
const BLOCK_SEPARATOR = "=".repeat(80);
const BLOCK_PATTERN = new RegExp(
    `^${BLOCK_SEPARATOR}\\nTimestamp: ([^\\n]+)\\nBatch run id: ([^\\n]+)\\nOOS holdout: (\\d+) bars\\nArchive sort: ([^\\n]+)\\n(?:Archive baseline: ([^\\n]+)\\n)?${BLOCK_SEPARATOR}\\n([\\s\\S]*?)(?=\\n${BLOCK_SEPARATOR}\\n|$)`,
    "gm",
);

interface ArchiveHorizon {
    bars: number;
    averagePnlPercent?: number | null;
}

interface ArchiveRow {
    rank?: number;
    forwardOosPerformance?: {
        horizons?: Array<{ bars: number; pnlPercent?: number | null; sampleSize?: number | null }>;
    } | null;
}

interface ParsedBlock {
    timestamp: string;
    batchRunId: string;
    holdoutBars: number;
    sortMetric: string;
    baselineByHorizon: Map<number, number>;
    rows: ArchiveRow[];
}

interface CellSample {
    holdoutBars: number;
    delta: number;
    /** Raw (friction-free) forward mean of the selected top-K picks in this file. */
    selectedMean: number;
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

function parseBlocks(text: string, holdoutBars: number): ParsedBlock[] {
    const blocks: ParsedBlock[] = [];
    for (const match of text.matchAll(BLOCK_PATTERN)) {
        const baselineByHorizon = new Map<number, number>();
        if (match[5]) {
            try {
                const baseline = JSON.parse(match[5]) as { horizons?: ArchiveHorizon[] };
                for (const horizon of baseline.horizons ?? []) {
                    if (typeof horizon.averagePnlPercent === "number") {
                        baselineByHorizon.set(horizon.bars, horizon.averagePnlPercent);
                    }
                }
            } catch {
                // Malformed baseline line: leave the map empty; the block is skipped per-cell.
            }
        }
        let rows: ArchiveRow[] = [];
        try {
            rows = JSON.parse(match[6]!) as ArchiveRow[];
        } catch {
            continue;
        }
        blocks.push({
            timestamp: match[1]!,
            batchRunId: match[2]!,
            holdoutBars,
            sortMetric: match[4]!,
            baselineByHorizon,
            rows,
        });
    }
    return blocks;
}

function loadBlocks(archiveDirectory: string): ParsedBlock[] {
    const files = fs.readdirSync(archiveDirectory)
        .map((file) => file.match(ARCHIVE_FILE_PATTERN))
        .filter((match): match is RegExpMatchArray => match !== null)
        .map((match) => ({ bars: Number(match[1]), file: match.input! }))
        .sort((left, right) => left.bars - right.bars || left.file.localeCompare(right.file));
    if (files.length === 0) {
        throw new Error(`No oos-holdout-<N>-bars.txt files found in ${archiveDirectory}`);
    }
    const allBlocks = files.flatMap((entry) => parseBlocks(
        fs.readFileSync(path.join(archiveDirectory, entry.file), "utf8"),
        entry.bars,
    ));
    // Keep only the latest batch run (largest block count wins, then latest timestamp).
    const byRun = new Map<string, { blocks: ParsedBlock[]; latest: string }>();
    for (const block of allBlocks) {
        const group = byRun.get(block.batchRunId);
        if (!group) {
            byRun.set(block.batchRunId, { blocks: [block], latest: block.timestamp });
        } else {
            group.blocks.push(block);
            if (block.timestamp.localeCompare(group.latest) > 0) group.latest = block.timestamp;
        }
    }
    const selected = [...byRun.values()].sort((left, right) =>
        right.blocks.length - left.blocks.length || right.latest.localeCompare(left.latest),
    )[0];
    if (!selected) {
        throw new Error("No archive blocks could be parsed.");
    }
    // Latest block wins per (holdout, sort) key.
    const deduped = new Map<string, ParsedBlock>();
    for (const block of selected.blocks) {
        const key = `${block.holdoutBars}|${block.sortMetric}`;
        const previous = deduped.get(key);
        if (!previous || block.timestamp.localeCompare(previous.timestamp) >= 0) {
            deduped.set(key, block);
        }
    }
    return [...deduped.values()].sort((left, right) =>
        left.holdoutBars - right.holdoutBars || left.sortMetric.localeCompare(right.sortMetric),
    );
}

function filterHoldoutsByStride(holdouts: number[], stride: number): Set<number> {
    if (stride <= 1) return new Set(holdouts);
    const kept = new Set<number>();
    let nextTarget = -Infinity;
    for (const h of holdouts) {
        if (h >= nextTarget) {
            kept.add(h);
            nextTarget = h + stride;
        }
    }
    return kept;
}

function computePoolBaseline(blocks: ParsedBlock[]): Map<number, Map<number, number>> {
    // holdoutBars -> horizonBars -> mean forward PnL across all unique candidates present in that holdout
    const byHoldout = new Map<number, Map<number, number>>();
    const grouped = new Map<number, ParsedBlock[]>();
    for (const block of blocks) {
        let list = grouped.get(block.holdoutBars);
        if (!list) grouped.set(block.holdoutBars, list = []);
        list.push(block);
    }
    for (const [holdout, holdoutBlocks] of grouped) {
        const horizonValues = new Map<number, number[]>();
        const seenCandidateKeys = new Set<string>();
        for (const block of holdoutBlocks) {
            for (const row of block.rows) {
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
        }
        const horizonMeans = new Map<number, number>();
        for (const [horizon, values] of horizonValues) {
            if (values.length > 0) {
                horizonMeans.set(horizon, values.reduce((sum, v) => sum + v, 0) / values.length);
            }
        }
        byHoldout.set(holdout, horizonMeans);
    }
    return byHoldout;
}

function blockDelta(
    block: ParsedBlock,
    topK: number,
    horizonBars: number,
    frictionPct = 0,
    control: "baseline" | "random_pool" = "baseline",
    poolBaselines?: Map<number, Map<number, number>>,
): { delta: number; selectedMean: number } | null {
    let baseline: number | undefined;
    if (control === "random_pool") {
        baseline = poolBaselines?.get(block.holdoutBars)?.get(horizonBars);
    } else {
        baseline = block.baselineByHorizon.get(horizonBars);
    }
    if (baseline === undefined || !Number.isFinite(baseline)) return null;
    const selected = block.rows
        .filter((row) => typeof row.rank === "number" && row.rank! >= 1 && row.rank! <= topK);
    if (selected.length === 0) return null;
    const values: number[] = [];
    for (const row of selected) {
        const horizon = row.forwardOosPerformance?.horizons?.find((entry) => entry.bars === horizonBars);
        if (horizon && typeof horizon.pnlPercent === "number" && (horizon.sampleSize ?? 1) > 0) {
            values.push(horizon.pnlPercent);
        }
    }
    if (values.length === 0) return null;
    const selectedMean = values.reduce((sum, value) => sum + value, 0) / values.length;
    // Friction is charged to BOTH arms — the control pick is the same kind of
    // trade and pays the same cost, so the cost cancels in the delta. The raw
    // selected mean is returned separately; the report's AbsNet column applies
    // friction to it, which is the number that answers "does the pick clear
    // costs in absolute terms".
    const delta = (selectedMean - frictionPct) - (baseline - frictionPct);
    return { delta, selectedMean };
}

function mean(values: number[]): number {
    return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: number[]): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

function percentile(values: number[], fraction: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const index = Math.min(sorted.length - 1, Math.max(0, Math.round((sorted.length - 1) * fraction)));
    return sorted[index]!;
}

function trimmedMean(values: number[], trimFraction: number): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const trim = Math.floor(sorted.length * trimFraction);
    const kept = sorted.slice(trim, sorted.length - trim);
    return kept.length === 0 ? sorted[sorted.length - 1 - trim]! : mean(kept);
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
    const sampleSize = Math.max(1, Math.floor(Number(getArgument(argv, "--sample-size") ?? 10) || 10));
    const iterations = Math.max(1, Math.floor(Number(getArgument(argv, "--iterations") ?? 2000) || 2000));
    const topKList = parseList(getArgument(argv, "--top-k"), [1, 2, 3]);
    const seed = Math.floor(Number(getArgument(argv, "--seed") ?? 42) || 42);
    const outputPrefix = getArgument(argv, "--output-prefix");

    const frictionBps = Math.max(0, Number(getArgument(argv, "--friction-bps") ?? 0) || 0);
    const frictionPct = frictionBps / 100;
    const controlArg = (getArgument(argv, "--control") ?? "baseline").toLowerCase();
    const control: "baseline" | "random_pool" = controlArg === "random_pool" ? "random_pool" : "baseline";

    const minHoldoutBars = Math.floor(Number(getArgument(argv, "--min-holdout") ?? 0) || 0);
    const maxHoldoutBars = Math.floor(Number(getArgument(argv, "--max-holdout") ?? Number.POSITIVE_INFINITY) || Number.POSITIVE_INFINITY);
    let rawBlocks = loadBlocks(archiveDirectory).filter((block) => block.holdoutBars >= minHoldoutBars && block.holdoutBars <= maxHoldoutBars);
    
    const horizons = [...new Set(rawBlocks.flatMap((block) => [...block.baselineByHorizon.keys()]))].sort((left, right) => left - right);
    const primaryHorizonFallback = horizons[0] ?? 12;
    const primaryHorizon = Math.max(1, Math.floor(Number(getArgument(argv, "--horizon") ?? primaryHorizonFallback) || primaryHorizonFallback));

    const overlappingFlag = argv.includes("--overlapping") || argv.includes("--all-holdouts");
    const strideArg = getArgument(argv, "--stride-bars");
    let strideBars = primaryHorizon;
    if (overlappingFlag) {
        strideBars = 1;
    } else if (strideArg !== undefined) {
        strideBars = strideArg.toLowerCase() === "auto" ? primaryHorizon : Math.max(1, Math.floor(Number(strideArg)) || 1);
    }

    const allHoldoutBarsSet = [...new Set(rawBlocks.map((block) => block.holdoutBars))].sort((left, right) => left - right);
    const allowedHoldouts = filterHoldoutsByStride(allHoldoutBarsSet, strideBars);
    const blocks = rawBlocks.filter((block) => allowedHoldouts.has(block.holdoutBars));
    const holdoutBarsSet = [...new Set(blocks.map((block) => block.holdoutBars))].sort((left, right) => left - right);
    const sorts = [...new Set(blocks.map((block) => block.sortMetric))].sort((left, right) => left.localeCompare(right));

    const poolBaselines = computePoolBaseline(blocks);

    // Collect per-cell samples: sort -> topK -> horizon -> per-file deltas.
    const samples = new Map<string, Map<number, Map<number, CellSample[]>>>();
    for (const block of blocks) {
        for (const topK of topKList) {
            for (const horizon of horizons) {
                const outcome = blockDelta(block, topK, horizon, frictionPct, control, poolBaselines);
                if (outcome === null) continue;
                let bySort = samples.get(block.sortMetric);
                if (!bySort) samples.set(block.sortMetric, bySort = new Map());
                let byK = bySort.get(topK);
                if (!byK) bySort.set(topK, byK = new Map());
                let list = byK.get(horizon);
                if (!list) byK.set(horizon, list = []);
                list.push({ holdoutBars: block.holdoutBars, delta: outcome.delta, selectedMean: outcome.selectedMean });
            }
        }
    }

    const lines: string[] = [];
    const json: Record<string, unknown> = {
        archiveDirectory,
        batchRunId: blocks[0]?.batchRunId,
        files: holdoutBarsSet.length,
        holdoutRange: [holdoutBarsSet[0], holdoutBarsSet[holdoutBarsSet.length - 1]],
        strideBars,
        frictionBps,
        control,
        sampleSize,
        iterations,
        seed,
        topKList,
        horizons,
        primaryHorizon,
        cells: [] as Array<Record<string, unknown>>,
    };

    lines.push("Asset Opportunity Decision-Rule Stability");
    lines.push("==========================================");
    lines.push(`Batch run: ${blocks[0]?.batchRunId} | files: ${holdoutBarsSet.length} of ${allHoldoutBarsSet.length} (holdouts ${holdoutBarsSet[holdoutBarsSet.length - 1]}..${holdoutBarsSet[0]})`);
    lines.push(`Stride: ${strideBars > 1 ? `${strideBars} bars (non-overlapping windows)` : "1 bar (all holdouts)"} | Friction: ${frictionBps > 0 ? `${frictionBps} bps (${(frictionBps / 100).toFixed(2)}%) — charged to BOTH arms, cancels in deltas` : "0 bps"}`);
    lines.push(`Control: ${control === "random_pool" ? "Unique active candidate pool average" : "Universe all-candidate baseline"}`);
    lines.push(`Bootstrap: ${iterations} shuffles x ${Math.min(sampleSize, holdoutBarsSet.length)} random files (seed ${seed}) | primary horizon: ${primaryHorizon} bars | top-K: ${topKList.join("/")}`);
    lines.push(`Delta = top-K selected forward PnL minus ${control === "random_pool" ? "pool average" : "all-candidate baseline"}, per file. Identical trades pay identical costs, so friction cancels in Delta.`);
    lines.push(`AbsNet = selected forward mean NET of friction — the absolute "does the pick clear costs" reading.`);
    lines.push(`Pre-stated verdict: STABLE+ = boot p5>0 AND >=60% files positive; WEAK+ = boot p50>0 AND >=55%; else UNSTABLE.`);
    lines.push(`Caveat: ${strideBars >= primaryHorizon ? "non-overlapping holdouts eliminate serial price overlap" : "holdout windows overlap; stability indicators, not independent p-values"}.`);
    lines.push("");
    lines.push(`RULE STABILITY (primary horizon ${primaryHorizon} bars)`);
    lines.push("Sort | K | Files | Mean | Median | %Files+ | Trim10 | Boot p5 | Boot p50 | Boot p95 | Boot %+ | AbsNet | Verdict");

    const rng = createRng(seed);
    const bootstrapStats = (deltas: number[]) => {
        const means: number[] = [];
        const size = Math.min(sampleSize, deltas.length);
        for (let index = 0; index < iterations; index += 1) {
            let sum = 0;
            for (let draw = 0; draw < size; draw += 1) {
                sum += deltas[Math.floor(rng() * deltas.length)]!;
            }
            means.push(sum / size);
        }
        return {
            p5: percentile(means, 0.05),
            p50: percentile(means, 0.5),
            p95: percentile(means, 0.95),
            positiveRate: means.filter((value) => value > 0).length / means.length,
        };
    };

    const stableCells: Array<{ sort: string; topK: number }> = [];
    interface RuleRow {
        sort: string;
        topK: number;
        files: number;
        meanDelta: number;
        medianDelta: number;
        signStability: number;
        trim10: number;
        boot: { p5: number; p50: number; p95: number; positiveRate: number };
        verdict: string;
        /** Selected forward mean net of friction — the absolute "clears costs?" number. */
        absNetMean: number;
    }
    const ruleRows: RuleRow[] = [];
    for (const sort of sorts) {
        for (const topK of topKList) {
            const list = samples.get(sort)?.get(topK)?.get(primaryHorizon);
            if (!list || list.length === 0) continue;
            const deltas = list.map((sample) => sample.delta);
            const boot = bootstrapStats(deltas);
            const signStability = deltas.filter((value) => value > 0).length / deltas.length;
            const verdict = boot.p5 > 0 && signStability >= 0.6
                ? "STABLE+"
                : boot.p50 > 0 && signStability >= 0.55 ? "WEAK+" : "UNSTABLE";
            if (verdict !== "UNSTABLE") stableCells.push({ sort, topK });
            ruleRows.push({
                sort,
                topK,
                files: deltas.length,
                meanDelta: mean(deltas),
                medianDelta: median(deltas),
                signStability,
                trim10: trimmedMean(deltas, 0.1),
                boot,
                verdict,
                absNetMean: mean(list.map((sample) => sample.selectedMean)) - frictionPct,
            });
        }
    }
    // Best cells first: most positive mean delta at the top of every table.
    ruleRows.sort((left, right) => right.meanDelta - left.meanDelta);
    const bestMeanBySort = new Map<string, number>();
    for (const row of ruleRows) {
        bestMeanBySort.set(row.sort, Math.max(bestMeanBySort.get(row.sort) ?? -Infinity, row.meanDelta));
    }
    const orderedSorts = [...sorts].sort(
        (left, right) => (bestMeanBySort.get(right) ?? -Infinity) - (bestMeanBySort.get(left) ?? -Infinity),
    );
    for (const row of ruleRows) {
        lines.push([
            row.sort,
            String(row.topK),
            String(row.files),
            formatDelta(row.meanDelta),
            formatDelta(row.medianDelta),
            formatRate(row.signStability),
            formatDelta(row.trim10),
            formatDelta(row.boot.p5),
            formatDelta(row.boot.p50),
            formatDelta(row.boot.p95),
            formatRate(row.boot.positiveRate),
            formatDelta(row.absNetMean),
            row.verdict,
        ].join(" | "));
        (json.cells as Array<Record<string, unknown>>).push({
            sort: row.sort, topK: row.topK, horizon: primaryHorizon, files: row.files,
            mean: row.meanDelta, median: row.medianDelta, signStability: row.signStability,
            trimmedMean: row.trim10, bootstrap: row.boot, absNetMean: row.absNetMean, verdict: row.verdict,
        });
    }

    lines.push("");
    lines.push(`HORIZON SENSITIVITY (mean delta / %files positive)`);
    lines.push(`Sort | K | ${horizons.map((horizon) => `${horizon} bars`).join(" | ")}`);
    for (const sort of orderedSorts) {
        for (const topK of topKList) {
            const byHorizon = samples.get(sort)?.get(topK);
            if (!byHorizon) continue;
            const cells = horizons.map((horizon) => {
                const list = byHorizon.get(horizon);
                if (!list || list.length === 0) return "n/a";
                const deltas = list.map((sample) => sample.delta);
                return `${formatDelta(mean(deltas))} / ${formatRate(deltas.filter((value) => value > 0).length / deltas.length)}`;
            });
            lines.push([sort, String(topK), ...cells].join(" | "));
        }
    }

    lines.push("");
    lines.push(`STALENESS TEST (holdout-size quartiles; K=${topKList[topKList.length - 1]}, horizon ${primaryHorizon} bars)`);
    const quartileCount = 4;
    const quartileLabels: string[] = [];
    const sortedHoldouts = holdoutBarsSet;
    for (let index = 0; index < quartileCount; index += 1) {
        const start = Math.floor((sortedHoldouts.length * index) / quartileCount);
        const end = Math.floor((sortedHoldouts.length * (index + 1)) / quartileCount);
        quartileLabels.push(`Q${index + 1} ${sortedHoldouts[start]}..${sortedHoldouts[Math.max(0, end - 1)]}`);
    }
    lines.push(`Sort | ${quartileLabels.join(" | ")}`);
    const lastK = topKList[topKList.length - 1]!;
    for (const sort of orderedSorts) {
        const byHorizon = samples.get(sort)?.get(lastK)?.get(primaryHorizon);
        if (!byHorizon) continue;
        const cells = Array.from({ length: quartileCount }, (_, index) => {
            const start = Math.floor((sortedHoldouts.length * index) / quartileCount);
            const end = Math.floor((sortedHoldouts.length * (index + 1)) / quartileCount);
            const range = new Set(sortedHoldouts.slice(start, end));
            const inRange = byHorizon.filter((sample) => range.has(sample.holdoutBars)).map((sample) => sample.delta);
            if (inRange.length === 0) return "n/a";
            return `${formatDelta(mean(inRange))} / ${formatRate(inRange.filter((value) => value > 0).length / inRange.length)}`;
        });
        lines.push([sort, ...cells].join(" | "));
    }

    const report = lines.join("\n");
    // Console copy adds ANSI color (green positive / red negative, verdict
    // highlights); the written .txt/.json stay plain so files stay clean.
    const useColor = process.stdout.isTTY === true && process.env.NO_COLOR === undefined;
    const colorize = (text: string): string => text
        .replace(/STABLE\+/g, "\u001b[92mSTABLE+\u001b[0m")
        .replace(/WEAK\+/g, "\u001b[32mWEAK+\u001b[0m")
        .replace(/UNSTABLE/g, "\u001b[31mUNSTABLE\u001b[0m")
        .replace(/[+-]\d+\.\d+%/g, (match) => match.startsWith("+")
            ? `\u001b[32m${match}\u001b[0m`
            : `\u001b[31m${match}\u001b[0m`);
    console.log(useColor ? colorize(report) : report);
    if (outputPrefix) {
        fs.writeFileSync(`${outputPrefix}.txt`, `${report}\n`);
        fs.writeFileSync(`${outputPrefix}.json`, `${JSON.stringify(json, null, 2)}\n`);
        console.log(`\nReports written to:\n  ${outputPrefix}.txt\n  ${outputPrefix}.json`);
    }
}

main();

