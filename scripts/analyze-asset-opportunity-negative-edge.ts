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
    symbol?: string;
    strategyId?: string;
    candidateFingerprint?: string;
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
            } catch {}
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
        .sort((left, right) => left.bars - right.bars);
    if (files.length === 0) return [];
    
    const allBlocks = files.flatMap((entry) =>
        parseBlocks(fs.readFileSync(path.join(archiveDirectory, entry.file), "utf8"), entry.bars)
    );
    
    const byRun = new Map<string, { blocks: ParsedBlock[]; latest: string }>();
    for (const block of allBlocks) {
        const group = byRun.get(block.batchRunId);
        if (!group) byRun.set(block.batchRunId, { blocks: [block], latest: block.timestamp });
        else {
            group.blocks.push(block);
            if (block.timestamp.localeCompare(group.latest) > 0) group.latest = block.timestamp;
        }
    }
    const selected = [...byRun.values()].sort((a, b) => b.blocks.length - a.blocks.length || b.latest.localeCompare(a.latest))[0];
    if (!selected) return [];
    
    const deduped = new Map<string, ParsedBlock>();
    for (const block of selected.blocks) {
        const key = `${block.holdoutBars}|${block.sortMetric}`;
        const prev = deduped.get(key);
        if (!prev || block.timestamp.localeCompare(prev.timestamp) >= 0) {
            deduped.set(key, block);
        }
    }
    return [...deduped.values()].sort((a, b) => a.holdoutBars - b.holdoutBars || a.sortMetric.localeCompare(b.sortMetric));
}

