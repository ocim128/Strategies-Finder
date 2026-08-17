/**
 * Fresh-entry detector for the Finder Asset Opportunity scope.
 *
 * Given a `BacktestResult` produced by re-running a strategy on the FULL closed
 * data (including the reserved application candle), this leaf resolves whether
 * the latest closed candle produced a NEW entry, an active (still-open) state
 * signal, or no position at all.
 *
 * Detection semantics — match the canonical `signal-entry-evaluator` model:
 *
 * - "fresh": the latest executed entry trade's source signal bar is within
 *   the requested freshness window (strictly the latest closed candle by
 *   default). A reversal (entry on the opposite side) on the latest bar
 *   counts as fresh. The trade itself is typically still open
 *   (exitReason === "end_of_data"), but the freshness determination is
 *   anchored on the signal bar, not the open/closed state.
 * - "active": there is an open position (latest trade exitReason ===
 *   "end_of_data") but its entry signal fired on an earlier bar — i.e. a
 *   repeated state signal, not a new opportunity.
 * - "flat": no open position and no fresh entry. Either no trades at all, or
 *   the latest trade already closed before the latest candle.
 *
 * The latest trade's `entryTime` is matched against candle times to find the
 * source signal bar. When the execution model is `next_open` or `next_close`,
 * the entry fill happens one bar after the signal; we walk back one bar from
 * the entry bar to find the signal bar (mirrors `getExecutionShift`).
 *
 * Leaf import hygiene: only depends on `../types/strategies` (types),
 * `../strategies/backtest/backtest-utils`, and the import-free
 * `../time-normalization` leaf. No `lightweight-charts` reach, so it is safe
 * for the Vite config bundle.
 */

import type {
    BacktestResult,
    BacktestSettings,
    OHLCVData,
    Signal,
    Time,
    Trade,
} from "../types/strategies";
import type {
    FinderAssetDirection,
    FinderAssetFillTiming,
    FinderAssetFreshStatus,
} from "../types/finder";
import { allowsSignalAsEntry, normalizeTradeDirection } from "../strategies/backtest/backtest-utils";
import { parseTimeToUnixSeconds } from "../time-normalization";

/**
 * Resolved fresh-entry status for one candidate's latest closed-candle backtest.
 * `signalAgeBars` is the offset from the latest closed candle (0 = signal on
 * the latest bar; positive = older). `latestSignalTime` is null only when no
 * entry signal exists at all.
 */
export interface FinderFreshEntryResult {
    freshStatus: FinderAssetFreshStatus;
    direction: FinderAssetDirection | null;
    /** Signal time of the latest entry, in unix seconds. Null when no signal. */
    latestSignalTime: Time | null;
    signalAgeBars: number;
    /** Modeled entry timing of the latest trade. */
    fillTiming: FinderAssetFillTiming | null;
    /** True iff the latest trade is still open (exitReason === "end_of_data"). */
    isOpen: boolean;
    /** The latest executed entry trade, or null when no trades exist. */
    latestTrade: Trade | null;
}

/**
 * Resolve the signal-bar index for a given trade entry time. Walks back one bar
 * for `next_open`/`next_close` execution models to find the source signal bar.
 */
function resolveSignalBarIndex(
    entryTimeSec: number,
    candles: OHLCVData[],
    executionShift: number,
): number {
    // Find the entry fill bar: last bar whose time <= entryTimeSec.
    let entryBarIndex = -1;
    for (let i = candles.length - 1; i >= 0; i--) {
        const barSec = parseTimeToUnixSeconds(candles[i]!.time);
        if (barSec !== null && barSec <= entryTimeSec) {
            entryBarIndex = i;
            break;
        }
    }
    if (entryBarIndex < 0) return -1;
    const signalBarIndex = entryBarIndex - executionShift;
    return signalBarIndex >= 0 ? signalBarIndex : -1;
}

/**
 * Find the latest executed entry trade by entry time (ties broken by trade id).
 * Lifted from `signal-entry-evaluator.ts:pickLatestExecutedEntryTrade`.
 */
function pickLatestEntryTrade(trades: Trade[]): { trade: Trade; entryTimeSec: number } | null {
    let latest: { trade: Trade; entryTimeSec: number } | null = null;
    for (const trade of trades) {
        const entryTimeSec = parseTimeToUnixSeconds(trade.entryTime);
        if (entryTimeSec === null) continue;
        if (
            latest === null
            || entryTimeSec > latest.entryTimeSec
            || (entryTimeSec === latest.entryTimeSec && trade.id > latest.trade.id)
        ) {
            latest = { trade, entryTimeSec };
        }
    }
    return latest;
}

/**
 * Resolve the modeled fill timing from normalized backtest settings.
 */
function resolveFillTiming(settings: BacktestSettings | undefined): FinderAssetFillTiming {
    const model = settings?.executionModel;
    if (model === "next_open") return "next_open";
    if (model === "next_close") return "next_close";
    return "signal_close";
}

/**
 * Execution shift in bars: 0 for `signal_close`, 1 for `next_open`/`next_close`.
 * Matches `getExecutionShift` in `lib/strategies/backtest/backtest-utils.ts`.
 */
function executionShiftFromSettings(settings: BacktestSettings | undefined): number {
    return settings?.executionModel === "signal_close" ? 0 : 1;
}

