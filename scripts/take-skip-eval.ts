/* Take/skip evaluation — standalone, reads L2 ledger JSONL directly. No checker/campaign dependencies. */
import { createReadStream, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import readline from "node:readline";

const DEFAULT_LEDGER_DIR = "archive/batch-open-score/sp500_top_mean_1788560534200_jedw";
const REPORT_BLOCK_COUNT = 10;

function fnv1a64(text: string): string {
    let h = BigInt("0xcbf29ce484222325");
    for (let i = 0; i < text.length; i++) {
        h ^= BigInt(text.charCodeAt(i));
        h = (h * BigInt("0x100000001b3")) & BigInt("0xFFFFFFFFFFFFFFFF");
    }
    return h.toString(16).padStart(16, "0");
}

function tieDigest(t: number, asset: string): string {
    return fnv1a64(`max_active_tie_v1|1|${Math.trunc(t)}|${asset}`);
}

interface Snap {
    eventId: string;
    decisionTimeSec: number;
    asset: string;
    signedVotes: number;
    activePairCount: number;
    longEligible: boolean;
    ema200Above: boolean;
    breadth: number | null;
    regime: string;
}

interface Outcome {
    eventId: string;
    asset: string;
    horizonBars: number;
    direction: string;
    eligible: boolean;
    status: string;
    return: number;
    entryTimeSec: number;
    exitTimeSec: number;
}

export interface EvalEvent {
    t: number;
    eventId: string;
    inc: Snap;
    incReturn: number;
    candidates: Snap[];
}

interface GateContext {
    S1: number;
    S2: number | null;
    C: number;
    B: number | null;
    tieCount: number;
    assetHist: number[];
    globalHist: number[];
}

interface GateDefinition {
    name: string;
    reportLabel?: string;
    check: (context: GateContext) => boolean;
}

export interface GateEvaluation {
    name: string;
    reportLabel: string | null;
    taken: number;
    skipped: number;
    takenSum: number;
    allSum: number;
    positiveBlocks: number;
}

const gates: GateDefinition[] = [
    { name: "score_floor_075", check: (c) => c.S1 >= 0.75 },
    { name: "coverage_floor_41", check: (c) => c.C >= 41 },
    { name: "score_margin_0025", check: (c) => c.S2 === null ? true : c.S1 - c.S2 >= 0.025 },
    { name: "unique_score_winner", check: (c) => c.tieCount === 1 },
    { name: "bullish_breadth_only", check: (c) => c.B !== null && c.B >= 0.50 },
    { name: "breadth_euphoria_cap_078", check: (c) => c.B === null ? true : c.B <= 0.78 },
    { name: "bear_coverage_confirmation_48", check: (c) => c.B === null ? c.C >= 48 : (c.B >= 0.50 ? true : c.C >= 48) },
    { name: "same_asset_two_loss_veto", reportLabel: "LOSS_VETO", check: (c) => {
        const h = c.assetHist;
        return h.length < 2 ? true : !(h[h.length - 1] < 0 && h[h.length - 2] < 0);
    } },
    { name: "global_return_regime_10", reportLabel: "REGIME_FLOOR", check: (c) =>
        c.globalHist.length < 10 ? true : c.globalHist.slice(-10).reduce((a, b) => a + b, 0) / 10 >= 0 },
    { name: "global_volatility_cap_10pct", check: (c) => c.globalHist.length < 20 ? true :
        Math.sqrt(c.globalHist.slice(-20).reduce((s, v) => s + v * v, 0) / 20 -
            Math.pow(c.globalHist.slice(-20).reduce((a, b) => a + b, 0) / 20, 2)) <= 0.10 },
];

/** Count positive means across the fixed ten chronological count-balanced blocks. */
export function countPositiveDeltaBlocks(deltas: readonly number[]): number {
    let positiveBlocks = 0;
    for (let block = 0; block < REPORT_BLOCK_COUNT; block += 1) {
        const start = Math.floor((block * deltas.length) / REPORT_BLOCK_COUNT);
        const end = Math.floor(((block + 1) * deltas.length) / REPORT_BLOCK_COUNT);
        if (end <= start) continue;
        const mean = deltas.slice(start, end).reduce((sum, value) => sum + value, 0) / (end - start);
        if (mean > 0) positiveBlocks += 1;
    }
    return positiveBlocks;
}

function sortEvents(events: readonly EvalEvent[]): EvalEvent[] {
    return [...events].sort((a, b) => a.t - b.t || a.eventId.localeCompare(b.eventId));
}

/** Evaluate the ten frozen diagnostic gates in their established order. */
export function evaluateGates(events: readonly EvalEvent[]): GateEvaluation[] {
    const orderedEvents = sortEvents(events);
    const assetReturns = new Map<string, number[]>();
    const globalReturns: number[] = [];
    const gateResults: GateEvaluation[] = gates.map((gate) => ({
        name: gate.name,
        reportLabel: gate.reportLabel ?? null,
        taken: 0,
        skipped: 0,
        takenSum: 0,
        allSum: 0,
        positiveBlocks: 0,
    }));
    const deltaSeries = gates.map(() => [] as number[]);

    for (const event of orderedEvents) {
        const allScores = event.candidates
            .filter((candidate) => candidate.longEligible && candidate.activePairCount > 0)
            .map((candidate) => candidate.signedVotes / candidate.activePairCount)
            .filter((score) => Number.isFinite(score) && score > 0)
            .sort((a, b) => b - a);
        const S1 = allScores[0] ?? 0;
        const S2 = allScores[1] ?? null;
        const C = event.inc.activePairCount;
        const B = event.inc.breadth;
        const tieCount = allScores.filter((score) => score === allScores[0]).length;
        const assetKey = event.inc.asset;
        const assetHist = assetReturns.get(assetKey) ?? [];
        const globalHist = [...globalReturns];
        const context = { S1, S2, C, B, tieCount, assetHist, globalHist };

        // Preserve the proven diagnostic update order and gate semantics.
        globalReturns.push(event.incReturn);
        if (!assetReturns.has(assetKey)) assetReturns.set(assetKey, []);
        assetReturns.get(assetKey)!.push(event.incReturn);

        for (let gateIndex = 0; gateIndex < gates.length; gateIndex += 1) {
            const take = gates[gateIndex]!.check(context);
            const result = gateResults[gateIndex]!;
            result.allSum += event.incReturn;
            deltaSeries[gateIndex]!.push(take ? 0 : -event.incReturn);
            if (take) {
                result.taken += 1;
                result.takenSum += event.incReturn;
            } else {
                result.skipped += 1;
            }
        }
    }

    for (let gateIndex = 0; gateIndex < gateResults.length; gateIndex += 1) {
        gateResults[gateIndex]!.positiveBlocks = countPositiveDeltaBlocks(deltaSeries[gateIndex]!);
    }
    return gateResults;
}

/** The two accepted gates formatted for insertion into an OPEN_SCORE report. */
export function buildTakeSkipReportLines(evaluations: readonly GateEvaluation[]): string[] {
    return evaluations
        .filter((evaluation) => evaluation.reportLabel !== null)
        .map(formatTakeSkipReportLine);
}

function formatSigned(value: number | null, suffix: "%" | "pp"): string {
    if (value === null || !Number.isFinite(value)) return "n/a";
    const rounded = Number((value * 100).toFixed(2));
    const normalized = Object.is(rounded, -0) ? 0 : rounded;
    return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(2)}${suffix}`;
}

export function formatTakeSkipReportLine(evaluation: GateEvaluation): string {
    if (evaluation.reportLabel === null) {
        throw new Error(`Gate ${evaluation.name} has no report label.`);
    }
    const total = evaluation.taken + evaluation.skipped;
    const top = evaluation.taken > 0 ? evaluation.takenSum / evaluation.taken : null;
    const all = total > 0 ? evaluation.allSum / total : null;
    return `${evaluation.reportLabel.padEnd(12)} n=${evaluation.taken} ` +
        `top=${formatSigned(top, "%")} all=${formatSigned(all, "%")} ` +
        `skip=${formatSigned(evaluation.takenSum - evaluation.allSum, "pp")} ` +
        `+blocks=${evaluation.positiveBlocks}/${REPORT_BLOCK_COUNT}`;
}

function isTakeSkipLine(line: string): boolean {
    return /^(?:LOSS_VETO|REGIME_FLOOR)(?:\s|$)/.test(line);
}

/** Insert formatted lines into the first full-window horizon-24 report block. */
export function augmentReportWithTakeSkipLines(reportText: string, insertionLines: readonly string[]): string {
    const newline = reportText.includes("\r\n") ? "\r\n" : "\n";
    const lines = reportText.split(/\r\n|\n/);
    if (lines.some(isTakeSkipLine)) {
        throw new Error("Cannot augment report: LOSS_VETO or REGIME_FLOOR lines already exist.");
    }

    const annualStart = lines.findIndex((line) => line.startsWith("================ OPEN_SCORE USD | CALENDAR YEAR"));
    const fullReportEnd = annualStart === -1 ? lines.length : annualStart;
    const horizonStart = lines.findIndex((line, index) =>
        index < fullReportEnd && /^--- horizon 24 bar\(s\) \|/.test(line));
    if (horizonStart === -1) {
        throw new Error("Cannot augment report: first full-report horizon-24 block is missing.");
    }
    const nextHorizon = lines.findIndex((line, index) =>
        index > horizonStart && index < fullReportEnd && /^--- horizon \d+ bar\(s\) \|/.test(line));
    const horizonEnd = nextHorizon === -1 ? fullReportEnd : nextHorizon;
    const topMeanIndexes = lines
        .map((line, index) => ({ line, index }))
        .filter(({ line, index }) => index > horizonStart && index < horizonEnd && /^TOP_MEAN\s+n=/.test(line))
        .map(({ index }) => index);
    if (topMeanIndexes.length === 0) {
        throw new Error("Cannot augment report: TOP_MEAN line is missing from the first horizon-24 block.");
    }
    if (topMeanIndexes.length > 1) {
        throw new Error("Cannot augment report: TOP_MEAN line is ambiguous in the first horizon-24 block.");
    }
    lines.splice(topMeanIndexes[0]! + 1, 0, ...insertionLines);
    return lines.join(newline);
}

async function readJsonl<T>(filePath: string): Promise<T[]> {
    const rows: T[] = [];
    const rl = readline.createInterface({ input: createReadStream(filePath), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line.trim()) continue;
        rows.push(JSON.parse(line) as T);
    }
    return rows;
}

async function loadEvalEvents(dir: string): Promise<EvalEvent[]> {
    const snaps = await readJsonl<Snap>(path.join(dir, "pool-snapshots.jsonl"));
    const outcomes = new Map<string, Outcome>();
    for (const outcome of await readJsonl<Outcome>(path.join(dir, "candidate-outcomes.jsonl"))) {
        if (outcome.horizonBars === 24 && outcome.direction === "long") {
            outcomes.set(`${outcome.eventId}|${outcome.asset}`, outcome);
        }
    }

    const eventMap = new Map<string, { t: number; eventId: string; cands: Snap[] }>();
    for (const snapshot of snaps) {
        let event = eventMap.get(snapshot.eventId);
        if (!event) {
            event = { t: snapshot.decisionTimeSec, eventId: snapshot.eventId, cands: [] };
            eventMap.set(snapshot.eventId, event);
        }
        event.cands.push(snapshot);
    }

    const events: EvalEvent[] = [];
    for (const event of eventMap.values()) {
        const base = event.cands
            .filter((candidate) => candidate.longEligible && candidate.activePairCount > 0 &&
                Number.isFinite(candidate.signedVotes / candidate.activePairCount) &&
                candidate.signedVotes / candidate.activePairCount > 0);
        if (base.length < 2) continue;

        let best = base[0]!;
        let bestScore = best.signedVotes / best.activePairCount;
        let bestDigest = tieDigest(event.t, best.asset);
        for (const candidate of base.slice(1)) {
            const score = candidate.signedVotes / candidate.activePairCount;
            const digest = tieDigest(event.t, candidate.asset);
            if (score > bestScore || (score === bestScore &&
                (digest < bestDigest || (digest === bestDigest && candidate.asset < best.asset)))) {
                best = candidate;
                bestScore = score;
                bestDigest = digest;
            }
        }

        const outcome = outcomes.get(`${event.eventId}|${best.asset}`);
        if (!outcome || !outcome.eligible || outcome.status !== "ok" ||
            !Number.isFinite(outcome.return) || !Number.isFinite(outcome.entryTimeSec) ||
            !Number.isFinite(outcome.exitTimeSec)) continue;
        events.push({
            t: event.t,
            eventId: event.eventId,
            inc: best,
            incReturn: outcome.return,
            candidates: event.cands,
        });
    }
    return sortEvents(events);
}

export interface TakeSkipCliOptions {
    ledgerDir: string;
    report: boolean;
    window: "discovery";
}

export function parseArgs(argv: readonly string[]): TakeSkipCliOptions {
    let ledgerDir: string | undefined;
    let report = false;
    let window: "discovery" = "discovery";
    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--report") {
            report = true;
        } else if (arg === "--window") {
            const value = argv[++index];
            if (value !== "discovery") throw new Error("--window currently supports only discovery.");
            window = value;
        } else if (arg.startsWith("--")) {
            throw new Error(`Unknown option: ${arg}`);
        } else if (ledgerDir === undefined) {
            ledgerDir = arg;
        } else {
            throw new Error("Usage: esno scripts/take-skip-eval.ts <ledgerDir> [--report] [--window discovery]");
        }
    }
    return { ledgerDir: ledgerDir ?? DEFAULT_LEDGER_DIR, report, window };
}

export async function main(argv: readonly string[] = process.argv.slice(2)): Promise<void> {
    const options = parseArgs(argv);
    const events = await loadEvalEvents(options.ledgerDir);
    const evaluations = evaluateGates(events);

    if (options.report) {
        const reportText = readFileSync(path.join(options.ledgerDir, "report.txt"), "utf8");
        const augmented = augmentReportWithTakeSkipLines(reportText, buildTakeSkipReportLines(evaluations));
        process.stdout.write(augmented.endsWith("\n") ? augmented : `${augmented}\n`);
        return;
    }

    console.log(`evaluable events: ${events.length}`);
    console.log(`total incumbent return: ${(events.reduce((sum, event) => sum + event.incReturn, 0) * 100).toFixed(2)}%`);

    const allTotal = evaluations[0]?.allSum ?? 0;
    console.log(`\nallReturnSum=${(allTotal * 100).toFixed(4)}pp over ${events.length} events`);
    console.log("");
    for (const gate of evaluations) {
        const difference = gate.takenSum - allTotal;
        console.log(`GATE|name=${gate.name}|taken=${gate.taken}|skipped=${events.length - gate.taken}|` +
            `takenReturnSum=${(gate.takenSum * 100).toFixed(4)}pp|allReturnSum=${(allTotal * 100).toFixed(4)}pp|` +
            `difference=${(difference * 100).toFixed(4)}pp|verdict=${difference > 0 ? "POSITIVE" : "NEGATIVE"}`);
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    main().catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
    });
}
