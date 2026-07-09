/**
 * Compact miner artifact contract (Phase 2 acceleration).
 *
 * The raw `BatchSyntheticPairArtifact` is an array-of-objects (AoS) shape:
 * each candle/signal/trade is a full JS object. On a 1000-pair / 65k-bar 4H
 * run that is ~5-10 GB of small objects, heavy on GC and slow to (de)serialize.
 * This module defines a compact, versioned, struct-of-arrays (SoA) artifact
 * that:
 *
 *   1. Stores OHLCV OHLCV as parallel Float64Arrays (open, high, low, close,
 *      volume) — 5 typed arrays vs N object literals. Lower heap, zero GC
 *      pressure, and directly mappable to Rust slices for the Phase 5 backend.
 *   2. Stores time as the exact `timeKey(bar.time)` string per bar. This is
 *      CRITICAL for parity: the miner's `timeIndex` is keyed by `timeKey(...)`,
 *      which returns the RAW time shape as a string (unix ms `1700000000000`
 *      stays `"1700000000000"`, NOT normalized to seconds). Normalizing time
 *      here would break lookup parity between compact-stored pairs and the
 *      freshly-loaded raw target candles (Phase 2 risk: "Time alignment must
 *      match `timeKey(...)` semantics exactly"). Storing the key string
 *      guarantees `timeKey(roundTrippedBar.time) === timeKey(rawBar.time)`.
 *   3. Stores signals and trades as flat primitive arrays (no nested objects).
 *   4. Carries a schema version so stale artifacts are rejected up front.
 *
 * This is a leaf module: it imports only types, never `lightweight-charts` or
 * any browser-bound singleton. That keeps it safe to import from `worker_threads`
 * and from the Vite config bundle path (see AGENTS.md "Server-side import
 * hygiene"). `timeKey` is duplicated locally (not imported) so this module
 * stays a leaf — the real `timeKey` lives in a `lightweight-charts`-typed
 * module.
 */

import type { BacktestResult, OHLCVData, Signal, Time, Trade } from "../types/strategies";
import type { BatchSyntheticPairArtifact } from "./batch-synthetic-state-miner";

// ---------------------------------------------------------------------------
// Schema version
// ---------------------------------------------------------------------------

/**
 * Compact artifact schema version. Bumped when the on-disk compact shape
 * changes. The server plugin's schema guard rejects any compact artifact whose
 * version does not match this constant, then falls back to the raw-artifact
 * path (Phase 2 fallback contract).
 */
export const COMPACT_MINER_ARTIFACT_SCHEMA_VERSION = 1;

// ---------------------------------------------------------------------------
// Compact pair artifact (struct-of-arrays)
// ---------------------------------------------------------------------------

/**
 * Compact representation of one synthetic pair's OHLCV + signals + trades.
 *
 * OHLCV is stored as 5 parallel Float64Arrays of length `barCount` (`open`,
 * `high`, `low`, `close`, `volume`) plus a `timeKey` string array of length
 * `barCount`. Storing the key string (not a normalized numeric time) is what
 * preserves lookup parity — see the module header.
 *
 * Signals are stored as 4 parallel arrays of length `signalCount`:
 *   `signalTimeKey` (string[]), `signalType` (Uint8Array; 1=buy/long,
 *   2=sell/short), `signalPrice` (Float64Array), `signalBarIndex` (Int32Array;
 *   -1 when the original signal had no barIndex).
 *
 * Trades are stored as 5 parallel arrays of length `tradeCount`:
 *   `tradeType` (Uint8Array; 1=long, 2=short), `tradeEntryTimeKey`,
 *   `tradeEntryPrice`, `tradeExitTimeKey` (string[], Float64Array, string[])
 *   and `tradeExitReason` (Int8Array; 0 = unspecified, 1 = end_of_data,
 *   2 = other). Only `end_of_data` is semantically load-bearing for the miner
 *   (it excludes the trade from closed-range / auto-horizon calibration);
 *   everything else maps to "closed".
 */
export interface CompactPairArtifact {
    schema: typeof COMPACT_MINER_ARTIFACT_SCHEMA_VERSION;
    symbol: string;
    baseAsset: string;
    quoteAsset: string;
    baseSymbol?: string;
    quoteSymbol?: string;
    barCount: number;
    /** Per-bar `timeKey(bar.time)` — the exact lookup key the miner uses. */
    timeKey: string[];
    open: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
    signalCount: number;
    signalTimeKey: string[];
    signalType: Uint8Array;
    signalPrice: Float64Array;
    signalBarIndex: Int32Array;
    tradeCount: number;
    tradeType: Uint8Array;
    tradeEntryTimeKey: string[];
    tradeEntryPrice: Float64Array;
    tradeExitTimeKey: string[];
    tradeExitReason: Int8Array;
}