function filterByStride(holdouts: number[], stride: number): Set<number> {
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

function blockMetrics(block: ParsedBlock, topK: number, horizonBars: number): {
    rawReturn: number;
    baseline: number;
    delta: number;
} | null {
    const baseline = block.baselineByHorizon.get(horizonBars);
    if (baseline === undefined) return null;
    const selected = block.rows.filter((r) => typeof r.rank === "number" && r.rank >= 1 && r.rank <= topK);
    if (selected.length === 0) return null;
    const values: number[] = [];
    for (const r of selected) {
        const h = r.forwardOosPerformance?.horizons?.find((entry) => entry.bars === horizonBars);
        if (h && typeof h.pnlPercent === "number" && (h.sampleSize ?? 1) > 0) {
            values.push(h.pnlPercent);
        }
    }
    if (values.length === 0) return null;
    const rawReturn = values.reduce((sum, v) => sum + v, 0) / values.length;
    return { rawReturn, baseline, delta: rawReturn - baseline };
}

function mean(nums: number[]): number {
    return nums.length === 0 ? 0 : nums.reduce((s, v) => s + v, 0) / nums.length;
}

async function runAnalysis() {
    const collectionDir = path.resolve(__dirname, "..", "archive", "asset opportunity", "Decision Rule Research", "output collection");
    const runs = fs.readdirSync(collectionDir).filter((d) => fs.statSync(path.join(collectionDir, d)).isDirectory());

    console.log("================================================================================");
    console.log("CROSS-RUN NEGATIVE EDGE & ANTI-SIGNAL AUDIT (NON-OVERLAPPING STRIDE = 12 BARS)");
    console.log("================================================================================");
    console.log(`Runs analyzed: ${runs.length} runs in output collection\n`);

    interface SortSummary {
        sort: string;
        topK: number;
        horizon: number;
        totalFiles: number;
        meanDelta: number;
        meanRawReturn: number;
        meanBaseline: number;
        pctNegative: number;
        pctRawNegative: number;
        runsWithNegativeDelta: number;
        totalRunsObserved: number;
        runDeltas: Array<{ run: string; delta: number; files: number; pctNegative: number }>;
    }

    const sortMap = new Map<string, Array<{
        run: string;
        holdout: number;
        rawReturn: number;
        baseline: number;
        delta: number;
    }>>();

    for (const runName of runs) {
        const runPath = path.join(collectionDir, runName);
        const rawBlocks = loadBlocks(runPath);
        if (rawBlocks.length === 0) continue;

        const allHoldouts = [...new Set(rawBlocks.map((b) => b.holdoutBars))].sort((a, b) => a - b);
        const strideHoldouts = filterByStride(allHoldouts, 12);
        const blocks = rawBlocks.filter((b) => strideHoldouts.has(b.holdoutBars));

        for (const block of blocks) {
            for (const topK of [1, 2, 3]) {
                for (const horizon of [12, 18, 24]) {
                    const res = blockMetrics(block, topK, horizon);
                    if (!res) continue;
                    const key = `${block.sortMetric}|${topK}|${horizon}`;
                    let list = sortMap.get(key);
                    if (!list) sortMap.set(key, list = []);
                    list.push({
                        run: runName,
                        holdout: block.holdoutBars,
                        rawReturn: res.rawReturn,
                        baseline: res.baseline,
                        delta: res.delta,
                    });
                }
            }
        }
    }

    const summaries: SortSummary[] = [];

    for (const [key, entries] of sortMap.entries()) {
        const [sort, topKStr, horizonStr] = key.split("|");
        const topK = Number(topKStr);
        const horizon = Number(horizonStr);

        const deltas = entries.map((e) => e.delta);
        const rawReturns = entries.map((e) => e.rawReturn);
        const baselines = entries.map((e) => e.baseline);

        const byRun = new Map<string, number[]>();
        for (const e of entries) {
            let list = byRun.get(e.run);
            if (!list) byRun.set(e.run, list = []);
            list.push(e.delta);
        }

        const runDeltas = [...byRun.entries()].map(([run, rDeltas]) => ({
            run,
            delta: mean(rDeltas),
            files: rDeltas.length,
            pctNegative: (rDeltas.filter((d) => d < 0).length / rDeltas.length) * 100,
        }));

        const runsWithNegativeDelta = runDeltas.filter((r) => r.delta < 0).length;

        summaries.push({
            sort: sort!,
            topK,
            horizon,
            totalFiles: entries.length,
            meanDelta: mean(deltas),
            meanRawReturn: mean(rawReturns),
            meanBaseline: mean(baselines),
            pctNegative: (deltas.filter((d) => d < 0).length / deltas.length) * 100,
            pctRawNegative: (rawReturns.filter((r) => r < 0).length / rawReturns.length) * 100,
            runsWithNegativeDelta,
            totalRunsObserved: runDeltas.length,
            runDeltas,
        });
    }

    for (const horizon of [12, 18, 24]) {
        console.log(`\n>>> RANKED ANTI-SIGNALS / NEGATIVE EDGE @ ${horizon} BARS (NON-OVERLAPPING STRIDE):`);
        console.log("Sort | K | Runs- | Mean Delta | %Files Delta<0 | Mean Raw PnL | Fade (Gross Short)");
        console.log("-".repeat(90));
        const horizonSummaries = summaries
            .filter((s) => s.horizon === horizon && s.totalRunsObserved >= 4)
            .sort((a, b) => a.meanDelta - b.meanDelta);

        for (const s of horizonSummaries.slice(0, 10)) {
            const fadeEdge = -s.meanRawReturn;
            console.log(
                `${s.sort.padEnd(25)} | K=${s.topK} | ${s.runsWithNegativeDelta}/${s.totalRunsObserved} | ` +
                `${s.meanDelta >= 0 ? "+" : ""}${s.meanDelta.toFixed(2)}% | ` +
                `${s.pctNegative.toFixed(1)}% | ` +
                `${s.meanRawReturn >= 0 ? "+" : ""}${s.meanRawReturn.toFixed(2)}% | ` +
                `Short PnL: ${fadeEdge >= 0 ? "+" : ""}${fadeEdge.toFixed(2)}%`
            );
        }
    }
}

runAnalysis();
