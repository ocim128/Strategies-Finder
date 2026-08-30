/**
 * Trade Ledger exporter for server-side Batch runs (v2).
 *
 * While a Batch run executes with the ledger toggle ON, the vite plugin
 * (`batch-backtest-vite-plugin.ts`) writes one run folder containing:
 *   - `provenance.json`   — run config snapshot + replay eligibility (start)
 *   - `ledger.jsonl`      — one line per ENTRY SIGNAL, appended per pair inside
 *                           the awaited `onSymbolComplete` path (audit F2 shape)
 *   - `signal-ranks.jsonl`— cross-sectional rank of each signal among the
 *                           signals fired at the same timestamp (run end)
 *   - `summary.json`      — totals, per-pair suppression rates, completeness
 *
 * v2 adds the AS-IF outcome per entry signal (`asIf`), computed with the
 * engine's own math by `trade-ledger-asif.ts`, so the offline checker can
 * REPLAY admission rules over all candidates instead of scoring only the
 * original run's executed survivors. `asIf` is null only for right-censored
 * signals (no fill bar near data end) — or when the run config is not
 * replay-eligible (`asIfReason: "replay_ineligible"`; the checker refuses
 * those folders anyway).
 *
 * The ledger is a pure side artifact: every function here only READS the
 * runner's rows, and any write failure is recorded (`ledgerComplete: false`)
 * instead of failing the batch run.
 *
 * Import hygiene: this module is bundled into the vite.config.ts esbuild bundle
 * (via the plugin). It may import only node builtins and pure lib leaf modules
 * — nothing that reaches `lightweight-charts` / `constants.ts` /
 * `chart-manager.ts`.
 */

import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { calculateATR } from "../strategies/indicators";
import { parseTimeToUnixSeconds } from "../time-normalization";
import {
    allowsSignalAsEntry,
    getExecutionShift,
    resolveExecutionPrice,
    signalToPositionDirection,
} from "../strategies/backtest/backtest-utils";
import { debugLogger } from "../debug-logger";
import {
    resolveAsIfOutcome,
    type AsIfPairModel,
} from "./trade-ledger-asif";
import type { NormalizedSettings } from "../types/backtest";
import type {
    OHLCVData,
    Signal,
    Trade,
    TradeDirection,
} from "../types/strategies";

import {
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_FEATURE_ATR_PERIOD,
    TRADE_LEDGER_FEATURE_RETURN_BARS,
    TRADE_LEDGER_PAIR_WIN_RATE_MIN_PRIOR,
    TRADE_LEDGER_VERSION,
    type TradeLedgerFinalizeResult,
    type TradeLedgerNotExecutedReason,
    type TradeLedgerPairSuppression,
    type TradeLedgerProvenance,
    type TradeLedgerRow,
    type TradeLedgerRowContext,
    type TradeLedgerSummary,
} from "./trade-ledger-schema";
export {
    TRADE_LEDGER_DEFAULT_FOLDER,
    TRADE_LEDGER_FEATURE_VERSION,
    TRADE_LEDGER_FEATURE_ATR_PERIOD,
    TRADE_LEDGER_FEATURE_RETURN_BARS,
    TRADE_LEDGER_PAIR_WIN_RATE_MIN_PRIOR,
    TRADE_LEDGER_RULE_ALLOWED_FIELDS,
    TRADE_LEDGER_RULE_FORBIDDEN_FIELDS,
    TRADE_LEDGER_VERSION,
    type TradeLedgerAsIfOutcome,
    type TradeLedgerDirection,
    type TradeLedgerFinalizeResult,
    type TradeLedgerNotExecutedReason,
    type TradeLedgerPairSuppression,
    type TradeLedgerProvenance,
    type TradeLedgerReplayProvenance,
    type TradeLedgerRankRow,
    type TradeLedgerRow,
    type TradeLedgerRowContext,
    type TradeLedgerSummary,
} from "./trade-ledger-schema";

export {
    buildBatchRunLedgerBodyField,
    type TradeLedgerRunOptions,
} from "./trade-ledger-wire";

// ============================================================================
// Folder helpers
// ============================================================================

/**
 * Validate a user-supplied ledger folder. Returns a normalized relative path
 * (`/`-separated, no drive letters, no absolute root, no `.`/`..` segments),
 * or null when the input is not a safe relative folder.
 */