// ---------------------------------------------------------------------------
// Compact target artifact
// ---------------------------------------------------------------------------

/**
 * Compact representation of one miner target's OHLCV. The miner only needs
 * time + OHLC (no volume) for forward-outcome and adverse-excursion scans, but
 * volume is kept for parity with the pair artifact shape so a single Rust
 * reader covers both.
 */
export interface CompactTargetArtifact {
    schema: typeof COMPACT_MINER_ARTIFACT_SCHEMA_VERSION;
    asset: string;
    symbol: string;
    barCount: number;
    /** Per-bar `timeKey(bar.time)` — the exact lookup key the miner uses. */
    timeKey: string[];
    open: Float64Array;
    high: Float64Array;
    low: Float64Array;
    close: Float64Array;
    volume: Float64Array;
}

// ---------------------------------------------------------------------------
// Conversion: raw -> compact
// ---------------------------------------------------------------------------

/**
 * Convert a raw `BatchSyntheticPairArtifact` to the compact SoA shape.
 *
 * Allocation cost: 5 typed arrays of length `barCount` + a `timeKey` string
 * array + 4 signal arrays + 5 trade arrays. On a 65k-bar / 200-signal / 50-
 * trade pair this is ~3 MB of typed arrays vs ~8-12 MB of object literals, and
 * the typed arrays survive V8 serialization (used by the server plugin)
 * without per-element bookkeeping.
 *
 * Time parity: every time field is stored as its `timeKey(...)` string so the
 * reverse converter reconstructs a `Time` whose key is identical. See the
 * module header for why this is load-bearing.
 */
export function toCompactPairArtifact(raw: BatchSyntheticPairArtifact): CompactPairArtifact {
    const barCount = raw.data.length;
    const timeKeyArr = new Array<string>(barCount);
    const open = new Float64Array(barCount);
    const high = new Float64Array(barCount);
    const low = new Float64Array(barCount);
    const close = new Float64Array(barCount);
    const volume = new Float64Array(barCount);
    for (let i = 0; i < barCount; i += 1) {
        const bar = raw.data[i]!;
        timeKeyArr[i] = localTimeKey(bar.time);
        open[i] = bar.open;
        high[i] = bar.high;
        low[i] = bar.low;
        close[i] = bar.close;
        volume[i] = bar.volume;
    }

    const signals = raw.signals ?? [];
    const signalCount = signals.length;
    const signalTimeKey = new Array<string>(signalCount);
    const signalType = new Uint8Array(signalCount);
    const signalPrice = new Float64Array(signalCount);
    const signalBarIndex = new Int32Array(signalCount);
    for (let i = 0; i < signalCount; i += 1) {
        const signal = signals[i]!;
        signalTimeKey[i] = localTimeKey(signal.time);
        signalType[i] = signal.type === "buy" ? 1 : 2;
        signalPrice[i] = signal.price;
        // barIndex is optional on Signal; store -1 sentinel so the reverse
        // converter can restore `undefined` exactly.
        signalBarIndex[i] = typeof signal.barIndex === "number" && signal.barIndex >= 0 ? signal.barIndex : -1;
    }

    const trades = raw.result?.trades ?? [];
    const tradeCount = trades.length;
    const tradeType = new Uint8Array(tradeCount);
    const tradeEntryTimeKey = new Array<string>(tradeCount);
    const tradeEntryPrice = new Float64Array(tradeCount);
    const tradeExitTimeKey = new Array<string>(tradeCount);
    const tradeExitReason = new Int8Array(tradeCount);
    for (let i = 0; i < tradeCount; i += 1) {
        const trade = trades[i]!;
        tradeType[i] = trade.type === "long" ? 1 : 2;
        tradeEntryTimeKey[i] = localTimeKey(trade.entryTime);
        tradeEntryPrice[i] = trade.entryPrice;
        tradeExitTimeKey[i] = localTimeKey(trade.exitTime);
        tradeExitReason[i] = encodeExitReason(trade.exitReason);
    }

    return {
        schema: COMPACT_MINER_ARTIFACT_SCHEMA_VERSION,
        symbol: raw.symbol,
        baseAsset: raw.baseAsset,
        quoteAsset: raw.quoteAsset,
        baseSymbol: raw.baseSymbol,
        quoteSymbol: raw.quoteSymbol,
        barCount,
        timeKey: timeKeyArr,
        open, high, low, close, volume,
        signalCount,
        signalTimeKey, signalType, signalPrice, signalBarIndex,
        tradeCount,
        tradeType, tradeEntryTimeKey, tradeEntryPrice, tradeExitTimeKey, tradeExitReason,
    };
}

