/**
 * Analyze the per-pair summaries recorded by Asset Opportunity batch runs.
 *
 * The five predictors are computed from the full in-search candidate pool;
 * forwardPnlPercentByHorizon is used only as the pair-level target. Holdouts
 * are stride-filtered before every analysis so adjacent windows do not reuse
 * the same forward bars by accident.
 *
 * Direct usage:
 *   esno scripts/analyze-asset-opportunity-pair-summaries.ts \
 *     --archive-dir "archive/asset opportunity" --stride-bars 12 \
 *     --horizon 12 --output-prefix "archive/asset opportunity/pair-analysis"
 */
import fs from "node:fs";
import path from "node:path";

const BLOCK_SEPARATOR = "=".repeat(80);
const PAIR_SUMMARY_FILE_PATTERN = /^oos-pair-summary-(\d+)-bars\.txt$/;
const HOLDOUT_FILE_PATTERN = /^oos-holdout-(\d+)-bars\.txt$/;
const PAIR_SUMMARY_BLOCK_PATTERN = new RegExp(
    `^${BLOCK_SEPARATOR}\\nTimestamp: ([^\\n]+)\\nBatch run id: ([^\\n]+)\\nOOS holdout: (\\d+) bars\\nPair summaries: JSON\\n${BLOCK_SEPARATOR}\\n([\\s\\S]*?)(?=\\n${BLOCK_SEPARATOR}\\n|$)`,
    "gm",
);
const HOLDOUT_BLOCK_PATTERN = new RegExp(
    `^${BLOCK_SEPARATOR}\\nTimestamp: ([^\\n]+)\\nBatch run id: ([^\\n]+)\\nOOS holdout: (\\d+) bars\\nArchive sort: ([^\\n]+)\\n(?:Archive baseline: ([^\\n]+)\\n)?${BLOCK_SEPARATOR}\\n([\\s\\S]*?)(?=\\n${BLOCK_SEPARATOR}\\n|$)`,
    "gm",
);

const PREDICTORS = [
    "profitableShare",
    "medianNetProfitPercent",
    "netProfitP75MinusP25",
    "medianExpectancy",
    "topNetProfit",
] as const;
type Predictor = typeof PREDICTORS[number];

interface PairSummaryRow {
    symbol?: string;
    candidateCount?: number;
    profitableShare?: number;
    medianNetProfitPercent?: number;
    netProfitP75MinusP25?: number;
    medianExpectancy?: number;
    topNetProfit?: number;
    forwardPnlPercentByHorizon?: Record<string, number | null>;
}

interface PairSummaryBlock {
    timestamp: string;
    batchRunId: string;
    holdoutBars: number;
    rows: PairSummaryRow[];
}

interface HoldoutRow {
    rank?: number;
    symbol?: string;
}

interface HoldoutBlock {
    timestamp: string;
    batchRunId: string;
    holdoutBars: number;
    sortMetric: string;
    rows: HoldoutRow[];
}

interface WindowValue {
    holdoutBars: number;
    value: number;
}

interface SummaryStats {
    windows: number;
    mean: number;
    standardError: number;
    t: number;
    positiveRate: number;
}

interface IncrementSample {
    target: number;
    predictor: number;
    median: number;
}

function getArgument(argv: string[], flag: string): string | undefined {
    const index = argv.indexOf(flag);
    return index >= 0 ? argv[index + 1] : undefined;
}

function finiteNumber(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value);
}

function mean(values: readonly number[]): number {
    return values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values: readonly number[]): number {
    if (values.length === 0) return Number.NaN;
    const sorted = [...values].sort((left, right) => left - right);
    const middle = (sorted.length - 1) / 2;
    const lower = Math.floor(middle);
    const upper = Math.ceil(middle);
    return lower === upper ? sorted[lower]! : (sorted[lower]! + sorted[upper]!) / 2;
}

function standardError(values: readonly number[]): number {
    if (values.length < 2) return Number.NaN;
    const average = mean(values);
    const variance = values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / (values.length - 1);
    return Math.sqrt(variance / values.length);
}

