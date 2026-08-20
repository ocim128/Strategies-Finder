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
        try { rows = JSON.parse(match[6]!) as ArchiveRow[]; } catch { continue; }
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
    if (!fs.existsSync(archiveDirectory)) return [];
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

function blockMetrics(block: ParsedBlock, topK: number, horizonBars: number): { rawReturn: number; baseline: number; delta: number } | null {
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

function findRunDirs(dir: string): string[] {
    let results: string[] = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const hasHoldoutFiles = entries.some((e) => e.isFile() && ARCHIVE_FILE_PATTERN.test(e.name));
    if (hasHoldoutFiles) {
        results.push(dir);
    } else {
        for (const e of entries) {
            if (e.isDirectory()) {
                results.push(...findRunDirs(path.join(dir, e.name)));
            }
        }
    }
    return results;
}

function mean(nums: number[]): number {
    return nums.length === 0 ? 0 : nums.reduce((s, v) => s + v, 0) / nums.length;
}

async function runNegativeAudit() {
    const baseDir = path.resolve(__dirname, "..", "archive", "asset opportunity", "Decision Rule Research", "output collection");
    const runDirs = findRunDirs(baseDir).filter((d) => !d.includes("Short"));

    const epochs = [
        { name: "Fresh (12..160 bars / Summer 2026)", min: 12, max: 160 },
        { name: "Mid (161..305 bars / Spring 2026)", min: 161, max: 305 },
        { name: "Deep (310..500 bars / Winter 2025)", min: 310, max: 500 },
        { name: "Ultra-Deep (1000+ bars / 2024–2025)", min: 1000, max: 3000 }
    ];

    // sort -> topK -> horizon -> epoch -> { delta: number, rawReturn: number }[]
    const data = new Map<string, Map<number, Map<number, Map<string, Array<{ delta: number; rawReturn: number }>>>>>();

    for (const runPath of runDirs) {
        const rawBlocks = loadBlocks(runPath);
        if (rawBlocks.length === 0) continue;
        const allHoldouts = [...new Set(rawBlocks.map((b) => b.holdoutBars))].sort((a, b) => a - b);

        for (const horizon of [12, 18, 24]) {
            const strideHoldouts = filterByStride(allHoldouts, horizon);
            const blocks = rawBlocks.filter((b) => strideHoldouts.has(b.holdoutBars));

            for (const block of blocks) {
                const h = block.holdoutBars;
                const epoch = epochs.find((e) => h >= e.min && h <= e.max)?.name ?? "Other";
                for (const topK of [1, 2, 3]) {
                    const res = blockMetrics(block, topK, horizon);
                    if (!res) continue;
                    const sort = block.sortMetric;
                    let bySort = data.get(sort);
                    if (!bySort) data.set(sort, bySort = new Map());
                    let byK = bySort.get(topK);
                    if (!byK) bySort.set(topK, byK = new Map());
                    let byH = byK.get(horizon);
                    if (!byH) byK.set(horizon, byH = new Map());
                    let list = byH.get(epoch);
                    if (!list) byH.set(epoch, list = []);
                    list.push({ delta: res.delta, rawReturn: res.rawReturn });
                }
            }
        }
    }

    interface NegativeRow {
        sort: string;
        topK: number;
        horizon: number;
        freshDelta: number;
        midDelta: number;
        deepDelta: number;
        ultraDelta: number;
        pooledDelta: number;
        pooledRawReturn: number;
        fadeNetReturn30bps: number;
        pctNegativeWindows: number;
        totalWindows: number;
        epochsNegative: number;
        totalObsEpochs: number;
    }

    const rows: NegativeRow[] = [];

    for (const [sort, byK] of data.entries()) {
        for (const topK of [1, 2, 3]) {
            for (const horizon of [12, 18, 24]) {
                const byH = byK.get(topK)?.get(horizon);
                if (!byH) continue;
                const fresh = (byH.get(epochs[0]!.name) || []).map((x) => x.delta);
                const mid = (byH.get(epochs[1]!.name) || []).map((x) => x.delta);
                const deep = (byH.get(epochs[2]!.name) || []).map((x) => x.delta);
                const ultra = (byH.get(epochs[3]!.name) || []).map((x) => x.delta);

                const allEntries = [
                    ...(byH.get(epochs[0]!.name) || []),
                    ...(byH.get(epochs[1]!.name) || []),
                    ...(byH.get(epochs[2]!.name) || []),
                    ...(byH.get(epochs[3]!.name) || [])
                ];
                if (allEntries.length < 50) continue;

                const allDeltas = allEntries.map((x) => x.delta);
                const allRaw = allEntries.map((x) => x.rawReturn);

                const freshDelta = mean(fresh);
                const midDelta = mean(mid);
                const deepDelta = mean(deep);
                const ultraDelta = mean(ultra);
                const pooledDelta = mean(allDeltas);
                const pooledRawReturn = mean(allRaw);
                const fadeGrossReturn = -pooledRawReturn;
                const fadeNetReturn30bps = fadeGrossReturn - 0.30;
                const pctNegativeWindows = (allDeltas.filter((d) => d < 0).length / allDeltas.length) * 100;

                let epochsNegative = 0;
                if (fresh.length > 0 && freshDelta < 0) epochsNegative++;
                if (mid.length > 0 && midDelta < 0) epochsNegative++;
                if (deep.length > 0 && deepDelta < 0) epochsNegative++;
                if (ultra.length > 0 && ultraDelta < 0) epochsNegative++;

                const totalObsEpochs = [fresh, mid, deep, ultra].filter((e) => e.length > 0).length;

                rows.push({
                    sort,
                    topK,
                    horizon,
                    freshDelta,
                    midDelta,
                    deepDelta,
                    ultraDelta,
                    pooledDelta,
                    pooledRawReturn,
                    fadeNetReturn30bps,
                    pctNegativeWindows,
                    totalWindows: allDeltas.length,
                    epochsNegative,
                    totalObsEpochs,
                });
            }
        }
    }

    const negativeRows = rows.filter((r) => r.epochsNegative >= 3 || r.pooledDelta < -0.30);
    negativeRows.sort((a, b) => (b.epochsNegative - a.epochsNegative) || (a.pooledDelta - b.pooledDelta));

    console.log("====================================================================================================");
    console.log("PERSISTENT NEGATIVE RULES & FADE/SHORT EDGE ACROSS MULTIPLE HISTORICAL EPOCHS (STRIDE-12)");
    console.log("====================================================================================================");
    console.log("Sort                      | K | Horiz | Fresh (12..160) | Mid (161..305)  | Deep (310..500) | Ultra (1000+)   | Pooled Delta | Fade (Short Net 30bps) | %Win<0 | Epochs-");
    console.log("-".repeat(162));

    for (const r of negativeRows.slice(0, 25)) {
        const fmt = (m: number) => `${m >= 0 ? "+" : ""}${m.toFixed(2)}%`.padEnd(16);
        console.log(
            `${r.sort.padEnd(25)} | K=${r.topK} | ${r.horizon}b   | ${fmt(r.freshDelta)}| ${fmt(r.midDelta)}| ${fmt(r.deepDelta)}| ${fmt(r.ultraDelta)}| ` +
            `${r.pooledDelta >= 0 ? "+" : ""}${r.pooledDelta.toFixed(2)}% (${r.totalWindows}) | ` +
            `Net: ${r.fadeNetReturn30bps >= 0 ? "+" : ""}${r.fadeNetReturn30bps.toFixed(2)}%          | ` +
            `${r.pctNegativeWindows.toFixed(1)}% | ` +
            `${r.epochsNegative}/${r.totalObsEpochs}`
        );
    }
}

runNegativeAudit();