/**
 * Convert a compact pair artifact back to the raw `BatchSyntheticPairArtifact`
 * shape the TypeScript miner consumes. Used by the server plugin when it loads
 * a compact artifact but the miner still expects prepared objects (Phase 2
 * adapter step).
 *
 * The round-trip is lossless for every field the miner reads. `BacktestResult`
 * is reconstructed minimally — only `trades` is load-bearing for the miner;
 * the scalar metrics default to 0 because the miner never reads them (the
 * per-row scalars travel separately via `toScalarRow(...)` and never enter the
 * artifact path).
 */
export function fromCompactPairArtifact(compact: CompactPairArtifact): BatchSyntheticPairArtifact {
    assertCompactSchema(compact);
    const data: OHLCVData[] = new Array(compact.barCount);
    for (let i = 0; i < compact.barCount; i += 1) {
        data[i] = {
            time: timeFromKey(compact.timeKey[i]!),
            open: compact.open[i]!,
            high: compact.high[i]!,
            low: compact.low[i]!,
            close: compact.close[i]!,
            volume: compact.volume[i]!,
        };
    }
    const signals: Signal[] = new Array(compact.signalCount);
    for (let i = 0; i < compact.signalCount; i += 1) {
        const barIndex = compact.signalBarIndex[i]!;
        signals[i] = {
            time: timeFromKey(compact.signalTimeKey[i]!),
            type: compact.signalType[i] === 1 ? "buy" : "sell",
            price: compact.signalPrice[i]!,
            ...(barIndex >= 0 ? { barIndex } : {}),
        };
    }
    const trades: Trade[] = new Array(compact.tradeCount);
    for (let i = 0; i < compact.tradeCount; i += 1) {
        const exitReason = decodeExitReason(compact.tradeExitReason[i]!);
        trades[i] = {
            id: i,
            type: compact.tradeType[i] === 1 ? "long" : "short",
            entryTime: timeFromKey(compact.tradeEntryTimeKey[i]!),
            entryPrice: compact.tradeEntryPrice[i]!,
            exitTime: timeFromKey(compact.tradeExitTimeKey[i]!),
            exitPrice: compact.tradeEntryPrice[i]!, // miner never reads exitPrice; keep entry to stay finite
            pnl: 0,
            pnlPercent: 0,
            size: 0,
            ...(exitReason !== undefined ? { exitReason } : {}),
        } as Trade;
    }
    const result: BacktestResult = {
        trades,
        netProfit: 0,
        netProfitPercent: 0,
        winRate: 0,
        expectancy: 0,
        avgTrade: 0,
        profitFactor: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        totalTrades: trades.length,
        winningTrades: 0,
        losingTrades: 0,
        avgWin: 0,
        avgLoss: 0,
        sharpeRatio: 0,
        equityCurve: [],
    };
    return {
        symbol: compact.symbol,
        baseAsset: compact.baseAsset,
        quoteAsset: compact.quoteAsset,
        ...(compact.baseSymbol !== undefined ? { baseSymbol: compact.baseSymbol } : {}),
        ...(compact.quoteSymbol !== undefined ? { quoteSymbol: compact.quoteSymbol } : {}),
        data,
        signals,
        result,
    };
}

/**
 * Convert a raw target artifact to the compact shape. Targets carry no
 * signals/trades; only OHLCV is needed.
 */
export function toCompactTargetArtifact(raw: { asset: string; symbol: string; data: OHLCVData[] }): CompactTargetArtifact {
    const barCount = raw.data.length;
    const timeKeyArr = new Array<string>(barCount);
    const open = new Float64Array(barCount);
    const high = new Float64Array(barCount);
    const low = new Float64Array(barCount);
    const close = new Float64Array(barCount);
    const volume = new Float64Array(barCount);
    for (let i = 0; i < barCount; i += 1) {
        const bar = raw.data[i]!;
        timeKeyArr[i] = localTimeKey(bar.time);
        open[i] = bar.open;
        high[i] = bar.high;
        low[i] = bar.low;
        close[i] = bar.close;
        volume[i] = bar.volume;
    }
    return {
        schema: COMPACT_MINER_ARTIFACT_SCHEMA_VERSION,
        asset: raw.asset,
        symbol: raw.symbol,
        barCount,
        timeKey: timeKeyArr,
        open, high, low, close, volume,
    };
}

