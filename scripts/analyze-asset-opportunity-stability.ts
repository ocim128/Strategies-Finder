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

function blockDelta(block: ParsedBlock, topK: number, horizonBars: number): number | null {
    const baseline = block.baselineByHorizon.get(horizonBars);
    if (baseline === undefined) return null;
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
    return values.reduce((sum, value) => sum + value, 0) / values.length - baseline;
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

    const minHoldoutBars = Math.floor(Number(getArgument(argv, "--min-holdout") ?? 0) || 0);
    const maxHoldoutBars = Math.floor(Number(getArgument(argv, "--max-holdout") ?? Number.POSITIVE_INFINITY) || Number.POSITIVE_INFINITY);
    const blocks = loadBlocks(archiveDirectory).filter((block) => block.holdoutBars >= minHoldoutBars && block.holdoutBars <= maxHoldoutBars);
    const holdoutBarsSet = [...new Set(blocks.map((block) => block.holdoutBars))].sort((left, right) => left - right);
    const sorts = [...new Set(blocks.map((block) => block.sortMetric))].sort((left, right) => left.localeCompare(right));
    const horizons = [...new Set(blocks.flatMap((block) => [...block.baselineByHorizon.keys()]))].sort((left, right) => left - right);
    const primaryHorizonFallback = horizons[0] ?? 12;
    const primaryHorizon = Math.max(1, Math.floor(Number(getArgument(argv, "--horizon") ?? primaryHorizonFallback) || primaryHorizonFallback));

    // Collect per-cell samples: sort -> topK -> horizon -> per-file deltas.
    const samples = new Map<string, Map<number, Map<number, CellSample[]>>>();
    for (const block of blocks) {
        for (const topK of topKList) {
            for (const horizon of horizons) {
                const delta = blockDelta(block, topK, horizon);
                if (delta === null) continue;
                let bySort = samples.get(block.sortMetric);
                if (!bySort) samples.set(block.sortMetric, bySort = new Map());
                let byK = bySort.get(topK);
                if (!byK) bySort.set(topK, byK = new Map());
                let list = byK.get(horizon);
                if (!list) byK.set(horizon, list = []);
                list.push({ holdoutBars: block.holdoutBars, delta });
            }
        }
    }

    const lines: string[] = [];
    const json: Record<string, unknown> = {
        archiveDirectory,
        batchRunId: blocks[0]?.batchRunId,
        files: holdoutBarsSet.length,
        holdoutRange: [holdoutBarsSet[0], holdoutBarsSet[holdoutBarsSet.length - 1]],
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
    lines.push(`Batch run: ${blocks[0]?.batchRunId} | files: ${holdoutBarsSet.length} (holdouts ${holdoutBarsSet[holdoutBarsSet.length - 1]}..${holdoutBarsSet[0]})`);
    lines.push(`Bootstrap: ${iterations} shuffles x ${sampleSize} random files (seed ${seed}) | primary horizon: ${primaryHorizon} bars | top-K: ${topKList.join("/")}`);
    lines.push(`Delta = top-K selected forward PnL minus all-candidate baseline, per file.`);
    lines.push(`Pre-stated verdict: STABLE+ = boot p5>0 AND >=60% files positive; WEAK+ = boot p50>0 AND >=55%; else UNSTABLE.`);
    lines.push(`Caveat: holdout windows overlap; these are stability indicators, not independent-sample p-values.`);
    lines.push("");
    lines.push(`RULE STABILITY (primary horizon ${primaryHorizon} bars)`);
    lines.push("Sort | K | Files | Mean | Median | %Files+ | Trim10 | Boot p5 | Boot p50 | Boot p95 | Boot %+ | Verdict");

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
            lines.push([
                sort,
                String(topK),
                String(deltas.length),
                formatDelta(mean(deltas)),
                formatDelta(median(deltas)),
                formatRate(signStability),
                formatDelta(trimmedMean(deltas, 0.1)),
                formatDelta(boot.p5),
                formatDelta(boot.p50),
                formatDelta(boot.p95),
                formatRate(boot.positiveRate),
                verdict,
            ].join(" | "));
            (json.cells as Array<Record<string, unknown>>).push({
                sort, topK, horizon: primaryHorizon, files: deltas.length,
                mean: mean(deltas), median: median(deltas), signStability,
                trimmedMean: trimmedMean(deltas, 0.1), bootstrap: boot, verdict,
            });
        }
    }

    lines.push("");
    lines.push(`HORIZON SENSITIVITY (mean delta / %files positive)`);
    lines.push(`Sort | K | ${horizons.map((horizon) => `${horizon} bars`).join(" | ")}`);
    for (const sort of sorts) {
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
    for (const sort of sorts) {
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
    console.log(report);
    if (outputPrefix) {
        fs.writeFileSync(`${outputPrefix}.txt`, `${report}\n`);
        fs.writeFileSync(`${outputPrefix}.json`, `${JSON.stringify(json, null, 2)}\n`);
        console.log(`\nReports written to:\n  ${outputPrefix}.txt\n  ${outputPrefix}.json`);
    }
}

main();
