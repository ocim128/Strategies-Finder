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

async function runTimeAudit() {
    const baseDir = path.resolve(__dirname, "..", "archive", "asset opportunity", "Decision Rule Research", "output collection");
    const runDirs = findRunDirs(baseDir).filter((d) => !d.includes("Short"));

    console.log("====================================================================================================");
    console.log("TIME-ROBUSTNESS AUDIT: WHICH DECISION RULES SURVIVE ACROSS MULTIPLE HISTORICAL EPOCHS?");
    console.log("====================================================================================================");
    console.log(`Auditing ${runDirs.length} long-direction runs across 4 distinct historical epochs (Stride = 12 bars)\n`);

    const epochs = [
        { name: "Fresh Band (12..160 bars / Summer 2026)", min: 12, max: 160 },
        { name: "Mid Band (161..305 bars / Spring 2026)", min: 161, max: 305 },
        { name: "Deep Band (310..500 bars / Winter 2025)", min: 310, max: 500 },
        { name: "Ultra-Deep (1000+ bars / 2024–2025)", min: 1000, max: 3000 }
    ];

    // sort -> K -> epoch -> number[]
    const data = new Map<string, Map<number, Map<string, number[]>>>();

    for (const runPath of runDirs) {
        const rawBlocks = loadBlocks(runPath);
        if (rawBlocks.length === 0) continue;
        const allHoldouts = [...new Set(rawBlocks.map((b) => b.holdoutBars))].sort((a, b) => a - b);
        const strideHoldouts = filterByStride(allHoldouts, 12);
        const blocks = rawBlocks.filter((b) => strideHoldouts.has(b.holdoutBars));

        for (const block of blocks) {
            const h = block.holdoutBars;
            const epoch = epochs.find((e) => h >= e.min && h <= e.max)?.name ?? "Other";
            for (const topK of [1, 2, 3]) {
                const res = blockMetrics(block, topK, 12);
                if (!res) continue;
                const sort = block.sortMetric;
                let bySort = data.get(sort);
                if (!bySort) data.set(sort, bySort = new Map());
                let byK = bySort.get(topK);
                if (!byK) bySort.set(topK, byK = new Map());
                let list = byK.get(epoch);
                if (!list) byK.set(epoch, list = []);
                list.push(res.delta);
            }
        }
    }

    interface ScoreboardEntry {
        sort: string;
        topK: number;
        freshMean: number; freshN: number;
        midMean: number; midN: number;
        deepMean: number; deepN: number;
        ultraMean: number; ultraN: number;
        pooledMean: number;
        netPooledMean30bps: number;
        posPct: number;
        totalN: number;
        epochsPositive: number;
        totalObsEpochs: number;
    }

    const entries: ScoreboardEntry[] = [];

    for (const [sort, byK] of data.entries()) {
        for (const topK of [2, 3]) {
            const byEpoch = byK.get(topK) ?? new Map();
            const fresh = byEpoch.get(epochs[0]!.name) ?? [];
            const mid = byEpoch.get(epochs[1]!.name) ?? [];
            const deep = byEpoch.get(epochs[2]!.name) ?? [];
            const ultra = byEpoch.get(epochs[3]!.name) ?? [];

            const allDeltas = [...fresh, ...mid, ...deep, ...ultra];
            if (allDeltas.length < 50) continue;

            const freshMean = mean(fresh);
            const midMean = mean(mid);
            const deepMean = mean(deep);
            const ultraMean = mean(ultra);
            const pooledMean = mean(allDeltas);
            const netPooledMean30bps = pooledMean - 0.30;
            const posPct = (allDeltas.filter((d) => d > 0).length / allDeltas.length) * 100;

            let epochsPositive = 0;
            if (fresh.length > 0 && freshMean > 0) epochsPositive++;
            if (mid.length > 0 && midMean > 0) epochsPositive++;
            if (deep.length > 0 && deepMean > 0) epochsPositive++;
            if (ultra.length > 0 && ultraMean > 0) epochsPositive++;

            const totalObsEpochs = [fresh, mid, deep, ultra].filter((e) => e.length > 0).length;

            entries.push({
                sort,
                topK,
                freshMean, freshN: fresh.length,
                midMean, midN: mid.length,
                deepMean, deepN: deep.length,
                ultraMean, ultraN: ultra.length,
                pooledMean,
                netPooledMean30bps,
                posPct,
                totalN: allDeltas.length,
                epochsPositive,
                totalObsEpochs,
            });
        }
    }

    // Sort by Epochs Positive (4 of 4 first), then by pooled delta
    entries.sort((a, b) => (b.epochsPositive - a.epochsPositive) || (b.pooledMean - a.pooledMean));

    console.log("DECISION RULE TIME-ROBUSTNESS SCOREBOARD (K=3 & K=2, Horizon = 12 Bars):");
    console.log("Sort                      | K | Fresh (12..160) | Mid (161..305)  | Deep (310..500) | Ultra (1000+)   | Pooled Delta | Net (30bps) | %Windows+ | Epochs+");
    console.log("-".repeat(146));

    const fmt = (m: number, n: number) => n === 0 ? "     N/A     " : `${m >= 0 ? "+" : ""}${m.toFixed(2)}% (n=${n})`.padEnd(16);

    for (const r of entries) {
        console.log(
            `${r.sort.padEnd(25)} | K=${r.topK} | ${fmt(r.freshMean, r.freshN)}| ${fmt(r.midMean, r.midN)}| ${fmt(r.deepMean, r.deepN)}| ${fmt(r.ultraMean, r.ultraN)}| ` +
            `${r.pooledMean >= 0 ? "+" : ""}${r.pooledMean.toFixed(2)}% (${r.totalN}) | ` +
            `${r.netPooledMean30bps >= 0 ? "+" : ""}${r.netPooledMean30bps.toFixed(2)}%   | ` +
            `${r.posPct.toFixed(1)}%     | ` +
            `${r.epochsPositive}/${r.totalObsEpochs}`
        );
    }
}

runTimeAudit();