// ---------------------------------------------------------------------------
// Schema guard
// ---------------------------------------------------------------------------

/**
 * Reject artifacts whose schema version does not match the current
 * `COMPACT_MINER_ARTIFACT_SCHEMA_VERSION`. Returns a structured result so the
 * server plugin can fall back to the raw-artifact path with a diagnostic
 * reason (Phase 2 risk mitigation + Phase 4 fallback contract).
 */
export function assertCompactSchema(
    artifact: { schema?: unknown },
): asserts artifact is { schema: typeof COMPACT_MINER_ARTIFACT_SCHEMA_VERSION } {
    if (
        typeof (artifact as { schema?: unknown }).schema !== "number"
        || (artifact as { schema?: number }).schema !== COMPACT_MINER_ARTIFACT_SCHEMA_VERSION
    ) {
        throw new CompactArtifactSchemaError(
            `compact miner artifact schema mismatch: expected ${COMPACT_MINER_ARTIFACT_SCHEMA_VERSION}, got ${
                (artifact as { schema?: unknown }).schema === undefined ? "missing" : String((artifact as { schema?: number }).schema)
            }`,
        );
    }
}

/**
 * Check the schema version without throwing. Used by the server plugin's
 * `loadStoredMineArtifact(...)` to decide compact-vs-raw dispatch on a hot path.
 */
export function isCompactPairArtifact(value: unknown): value is CompactPairArtifact {
    return (
        typeof value === "object" && value !== null
        && (value as { schema?: unknown }).schema === COMPACT_MINER_ARTIFACT_SCHEMA_VERSION
        && Array.isArray((value as CompactPairArtifact).timeKey)
        && (value as CompactPairArtifact).close instanceof Float64Array
    );
}

export class CompactArtifactSchemaError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "CompactArtifactSchemaError";
    }
}

// ---------------------------------------------------------------------------
// Time-key codec (local copy of toTimeKey — see module header)
// ---------------------------------------------------------------------------

/**
 * Local, dependency-free copy of `toTimeKey` / `timeKey`. Duplicated so this
 * module stays a leaf (the real `timeKey` lives in `lib/time-key.ts` which is
 * fine, but the broader re-export at `lib/strategies` pulls types from
 * `lightweight-charts`; keeping this local avoids any chance of the leaf
 // invariant regressing if `time-key.ts` ever grows a heavyweight import).
 *
 * MUST stay byte-identical in behavior to `lib/time-key.ts:toTimeKey`. A parity
 * test in tests/batch-miner-artifact.spec.ts locks the equivalence.
 */
function localTimeKey(time: Time): string {
    if (typeof time === "number") return String(time);
    if (typeof time === "string") return time;
    if (time && typeof time === "object" && "year" in time) {
        const day = time as { year: number; month: number; day: number };
        const month = String(day.month).padStart(2, "0");
        const date = String(day.day).padStart(2, "0");
        return `${day.year}-${month}-${date}`;
    }
    return String(time);
}

/**
 * Reconstruct a `Time` from its stored key. For numeric keys (the dominant
 * case — unix seconds or unix ms) this returns a number, and
 * `localTimeKey(number) === String(number) === key`, so lookup parity holds.
 * For string keys (ISO strings or `YYYY-MM-DD` BusinessDay keys) it returns the
 * string itself, and `localTimeKey(string) === string === key`. The miner
 * never inspects the `Time` value beyond calling `timeKey(...)` on it, so this
 * is sufficient for full parity.
 */
function timeFromKey(key: string): Time {
    // All-numeric (possibly negative, possibly float) -> number.
    if (/^-?\d+(\.\d+)?$/.test(key)) {
        const asNum = Number(key);
        if (Number.isFinite(asNum)) return asNum as Time;
    }
    return key as Time;
}

// ---------------------------------------------------------------------------
// Exit-reason codec (only end_of_data is load-bearing for the miner)
// ---------------------------------------------------------------------------

function encodeExitReason(reason: Trade["exitReason"] | undefined): number {
    if (reason === "end_of_data") return 1;
    if (reason === undefined) return 0;
    return 2;
}

function decodeExitReason(code: number): Trade["exitReason"] | undefined {
    if (code === 1) return "end_of_data";
    if (code === 0) return undefined;
    // The miner treats every non-end_of_data reason as "closed" for
    // auto-horizon calibration, so the specific original reason does not need
    // to round-trip. Reconstruct a benign placeholder.
    return "signal";
}
