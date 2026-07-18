/**
 * Stream event contract for the Mine A/B Test server-side plugin
 * (`POST /api/batch-backtest/mine-prediction-ab`). Mirrors the Mine Prediction
 * stream pattern: per-pair progress + terminal done/fatal.
 */
import type { MineAbResult } from "./batch-mine-prediction-ab-engine";

export type MineAbStreamEvent =
    | { type: "start"; pairs: number }
    | { type: "target-progress"; asset: string; doneAssets: number; totalAssets: number }
    | { type: "progress"; symbol: string; donePairs: number; totalPairs: number }
    | { type: "done"; ok: true; result: MineAbResult }
    | { type: "done"; ok: false; cancelled: true; summary: string }
    | { type: "fatal"; error: string };
