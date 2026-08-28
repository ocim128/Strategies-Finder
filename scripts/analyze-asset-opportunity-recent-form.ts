/**
 * Recent-form sort test for Asset Opportunity holdout archives.
 *
 * Operator idea (2026-08-17): rank candidates by RECENT performance (their last
 * few trades) instead of full-window aggregates, so the top-1 can change with
 * recent form — but robustly.
 *
 * Design notes:
 *   - Literal "last 5 trades" is a noise trap (5-trade samples rank luck across
 *     thousands of candidates) and is not computable from persisted aggregates.
 *   - Calendar-aligned recency IS computable offline: file holdout=N searched
 *     data ending N bars before dataset end; file holdout=N+W ended W bars
 *     earlier. For a candidate present in BOTH files,
 *       marginalAvgTrade = (netProfit_N - netProfit_{N+W}) / (trades_N - trades_{N+W})
 *     is its average PnL on exactly the last W bars of file N's search window.
 *   - Sorts tested: recent_margin{W} (pure recent form) and recent_blend{W}
 *     (0.5 * full avgTrade + 0.5 * marginal), W in {30, 60} bars (~10/20 days).
 *   - OVERTURN section: how often the recent sort's #1 disagrees with the
 *     averageGain block's #1 in the same file, and whether the disagreement is
 *     RIGHT (forward PnL of the recent pick minus the averageGain pick).
 *
 * Same pre-stated verdicts as the sibling tools: STABLE+ = boot p5>0 AND >=60%
 * files positive; WEAK+ = boot p50>0 AND >=55%; else UNSTABLE. Overlapping
 * holdouts => stability indicators, not p-values.
 *
 * Usage:
 *   esno scripts/analyze-asset-opportunity-recent-form.ts \
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
const MIN_MARGINAL_TRADES = 3;
const MARGINAL_WINDOWS = [30, 60];

interface Performance {
    netProfit?: number | null;
    avgTrade?: number | null;
    totalTrades?: number | null;
}

interface Row {
    symbol?: string;
    strategyId?: string;
    candidateFingerprint?: string;
    selectionPerformance?: Performance | null;
    forwardOosPerformance?: {
        horizons?: Array<{ bars: number; pnlPercent?: number | null; sampleSize?: number | null }>;
    } | null;
}

interface FileData {
    holdoutBars: number;
    timestamp: string;
    batchRunId: string;
    baselineByHorizon: Map<number, number>;
    candidates: Map<string, Row>;
    averageGainRank1: Row | null;
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

function candidateKey(row: Row): string | null {
    if (!row.symbol) return null;
    return `${row.symbol}|${row.strategyId ?? ""}|${row.candidateFingerprint ?? ""}`;
}

function forwardPnl(row: Row, horizonBars: number): number | null {
    const horizon = row.forwardOosPerformance?.horizons?.find((entry) => entry.bars === horizonBars);
    if (horizon && typeof horizon.pnlPercent === "number" && (horizon.sampleSize ?? 1) > 0) return horizon.pnlPercent;
    return null;
}

function loadFiles(archiveDirectory: string): FileData[] {
    const entries = fs.readdirSync(archiveDirectory)
        .map((file) => ({ file, match: file.match(ARCHIVE_FILE_PATTERN) }))
        .filter((entry): entry is { file: string; match: RegExpMatchArray } => entry.match !== null)
        .map((entry) => ({ bars: Number(entry.match[1]), file: entry.file }))
        .sort((left, right) => left.bars - right.bars);
    if (entries.length === 0) throw new Error(`No oos-holdout-<N>-bars.txt files found in ${archiveDirectory}`);
    const parsed = entries.map((entry) => {
        const text = fs.readFileSync(path.join(archiveDirectory, entry.file), "utf8");
        const baselineByHorizon = new Map<number, number>();
        const candidates = new Map<string, Row>();
        let averageGainRank1: Row | null = null;
        let timestamp = "";
        let batchRunId = "";
        for (const match of text.matchAll(BLOCK_PATTERN)) {
            timestamp = match[1]!;
            batchRunId = match[2]!;
            const sortName = match[4]!;
            if (match[6] && baselineByHorizon.size === 0) {
                try {
                    const baseline = JSON.parse(match[6]) as { horizons?: Array<{ bars: number; averagePnlPercent?: number | null }> };
                    for (const horizon of baseline.horizons ?? []) {
                        if (typeof horizon.averagePnlPercent === "number") baselineByHorizon.set(horizon.bars, horizon.averagePnlPercent);
                    }
                } catch {
                    // Baseline parse failure: skipped downstream per-cell.
                }
            }
            let rows: Row[] = [];
            try {
                rows = JSON.parse(match[8]!) as Row[];
            } catch {
                continue;
            }
            for (const row of rows) {
                const key = candidateKey(row);
                if (!key) continue;
                if (!candidates.has(key)) candidates.set(key, row);
                if (sortName === "averageGain" && (averageGainRank1 === null || entry === undefined)) {
                    // Keep the first averageGain rank-1 row seen in this file.
                    if (typeof (rows[0] as { rank?: number } | undefined)?.rank === "number") {
                        // rows are stored rank-ordered; rank 1 is the first element.
                        if (averageGainRank1 === null) averageGainRank1 = rows[0] ?? null;
                    }
                }
            }
        }
        return { holdoutBars: entry.bars, timestamp, batchRunId, baselineByHorizon, candidates, averageGainRank1 };
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

function marginalAvgTrade(current: Row, partner: Row): { value: number; trades: number } | null {
    const currentNet = current.selectionPerformance?.netProfit;
    const partnerNet = partner.selectionPerformance?.netProfit;
    const currentTrades = current.selectionPerformance?.totalTrades;
    const partnerTrades = partner.selectionPerformance?.totalTrades;
    if (typeof currentNet !== "number" || typeof partnerNet !== "number") return null;
    if (typeof currentTrades !== "number" || typeof partnerTrades !== "number") return null;
    const tradeDiff = currentTrades - partnerTrades;
    if (tradeDiff < MIN_MARGINAL_TRADES) return null;
    return { value: (currentNet - partnerNet) / tradeDiff, trades: tradeDiff };
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
    const outputPrefix = getArgument(argv, "--output-prefix");

    const minHoldoutBars = Math.floor(Number(getArgument(argv, "--min-holdout") ?? 0) || 0);
    const maxHoldoutBars = Math.floor(Number(getArgument(argv, "--max-holdout") ?? Number.POSITIVE_INFINITY) || Number.POSITIVE_INFINITY);
    const files = loadFiles(archiveDirectory).filter((file) => file.holdoutBars >= minHoldoutBars && file.holdoutBars <= maxHoldoutBars);
    const filesByBars = new Map(files.map((file) => [file.holdoutBars, file]));
    const horizons = [...new Set(files.flatMap((file) => [...file.baselineByHorizon.keys()]))].sort((left, right) => left - right);
    const horizonFallback = horizons[0] ?? 12;
    const primaryHorizon = Math.max(1, Math.floor(Number(getArgument(argv, "--horizon") ?? horizonFallback) || horizonFallback));

    const rng = createRng(seed);
    const lines: string[] = [];
    lines.push("Asset Opportunity Recent-Form Sort Stability");
    lines.push("=============================================");
    lines.push(`Batch run: ${files[0]?.batchRunId} | files: ${files.length} | horizon: ${primaryHorizon} bars | top-K: ${topKList.join("/")}`);
    lines.push(`Recent form = marginal avgTrade over the last W bars, from cross-file differencing (holdout N vs N+W).`);
    lines.push(`Marginal trade floor: ${MIN_MARGINAL_TRADES}. Same pre-stated verdicts (STABLE+/WEAK+/UNSTABLE). Overlap caveat applies.`);
    lines.push("");
    lines.push(`RECENT-FORM SORT STABILITY (horizon ${primaryHorizon} bars)`);
    lines.push("Sort | K | Files | Mean | %Files+ | Boot p5 | Boot p50 | Boot p95 | Boot %+ | Verdict");

    const json: Record<string, unknown> = { archiveDirectory, batchRunId: files[0]?.batchRunId, cells: [] as Array<Record<string, unknown>>, overturn: {} };

    const emitCell = (sortName: string, topK: number, deltas: number[]): void => {
        if (deltas.length === 0) return;
        const means: number[] = [];
        const size = Math.min(sampleSize, deltas.length);
        for (let index = 0; index < iterations; index += 1) {
            let sum = 0;
            for (let draw = 0; draw < size; draw += 1) sum += deltas[Math.floor(rng() * deltas.length)]!;
            means.push(sum / size);
        }
        const boot = { p5: percentile(means, 0.05), p50: percentile(means, 0.5), p95: percentile(means, 0.95), positiveRate: means.filter((value) => value > 0).length / means.length };
        const signStability = deltas.filter((value) => value > 0).length / deltas.length;
        const verdict = boot.p5 > 0 && signStability >= 0.6 ? "STABLE+" : boot.p50 > 0 && signStability >= 0.55 ? "WEAK+" : "UNSTABLE";
        lines.push([sortName, String(topK), String(deltas.length), formatDelta(mean(deltas)), formatRate(signStability), formatDelta(boot.p5), formatDelta(boot.p50), formatDelta(boot.p95), formatRate(boot.positiveRate), verdict].join(" | "));
        (json.cells as Array<Record<string, unknown>>).push({ sort: sortName, topK, files: deltas.length, mean: mean(deltas), signStability, bootstrap: boot, verdict });
    };

    // Per (window, sort-variant, K): delta per file where enough qualifying candidates exist.
    const overturnStats = { disagreements: 0, recentWins: 0, deltas: [] as number[] };
    for (const window of MARGINAL_WINDOWS) {
        for (const variant of ["margin", "blend"] as const) {
            for (const topK of topKList) {
                const deltas: number[] = [];
                for (const file of files) {
                    const partner = filesByBars.get(file.holdoutBars + window);
                    const baseline = file.baselineByHorizon.get(primaryHorizon);
                    if (!partner || baseline === undefined) continue;
                    const qualified: Array<{ row: Row; score: number; forward: number }> = [];
                    for (const [key, row] of file.candidates) {
                        const partnerRow = partner.candidates.get(key);
                        if (!partnerRow) continue;
                        const marginal = marginalAvgTrade(row, partnerRow);
                        if (!marginal) continue;
                        const full = row.selectionPerformance?.avgTrade;
                        const score = variant === "margin"
                            ? marginal.value
                            : 0.5 * (typeof full === "number" ? full : marginal.value) + 0.5 * marginal.value;
                        const forward = forwardPnl(row, primaryHorizon);
                        if (forward === null) continue;
                        qualified.push({ row, score, forward });
                    }
                    if (qualified.length === 0) continue;
                    qualified.sort((left, right) => right.score - left.score);
                    const picks = qualified.slice(0, topK);
                    deltas.push(mean(picks.map((pick) => pick.forward)) - baseline);
                    if (window === MARGINAL_WINDOWS[0] && variant === "margin" && topK === 1) {
                        const averageGainPick = file.averageGainRank1;
                        const recentPick = picks[0]!;
                        const averageGainForward = averageGainPick ? forwardPnl(averageGainPick, primaryHorizon) : null;
                        if (averageGainForward !== null && recentPick.row.symbol !== averageGainPick?.symbol) {
                            overturnStats.disagreements += 1;
                            const delta = recentPick.forward - averageGainForward;
                            overturnStats.deltas.push(delta);
                            if (delta > 0) overturnStats.recentWins += 1;
                        }
                    }
                }
                emitCell(`recent_${variant}${window}`, topK, deltas);
            }
        }
    }

    lines.push("");
    lines.push(`OVERTURN TEST (recent_margin${MARGINAL_WINDOWS[0]}, top-1 vs averageGain top-1, horizon ${primaryHorizon} bars)`);
    if (overturnStats.disagreements === 0) {
        lines.push("No disagreements observed (recent sort agrees with averageGain #1 everywhere it qualified).");
    } else {
        lines.push(`Disagreements: ${overturnStats.disagreements} files | recent pick better in ${overturnStats.recentWins} (${formatRate(overturnStats.recentWins / overturnStats.disagreements)})`);
        lines.push(`Mean forward delta (recent pick - averageGain pick) on disagreements: ${formatDelta(mean(overturnStats.deltas))}`);
    }

    if (argv.includes("--picks")) {
        const picksWindow = MARGINAL_WINDOWS[MARGINAL_WINDOWS.length - 1]!;
        const file = files.find((candidate) => filesByBars.has(candidate.holdoutBars + picksWindow)) ?? files[0]!;
        const partner = filesByBars.get(file.holdoutBars + picksWindow);
        lines.push("", `PICKS — recent_margin${picksWindow} on freshest qualifying search (holdout ${file.holdoutBars} bars)`);
        if (partner) {
            const qualified: Array<{ row: Row; score: number }> = [];
            for (const [key, row] of file.candidates) {
                const partnerRow = partner.candidates.get(key);
                if (!partnerRow) continue;
                const marginal = marginalAvgTrade(row, partnerRow);
                if (!marginal) continue;
                const forward = forwardPnl(row, primaryHorizon);
                if (forward === null) continue;
                qualified.push({ row, score: marginal.value });
            }
            qualified.sort((left, right) => right.score - left.score);
            const picks = qualified.slice(0, 3).map((item) => `${item.row.symbol} [${formatDelta(forwardPnl(item.row, primaryHorizon) ?? Number.NaN)}]`);
            lines.push(`recent_margin${picksWindow} top-3: ${picks.length > 0 ? picks.join(", ") : "n/a"}`);
        } else {
            lines.push("No partner file available for the marginal window.");
        }
        lines.push(`averageGain top-1 (app view): ${file.averageGainRank1?.symbol ?? "n/a"}`);
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
