/**
 * NDJSON stream contract for the OPEN_SCORE USD Replay server endpoint
 * (`POST /api/batch-backtest/open-score-usd`).
 *
 * Research question: at historical synthetic-pair decision events, did picking
 * the highest positive OPEN_SCORE asset and trading it vs USD beat picking
 * another positive-score asset at random (same event)? Read-only on the Batch
 * artifact store; no orders, no change to the Batch result.
 *
 * The consumer (`BatchBacktestService.runOpenScoreUsdServer`) reads this via
 * `postBatchNdjson<OpenScoreUsdReplayStreamEvent>`. Dispatch is by
 * `event.type` -> camelCase handler key and is non-exhaustive, so this union
 * exists for compiler coverage at the consumer, not runtime enforcement.
 *
 * `phase` marks a long CPU phase transition; `progress` carries a bounded
 * work-chunk update. Both must be emitted often enough that the browser sees
 * movement at least every ~2s during a non-trivial phase. `done` is scalar and
 * bounded — no per-event candidate arrays or target OHLCV cross the wire.
 */
import type { OpenScoreUsdReplayResult } from "./batch-open-score-usd-replay-engine";

export type OpenScoreUsdReplayPhase = "scan" | "events" | "targets" | "outcomes" | "aggregate";

export type OpenScoreUsdReplayStreamEvent =
    | { type: "start"; pairs: number; assets: number; horizons: number[] }
    | {
        type: "phase";
        phase: OpenScoreUsdReplayPhase;
        detail: string;
        completed: number;
        total: number;
        elapsedMs: number;
    }
    | {
        type: "progress";
        phase: string;
        detail: string;
        completed: number;
        total: number;
        elapsedMs: number;
        events?: number;
        omitted?: number;
    }
    | { type: "done"; ok: true; result: OpenScoreUsdReplayResult }
    | { type: "done"; ok: false; cancelled: true; summary: string }
    | { type: "fatal"; error: string };