function summarize(values: readonly number[]): SummaryStats {
    const se = standardError(values);
    return {
        windows: values.length,
        mean: mean(values),
        standardError: se,
        t: finiteNumber(se) && se > 0 ? mean(values) / se : Number.NaN,
        positiveRate: values.length > 0 ? values.filter((value) => value > 0).length / values.length : Number.NaN,
    };
}

function rank(values: readonly number[]): number[] {
    const ordered = values
        .map((value, index) => ({ value, index }))
        .sort((left, right) => left.value - right.value || left.index - right.index);
    const ranks = new Array<number>(values.length);
    let start = 0;
    while (start < ordered.length) {
        let end = start + 1;
        while (end < ordered.length && ordered[end]!.value === ordered[start]!.value) end += 1;
        const averageRank = (start + 1 + end) / 2;
        for (let index = start; index < end; index += 1) ranks[ordered[index]!.index] = averageRank;
        start = end;
    }
    return ranks;
}

function spearman(left: readonly number[], right: readonly number[]): number | null {
    if (left.length !== right.length || left.length < 2) return null;
    const leftRanks = rank(left);
    const rightRanks = rank(right);
    const leftMean = mean(leftRanks);
    const rightMean = mean(rightRanks);
    let covariance = 0;
    let leftVariance = 0;
    let rightVariance = 0;
    for (let index = 0; index < left.length; index += 1) {
        const leftDelta = leftRanks[index]! - leftMean;
        const rightDelta = rightRanks[index]! - rightMean;
        covariance += leftDelta * rightDelta;
        leftVariance += leftDelta ** 2;
        rightVariance += rightDelta ** 2;
    }
    if (leftVariance === 0 || rightVariance === 0) return null;
    return covariance / Math.sqrt(leftVariance * rightVariance);
}

function parsePairSummaryBlocks(text: string, holdoutBars: number): PairSummaryBlock[] {
    const blocks: PairSummaryBlock[] = [];
    for (const match of text.matchAll(PAIR_SUMMARY_BLOCK_PATTERN)) {
        try {
            const rows = JSON.parse(match[4]!) as unknown;
            if (!Array.isArray(rows)) continue;
            blocks.push({
                timestamp: match[1]!,
                batchRunId: match[2]!,
                holdoutBars,
                rows: rows as PairSummaryRow[],
            });
        } catch {
            // Ignore a partially-written or manually edited block.
        }
    }
    return blocks;
}

function parseHoldoutBlocks(text: string, holdoutBars: number): HoldoutBlock[] {
    const blocks: HoldoutBlock[] = [];
    for (const match of text.matchAll(HOLDOUT_BLOCK_PATTERN)) {
        try {
            const rows = JSON.parse(match[6]!) as unknown;
            if (!Array.isArray(rows)) continue;
            blocks.push({
                timestamp: match[1]!,
                batchRunId: match[2]!,
                holdoutBars,
                sortMetric: match[4]!,
                rows: rows as HoldoutRow[],
            });
        } catch {
            // Ignore a partially-written or manually edited block.
        }
    }
    return blocks;
}

