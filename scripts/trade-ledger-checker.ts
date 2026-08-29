/**
 * Offline trade-ledger REPLAY checker (ledger v2).
 *
 * The checker is THE scoring tool for a Batch "Save trade ledger" folder: it
 * REPLAYS admission rules per pair — walk candidates chronologically, apply
 * the rule BEFORE ordering, admit the trade if the pair is flat (and cooldown
 * has elapsed) and the rule passes, keep the pair busy until the admitted
 * trade's as-if exit. Scoring only the original run's executed rows would mean
 * judging rules on survivors, not candidates; replay replaces that path
 * entirely.
 *
 * Validity: admission changes WHICH trades exist, so per-candidate outcomes
 * must not depend on prior accepted trades. Folders carry `replay.replayEligible`
 * (written by the exporter from the run's resolved settings); the checker
 * REFUSES replay on ineligible folders and on v1 folders (no as-if outcomes —
 * re-run the batch to regenerate).
 *
 * Usage:
 *   ..\..\..\node_modules\.bin\esno scripts/trade-ledger-checker.ts <ledgerFolder> <ruleFile.ts>
 *
 * The rule file default-exports `(row) => boolean` and may read ONLY
 * identity/entry fields and `feat_*` fields — enforced by a Proxy allowlist
 * whose traps cover get / has / ownKeys / getOwnPropertyDescriptor, so
 * `Object.keys`, spread, and descriptor reads all throw on forbidden fields.
 *
 * Per-candidate replay is faithful to Batch semantics because pairs are
 * independent in the engine; there is deliberately NO global cross-pair
 * capital replay. Pure Node + TypeScript, no new dependencies, deterministic.
 */

import { createReadStream, existsSync, readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_RULE_ALLOWED_FIELDS,
    TRADE_LEDGER_RULE_FORBIDDEN_FIELDS,
    TRADE_LEDGER_VERSION,
    type TradeLedgerProvenance,
    type TradeLedgerRankRow,
    type TradeLedgerRow,
} from "../lib/batch-backtest/trade-ledger-exporter";

/** IS slice = first fraction of the folder's GLOBAL calendar time range. */
export const TRADE_LEDGER_IS_FRACTION = 0.6;
/**
 * Deterministic random control: 200 seeded replay filters, two-pass keep-rate
 * calibration (calibration seed 42, control k seeded 42 + k).
 */
export const TRADE_LEDGER_CONTROL_RUNS = 200;
export const TRADE_LEDGER_CONTROL_SEED = 42;

const LEDGER_FILE = "ledger.jsonl";
const RANKS_FILE = "signal-ranks.jsonl";
const PROVENANCE_FILE = "provenance.json";
const SUMMARY_FILE = "summary.json";

export type TradeLedgerRuleRow = Omit<TradeLedgerRow, typeof TRADE_LEDGER_RULE_FORBIDDEN_FIELDS[number]>;
export type LedgerRule = (row: TradeLedgerRuleRow) => boolean;

const RULE_ALLOWED_FIELDS: ReadonlySet<string> = new Set<string>(TRADE_LEDGER_RULE_ALLOWED_FIELDS);

function assertAllowedField(prop: string | symbol): void {
    if (typeof prop !== "string") return;
    if (RULE_ALLOWED_FIELDS.has(prop) || prop.startsWith("feat_")) return;
    throw new Error(
        `Rule accessed forbidden ledger field "${prop}". `
        + `Allowed: identity/entry fields and feat_*. Sealed: ${TRADE_LEDGER_RULE_FORBIDDEN_FIELDS.join(", ")}.`,
    );
}

/**
 * Wrap a ledger row so a rule physically cannot reach outcome-ish fields.
 * get/has/ownKeys/getOwnPropertyDescriptor are ALL trapped: property reads,
 * `in` probes, `Object.keys` / `Object.entries` / spread (`{...row}`), and
 * descriptor reads of a forbidden key throw.
 */
