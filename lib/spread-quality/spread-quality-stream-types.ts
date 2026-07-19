/**
 * Stream event contract for the Exposure & Redundancy server-side plugin
 * (`POST /api/batch-backtest/exposure-redundancy`). Mirrors
 * {@link BatchMinePredictionStreamEvent}: the report is aggregate, so the
 * endpoint streams per-pair `progress` events and a terminal `done` carrying
 * the full {@link ExposureRedundancyResult}. No per-correlation streaming (the
 * N×N matrix is never sent — only the truncated top-K inside the result).
 *
 * The consumer (`BatchBacktestService.runExposureRedundancyServer`) reads it
 * via `consumeNdjsonStream<ExposureRedundancyStreamEvent>`. Dispatch in
 * `consumeNdjsonStream` is by `event.type` → camelCase handler key and is
 * non-exhaustive, so this union exists for compiler coverage at the consumer,
 * not for runtime enforcement.
 *
 * Serialization note: NaN and Infinity serialize as `null` in JSON. All
 * correlation fields in {@link ExposureRedundancyResult} are `number | null`
 * with explicit overlap counts, so no fabricated values cross the wire.
 */
import type { ExposureRedundancyResult } from "./spread-quality-engine";

export type ExposureRedundancyStreamEvent =
    | { type: "start"; pairs: number }
    | { type: "progress"; symbol: string; donePairs: number; totalPairs: number }
    | { type: "done"; ok: true; result: ExposureRedundancyResult }
    | { type: "done"; ok: false; cancelled: true; summary: string }
    | { type: "fatal"; error: string };