export function sanitizeTradeLedgerFolder(raw: unknown): string | null {
    if (typeof raw !== "string") return null;
    const trimmed = raw.trim().replace(/\\/g, "/");
    if (!trimmed || trimmed.length > 200) return null;
    if (/^[a-zA-Z]:/.test(trimmed) || trimmed.startsWith("/")) return null;
    const parts = trimmed.split("/");
    for (const part of parts) {
        if (!part || part === "." || part === "..") return null;
    }
    return parts.join("/");
}

/** `yyyy-MM-dd_HHmm` local-time stamp for the run folder name. */
export function formatLedgerRunStamp(ms: number): string {
    const d = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, "0");
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}_${pad(d.getHours())}${pad(d.getMinutes())}`;
}

// ============================================================================
// Row builder — pure, read-only over the pair's row
// ============================================================================

export interface BuildTradeLedgerRowsArgs {
    pair: string;
    data: OHLCVData[];
    signals: readonly Signal[] | undefined;
    trades: readonly Trade[] | undefined;
    context: TradeLedgerRowContext;
    /** Per-pair as-if model; null/undefined when the run is replay-ineligible. */
    asIfModel?: AsIfPairModel | null;
}

export interface TradeLedgerPairRows {
    rows: TradeLedgerRow[];
    /** Same-direction signals collapsed onto an already-seen decision bar. */
    duplicatesCollapsed: number;
    rightCensored: number;
}

/**
 * Build one ledger row per ENTRY SIGNAL for a single pair.
 *
 * Entry candidates mirror the engine's own gate: `allowsSignalAsEntry` under
 * the run's resolved tradeDirection (exit-only signals from the Exit Strategy
 * Override are never entries). Signals are sorted by DECISION time (stable)
 * before trailing per-pair statistics are computed, and duplicate
 * same-direction signals on one decision bar collapse deterministically
 * (first wins, counted). Fill time/price mirror `prepareSignals`' execution
 * shift. Signals are matched to executed trades by (direction, fillTime,
 * entryPrice within slippage tolerance). All features read bars at or before
 * the signal bar. Every row carries an as-if outcome (engine math) unless
 * right-censored or the run is replay-ineligible.
 */
export function buildTradeLedgerRowsForPair(args: BuildTradeLedgerRowsArgs): TradeLedgerPairRows {
    const { pair, data, signals, trades, context, asIfModel } = args;
    if (!signals || signals.length === 0 || !data || data.length === 0) {
        return { rows: [], duplicatesCollapsed: 0, rightCensored: 0 };
    }

    const closes: number[] = new Array(data.length);
    const highs: number[] = new Array(data.length);
    const lows: number[] = new Array(data.length);
    const barSecs: (number | null)[] = new Array(data.length);
    for (let i = 0; i < data.length; i += 1) {
        const bar = data[i]!;
        closes[i] = bar.close;
        highs[i] = bar.high;
        lows[i] = bar.low;
        barSecs[i] = parseTimeToUnixSeconds(bar.time);
    }
    const atr = calculateATR(highs, lows, closes, TRADE_LEDGER_FEATURE_ATR_PERIOD);

    // Trade lookup: (direction | fill time) bucket, matched by entry price
    // within the run's slippage tolerance (the engine applies slippage to the
    // fill price; commission does not alter entryPrice).
    const tradeBuckets = new Map<string, Trade[]>();
    const tradeSecs = new Map<Trade, { entry: number | null; exit: number | null }>();
    for (const trade of trades ?? []) {
        const entrySec = parseTimeToUnixSeconds(trade.entryTime);
        const exitSec = parseTimeToUnixSeconds(trade.exitTime);
        tradeSecs.set(trade, { entry: entrySec, exit: exitSec });
        if (entrySec === null) continue;
        const key = `${trade.type}|${entrySec}`;
        const bucket = tradeBuckets.get(key);
        if (bucket) bucket.push(trade);
        else tradeBuckets.set(key, [trade]);
    }
    const claimed = new Set<Trade>();
    const executedSoFar: Trade[] = [];
    const executedExitBars: number[] = [];
    // Unlimited overlap resolves to Infinity in the engine — preserve it; a
    // non-finite or non-positive cap means unlimited, never 1.
    const maxOpenTrades = Number.isFinite(context.maxOpenTrades) && context.maxOpenTrades > 0
        ? context.maxOpenTrades
        : Number.POSITIVE_INFINITY;
    const cooldownBars = Math.max(0, context.cooldownBars);
    const rows: TradeLedgerRow[] = [];
    let duplicatesCollapsed = 0;
    let rightCensored = 0;

    // W4: decision-time order (stable) before trailing statistics; W5:
    // (signalBarIndex, direction) identity — first wins, duplicates counted.
    const ordered = signals
        .map((signal, index) => ({ signal, index }))
        .filter(({ signal }) => isEntrySignal(signal, context.tradeDirection))
        .sort((a, b) => {
            const aSec = parseTimeToUnixSeconds(a.signal.time);
            const bSec = parseTimeToUnixSeconds(b.signal.time);
            const aTime = aSec ?? Number.MAX_SAFE_INTEGER;
            const bTime = bSec ?? Number.MAX_SAFE_INTEGER;
            if (aTime !== bTime) return aTime - bTime;
            return a.index - b.index;
        });
    const seenIdentity = new Set<string>();

    for (const { signal } of ordered) {
        const signalBarIndex = resolveSignalBarIndex(signal, barSecs);
        const signalSec = signalBarIndex === -1 ? parseTimeToUnixSeconds(signal.time) : barSecs[signalBarIndex];
        if (signalSec === null) continue;
        const direction = signalToPositionDirection(signal.type);
        const identity = `${signalBarIndex}|${direction}`;
        if (signalBarIndex !== -1) {
            if (seenIdentity.has(identity)) {
                duplicatesCollapsed += 1;
                continue;
            }
            seenIdentity.add(identity);
        }

        const fillBarIndex = signalBarIndex === -1
            ? -1
            : signalBarIndex + getExecutionShift(context as unknown as NormalizedSettings);
        const hasFillBar = fillBarIndex >= 0 && fillBarIndex < data.length;
        const rawFillPrice = hasFillBar
            ? resolveExecutionPrice(data, signal, signalBarIndex, fillBarIndex, context as unknown as NormalizedSettings)
            : null;
        const fillSec = hasFillBar ? barSecs[fillBarIndex] : null;
        const fillPrice =
            rawFillPrice !== null && Number.isFinite(rawFillPrice) && rawFillPrice > 0 ? rawFillPrice : null;

        const matched = matchTrade(
            tradeBuckets.get(`${direction}|${fillSec}`),
            claimed,
            fillPrice,
            context.slippageRate,
        );

        const prior = executedSoFar.length;
        const wins = countWins(executedSoFar);
        const row: TradeLedgerRow = {
            ledgerVersion: TRADE_LEDGER_VERSION,
            pair,
            direction,
            signalTime: signalSec,
            signalBarIndex: signalBarIndex === -1 ? -1 : signalBarIndex,
            fillTime: fillSec,
            fillPrice,
            executed: matched !== null,
            notExecutedReason: matched !== null
                ? null
                : classifyNotExecuted(
                    executedExitBars,
                    tradeSecs,
                    executedSoFar,
                    signalSec,
                    fillBarIndex,
                    hasFillBar,
                    maxOpenTrades,
                    cooldownBars,
                ),
            feat_entryRangePosition:
                signalBarIndex >= 1 && highs[signalBarIndex - 1]! > lows[signalBarIndex - 1]!
                    ? (closes[signalBarIndex]! - lows[signalBarIndex - 1]!)
                      / (highs[signalBarIndex - 1]! - lows[signalBarIndex - 1]!)
                      * 100
                    : null,
            feat_atrPct:
                atr[signalBarIndex] != null && closes[signalBarIndex]! > 0
                    ? (atr[signalBarIndex]! / closes[signalBarIndex]!) * 100
                    : null,
            feat_return20:
                signalBarIndex >= TRADE_LEDGER_FEATURE_RETURN_BARS
                && closes[signalBarIndex - TRADE_LEDGER_FEATURE_RETURN_BARS]! > 0
                    ? (closes[signalBarIndex]! - closes[signalBarIndex - TRADE_LEDGER_FEATURE_RETURN_BARS]!)
                      / closes[signalBarIndex - TRADE_LEDGER_FEATURE_RETURN_BARS]!
                      * 100
                    : null,
            feat_gapPct:
                signalBarIndex >= 1 && closes[signalBarIndex - 1]! > 0
                    ? (data[signalBarIndex]!.open - closes[signalBarIndex - 1]!) / closes[signalBarIndex - 1]! * 100
                    : null,
            feat_dow: utcField(signalSec, (d) => d.getUTCDay()),
            feat_hour: utcField(signalSec, (d) => d.getUTCHours()),
            feat_pairWinRatePrior:
                prior >= TRADE_LEDGER_PAIR_WIN_RATE_MIN_PRIOR ? (wins / prior) * 100 : null,
            feat_pairTradesPrior: prior,
            feat_rank: null,
            feat_candidatesAtTime: null,
            asIf: null,
            asIfReason: null,
        };
        if (matched) {
            executedSoFar.push(matched);
            // The cooldown/overlap reconstruction tracks the TRADE's exit bar,
            // not the signal's fill bar.
            executedExitBars.push(resolveExitBarIndex(barSecs, tradeSecs.get(matched)?.exit ?? null));
            const matchedSecs = tradeSecs.get(matched);
            // Executed rows carry the trade's ACTUAL fill (post-slippage).
            row.fillPrice = matched.entryPrice;
            row.exitTime = matchedSecs?.exit ?? undefined;
            row.exitPrice = matched.exitPrice;
            row.pnlPercent = matched.pnlPercent;
            row.fees = matched.fees ?? 0;
            row.exitReason = matched.exitReason;
        }
        // As-if outcome for EVERY entry signal (v2 replay contract).
        if (asIfModel) {
            if (signalBarIndex === -1) {
                row.asIf = null;
                row.asIfReason = "right_censored";
                rightCensored += 1;
            } else {
                const asIf = resolveAsIfOutcome(asIfModel, data, signalBarIndex, signal);
                if (asIf.outcome) {
                    row.asIf = asIf.outcome;
                } else if (asIf.rightCensored) {
                    row.asIf = null;
                    row.asIfReason = "right_censored";
                    rightCensored += 1;
                } else {
                    // Unreachable today; never zero-fill.
                    row.asIf = null;
                    row.asIfReason = "right_censored";
                    rightCensored += 1;
                }
            }
        } else {
            row.asIf = null;
            row.asIfReason = "replay_ineligible";
        }
        rows.push(row);
    }
    return { rows, duplicatesCollapsed, rightCensored };
}

function isEntrySignal(signal: Signal, tradeDirection: TradeDirection): boolean {
    return signal.exitOnly !== true && allowsSignalAsEntry(signal.type, tradeDirection);
}

/**
 * Resolve the decision bar index for a signal. Prefers the signal's own
 * barIndex when it points at a bar carrying the signal's time; falls back to a
 * binary search over the (time-ordered) dataset.
 */
function resolveSignalBarIndex(signal: Signal, barSecs: (number | null)[]): number {
    const signalSec = parseTimeToUnixSeconds(signal.time);
    if (signalSec === null) return -1;
    const declared = Number.isFinite(signal.barIndex) ? Math.trunc(signal.barIndex as number) : -1;
    if (declared >= 0 && declared < barSecs.length && barSecs[declared] === signalSec) {
        return declared;
    }
    let lo = 0;
    let hi = barSecs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = barSecs[mid];
        if (t === null) return -1;
        if (t === signalSec) return mid;
        if (t < signalSec) lo = mid + 1;
        else hi = mid - 1;
    }
    return -1;
}

function resolveExitBarIndex(barSecs: (number | null)[], exitSec: number | null): number {
    if (exitSec === null) return barSecs.length - 1;
    // Last bar whose time <= exit time (time-ordered data).
    let lo = 0;
    let hi = barSecs.length - 1;
    let found = barSecs.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const t = barSecs[mid];
        if (t === null) break;
        if (t <= exitSec) {
            found = mid;
            lo = mid + 1;
        } else {
            hi = mid - 1;
        }
    }
    return found;
}

function matchTrade(
    bucket: Trade[] | undefined,
    claimed: Set<Trade>,
    fillPrice: number | null,
    slippageRate: number,
): Trade | null {
    if (!bucket || fillPrice === null) return null;
    const tolerance = fillPrice * slippageRate + 1e-9;
    for (const trade of bucket) {
        if (claimed.has(trade)) continue;
        if (Math.abs(trade.entryPrice - fillPrice) <= tolerance) {
            claimed.add(trade);
            return trade;
        }
    }
    return null;
}

/**
 * Approximate the engine's suppression cause for a not-executed candidate.
 * `position_open` when the executed trades of this pair already occupy every
 * open slot at the decision moment; `cooldown` when the run's post-exit entry
 * cooldown blocks the fill bar; `match_missing` when the pair looked FLAT and
 * unblocked but no executed trade matched — a counted matching failure, never
 * a silent drop; `no_fill_bar` for entries beyond the data end; everything
 * else (sizing rejections, confirmation, …) is `engine_skip`.
 */
function classifyNotExecuted(
    executedExitBars: readonly number[],
    tradeSecs: Map<Trade, { entry: number | null; exit: number | null }>,
    executedSoFar: readonly Trade[],
    signalSec: number,
    fillBarIndex: number,
    hasFillBar: boolean,
    maxOpenTrades: number,
    cooldownBars: number,
): TradeLedgerNotExecutedReason {
    if (!hasFillBar) return "no_fill_bar";
    let open = 0;
    let lastExitBar = -1;
    for (let i = 0; i < executedSoFar.length; i += 1) {
        const trade = executedSoFar[i]!;
        const secs = tradeSecs.get(trade);
        if (!secs || secs.entry === null || secs.exit === null) continue;
        if (secs.entry <= signalSec && secs.exit > signalSec) open += 1;
        const exitBar = executedExitBars[i] ?? -1;
        if (exitBar > lastExitBar) lastExitBar = exitBar;
    }
    if (open >= maxOpenTrades) return "position_open";
    if (cooldownBars > 0 && lastExitBar >= 0 && lastExitBar + cooldownBars - 1 >= fillBarIndex) {
        return "cooldown";
    }
    return "match_missing";
}

function countWins(trades: readonly Trade[]): number {
    let wins = 0;
    for (const trade of trades) {
        if (trade.pnlPercent > 0) wins += 1;
    }
    return wins;
}

function utcField(signalSec: number, read: (d: Date) => number): number {
    return read(new Date(signalSec * 1000));
}

// ============================================================================
// Writer — per-run folder with incremental ledger appends
// ============================================================================

export interface TradeLedgerWriterDeps {
    mkdir: typeof mkdir;
    appendFile: typeof appendFile;
    writeFile: typeof writeFile;
    /** Backoff between append retries. Injectable so tests run instantly. */
    delay: (ms: number) => Promise<void>;
}

/** Transient FS errors worth retrying; anything else fails on first attempt. */
const RETRYABLE_LEDGER_ERROR_CODES = new Set(["EBUSY", "EPERM", "ESTALE"]);
const LEDGER_APPEND_MAX_ATTEMPTS = 3;
const LEDGER_APPEND_BACKOFF_MS = [50, 200];

/**
 * Bounded retry for ledger appends (audit W3): on EBUSY/EPERM/ESTALE only,
 * retry up to 3 total attempts with a 50ms/200ms backoff. Any other error, or
 * a final failure, propagates to the caller's loud-but-non-fatal recording.
 */
async function appendWithRetry(deps: TradeLedgerWriterDeps, path: string, data: string): Promise<void> {
    let lastError: unknown;
    for (let attempt = 1; attempt <= LEDGER_APPEND_MAX_ATTEMPTS; attempt += 1) {
        try {
            await deps.appendFile(path, data, "utf8");
            return;
        } catch (error) {
            lastError = error;
            const code = (error as NodeJS.ErrnoException | null)?.code;
            if (!code || !RETRYABLE_LEDGER_ERROR_CODES.has(code) || attempt === LEDGER_APPEND_MAX_ATTEMPTS) {
                throw error;
            }
            await deps.delay(LEDGER_APPEND_BACKOFF_MS[attempt - 1] ?? 200);
        }
    }
    throw lastError;
}

export interface TradeLedgerWriterCreateOptions {
    rootDir: string;
    folder: string;
    runId: string;
    startedAtMs: number;
    provenance: TradeLedgerProvenance;
    deps?: Partial<TradeLedgerWriterDeps>;
}

/** Pair accounting for summary.json (audit W4). */
export interface TradeLedgerPairAccounting {
    /** Pairs submitted in the request (provenance.pairCount). */
    submittedPairs: number;
    /** Pairs whose dataset loaded and ran (output.loadedSymbols). */
    loadedPairs: number;
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const PROVENANCE_FILE = "provenance.json";
const LEDGER_FILE = "ledger.jsonl";
const RANKS_FILE = "signal-ranks.jsonl";
const SUMMARY_FILE = "summary.json";

/**
 * Per-run ledger writer. `create` never throws — a setup failure returns null
 * and logs, so a ledger problem can never fail the batch run (the run's final
 * status surfaces the incompleteness instead). Appends and finalize record
 * failures on the writer and resolve normally.
 */
export class TradeLedgerWriter {
    readonly runDir: string;
    private readonly runId: string;
    private readonly startedAtMs: number;
    private ledgerComplete = true;
    private failedWrites = 0;
    private lastError: string | null = null;
    private finalized = false;
    private rightCensored = 0;
    private duplicateSignalsCollapsed = 0;
    private readonly totals = { signals: 0, executed: 0, notExecuted: 0 };
    private readonly perPair = new Map<string, { signals: number; executed: number }>();
    /** Pairs whose rows were DROPPED by a failed append (audit W2) — not a count only. */
    private readonly failedPairs = new Set<string>();
    /** Bounded (signalTime → distinct pairs) tuples — interned pair strings, no candle data. */
    private readonly rankPairsByTime = new Map<number, Set<string>>();
    private readonly deps: TradeLedgerWriterDeps;

    private constructor(runDir: string, runId: string, startedAtMs: number, deps: TradeLedgerWriterDeps) {
        this.runDir = runDir;
        this.runId = runId;
        this.startedAtMs = startedAtMs;
        this.deps = deps;
    }

    static async create(options: TradeLedgerWriterCreateOptions): Promise<TradeLedgerWriter | null> {
        const deps: TradeLedgerWriterDeps = {
            mkdir: options.deps?.mkdir ?? mkdir,
            appendFile: options.deps?.appendFile ?? appendFile,
            writeFile: options.deps?.writeFile ?? writeFile,
            delay: options.deps?.delay ?? wait,
        };
        const folder = sanitizeTradeLedgerFolder(options.folder);
        if (!folder) {
            debugLogger.warn("batch.server.ledger_invalid_folder", { folder: options.folder });
            return null;
        }
        const dirName = options.runId
            ? `${formatLedgerRunStamp(options.startedAtMs)}_${options.runId}`
            : formatLedgerRunStamp(options.startedAtMs);
        const runDir = join(options.rootDir, folder, dirName);
        const writer = new TradeLedgerWriter(runDir, options.runId, options.startedAtMs, deps);
        try {
            await deps.mkdir(runDir, { recursive: true });
            await deps.writeFile(
                join(runDir, PROVENANCE_FILE),
                JSON.stringify({ ...options.provenance, runId: options.runId }, null, 2),
                "utf8",
            );
        } catch (error) {
            debugLogger.warn("batch.server.ledger_create_failed", {
                runDir,
                error: error instanceof Error ? error.message : String(error),
            });
            return null;
        }
        return writer;
    }

    /** Append one pair's rows as a single incremental write. Never throws. */
    async appendPairRows(pairRows: TradeLedgerPairRows): Promise<void> {
        const rows = pairRows.rows;
        if (rows.length === 0) return;
        try {
            const lines = rows.map((row) => JSON.stringify(row));
            lines.push("");
            await appendWithRetry(this.deps, join(this.runDir, LEDGER_FILE), lines.join("\n"));
            this.duplicateSignalsCollapsed += pairRows.duplicatesCollapsed;
            this.rightCensored += pairRows.rightCensored;
            for (const row of rows) {
                this.totals.signals += 1;
                if (row.executed) this.totals.executed += 1;
                else this.totals.notExecuted += 1;
                const totals = this.perPair.get(row.pair) ?? { signals: 0, executed: 0 };
                totals.signals += 1;
                if (row.executed) totals.executed += 1;
                this.perPair.set(row.pair, totals);
                // Per-time Set of distinct pairs — no repeated `includes` scan
                // inside large same-timestamp buckets.
                let pairs = this.rankPairsByTime.get(row.signalTime);
                if (!pairs) {
                    pairs = new Set<string>();
                    this.rankPairsByTime.set(row.signalTime, pairs);
                }
                pairs.add(row.pair);
            }
        } catch (error) {
            // W2: record WHICH pairs lost rows, not just a count.
            for (const row of rows) this.failedPairs.add(row.pair);
            this.recordFailure(error);
        }
    }

    /**
     * Write `signal-ranks.jsonl` + `summary.json` at run end. Idempotent;
     * never throws. Ranks are 1-based positions of the DISTINCT pairs signaling
     * at each timestamp, ordered ascending by pair symbol.
     */
    async finalize(input: { cancelled: boolean; finishedAtMs: number; accounting?: TradeLedgerPairAccounting }): Promise<TradeLedgerFinalizeResult> {
        if (this.finalized) {
            return {
                ledgerComplete: this.ledgerComplete,
                failedWrites: this.failedWrites,
                lastError: this.lastError,
                totals: { ...this.totals, pairs: this.perPair.size },
            };
        }
        this.finalized = true;

        try {
            const rankLines: string[] = [];
            const times = [...this.rankPairsByTime.keys()].sort((a, b) => a - b);
            for (const time of times) {
                const pairs = [...this.rankPairsByTime.get(time)!].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
                pairs.forEach((pair, index) => {
                    rankLines.push(JSON.stringify({
                        signalTime: time,
                        pair,
                        rank: index + 1,
                        candidatesAtTime: pairs.length,
                    }));
                });
            }
            rankLines.push("");
            await appendWithRetry(this.deps, join(this.runDir, RANKS_FILE), rankLines.join("\n"));
        } catch (error) {
            this.recordFailure(error);
        }

        try {
            const perPair: TradeLedgerPairSuppression[] = [];
            for (const [pair, totals] of this.perPair) {
                const notExecuted = totals.signals - totals.executed;
                perPair.push({
                    pair,
                    signals: totals.signals,
                    executed: totals.executed,
                    notExecuted,
                    suppressionRate: totals.signals > 0 ? notExecuted / totals.signals : 0,
                });
            }
            perPair.sort((a, b) => (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0));
            const topSuppressedPairs = [...perPair]
                .sort((a, b) =>
                    b.suppressionRate - a.suppressionRate
                    || b.notExecuted - a.notExecuted
                    || (a.pair < b.pair ? -1 : a.pair > b.pair ? 1 : 0))
                .slice(0, 20);
            const rowBearingPairs = this.perPair.size;
            const submittedPairs = Math.max(input.accounting?.submittedPairs ?? rowBearingPairs, rowBearingPairs);
            const loadedPairs = Math.min(
                Math.max(input.accounting?.loadedPairs ?? rowBearingPairs, rowBearingPairs),
                submittedPairs,
            );
            const summary: TradeLedgerSummary = {
                ledgerVersion: TRADE_LEDGER_VERSION,
                featureVersion: TRADE_LEDGER_FEATURE_VERSION,
                runId: this.runId,
                startedAt: new Date(this.startedAtMs).toISOString(),
                finishedAt: new Date(input.finishedAtMs).toISOString(),
                cancelled: input.cancelled,
                ledgerComplete: this.ledgerComplete,
                failedWrites: this.failedWrites,
                lastError: this.lastError,
                totals: { pairs: rowBearingPairs, ...this.totals },
                suppressionRate: this.totals.signals > 0 ? this.totals.notExecuted / this.totals.signals : 0,
                // W4 pair accounting: submittedPairs − loadedPairs = pairs that
                // failed to load/run (names ride the run's done event + logs);
                // loadedPairs − rowBearingPairs = loaded pairs with zero entry
                // signals; failedPairs = pairs whose rows were DROPPED by a
                // failed append.
                submittedPairs,
                loadedPairs,
                rowBearingPairs,
                emptyPairs: Math.max(0, loadedPairs - rowBearingPairs),
                failedPairs: [...this.failedPairs].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)),
                rightCensored: this.rightCensored,
                duplicateSignalsCollapsed: this.duplicateSignalsCollapsed,
                perPairSuppression: perPair,
                topSuppressedPairs,
            };
            await this.deps.writeFile(join(this.runDir, SUMMARY_FILE), JSON.stringify(summary, null, 2), "utf8");
        } catch (error) {
            this.recordFailure(error);
        }

        return {
            ledgerComplete: this.ledgerComplete,
            failedWrites: this.failedWrites,
            lastError: this.lastError,
            totals: { ...this.totals, pairs: this.perPair.size },
        };
    }

    private recordFailure(error: unknown): void {
        this.ledgerComplete = false;
        this.failedWrites += 1;
        this.lastError = error instanceof Error ? error.message : String(error);
        debugLogger.warn("batch.server.ledger_write_failed", {
            runDir: this.runDir,
            error: this.lastError,
        });
    }
}