export function createRuleRowProxy(row: TradeLedgerRow): TradeLedgerRuleRow {
    return new Proxy(row as TradeLedgerRuleRow, {
        get(target, prop, receiver) {
            assertAllowedField(prop);
            return Reflect.get(target, prop, receiver);
        },
        has(target, prop) {
            assertAllowedField(prop);
            return Reflect.has(target, prop);
        },
        ownKeys() {
            throw new Error(
                "Rule tried to enumerate ledger fields (Object.keys/spread/entries). "
                + `Field enumeration is refused; read allowed fields directly. Sealed: ${TRADE_LEDGER_RULE_FORBIDDEN_FIELDS.join(", ")}.`,
            );
        },
        getOwnPropertyDescriptor(target, prop) {
            assertAllowedField(prop);
            return Reflect.getOwnPropertyDescriptor(target, prop);
        },
    });
}

// ---------------------------------------------------------------------------
// Loading + joining (W6: streaming line iteration — no whole-file Buffer)
// ---------------------------------------------------------------------------

/**
 * Async-generator over JSONL lines using a chunked read stream + readline, so
 * a 2M-row ledger is never materialized as one Buffer/string. Handles CRLF
 * (`crlfDelay: Infinity`), empty lines, missing trailing newline, and UTF-8
 * bullet pair names (the stream decodes incrementally).
 */
async function* iterateJsonlLines(filePath: string): AsyncGenerator<string> {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    let firstLine = true;
    try {
        for await (const rawLine of reader) {
            let line = rawLine.trim();
            if (firstLine) {
                // Tolerate a UTF-8 BOM on the first line.
                if (line.startsWith("\uFEFF")) line = line.slice(1).trim();
                firstLine = false;
            }
            if (line) yield line;
        }
    } finally {
        reader.close();
        stream.destroy();
    }
}

export async function loadLedgerRows(folder: string): Promise<TradeLedgerRow[]> {
    const rows: TradeLedgerRow[] = [];
    for await (const line of iterateJsonlLines(path.join(folder, LEDGER_FILE))) {
        rows.push(JSON.parse(line) as TradeLedgerRow);
    }
    return rows;
}

/** Keyed by `${signalTime}|${pair}` — the join the checker performs. */
export async function loadSignalRanks(folder: string): Promise<Map<string, TradeLedgerRankRow>> {
    const ranksFile = path.join(folder, RANKS_FILE);
    const map = new Map<string, TradeLedgerRankRow>();
    if (!existsSync(ranksFile)) return map;
    for await (const line of iterateJsonlLines(ranksFile)) {
        const rank = JSON.parse(line) as TradeLedgerRankRow;
        map.set(`${rank.signalTime}|${rank.pair}`, rank);
    }
    return map;
}

/**
 * Mutates each row's `feat_rank` / `feat_candidatesAtTime` in place from the
 * ranks map. Returns the number of rows that matched a rank entry.
 */
export function joinSignalRanks(rows: TradeLedgerRow[], ranks: Map<string, TradeLedgerRankRow>): number {
    let joined = 0;
    for (const row of rows) {
        const rank = ranks.get(`${row.signalTime}|${row.pair}`);
        if (!rank) continue;
        row.feat_rank = rank.rank;
        row.feat_candidatesAtTime = rank.candidatesAtTime;
        joined += 1;
    }
    return joined;
}

// ---------------------------------------------------------------------------
// Replay
// ---------------------------------------------------------------------------

export interface ReplayParams {
    maxOpenTrades: number; // Infinity for unlimited
    cooldownBars: number; // 0 = disabled
}

export interface ReplayPairResult {
    pair: string;
    candidates: number;
    admitted: number;
    rejectedByRule: number;
    blocked: number;
    rightCensored: number;
    trades: TradeLedgerRow[];
}

/**
 * Replay ONE pair: sort candidates by decision time, apply the rule BEFORE
 * ordering, admit when flat (open slots free, cooldown elapsed) and the rule
 * passes; an admitted trade keeps its slot busy until its as-if exit bar
 * (exit bar = signalBarIndex + shift + barsHeld). Faithful to Batch semantics
 * because pairs are independent in the engine — there is deliberately NO
 * cross-pair capital replay.
 */
