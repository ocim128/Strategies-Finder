/**
 * Pure trade-ledger replay and report core.
 *
 * This module deliberately has no filesystem, Vite, or browser imports. The
 * checker CLI and the server sweep worker are adapters around these exact
 * replay semantics.
 */

import {
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_RULE_ALLOWED_FIELDS,
    TRADE_LEDGER_RULE_FORBIDDEN_FIELDS,
    TRADE_LEDGER_VERSION,
    type TradeLedgerProvenance,
    type TradeLedgerRow,
} from "./trade-ledger-schema";

/** IS slice = first fraction of the folder's GLOBAL calendar time range. */
export const TRADE_LEDGER_IS_FRACTION = 0.6;
/**
 * Deterministic random control: 200 seeded replay filters, two-pass keep-rate
 * calibration (calibration seed 42, control k seeded 42 + k).
 */
export const TRADE_LEDGER_CONTROL_RUNS = 200;
export const TRADE_LEDGER_CONTROL_SEED = 42;

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
    preparedRuleRows?: ReadonlyMap<TradeLedgerRow, TradeLedgerRuleRow>,
    alreadySorted = false,
): ReplayPairResult {
    const candidates = alreadySorted
        ? rows
        : [...rows].sort((a, b) => a.signalTime - b.signalTime || a.signalBarIndex - b.signalBarIndex);
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
        let openSlots = 0;
        for (const until of slots) {
            if (until >= fillBar) openSlots += 1;
        }
        const busy = openSlots >= params.maxOpenTrades;
        const cooling = params.cooldownBars > 0 && cooldownUntilBar >= fillBar;
        if (busy || cooling) {
            result.blocked += 1;
            continue;
        }
        const ruleRow = preparedRuleRows?.get(row) ?? createRuleRowProxy(row);
        if (rule(ruleRow) !== true) {
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

// ============================================================================
// Prepared run data
// ============================================================================

export interface PreparedTradeLedgerReplay {
    readonly rows: readonly TradeLedgerRow[];
    readonly pairs: ReadonlyMap<string, readonly TradeLedgerRow[]>;
    /** Candidate-only views used by the repeated random-control replays. */
    readonly controlRows: readonly TradeLedgerRow[];
    readonly controlPairs: ReadonlyMap<string, readonly TradeLedgerRow[]>;
    readonly ruleRows: ReadonlyMap<TradeLedgerRow, TradeLedgerRuleRow>;
    readonly totalRows: number;
    readonly candidateRows: number;
    readonly rightCensoredRows: number;
    readonly pairBuckets: number;
    readonly sortedRows: number;
    readonly proxyCount: number;
    readonly split: LedgerTimeSplit;
    readonly joinedRankCount: number;
    readonly replayParams: ReplayParams | null;
}

export interface PrepareTradeLedgerReplayInput {
    rows: readonly TradeLedgerRow[];
    joinedRankCount?: number;
    replayParams?: ReplayParams;
}

function isReplayCandidate(row: TradeLedgerRow): boolean {
    return Boolean(row.asIf && typeof row.asIf.pnlPercent === "number");
}

/**
 * Build immutable run-scoped indexes shared by rule evaluations. It caches
 * row ordering, pair buckets, guarded views, and candidate membership; no
 * rule decisions, admitted trades, controls, or outcome-derived rule results
 * are cached.
 */
export function prepareTradeLedgerReplay(
    input: PrepareTradeLedgerReplayInput,
): PreparedTradeLedgerReplay {
    const pairs = new Map<string, TradeLedgerRow[]>();
    for (const row of input.rows) {
        const bucket = pairs.get(row.pair);
        if (bucket) bucket.push(row);
        else pairs.set(row.pair, [row]);
    }
    let sortedRows = 0;
    const sortedPairs = new Map<string, readonly TradeLedgerRow[]>();
    for (const [pair, pairRows] of pairs) {
        const sorted = [...pairRows].sort((a, b) =>
            a.signalTime - b.signalTime
            || a.signalBarIndex - b.signalBarIndex);
        sortedRows += sorted.length;
        sortedPairs.set(pair, Object.freeze(sorted));
    }
    const candidateRows = input.rows.filter(isReplayCandidate);
    const candidatePairs = new Map<string, readonly TradeLedgerRow[]>();
    for (const [pair, pairRows] of sortedPairs) {
        const pairCandidates = pairRows.filter(isReplayCandidate);
        if (pairCandidates.length > 0) {
            candidatePairs.set(pair, Object.freeze(pairCandidates));
        }
    }
    const ruleRows = new Map<TradeLedgerRow, TradeLedgerRuleRow>();
    for (const row of input.rows) ruleRows.set(row, createRuleRowProxy(row));
    const prepared: PreparedTradeLedgerReplay = {
        rows: input.rows,
        pairs: sortedPairs,
        controlRows: candidateRows,
        controlPairs: candidatePairs,
        ruleRows,
        totalRows: input.rows.length,
        candidateRows: candidateRows.length,
        rightCensoredRows: input.rows.length - candidateRows.length,
        pairBuckets: sortedPairs.size,
        sortedRows,
        proxyCount: ruleRows.size,
        split: computeTimeSplit(input.rows),
        joinedRankCount: input.joinedRankCount ?? 0,
        replayParams: input.replayParams ?? null,
    };
    return Object.freeze(prepared);
}

// ============================================================================
// Stats
// ============================================================================

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

// ============================================================================
// Seeded random control
// ============================================================================

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

interface RandomControlAccumulator {
    equity: number;
    readonly splitTime: number;
    readonly isPnls: number[];
    readonly holdoutPnls: number[];
}

/**
 * Replay a random filter over candidate-only rows without constructing rule
 * proxies or ReplayPairResult objects. The branch for one open slot is the
 * normal ledger-sweep setting; the general branch preserves the same slot
 * ordering for larger limits.
 */
function replayRandomControlRows(
    rows: readonly TradeLedgerRow[],
    rng: () => number,
    keepProbability: number,
    params: ReplayParams,
    shift: number,
    accumulator?: RandomControlAccumulator,
): number {
    let admitted = 0;
    const cooldownBars = params.cooldownBars;

    const recordAdmit = (row: TradeLedgerRow, pnl: number): void => {
        admitted += 1;
        if (!accumulator) return;
        accumulator.equity *= 1 + pnl / 100;
        if (row.signalTime < accumulator.splitTime) accumulator.isPnls.push(pnl);
        else accumulator.holdoutPnls.push(pnl);
    };

    if (params.maxOpenTrades === 1) {
        let slotUntil = Number.NEGATIVE_INFINITY;
        let cooldownUntilBar = -1;
        for (const row of rows) {
            const asIf = row.asIf!;
            const fillBar = row.signalBarIndex + shift;
            const busy = slotUntil >= fillBar;
            const cooling = cooldownBars > 0 && cooldownUntilBar >= fillBar;
            if (busy || cooling || !(rng() < keepProbability)) continue;
            const exitBar = fillBar + asIf.barsHeld;
            slotUntil = exitBar;
            if (cooldownBars > 0) {
                cooldownUntilBar = Math.max(cooldownUntilBar, exitBar + cooldownBars - 1);
            }
            recordAdmit(row, asIf.pnlPercent);
        }
        return admitted;
    }

    const slots: number[] = [];
    let cooldownUntilBar = -1;
    for (const row of rows) {
        const asIf = row.asIf!;
        const fillBar = row.signalBarIndex + shift;
        let openSlots = 0;
        let freeIdx = -1;
        for (let i = 0; i < slots.length; i += 1) {
            const until = slots[i]!;
            if (until >= fillBar) openSlots += 1;
            else if (freeIdx < 0) freeIdx = i;
        }
        const busy = openSlots >= params.maxOpenTrades;
        const cooling = cooldownBars > 0 && cooldownUntilBar >= fillBar;
        if (busy || cooling || !(rng() < keepProbability)) continue;
        const exitBar = fillBar + asIf.barsHeld;
        if (freeIdx >= 0) slots[freeIdx] = exitBar;
        else slots.push(exitBar);
        if (cooldownBars > 0) {
            cooldownUntilBar = Math.max(cooldownUntilBar, exitBar + cooldownBars - 1);
        }
        recordAdmit(row, asIf.pnlPercent);
    }
    return admitted;
}

function replayRandomControlPairs(
    pairRows: Iterable<readonly TradeLedgerRow[]>,
    rng: () => number,
    keepProbability: number,
    params: ReplayParams,
    shift: number,
): number {
    let admitted = 0;
    for (const rows of pairRows) {
        admitted += replayRandomControlRows(rows, rng, keepProbability, params, shift);
    }
    return admitted;
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
    preparedRuleRows?: ReadonlyMap<TradeLedgerRow, TradeLedgerRuleRow>,
    alreadySorted = false,
    candidateRowsOverride?: readonly TradeLedgerRow[],
    candidatePairsOverride?: ReadonlyMap<string, readonly TradeLedgerRow[]>,
): { rule: LedgerRule; calibratedP: number } {
    const candidateRows = candidateRowsOverride
        ?? (candidatePairsOverride ? [...candidatePairsOverride.values()].flat() : rows.filter(isReplayCandidate));
    const makeRule = (seed: number, p: number): LedgerRule => {
        const rng = mulberry32(seed);
        return () => rng() < p;
    };
    const baseline = Math.max(1, candidateRows.length);
    const p0 = Math.min(1, Math.max(0, targetCount / baseline));
    const firstAdmitted = candidatePairsOverride
        ? replayRandomControlPairs(candidatePairsOverride.values(), mulberry32(TRADE_LEDGER_CONTROL_SEED), p0, params, shift)
        : candidateRowsOverride
        ? replayRandomControlRows(candidateRows, mulberry32(TRADE_LEDGER_CONTROL_SEED), p0, params, shift)
        : replayPair(
            "__calibration",
            candidateRows,
            makeRule(TRADE_LEDGER_CONTROL_SEED, p0),
            params,
            shift,
            preparedRuleRows,
            alreadySorted,
        ).admitted;
    let p1 = p0;
    if (firstAdmitted > 0 && firstAdmitted !== targetCount) {
        p1 = Math.min(1, Math.max(0, p0 * (targetCount / firstAdmitted)));
    }
    return { rule: makeRule(controlSeed, p1), calibratedP: p1 };
}

// ============================================================================
// Structured evaluation and report
// ============================================================================

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
    /** Reuse a run-scoped prepared dataset in the load-once worker. */
    prepared?: PreparedTradeLedgerReplay;
    /** Set when the run proceeded over an incomplete ledger via --allow-incomplete. */
    incomplete?: { failedWrites: number; failedPairs: string[] };
}

export interface LedgerSweepRuleResultInput {
    candidates: number;
    kept: number;
    keptPct: number | null;
    isMeanPnlDeltaPp: number | null;
    isMedianPnlDeltaPp: number | null;
    holdoutMeanPnlDeltaPp: number | null;
    holdoutMedianPnlDeltaPp: number | null;
}

export interface LedgerRuleEvaluation {
    readonly rows: readonly TradeLedgerRow[];
    readonly split: LedgerTimeSplit;
    readonly pairResults: readonly ReplayPairResult[];
    readonly admitted: readonly TradeLedgerRow[];
    readonly rightCensored: number;
    readonly isStats: LedgerSliceStats;
    readonly holdoutStats: LedgerSliceStats;
    readonly controlRuns: number;
    readonly controlMean: number | null;
    readonly controlMedian: number | null;
    readonly controlIsMeanPnl: number | null;
    readonly controlIsMedianPnl: number | null;
    readonly controlHoldoutMeanPnl: number | null;
    readonly controlHoldoutMedianPnl: number | null;
    readonly isMeanPnlDelta: number | null;
    readonly isMedianPnlDelta: number | null;
    readonly holdoutMeanPnlDelta: number | null;
    readonly holdoutMedianPnlDelta: number | null;
    readonly ruleReplayMs: number;
    readonly controlReplayMs: number;
    readonly calibrationReplays: number;
    readonly controlCandidateVisits: number;
    readonly resultInput: LedgerSweepRuleResultInput;
}

export interface LedgerRuleEvaluationWithReport {
    evaluation: LedgerRuleEvaluation;
    resultInput: LedgerSweepRuleResultInput;
    reportLines: string[];
}

export interface TradeLedgerControlRunResult {
    totalReturnPercent: number;
    isMeanPnlPercent: number | null;
    isMedianPnlPercent: number | null;
    holdoutMeanPnlPercent: number | null;
    holdoutMedianPnlPercent: number | null;
}

export interface TradeLedgerControlRunnerInput {
    controlRuns: number;
    controlSeed: number;
    calibratedP: number;
    replay: ReplayParams;
    shift: number;
    splitTime: number;
}

export type TradeLedgerControlRunner = (
    input: TradeLedgerControlRunnerInput,
) => Promise<readonly TradeLedgerControlRunResult[]>;

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

function summarizeRandomControl(accumulator: RandomControlAccumulator): TradeLedgerControlRunResult {
    return {
        totalReturnPercent: (accumulator.equity - 1) * 100,
        isMeanPnlPercent: mean(accumulator.isPnls),
        isMedianPnlPercent: median(accumulator.isPnls),
        holdoutMeanPnlPercent: mean(accumulator.holdoutPnls),
        holdoutMedianPnlPercent: median(accumulator.holdoutPnls),
    };
}

interface RuleReplayBase {
    rows: readonly TradeLedgerRow[];
    split: LedgerTimeSplit;
    pairResults: readonly ReplayPairResult[];
    admitted: readonly TradeLedgerRow[];
    rightCensored: number;
    replayParams: ReplayParams;
    ruleReplayMs: number;
}

function replayRuleForEvaluation(
    input: CheckerReportInput,
    prepared: PreparedTradeLedgerReplay,
): RuleReplayBase {
    const rows = prepared.rows;
    const total = rows.length;
    const candidates = prepared.controlRows;
    const replayParams: ReplayParams = {
        maxOpenTrades: input.replay.maxOpenTrades,
        cooldownBars: input.replay.cooldownBars,
    };
    const ruleReplayStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const pairResults: ReplayPairResult[] = [];
    for (const [pair, pairRows] of prepared.pairs) {
        pairResults.push(replayPair(pair, pairRows, input.rule, replayParams, input.replay.shift, prepared.ruleRows, true));
    }
    pairResults.sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
    return {
        rows,
        split: prepared.split,
        pairResults,
        admitted: pairResults.flatMap((result) => result.trades),
        rightCensored: total - candidates.length,
        replayParams,
        ruleReplayMs: (typeof performance !== "undefined" ? performance.now() : Date.now()) - ruleReplayStartedAt,
    };
}

function buildLedgerRuleEvaluation(
    input: CheckerReportInput,
    base: RuleReplayBase,
    controlResults: readonly TradeLedgerControlRunResult[],
    controlReplayMs: number,
    calibrationReplays: number,
    controlCandidateVisits: number,
): LedgerRuleEvaluation {
    const controlTotalReturns = controlResults.map((result) => result.totalReturnPercent);
    const controlIsMeanPnls = controlResults.flatMap((result) => result.isMeanPnlPercent === null ? [] : [result.isMeanPnlPercent]);
    const controlIsMedianPnls = controlResults.flatMap((result) => result.isMedianPnlPercent === null ? [] : [result.isMedianPnlPercent]);
    const controlHoldoutMeanPnls = controlResults.flatMap((result) => result.holdoutMeanPnlPercent === null ? [] : [result.holdoutMeanPnlPercent]);
    const controlHoldoutMedianPnls = controlResults.flatMap((result) => result.holdoutMedianPnlPercent === null ? [] : [result.holdoutMedianPnlPercent]);
    const controlMean = mean(controlTotalReturns);
    const controlMedian = median(controlTotalReturns);
    const controlIsMeanPnl = mean(controlIsMeanPnls);
    const controlIsMedianPnl = mean(controlIsMedianPnls);
    const controlHoldoutMeanPnl = mean(controlHoldoutMeanPnls);
    const controlHoldoutMedianPnl = mean(controlHoldoutMedianPnls);

    const admittedIs = base.admitted.filter((row) => row.signalTime < base.split.splitTime);
    const admittedHoldout = base.admitted.filter((row) => row.signalTime >= base.split.splitTime);
    const isStats = computeSliceStats(admittedIs.map((row) => row.asIf!.pnlPercent));
    const holdoutStats = computeSliceStats(admittedHoldout.map((row) => row.asIf!.pnlPercent));
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

    const totalCandidates = base.pairResults.reduce((sum, result) => sum + result.candidates, 0);
    const totalAdmitted = base.pairResults.reduce((sum, result) => sum + result.admitted, 0);
    const resultInput: LedgerSweepRuleResultInput = {
        candidates: totalCandidates,
        kept: totalAdmitted,
        keptPct: totalCandidates > 0 ? totalAdmitted / totalCandidates * 100 : 0,
        isMeanPnlDeltaPp: isMeanPnlDelta,
        isMedianPnlDeltaPp: isMedianPnlDelta,
        holdoutMeanPnlDeltaPp: holdoutMeanPnlDelta,
        holdoutMedianPnlDeltaPp: holdoutMedianPnlDelta,
    };
    return {
        rows: base.rows,
        split: base.split,
        pairResults: base.pairResults,
        admitted: base.admitted,
        rightCensored: base.rightCensored,
        isStats,
        holdoutStats,
        controlRuns: input.controlRuns ?? TRADE_LEDGER_CONTROL_RUNS,
        controlMean,
        controlMedian,
        controlIsMeanPnl,
        controlIsMedianPnl,
        controlHoldoutMeanPnl,
        controlHoldoutMedianPnl,
        isMeanPnlDelta,
        isMedianPnlDelta,
        holdoutMeanPnlDelta,
        holdoutMedianPnlDelta,
        ruleReplayMs: base.ruleReplayMs,
        controlReplayMs,
        calibrationReplays,
        controlCandidateVisits,
        resultInput,
    };
}

function formatFailedPairList(failedPairs: readonly string[]): string {
    return failedPairs.length <= 20
        ? failedPairs.join(", ")
        : `${failedPairs.slice(0, 20).join(", ")} … and ${failedPairs.length - 20} more`;
}

interface ControlReplayExecution {
    results: readonly TradeLedgerControlRunResult[];
    candidateVisits: number;
    calibrationReplays: number;
}

function preparedForEvaluation(input: CheckerReportInput): PreparedTradeLedgerReplay {
    return input.prepared ?? prepareTradeLedgerReplay({
        rows: input.rows,
        joinedRankCount: input.joinedRankCount,
        replayParams: input.replay,
    });
}

function runControlReplaySync(
    input: CheckerReportInput,
    base: RuleReplayBase,
    prepared: PreparedTradeLedgerReplay,
): ControlReplayExecution {
    const controlRuns = input.controlRuns ?? TRADE_LEDGER_CONTROL_RUNS;
    const controlSeed = input.controlSeed ?? TRADE_LEDGER_CONTROL_SEED;
    let calibratedP = 0;
    let calibrationReplays = 0;
    if (controlRuns > 0) {
        // The calibration seed and every calibration input are fixed for this
        // rule, so its two-pass result is identical for every control k.
        calibratedP = calibratedRandomRule(
            base.rows,
            base.admitted.length,
            base.replayParams,
            input.replay.shift,
            controlSeed + 1,
            prepared.ruleRows,
            true,
            undefined,
            prepared.controlPairs,
        ).calibratedP;
        calibrationReplays = 1;
    }
    const results: TradeLedgerControlRunResult[] = [];
    let candidateVisits = 0;
    for (let k = 0; k < controlRuns; k += 1) {
        const accumulator: RandomControlAccumulator = {
            equity: 1,
            splitTime: base.split.splitTime,
            isPnls: [],
            holdoutPnls: [],
        };
        const rng = mulberry32(controlSeed + 1 + k);
        candidateVisits += prepared.controlRows.length;
        for (const pairRows of prepared.controlPairs.values()) {
            replayRandomControlRows(pairRows, rng, calibratedP, base.replayParams, input.replay.shift, accumulator);
        }
        results.push(summarizeRandomControl(accumulator));
    }
    return {
        results,
        candidateVisits,
        calibrationReplays,
    };
}

/** Evaluate one rule without formatting or parsing a report. */
export function evaluateTradeLedgerRule(input: CheckerReportInput): LedgerRuleEvaluation {
    const prepared = preparedForEvaluation(input);
    const base = replayRuleForEvaluation(input, prepared);
    const controlStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    const controls = runControlReplaySync(input, base, prepared);
    const controlReplayMs = (typeof performance !== "undefined" ? performance.now() : Date.now()) - controlStartedAt;
    return buildLedgerRuleEvaluation(input, base, controls.results, controlReplayMs, controls.calibrationReplays, controls.candidateVisits);
}

/** Evaluate one rule using an external server-side control runner. */
export async function evaluateTradeLedgerRuleAsync(
    input: CheckerReportInput,
    controlRunner: TradeLedgerControlRunner,
): Promise<LedgerRuleEvaluation> {
    const prepared = preparedForEvaluation(input);
    const base = replayRuleForEvaluation(input, prepared);
    const controlRuns = input.controlRuns ?? TRADE_LEDGER_CONTROL_RUNS;
    const controlSeed = input.controlSeed ?? TRADE_LEDGER_CONTROL_SEED;
    const controlStartedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
    let calibratedP = 0;
    let calibrationReplays = 0;
    if (controlRuns > 0) {
        calibratedP = calibratedRandomRule(
            base.rows,
            base.admitted.length,
            base.replayParams,
            input.replay.shift,
            controlSeed + 1,
            prepared.ruleRows,
            true,
            undefined,
            prepared.controlPairs,
        ).calibratedP;
        calibrationReplays = 1;
    }
    const results = controlRuns > 0
        ? await controlRunner({
            controlRuns,
            controlSeed,
            calibratedP,
            replay: base.replayParams,
            shift: input.replay.shift,
            splitTime: base.split.splitTime,
        })
        : [];
    if (results.length !== Math.max(0, controlRuns)) {
        throw new Error(`Control runner returned ${results.length} results for ${controlRuns} requested runs.`);
    }
    return buildLedgerRuleEvaluation(
        input,
        base,
        results,
        (typeof performance !== "undefined" ? performance.now() : Date.now()) - controlStartedAt,
        calibrationReplays,
        prepared.controlRows.length * results.length,
    );
}

function fmt(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : value.toFixed(4);
}

function pct(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : `${value.toFixed(4)}%`;
}

function signedPp(value: number | null | undefined): string {
    return value === null || value === undefined || !Number.isFinite(value) ? "n/a" : `${value >= 0 ? "+" : ""}${value.toFixed(4)}pp`;
}

export function buildCheckerReportLines(input: CheckerReportInput, evaluation: LedgerRuleEvaluation): string[] {
    const rows = input.rows;
    const total = rows.length;
    const split = evaluation.split;
    const pairResults = evaluation.pairResults;
    const admitted = evaluation.admitted;
    const admittedIs = admitted.filter((r) => r.signalTime < split.splitTime);
    const admittedHoldout = admitted.filter((r) => r.signalTime >= split.splitTime);
    const totalCandidates = evaluation.resultInput.candidates;
    const totalAdmitted = evaluation.resultInput.kept;
    const isStats = evaluation.isStats;
    const holdoutStats = evaluation.holdoutStats;
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
        `candidates: total=${totalCandidates} admitted=${totalAdmitted} rejectedByRule=${pairResults.reduce((s, r) => s + r.rejectedByRule, 0)} blocked=${pairResults.reduce((s, r) => s + r.blocked, 0)} rightCensored=${evaluation.rightCensored}`,
        "note: per-pair replay admits trades from ALL candidates (rule applied before ordering); pairs are independent in the engine — there is NO global cross-pair capital replay.",
        "note: the PRIMARY rule-vs-control comparison is per-trade pnl deltas; compounded total return and max drawdown are scale-dependent at large per-trade means and are informational only.",
        `ranks joined: ${input.joinedRankCount}/${total} rows matched signal-ranks.jsonl`,
        `rule: ${input.ruleName}`,
        `kept: ${totalAdmitted}/${totalCandidates} (${pct(totalCandidates > 0 ? totalAdmitted / totalCandidates * 100 : 0)} of candidates)`,
        `RULE ${input.ruleName} kept=${totalAdmitted}/${totalCandidates}`
            + ` (${fmt(totalCandidates > 0 ? totalAdmitted / totalCandidates * 100 : 0)}%)`
            + ` isMeanPnl=${pct(isStats.meanPnlPercent)}`
            + ` isMedianPnl=${pct(isStats.medianPnlPercent)}`
            + ` isHitRate=${pct(isStats.hitRatePercent)}`
            + ` isMeanPnlVsControl=${signedPp(evaluation.isMeanPnlDelta)}`
            + ` isMedianPnlVsControl=${signedPp(evaluation.isMedianPnlDelta)}`,
        "",
        `IS slice (first ${TRADE_LEDGER_IS_FRACTION * 100}% of global calendar range; split at ${new Date(split.splitTime * 1000).toISOString()}): trades=${admittedIs.length}`,
        `  meanPnl=${pct(isStats.meanPnlPercent)} medianPnl=${pct(isStats.medianPnlPercent)} hitRate=${pct(isStats.hitRatePercent)}`,
        `  scale-dependent (compounded): totalReturn=${pct(isStats.totalReturnPercent)} maxDrawdown=${pct(isStats.maxDrawdownPercent)}`,
        `HOLDOUT slice (last ${(1 - TRADE_LEDGER_IS_FRACTION) * 100}%) — sealed - finalists only: trades=${admittedHoldout.length}`,
        `  meanPnl=${pct(holdoutStats.meanPnlPercent)} medianPnl=${pct(holdoutStats.medianPnlPercent)} hitRate=${pct(holdoutStats.hitRatePercent)}`,
        `  scale-dependent (compounded): totalReturn=${pct(holdoutStats.totalReturnPercent)} maxDrawdown=${pct(holdoutStats.maxDrawdownPercent)}`,
        `random control: ${evaluation.controlRuns} seeded replay filters (base seed ${input.controlSeed ?? TRADE_LEDGER_CONTROL_SEED}; two-pass keep-rate calibration targeting ${totalAdmitted} admits)`,
        `  controlIsMeanPnl=${pct(evaluation.controlIsMeanPnl)} controlIsMedianPnl=${pct(evaluation.controlIsMedianPnl)} (per-trade, mean across controls)`,
        `  scale-dependent (compounded): meanIsTotalReturn=${pct(evaluation.controlMean)} medianIsTotalReturn=${pct(evaluation.controlMedian)}`,
        `rule vs control (per-trade, primary): isMeanPnlDelta=${signedPp(evaluation.isMeanPnlDelta)} isMedianPnlDelta=${signedPp(evaluation.isMedianPnlDelta)} holdoutMeanPnlDelta=${signedPp(evaluation.holdoutMeanPnlDelta)} holdoutMedianPnlDelta=${signedPp(evaluation.holdoutMedianPnlDelta)}`,
        "",
        "per-pair admitted vs total candidates:",
        ...pairResults.map((r) =>
            `  ${r.pair}: candidates=${r.candidates} admitted=${r.admitted} rejectedByRule=${r.rejectedByRule} blocked=${r.blocked} rightCensored=${r.rightCensored}`),
    ];
    return lines;
}

/** Evaluate one rule and return its structured values with stable report lines. */
export function evaluateTradeLedgerRuleWithReport(input: CheckerReportInput): LedgerRuleEvaluationWithReport {
    const evaluation = evaluateTradeLedgerRule(input);
    return {
        evaluation,
        resultInput: evaluation.resultInput,
        reportLines: buildCheckerReportLines(input, evaluation),
    };
}

/** Evaluate one rule with server-side parallel random controls. */
export async function evaluateTradeLedgerRuleWithReportAsync(
    input: CheckerReportInput,
    controlRunner: TradeLedgerControlRunner,
): Promise<LedgerRuleEvaluationWithReport> {
    const evaluation = await evaluateTradeLedgerRuleAsync(input, controlRunner);
    return {
        evaluation,
        resultInput: evaluation.resultInput,
        reportLines: buildCheckerReportLines(input, evaluation),
    };
}

/** Assemble the legacy stable replay report. */
export function buildCheckerReport(input: CheckerReportInput): string {
    return evaluateTradeLedgerRuleWithReport(input).reportLines.join("\n");
}

/** Keep the provenance type reachable from the pure-core public surface. */
export type { TradeLedgerProvenance };