function findLatestEntrySignal(args: {
    signals: Signal[] | undefined;
    candles: OHLCVData[];
    settings?: BacktestSettings;
    maxAgeBars: number;
}): { signal: Signal; direction: FinderAssetDirection; signalAgeBars: number } | null {
    if (!args.signals || args.signals.length === 0) return null;
    const tradeDirection = normalizeTradeDirection(args.settings);
    const latestCandleIndex = args.candles.length - 1;
    for (let signalAgeBars = 0; signalAgeBars <= args.maxAgeBars; signalAgeBars += 1) {
        const candle = args.candles[latestCandleIndex - signalAgeBars];
        if (!candle) continue;
        const candleTimeSec = parseTimeToUnixSeconds(candle.time);
        if (candleTimeSec === null) continue;
        let latest: { signal: Signal; direction: FinderAssetDirection; signalAgeBars: number } | null = null;
        for (const signal of args.signals) {
            if (!allowsSignalAsEntry(signal.type, tradeDirection)) continue;
            if (parseTimeToUnixSeconds(signal.time) !== candleTimeSec) continue;
            latest = {
                signal,
                direction: signal.type === "sell" ? "short" : "long",
                signalAgeBars,
            };
        }
        if (latest) return latest;
    }
    return null;
}

/**
 * Detect the fresh-entry status for a candidate's latest closed-candle backtest.
 *
 * The caller must pass the FULL closed dataset (including the reserved
 * application candle) so the detector can resolve the signal bar of the latest
 * trade against the candle that ends the historical window.
 *
 * Returns `{ freshStatus: "flat", direction: null, ... }` when no trades exist.
 */
export function detectFreshEntry(args: {
    result: BacktestResult;
    candles: OHLCVData[];
    settings?: BacktestSettings;
    signals?: Signal[];
    /**
     * Maximum source-signal age accepted as fresh. The default is 0, which
     * preserves the strict latest-signal semantics used by generic callers.
     * Asset Opportunity passes 1 for next-bar execution so a signal that fills
     * on the latest candle is not discarded solely because its source signal
     * was on the preceding candle.
     */
    freshnessBars?: number;
}): FinderFreshEntryResult {
    const { result, candles, settings } = args;
    const freshnessBars = Number.isFinite(args.freshnessBars)
        ? Math.max(0, Math.floor(args.freshnessBars!))
        : 0;
    const fallback: FinderFreshEntryResult = {
        freshStatus: "flat",
        direction: null,
        latestSignalTime: null,
        signalAgeBars: Number.POSITIVE_INFINITY,
        fillTiming: null,
        isOpen: false,
        latestTrade: null,
    };
    if (candles.length === 0) {
        return fallback;
    }

    const latestEntrySignal = findLatestEntrySignal({
        signals: args.signals,
        candles,
        settings,
        maxAgeBars: freshnessBars,
    });
    const executionShift = executionShiftFromSettings(settings);

    if (!Array.isArray(result.trades) || result.trades.length === 0) {
        // In next_open/next_close mode, a signal on the latest closed candle
        // has no fill yet: the modeled entry occurs on the next bar. It is
        // still a fresh opportunity, so use the signal instead of requiring a
        // trade that cannot exist until another candle arrives.
        if (executionShift > 0 && latestEntrySignal) {
            return {
                freshStatus: "fresh",
                direction: latestEntrySignal.direction,
                latestSignalTime: latestEntrySignal.signal.time,
                signalAgeBars: latestEntrySignal.signalAgeBars,
                fillTiming: resolveFillTiming(settings),
                isOpen: false,
                latestTrade: null,
            };
        }
        return fallback;
    }

    const latest = pickLatestEntryTrade(result.trades);
    if (!latest) return fallback;
    const { trade: latestTrade, entryTimeSec } = latest;

    const signalBarIndex = resolveSignalBarIndex(entryTimeSec, candles, executionShift);
    const signalTimeSec = signalBarIndex >= 0 ? parseTimeToUnixSeconds(candles[signalBarIndex]!.time) : null;

    const lastCandleIndex = candles.length - 1;
    const signalAgeBars = signalBarIndex >= 0 ? lastCandleIndex - signalBarIndex : Number.POSITIVE_INFINITY;
    const isOpen = latestTrade.exitReason === "end_of_data";
    const direction: FinderAssetDirection = latestTrade.type === "short" ? "short" : "long";

    if (
        executionShift > 0
        && latestEntrySignal
        && latestEntrySignal.signalAgeBars === 0
        && (!isOpen || latestEntrySignal.direction !== direction)
    ) {
        return {
            freshStatus: "fresh",
            direction: latestEntrySignal.direction,
            latestSignalTime: latestEntrySignal.signal.time,
            signalAgeBars: 0,
            fillTiming: resolveFillTiming(settings),
            isOpen,
            latestTrade,
        };
    }

    let freshStatus: FinderAssetFreshStatus;
    if (signalAgeBars <= freshnessBars) {
        // The signal fired within the caller's freshness window. This includes
        // reversals (entry on the opposite side) and brand-new entries from
        // flat. Asset Opportunity uses a one-bar window for next-bar fills.
        freshStatus = "fresh";
    } else if (isOpen) {
        // Position is open but entered on an earlier bar: a repeated state
        // signal, not a fresh opportunity.
        freshStatus = "active";
    } else {
        freshStatus = "flat";
    }

    return {
        freshStatus,
        direction,
        latestSignalTime: signalTimeSec !== null ? candles[signalBarIndex]!.time : null,
        signalAgeBars,
        fillTiming: resolveFillTiming(settings),
        isOpen,
        latestTrade,
    };
}