export function replayPair(
    pair: string,
    rows: readonly TradeLedgerRow[],
    rule: LedgerRule,
    params: ReplayParams,
    shift: number,
): ReplayPairResult {
    const candidates = [...rows].sort((a, b) =>
        a.signalTime - b.signalTime
        || a.signalBarIndex - b.signalBarIndex);
    // Slots busy until their exit bar (inclusive); a fill bar frees the slot
    // one bar after the exit — mirroring the engine, where the position is
    // still open while its exit bar is being processed.
    const slots: number[] = [];
    let cooldownUntilBar = -1;
    const result: ReplayPairResult = {
        pair,
        candidates: candidates.length,
        admitted: 0,
        rejectedByRule: 0,
        blocked: 0,
        rightCensored: 0,
        trades: [],
    };

    for (const row of candidates) {
        if (!row.asIf || typeof row.asIf.pnlPercent !== "number") {
            result.rightCensored += 1;
            result.blocked += 1;
            continue;
        }
        const fillBar = row.signalBarIndex + shift;
        const exitBar = fillBar + row.asIf.barsHeld;
        const openSlots = slots.filter((until) => until >= fillBar).length;
        const busy = openSlots >= params.maxOpenTrades;
        const cooling = params.cooldownBars > 0 && cooldownUntilBar >= fillBar;
        if (busy || cooling) {
            result.blocked += 1;
            continue;
        }
        if (rule(createRuleRowProxy(row)) !== true) {
            result.rejectedByRule += 1;
            continue;
        }
        // Admit: occupy a slot until the exit bar, arm the cooldown.
        const freeIdx = slots.findIndex((until) => until < fillBar);
        if (freeIdx >= 0) slots[freeIdx] = exitBar;
        else slots.push(exitBar);
        if (params.cooldownBars > 0) {
            cooldownUntilBar = Math.max(cooldownUntilBar, exitBar + params.cooldownBars - 1);
        }
        result.admitted += 1;
        result.trades.push(row);
    }
    return result;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

export interface LedgerSliceStats {
    trades: number;
    meanPnlPercent: number | null;
    medianPnlPercent: number | null;
    hitRatePercent: number | null;
    totalReturnPercent: number | null;
    maxDrawdownPercent: number | null;
}

/**
 * Stats over admitted-trade pnlPercents in CHRONOLOGICAL order. Total return
 * compounds per trade; max drawdown is the deepest peak-to-trough dip of that
 * cumulative equity (percent).
 */
export function computeSliceStats(pnlPercents: readonly number[]): LedgerSliceStats {
    const trades = pnlPercents.length;
    if (trades === 0) {
        return {
            trades: 0,
            meanPnlPercent: null,
            medianPnlPercent: null,
            hitRatePercent: null,
            totalReturnPercent: null,
            maxDrawdownPercent: null,
        };
    }
    const mean = pnlPercents.reduce((sum, p) => sum + p, 0) / trades;
    const sorted = [...pnlPercents].sort((a, b) => a - b);
    const median = trades % 2 === 1
        ? sorted[(trades - 1) / 2]!
        : (sorted[trades / 2 - 1]! + sorted[trades / 2]!) / 2;
    const wins = pnlPercents.filter((p) => p > 0).length;

    let equity = 1;
    let peak = 1;
    let maxDrawdown = 0;
    for (const p of pnlPercents) {
        equity *= 1 + p / 100;
        if (equity > peak) peak = equity;
        if (peak > 0) {
            const drawdown = (peak - equity) / peak * 100;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }
    }
    return {
        trades,
        meanPnlPercent: mean,
        medianPnlPercent: median,
        hitRatePercent: wins / trades * 100,
        totalReturnPercent: (equity - 1) * 100,
        maxDrawdownPercent: maxDrawdown,
    };
}

export interface LedgerTimeSplit {
    minTime: number;
    maxTime: number;
    splitTime: number;
}

export function computeTimeSplit(rows: readonly TradeLedgerRow[], isFraction = TRADE_LEDGER_IS_FRACTION): LedgerTimeSplit {
    let minTime = Number.POSITIVE_INFINITY;
    let maxTime = Number.NEGATIVE_INFINITY;
    for (const row of rows) {
        if (row.signalTime < minTime) minTime = row.signalTime;
        if (row.signalTime > maxTime) maxTime = row.signalTime;
    }
    if (!Number.isFinite(minTime) || !Number.isFinite(maxTime)) {
        return { minTime: 0, maxTime: 0, splitTime: 0 };
    }
    return { minTime, maxTime, splitTime: minTime + (maxTime - minTime) * isFraction };
}

// ---------------------------------------------------------------------------
// Seeded random control
// ---------------------------------------------------------------------------

/** Deterministic 32-bit PRNG (mulberry32). Same seed → identical sequence. */
export function mulberry32(seed: number): () => number {
    let a = seed >>> 0;
    return () => {
        a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Build a seeded random RULE under the replay: keep a candidate when
 * rng() < p. p is calibrated in TWO DETERMINISTIC PASSES so the random filter
 * admits approximately the same count as the rule under test: pass 1 replays
 * at p0 = 0.5 to measure acceptance, pass 2 replays at the scaled
 * probability. Fixed seeds keep every run byte-identical.
 */
export function calibratedRandomRule(
    rows: readonly TradeLedgerRow[],
    targetCount: number,
    params: ReplayParams,
    shift: number,
    controlSeed: number,
): { rule: LedgerRule; calibratedP: number } {
    const candidateRows = rows.filter((r) => r.asIf && typeof r.asIf.pnlPercent === "number");
    const makeRule = (seed: number, p: number): LedgerRule => {
        const rng = mulberry32(seed);
        return () => rng() < p;
    };
    const baseline = Math.max(1, candidateRows.length);
    const p0 = Math.min(1, Math.max(0, targetCount / baseline));
    const first = replayPair("__calibration", candidateRows, makeRule(TRADE_LEDGER_CONTROL_SEED, p0), params, shift);
    let p1 = p0;
    if (first.admitted > 0 && first.admitted !== targetCount) {
        p1 = Math.min(1, Math.max(0, p0 * (targetCount / first.admitted)));
    }
    return { rule: makeRule(controlSeed, p1), calibratedP: p1 };
}

// ---------------------------------------------------------------------------
// Report
// ---------------------------------------------------------------------------

function fmt(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(4);
}

function pct(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : `${value.toFixed(4)}%`;
}

function signedPp(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(4)}pp`;
}

function mean(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function median(values: readonly number[]): number | null {
    if (values.length === 0) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const n = sorted.length;
    return n % 2 === 1 ? sorted[(n - 1) / 2]! : (sorted[n / 2 - 1]! + sorted[n / 2]!) / 2;
}

export interface CheckerReportInput {
    folder: string;
    ruleName: string;
    rows: readonly TradeLedgerRow[];
    joinedRankCount: number;
    rule: LedgerRule;
    replay: {
        maxOpenTrades: number;
        cooldownBars: number;
        shift: number;
    };
    controlRuns?: number;
    controlSeed?: number;
    /** Set when the run proceeded over an incomplete ledger via --allow-incomplete. */
    incomplete?: { failedWrites: number; failedPairs: string[] };
}

/**
 * Assemble the stable replay report. Deterministic: identical folder + rule
 * produce byte-identical output.
 */
export function buildCheckerReport(input: CheckerReportInput): string {
    const rows = input.rows;
    const total = rows.length;
    const candidates = rows.filter((r) => r.asIf && typeof r.asIf.pnlPercent === "number");
    const rightCensored = total - candidates.length;

    // Global calendar range over every row; IS/holdout split by TIME only.
    const split = computeTimeSplit(rows);

    // Replay rule + random controls over the SAME candidate space.
    const replayParams: ReplayParams = {
        maxOpenTrades: input.replay.maxOpenTrades,
        cooldownBars: input.replay.cooldownBars,
    };
    const pairs = new Map<string, TradeLedgerRow[]>();
    for (const row of rows) {
        const bucket = pairs.get(row.pair);
        if (bucket) bucket.push(row);
        else pairs.set(row.pair, [row]);
    }

    const pairResults: ReplayPairResult[] = [];
    for (const [pair, pairRows] of pairs) {
        pairResults.push(replayPair(pair, pairRows, input.rule, replayParams, input.replay.shift));
    }
    pairResults.sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
    const admitted = pairResults.flatMap((r) => r.trades);

    // Random controls: calibrated per control against the RULE's admitted
    // count, replayed with the same state machine. The PRIMARY comparison is
    // PER-TRADE (mean/median pnlPercent deltas per slice); compounded returns
    // explode with per-trade means, so they are collected but demoted to
    // informational, scale-dependent lines.
    const controlRuns = input.controlRuns ?? TRADE_LEDGER_CONTROL_RUNS;
    const controlTotalReturns: number[] = [];
    const controlIsMeanPnls: number[] = [];
    const controlIsMedianPnls: number[] = [];
    const controlHoldoutMeanPnls: number[] = [];
    const controlHoldoutMedianPnls: number[] = [];
    for (let k = 0; k < controlRuns; k += 1) {
        const { rule } = calibratedRandomRule(rows, admitted.length, replayParams, input.replay.shift, (input.controlSeed ?? TRADE_LEDGER_CONTROL_SEED) + 1 + k);
        let equity = 1;
        const isPnls: number[] = [];
        const holdoutPnls: number[] = [];
        for (const [pair, pairRows] of pairs) {
            const result = replayPair(pair, pairRows, rule, replayParams, input.replay.shift);
            for (const trade of result.trades) {
                const pnl = trade.asIf?.pnlPercent ?? 0;
                equity *= 1 + pnl / 100;
                if (trade.signalTime < split.splitTime) isPnls.push(pnl);
                else holdoutPnls.push(pnl);
            }
        }
        controlTotalReturns.push((equity - 1) * 100);
        const controlIsStats = computeSliceStats(isPnls);
        if (controlIsStats.meanPnlPercent !== null) controlIsMeanPnls.push(controlIsStats.meanPnlPercent);
        if (controlIsStats.medianPnlPercent !== null) controlIsMedianPnls.push(controlIsStats.medianPnlPercent);
        const controlHoldoutStats = computeSliceStats(holdoutPnls);
        if (controlHoldoutStats.meanPnlPercent !== null) controlHoldoutMeanPnls.push(controlHoldoutStats.meanPnlPercent);
        if (controlHoldoutStats.medianPnlPercent !== null) controlHoldoutMedianPnls.push(controlHoldoutStats.medianPnlPercent);
    }
    const controlMean = mean(controlTotalReturns);
    const controlMedian = median(controlTotalReturns);
    const controlIsMeanPnl = mean(controlIsMeanPnls);
    const controlIsMedianPnl = mean(controlIsMedianPnls);
    const controlHoldoutMeanPnl = mean(controlHoldoutMeanPnls);
    const controlHoldoutMedianPnl = mean(controlHoldoutMedianPnls);

    // IS/HOLDOUT split of the ADMITTED trades by global signal time.
    const admittedIs = admitted.filter((r) => r.signalTime < split.splitTime);
    const admittedHoldout = admitted.filter((r) => r.signalTime >= split.splitTime);
    const isStats = computeSliceStats(admittedIs.map((r) => r.asIf!.pnlPercent));
    const holdoutStats = computeSliceStats(admittedHoldout.map((r) => r.asIf!.pnlPercent));
    // PRIMARY rule-vs-control comparison: per-trade pnl deltas per slice.
    const isMeanPnlDelta = isStats.meanPnlPercent !== null && controlIsMeanPnl !== null
        ? isStats.meanPnlPercent - controlIsMeanPnl
        : null;
    const isMedianPnlDelta = isStats.medianPnlPercent !== null && controlIsMedianPnl !== null
        ? isStats.medianPnlPercent - controlIsMedianPnl
        : null;
    const holdoutMeanPnlDelta = holdoutStats.meanPnlPercent !== null && controlHoldoutMeanPnl !== null
        ? holdoutStats.meanPnlPercent - controlHoldoutMeanPnl
        : null;
    const holdoutMedianPnlDelta = holdoutStats.medianPnlPercent !== null && controlHoldoutMedianPnl !== null
        ? holdoutStats.medianPnlPercent - controlHoldoutMedianPnl
        : null;

    const totalCandidates = pairResults.reduce((sum, r) => sum + r.candidates, 0);
    const totalAdmitted = pairResults.reduce((sum, r) => sum + r.admitted, 0);
    const lines: string[] = [
        "trade-ledger-checker (replay, ledger v2)",
        `folder: ${input.folder}`,
        `ledgerVersion: ${TRADE_LEDGER_VERSION} featureVersion: ${TRADE_LEDGER_FEATURE_VERSION}`,
        ...(input.incomplete
            ? [
                `!! INCOMPLETE LEDGER — produced with --allow-incomplete: failedWrites=${input.incomplete.failedWrites}; dropped pair rows (${input.incomplete.failedPairs.length}): ${formatFailedPairList(input.incomplete.failedPairs) || "(none recorded — pre-W2 summary)"}.`,
                "!! This report must NOT be treated as a clean result.",
            ]
            : []),
        `candidates: total=${totalCandidates} admitted=${totalAdmitted} rejectedByRule=${pairResults.reduce((s, r) => s + r.rejectedByRule, 0)} blocked=${pairResults.reduce((s, r) => s + r.blocked, 0)} rightCensored=${rightCensored}`,
        "note: per-pair replay admits trades from ALL candidates (rule applied before ordering); pairs are independent in the engine — there is NO global cross-pair capital replay.",
        "note: the PRIMARY rule-vs-control comparison is per-trade pnl deltas; compounded total return and max drawdown are scale-dependent at large per-trade means and are informational only.",
        `ranks joined: ${input.joinedRankCount}/${total} rows matched ${RANKS_FILE}`,
        `rule: ${input.ruleName}`,
        `kept: ${totalAdmitted}/${totalCandidates} (${pct(totalCandidates > 0 ? totalAdmitted / totalCandidates * 100 : 0)} of candidates)`,
        `RULE ${input.ruleName} kept=${totalAdmitted}/${totalCandidates}`
            + ` (${fmt(totalCandidates > 0 ? totalAdmitted / totalCandidates * 100 : 0)}%)`
            + ` isMeanPnl=${pct(isStats.meanPnlPercent)}`
            + ` isMedianPnl=${pct(isStats.medianPnlPercent)}`
            + ` isHitRate=${pct(isStats.hitRatePercent)}`
            + ` isMeanPnlVsControl=${signedPp(isMeanPnlDelta)}`
            + ` isMedianPnlVsControl=${signedPp(isMedianPnlDelta)}`,
        "",
        `IS slice (first ${TRADE_LEDGER_IS_FRACTION * 100}% of global calendar range; split at ${new Date(split.splitTime * 1000).toISOString()}): trades=${admittedIs.length}`,
        `  meanPnl=${pct(isStats.meanPnlPercent)} medianPnl=${pct(isStats.medianPnlPercent)} hitRate=${pct(isStats.hitRatePercent)}`,
        `  scale-dependent (compounded): totalReturn=${pct(isStats.totalReturnPercent)} maxDrawdown=${pct(isStats.maxDrawdownPercent)}`,
        `HOLDOUT slice (last ${(1 - TRADE_LEDGER_IS_FRACTION) * 100}%) — sealed - finalists only: trades=${admittedHoldout.length}`,
        `  meanPnl=${pct(holdoutStats.meanPnlPercent)} medianPnl=${pct(holdoutStats.medianPnlPercent)} hitRate=${pct(holdoutStats.hitRatePercent)}`,
        `  scale-dependent (compounded): totalReturn=${pct(holdoutStats.totalReturnPercent)} maxDrawdown=${pct(holdoutStats.maxDrawdownPercent)}`,
        `random control: ${controlRuns} seeded replay filters (base seed ${input.controlSeed ?? TRADE_LEDGER_CONTROL_SEED}; two-pass keep-rate calibration targeting ${totalAdmitted} admits)`,
        `  controlIsMeanPnl=${pct(controlIsMeanPnl)} controlIsMedianPnl=${pct(controlIsMedianPnl)} (per-trade, mean across controls)`,
        `  scale-dependent (compounded): meanIsTotalReturn=${pct(controlMean)} medianIsTotalReturn=${pct(controlMedian)}`,
        `rule vs control (per-trade, primary): isMeanPnlDelta=${signedPp(isMeanPnlDelta)} isMedianPnlDelta=${signedPp(isMedianPnlDelta)} holdoutMeanPnlDelta=${signedPp(holdoutMeanPnlDelta)} holdoutMedianPnlDelta=${signedPp(holdoutMedianPnlDelta)}`,
        "",
        "per-pair admitted vs total candidates:",
        ...pairResults.map((r) =>
            `  ${r.pair}: candidates=${r.candidates} admitted=${r.admitted} rejectedByRule=${r.rejectedByRule} blocked=${r.blocked} rightCensored=${r.rightCensored}`),
    ];
    return lines.join("\n");
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export interface LoadedLedger {
    rows: TradeLedgerRow[];
    joinedRankCount: number;
    provenance: TradeLedgerProvenance;
    replayParams: { maxOpenTrades: number; cooldownBars: number; shift: number };
    /** Set ONLY when the folder is incomplete and --allow-incomplete overrode the refusal. */
    incomplete?: { failedWrites: number; failedPairs: string[] };
}

export interface LoadLedgerOptions {
    /** Proceed on an incomplete ledger — the report carries a loud warning banner. */
    allowIncomplete?: boolean;
}

function formatFailedPairList(failedPairs: readonly string[]): string {
    return failedPairs.length <= 20
        ? failedPairs.join(", ")
        : `${failedPairs.slice(0, 20).join(", ")} … and ${failedPairs.length - 20} more`;
}

/**
 * Load + validate a ledger folder for replay. Throws with a clear message on
 * v1 folders (no as-if outcomes), replay-ineligible configs, and — audit W1 —
 * INCOMPLETE ledgers (summary missing, unsupported version,
 * ledgerComplete:false, failedWrites>0). `allowIncomplete` overrides the
 * incompleteness refusal but the returned `incomplete` field feeds a loud
 * warning banner INSIDE the report, so an overridden run can never be
 * mistaken for a clean one later.
 */
export async function loadLedgerForReplay(folder: string, options: LoadLedgerOptions = {}): Promise<LoadedLedger> {
    const provenancePath = path.join(folder, PROVENANCE_FILE);
    if (!existsSync(provenancePath)) {
        throw new Error(`${PROVENANCE_FILE} not found in "${folder}" — not a trade-ledger run folder.`);
    }
    const provenance = JSON.parse(readFileSync(provenancePath, "utf8")) as TradeLedgerProvenance;
    if (provenance.ledgerVersion !== TRADE_LEDGER_VERSION) {
        throw new Error(
            `ledger v${provenance.ledgerVersion} — re-run the batch to regenerate (checker requires ledger v${TRADE_LEDGER_VERSION} with as-if outcomes).`
        );
    }
    const replay = provenance.replay;
    if (!replay || replay.replayEligible !== true) {
        throw new Error(
            `Replay is not eligible for this run config. Blockers: ${replay?.replayBlockers?.join("; ") ?? "unknown"}. `
            + "Re-run the batch with a replay-eligible configuration (see docs/trade-ledger.md)."
        );
    }
    // W1: summary.json certifies ledger completeness. Without it, a run with
    // dropped pair rows (e.g. EBUSY append failures) would replay as if
    // complete and silently poison research.
    const summaryPath = path.join(folder, SUMMARY_FILE);
    if (!existsSync(summaryPath)) {
        throw new Error(
            `${SUMMARY_FILE} not found in "${folder}" — ledger completeness cannot be verified. `
            + "Re-run the batch or point at the correct per-run folder."
        );
    }
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as {
        ledgerVersion?: number;
        ledgerComplete?: boolean;
        failedWrites?: number;
        failedPairs?: string[];
    };
    if (summary.ledgerVersion !== TRADE_LEDGER_VERSION) {
        throw new Error(
            `summary.json ledgerVersion ${String(summary.ledgerVersion)} unsupported — checker requires v${TRADE_LEDGER_VERSION}. Re-run the batch.`
        );
    }
    const failedPairs = Array.isArray(summary.failedPairs) ? summary.failedPairs : [];
    let incomplete: LoadedLedger["incomplete"];
    if (summary.ledgerComplete !== true || (summary.failedWrites ?? 0) !== 0) {
        const reason = summary.ledgerComplete !== true
            ? `ledgerComplete=false, failedWrites=${String(summary.failedWrites ?? 0)}`
            : `failedWrites=${String(summary.failedWrites ?? 0)}`;
        const message = `Refusing incomplete ledger: ${reason}. Dropped pair rows (${failedPairs.length}): ${formatFailedPairList(failedPairs) || "(none recorded — pre-W2 summary)"}. `
            + "Re-run the batch, or pass --allow-incomplete to proceed with a loud warning banner in the report.";
        if (options.allowIncomplete !== true) {
            throw new Error(message);
        }
        incomplete = { failedWrites: summary.failedWrites ?? 0, failedPairs };
    }
    if (!existsSync(path.join(folder, LEDGER_FILE))) {
        throw new Error(`${LEDGER_FILE} not found in "${folder}" — the run wrote no ledger rows.`);
    }
    const shift = replay.executionModel === "signal_close" ? 0 : 1;
    const rows = await loadLedgerRows(folder);
    return {
        rows,
        joinedRankCount: joinSignalRanks(rows, await loadSignalRanks(folder)),
        provenance,
        replayParams: {
            maxOpenTrades: replay.maxOpenTrades === "unlimited" ? Number.POSITIVE_INFINITY : Number(replay.maxOpenTrades),
            cooldownBars: replay.cooldownBars,
            shift,
        },
        incomplete,
    };
}

export interface RunCheckerOptions extends LoadLedgerOptions {}

export async function runChecker(folder: string, ruleFile: string, options: RunCheckerOptions = {}): Promise<string> {
    const loaded = await loadLedgerForReplay(folder, options);
    const resolvedRule = path.resolve(ruleFile);
    if (!existsSync(resolvedRule)) {
        throw new Error(`Rule file not found: ${resolvedRule}`);
    }
    const module = await import(pathToFileURL(resolvedRule).href);
    const rule: unknown = module.default;
    if (typeof rule !== "function") {
        throw new Error(`Rule file must default-export (row) => boolean: ${resolvedRule}`);
    }
    return buildCheckerReport({
        folder,
        ruleName: path.basename(resolvedRule),
        rows: loaded.rows,
        joinedRankCount: loaded.joinedRankCount,
        rule: rule as LedgerRule,
        replay: loaded.replayParams,
        incomplete: loaded.incomplete,
    });
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
    const allowIncomplete = argv.includes("--allow-incomplete");
    const positional = argv.filter((arg) => arg !== "--allow-incomplete");
    const [folder, ruleFile] = positional;
    if (!folder || !ruleFile) {
        console.log("Usage: esno scripts/trade-ledger-checker.ts <ledgerFolder> <ruleFile.ts> [--allow-incomplete]");
        console.log("  <ledgerFolder>  per-run folder containing ledger.jsonl (e.g. archive/mining-ledger/2026-08-29_1412_batch-abc)");
        console.log("  <ruleFile.ts>   TS module default-exporting (row) => boolean using only identity/entry/feat_* fields");
        console.log("  --allow-incomplete  proceed on an incomplete ledger (summary certifies failures); the report carries a loud warning banner");
        process.exitCode = 1;
        return;
    }
    try {
        console.log(await runChecker(folder, ruleFile, { allowIncomplete }));
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.error(`trade-ledger-checker failed: ${message}`);
        process.exitCode = 1;
    }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    void main();
}
