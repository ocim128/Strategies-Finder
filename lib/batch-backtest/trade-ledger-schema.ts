/**
 * Data-only trade-ledger v2 schema and fixed feature constants.
 *
 * Keep this leaf free of filesystem, browser, and writer imports so replay
 * consumers can share the schema without pulling in the exporter.
 */

import type { AsIfPairModel } from "./trade-ledger-asif";
import type {
    ExecutionModel,
    OHLCVData,
    Signal,
    Trade,
    TradeDirection,
} from "../types/strategies";

// ============================================================================
// Constants (bump versions whenever the schema or the feature set changes)
// ============================================================================

export const TRADE_LEDGER_VERSION = 2;
export const TRADE_LEDGER_FEATURE_VERSION = 2;
export const TRADE_LEDGER_DEFAULT_FOLDER = "archive/mining-ledger";

/** Fixed feature ATR period — independent of the user's backtest ATR settings. */
export const TRADE_LEDGER_FEATURE_ATR_PERIOD = 14;
/** Lookback bars for `feat_return20`. */
export const TRADE_LEDGER_FEATURE_RETURN_BARS = 20;
/** `feat_pairWinRatePrior` stays null until this many prior executed trades. */
export const TRADE_LEDGER_PAIR_WIN_RATE_MIN_PRIOR = 5;

/**
 * Outcome-ish fields a checker rule must NEVER read: realized outcomes, the
 * as-if outcomes, and the original run's survivorship (`executed` /
 * `notExecutedReason` — conditioning on them is survivorship lookahead).
 */
export const TRADE_LEDGER_RULE_FORBIDDEN_FIELDS = [
    "exitTime",
    "exitPrice",
    "pnlPercent",
    "fees",
    "exitReason",
    "asIf",
    "asIfReason",
    "executed",
    "notExecutedReason",
] as const;

/** Fields a checker rule MAY read (identity/entry only; plus any `feat_*`). */
export const TRADE_LEDGER_RULE_ALLOWED_FIELDS = [
    "ledgerVersion",
    "pair",
    "direction",
    "signalTime",
    "signalBarIndex",
    "fillTime",
    "fillPrice",
    "feat_entryRangePosition",
    "feat_atrPct",
    "feat_return20",
    "feat_gapPct",
    "feat_dow",
    "feat_hour",
    "feat_pairWinRatePrior",
    "feat_pairTradesPrior",
    "feat_rank",
    "feat_candidatesAtTime",
] as const;

export type TradeLedgerDirection = "long" | "short";
export type TradeLedgerNotExecutedReason =
    | "position_open"
    | "cooldown"
    | "match_missing"
    | "no_fill_bar"
    | "engine_skip";

export interface TradeLedgerAsIfOutcome {
    fillTime: number;
    fillPrice: number;
    exitTime: number;
    exitPrice: number;
    pnlPercent: number;
    barsHeld: number;
    exitReason: string;
}

export interface TradeLedgerRow {
    ledgerVersion: number;
    pair: string;
    direction: TradeLedgerDirection;
    /** Decision-bar time, unix seconds. */
    signalTime: number;
    signalBarIndex: number;
    /** Fill time/price (unix seconds). Null when the signal had no fill bar. */
    fillTime: number | null;
    fillPrice: number | null;
    executed: boolean;
    notExecutedReason: TradeLedgerNotExecutedReason | null;
    // ── Causal features: bars at or before the signal bar only ──
    /** Signal-bar close located within the PRIOR bar's [low, high] range (percent). */
    feat_entryRangePosition: number | null;
    /** ATR(TRADE_LEDGER_FEATURE_ATR_PERIOD) / close * 100 at the signal bar. */
    feat_atrPct: number | null;
    /** Percent return from close[i - RETURN_BARS] to close[i]. */
    feat_return20: number | null;
    /** This bar's open vs prior close (percent). */
    feat_gapPct: number | null;
    /** UTC day-of-week (0 = Sunday) of the signal bar. */
    feat_dow: number | null;
    /** UTC hour (0-23) of the signal bar. */
    feat_hour: number | null;
    /** Trailing win rate of THIS pair's earlier executed trades in this run. */
    feat_pairWinRatePrior: number | null;
    /** Count of those prior executed trades. */
    feat_pairTradesPrior: number;
    /** Joined from signal-ranks.jsonl at check time; null in ledger rows. */
    feat_rank: number | null;
    feat_candidatesAtTime: number | null;
    /**
     * As-if outcome for EVERY entry signal (engine math, see
     * trade-ledger-asif.ts). Null ONLY when right-censored (no fill bar) or
     * when the run is not replay-eligible — never zero-filled.
     */
    asIf: TradeLedgerAsIfOutcome | null;
    asIfReason: "right_censored" | "replay_ineligible" | null;
    // ── Outcome fields, executed rows ONLY (never present otherwise) ──
    exitTime?: number;
    exitPrice?: number;
    pnlPercent?: number;
    fees?: number;
    exitReason?: Trade["exitReason"];
}

