/**
 * Stream event contract for the Mine Prediction server-side plugin
 * (`POST /api/batch-backtest/mine-prediction`). Mirrors
 * {@link BatchStabilityMineStreamEvent}: the result is heavy (the engine
 * re-runs Mine at ~hundreds of historical bars per asset), so the endpoint
 * streams per-asset `progress` events and a terminal `done` carrying the full
 * {@link BatchMinePredictionResult}. No per-verdict streaming (the report is
 * aggregate).
 *
 * The consumer (`BatchBacktestService.runMinePredictionServer`) reads it via
 * `consumeNdjsonStream<BatchMinePredictionStreamEvent>`. Dispatch in
 * `consumeNdjsonStream` is by `event.type` → camelCase handler key and is
 * non-exhaustive, so this union exists for compiler coverage at the consumer,
 * not for runtime enforcement.
 */
import type { BatchMinePredictionResult } from "./batch-mine-prediction-engine";

export type BatchMinePredictionStreamEvent =
    | { type: "start"; assets: number; pairs: number }
    | { type: "progress"; asset: string; samples: number; doneAssets: number; totalAssets: number }
    | { type: "bar"; asset: string; barsDone: number; barsTotal: number }
    | { type: "done"; ok: true; result: BatchMinePredictionResult }
    | { type: "done"; ok: false; cancelled: true; summary: string }
    | { type: "fatal"; error: string };