function selectLatestBatch<T extends { batchRunId: string; timestamp: string }>(blocks: T[]): T[] {
    const byRun = new Map<string, { blocks: T[]; latest: string }>();
    for (const block of blocks) {
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
    return selected?.blocks ?? [];
}

function dedupePairSummaryBlocks(blocks: PairSummaryBlock[]): PairSummaryBlock[] {
    const deduped = new Map<number, PairSummaryBlock>();
    for (const block of blocks) {
        const previous = deduped.get(block.holdoutBars);
        if (!previous || block.timestamp.localeCompare(previous.timestamp) >= 0) deduped.set(block.holdoutBars, block);
    }
    return [...deduped.values()].sort((left, right) => left.holdoutBars - right.holdoutBars);
}

function loadPairSummaryBlocks(archiveDirectory: string): PairSummaryBlock[] {
    if (!fs.existsSync(archiveDirectory)) return [];
    const files = fs.readdirSync(archiveDirectory)
        .map((file) => ({ file, match: file.match(PAIR_SUMMARY_FILE_PATTERN) }))
        .filter((entry): entry is { file: string; match: RegExpMatchArray } => entry.match !== null)
        .map((entry) => ({ holdoutBars: Number(entry.match[1]), file: entry.file }))
        .sort((left, right) => left.holdoutBars - right.holdoutBars || left.file.localeCompare(right.file));
    const parsed = files.flatMap((entry) => parsePairSummaryBlocks(
        fs.readFileSync(path.join(archiveDirectory, entry.file), "utf8"),
        entry.holdoutBars,
    ));
    return dedupePairSummaryBlocks(selectLatestBatch(parsed));
}

function loadReferenceBlocks(archiveDirectory: string, batchRunId: string): HoldoutBlock[] {
    if (!fs.existsSync(archiveDirectory)) return [];
    const files = fs.readdirSync(archiveDirectory)
        .map((file) => ({ file, match: file.match(HOLDOUT_FILE_PATTERN) }))
        .filter((entry): entry is { file: string; match: RegExpMatchArray } => entry.match !== null)
        .map((entry) => ({ holdoutBars: Number(entry.match[1]), file: entry.file }));
    const parsed = files.flatMap((entry) => parseHoldoutBlocks(
        fs.readFileSync(path.join(archiveDirectory, entry.file), "utf8"),
        entry.holdoutBars,
    )).filter((block) => block.batchRunId === batchRunId);
    const deduped = new Map<string, HoldoutBlock>();
    for (const block of parsed) {
        const key = `${block.holdoutBars}|${block.sortMetric}`;
        const previous = deduped.get(key);
        if (!previous || block.timestamp.localeCompare(previous.timestamp) >= 0) deduped.set(key, block);
    }
    return [...deduped.values()].sort((left, right) =>
        left.holdoutBars - right.holdoutBars || left.sortMetric.localeCompare(right.sortMetric),
    );
}

function filterHoldoutsByStride(holdouts: readonly number[], stride: number): Set<number> {
    const kept = new Set<number>();
    let nextTarget = Number.NEGATIVE_INFINITY;
    for (const holdout of holdouts) {
        if (holdout >= nextTarget) {
            kept.add(holdout);
            nextTarget = holdout + stride;
        }
    }
    return kept;
}

function targetForRow(row: PairSummaryRow, horizon: number): number | null {
    const value = row.forwardPnlPercentByHorizon?.[String(horizon)];
    return finiteNumber(value) ? value : null;
}

function predictorValue(row: PairSummaryRow, predictor: Predictor): number | null {
    const value = row[predictor];
    return finiteNumber(value) ? value : null;
}

function computeIc(
    blocks: readonly PairSummaryBlock[],
    horizon: number,
): Map<Predictor, WindowValue[]> {
    const samples = new Map<Predictor, WindowValue[]>();
    for (const predictor of PREDICTORS) samples.set(predictor, []);
    for (const block of blocks) {
        for (const predictor of PREDICTORS) {
            const predictorValues: number[] = [];
            const targetValues: number[] = [];
            for (const row of block.rows) {
                const predictorValueForRow = predictorValue(row, predictor);
                const target = targetForRow(row, horizon);
                if (predictorValueForRow === null || target === null) continue;
                predictorValues.push(predictorValueForRow);
                targetValues.push(target);
            }
            const correlation = spearman(predictorValues, targetValues);
            if (correlation !== null) samples.get(predictor)!.push({ holdoutBars: block.holdoutBars, value: correlation });
        }
    }
    return samples;
}

function computeTimeBlockSplit(samples: Map<Predictor, WindowValue[]>): Record<Predictor, {
    firstHalf: SummaryStats;
    secondHalf: SummaryStats;
    stableBothPositive: boolean;
}> {
    return Object.fromEntries(PREDICTORS.map((predictor) => {
        const values = samples.get(predictor)!.map((sample) => sample.value);
        const midpoint = Math.ceil(values.length / 2);
        const firstHalf = summarize(values.slice(0, midpoint));
        const secondHalf = summarize(values.slice(midpoint));
        return [predictor, {
            firstHalf,
            secondHalf,
            stableBothPositive: firstHalf.mean > 0 && secondHalf.mean > 0,
        }];
    })) as Record<Predictor, {
        firstHalf: SummaryStats;
        secondHalf: SummaryStats;
        stableBothPositive: boolean;
    }>;
}

function computeIncrement(
    pairBlocks: readonly PairSummaryBlock[],
    referenceBlocks: readonly HoldoutBlock[],
    horizon: number,
): Record<Predictor, {
    windows: number;
    gatedWindows: number;
    ungatedMean: number;
    gatedMean: number;
    delta: number;
    gateRate: number;
}> {
    const referenceByHoldout = new Map<number, HoldoutBlock>();
    for (const block of referenceBlocks) {
        if (block.sortMetric === "profitFactor") referenceByHoldout.set(block.holdoutBars, block);
    }
    const samples = new Map<Predictor, IncrementSample[]>();
    for (const predictor of PREDICTORS) samples.set(predictor, []);

    for (const block of pairBlocks) {
        const reference = referenceByHoldout.get(block.holdoutBars);
        const topOne = reference?.rows.find((row) => row.rank === 1);
        const selected = topOne?.symbol ? block.rows.find((row) => row.symbol === topOne.symbol) : undefined;
        const target = selected ? targetForRow(selected, horizon) : null;
        if (target === null) continue;
        for (const predictor of PREDICTORS) {
            const values = block.rows
                .map((row) => predictorValue(row, predictor))
                .filter((value): value is number => value !== null);
            const selectedPredictor = selected ? predictorValue(selected, predictor) : null;
            if (selectedPredictor === null || values.length === 0) continue;
            samples.get(predictor)!.push({ target, predictor: selectedPredictor, median: median(values) });
        }
    }

    return Object.fromEntries(PREDICTORS.map((predictor) => {
        const predictorSamples = samples.get(predictor)!;
        const ungatedValues = predictorSamples.map((sample) => sample.target);
        const gatedValues = predictorSamples
            .filter((sample) => sample.predictor >= sample.median)
            .map((sample) => sample.target);
        const ungatedMean = mean(ungatedValues);
        const gatedMean = mean(gatedValues);
        return [predictor, {
            windows: ungatedValues.length,
            gatedWindows: gatedValues.length,
            ungatedMean,
            gatedMean,
            delta: gatedMean - ungatedMean,
            gateRate: ungatedValues.length > 0 ? gatedValues.length / ungatedValues.length : Number.NaN,
        }];
    })) as Record<Predictor, {
        windows: number;
        gatedWindows: number;
        ungatedMean: number;
        gatedMean: number;
        delta: number;
        gateRate: number;
    }>;
}

function computeBreadthSeries(
    blocks: readonly PairSummaryBlock[],
): Array<{ holdoutBars: number; breadth: number | null; symbols: number }> {
    return blocks.map((block) => {
        const values = block.rows.map((row) => row.profitableShare).filter(finiteNumber);
        return {
            holdoutBars: block.holdoutBars,
            breadth: values.length > 0 ? mean(values) : null,
            symbols: values.length,
        };
    });
}

function formatNumber(value: number): string {
    return finiteNumber(value) ? value.toFixed(4) : "n/a";
}

function formatRate(value: number): string {
    return finiteNumber(value) ? `${(value * 100).toFixed(1)}%` : "n/a";
}

function buildInsufficientDataReport(archiveDirectory: string, reason: string): { report: string; json: Record<string, unknown> } {
    const report = [
        "Asset Opportunity Pair Summary Analysis",
        "=========================================",
        `Archive: ${archiveDirectory}`,
        "INSUFFICIENT DATA",
        reason,
    ].join("\n");
    return { report, json: { archiveDirectory, status: "INSUFFICIENT_DATA", reason } };
}

function main(): void {
    const argv = process.argv.slice(2);
    const archiveDirectory = getArgument(argv, "--archive-dir")
        ?? path.resolve(__dirname, "..", "archive", "asset opportunity");
    const strideBars = Math.max(1, Math.floor(Number(getArgument(argv, "--stride-bars") ?? 12) || 12));
    const horizon = Math.max(1, Math.floor(Number(getArgument(argv, "--horizon") ?? 12) || 12));
    const outputPrefix = getArgument(argv, "--output-prefix");
    const allPairBlocks = loadPairSummaryBlocks(archiveDirectory);
    if (allPairBlocks.length === 0) {
        const insufficient = buildInsufficientDataReport(
            archiveDirectory,
            "No oos-pair-summary-<N>-bars.txt blocks were found for a completed batch run.",
        );
        console.log(insufficient.report);
        if (outputPrefix) {
            fs.writeFileSync(`${outputPrefix}.txt`, `${insufficient.report}\n`);
            fs.writeFileSync(`${outputPrefix}.json`, `${JSON.stringify(insufficient.json, null, 2)}\n`);
        }
        return;
    }

    const allHoldouts = [...new Set(allPairBlocks.map((block) => block.holdoutBars))].sort((left, right) => left - right);
    const allowedHoldouts = filterHoldoutsByStride(allHoldouts, strideBars);
    const pairBlocks = allPairBlocks.filter((block) => allowedHoldouts.has(block.holdoutBars));
    const batchRunId = pairBlocks[0]?.batchRunId ?? allPairBlocks[0]!.batchRunId;
    const icSamples = computeIc(pairBlocks, horizon);
    const ic = Object.fromEntries(PREDICTORS.map((predictor) => [predictor, summarize(icSamples.get(predictor)!.map((sample) => sample.value))])) as Record<Predictor, SummaryStats>;
    const timeBlockSplit = computeTimeBlockSplit(icSamples);
    const referenceBlocks = loadReferenceBlocks(archiveDirectory, batchRunId);
    const increment = computeIncrement(pairBlocks, referenceBlocks, horizon);
    const breadthSeries = computeBreadthSeries(pairBlocks);

    const json: Record<string, unknown> = {
        archiveDirectory,
        batchRunId,
        files: pairBlocks.length,
        allFiles: allPairBlocks.length,
        strideBars,
        horizon,
        predictors: [...PREDICTORS],
        referenceSort: "profitFactor",
        ic,
        timeBlockSplit,
        increment,
        breadthSeries,
    };
    const lines: string[] = [
        "Asset Opportunity Pair Summary Analysis",
        "========================================",
        `Batch run: ${batchRunId} | files: ${pairBlocks.length} of ${allPairBlocks.length}`,
        `Stride: ${strideBars} bars (disjoint holdout selection) | horizon: ${horizon} bars`,
        "Forward PnL is the pair-level mean across the full candidate pool; it is never a predictor.",
        "",
        "PREDICTOR IC (Spearman across symbols per holdout)",
        "Predictor | Windows | Mean IC | SE | t | % windows positive",
    ];
    for (const predictor of PREDICTORS) {
        const stats = ic[predictor];
        lines.push([predictor, String(stats.windows), formatNumber(stats.mean), formatNumber(stats.standardError), formatNumber(stats.t), formatRate(stats.positiveRate)].join(" | "));
    }
    lines.push("", "TIME-BLOCK SIGN CHECK (chronological halves)", "Predictor | First-half mean | Second-half mean | Stable both positive");
    for (const predictor of PREDICTORS) {
        const split = timeBlockSplit[predictor];
        lines.push([predictor, formatNumber(split.firstHalf.mean), formatNumber(split.secondHalf.mean), split.stableBothPositive ? "YES" : "NO"].join(" | "));
    }
    lines.push("", "INCREMENT TEST (profitFactor top-1, gated at each window's predictor median)", "Predictor | Windows | Gated | Ungated mean % | Gated mean % | Delta % | Gate rate");
    for (const predictor of PREDICTORS) {
        const row = increment[predictor];
        lines.push([predictor, String(row.windows), String(row.gatedWindows), formatNumber(row.ungatedMean), formatNumber(row.gatedMean), formatNumber(row.delta), formatRate(row.gateRate)].join(" | "));
    }
    lines.push("", "REGIME MONITOR (pool mean profitableShare)", "Holdout bars | Breadth | Symbols");
    for (const row of breadthSeries) lines.push([String(row.holdoutBars), row.breadth === null ? "n/a" : formatRate(row.breadth), String(row.symbols)].join(" | "));

    const report = lines.join("\n");
    console.log(report);
    if (outputPrefix) {
        fs.writeFileSync(`${outputPrefix}.txt`, `${report}\n`);
        fs.writeFileSync(`${outputPrefix}.json`, `${JSON.stringify(json, null, 2)}\n`);
        console.log(`\nReports written to:\n  ${outputPrefix}.txt\n  ${outputPrefix}.json`);
    }
}

main();