export interface TradeLedgerRankRow {
    signalTime: number;
    pair: string;
    rank: number;
    candidatesAtTime: number;
}

export interface TradeLedgerPairSuppression {
    pair: string;
    signals: number;
    executed: number;
    notExecuted: number;
    suppressionRate: number;
}

export interface TradeLedgerSummary {
    ledgerVersion: number;
    featureVersion: number;
    runId: string;
    startedAt: string;
    finishedAt: string;
    cancelled: boolean;
    ledgerComplete: boolean;
    failedWrites: number;
    lastError: string | null;
    totals: {
        pairs: number;
        signals: number;
        executed: number;
        notExecuted: number;
    };
    suppressionRate: number;
    rightCensored: number;
    duplicateSignalsCollapsed: number;
    /** W4 pair accounting (see the comment at the construction site). */
    submittedPairs: number;
    loadedPairs: number;
    rowBearingPairs: number;
    emptyPairs: number;
    /** Pairs whose rows were dropped by a failed append (audit W2). */
    failedPairs: string[];
    perPairSuppression: TradeLedgerPairSuppression[];
    topSuppressedPairs: TradeLedgerPairSuppression[];
}

export interface TradeLedgerProvenance {
    ledgerVersion: number;
    featureVersion: number;
    runId: string;
    startedAt: string;
    interval: string;
    strategyKey: string;
    strategyParams: Record<string, unknown>;
    backtestSettings: Record<string, unknown>;
    capitalSettings: Record<string, unknown>;
    engineMode: "typescript" | "rust_preferred";
    executionModel: string;
    tradeDirection: string;
    riskMode: string;
    fees: { commissionPercent: number; slippageBps: number };
    pairCount: number;
    symbols: string[];
    /** Replay contract for the offline checker. */
    replay: TradeLedgerReplayProvenance;
}

export interface TradeLedgerReplayProvenance {
    /** False when ANY replayBlocker applies — the checker must refuse replay. */
    replayEligible: boolean;
    replayBlockers: string[];
    /** Resolved position-state parameters the replay state machine needs. */
    maxOpenTrades: number | "unlimited";
    cooldownBars: number;
    executionModel: string;
    tradeDirection: string;
    allowSameBarExit: boolean;
    disableSignalExits: boolean;
    slippageRate: number;
    commissionRate: number;
}

/** Resolved per-run settings the row builder needs (mirrors the engine gate). */
export interface TradeLedgerRowContext {
    tradeDirection: TradeDirection;
    executionModel: ExecutionModel;
    /** Infinity for unlimited overlap (resolved settings may carry Infinity). */
    maxOpenTrades: number;
    cooldownBars: number;
    slippageRate: number;
}

export interface TradeLedgerFinalizeResult {
    ledgerComplete: boolean;
    failedWrites: number;
    lastError: string | null;
    totals: { pairs: number; signals: number; executed: number; notExecuted: number };
}

/** Writer-side arguments retained here so the exporter can re-export its old API. */
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
