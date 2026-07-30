/**
 * NDJSON stream contract for the SP500 TOP_MEAN coordinator server endpoint
 * (`POST /api/batch-backtest/sp500-top-mean/run`).
 *
 * Audit Finding 2: the browser service consumed these events through
 * `(event: any)` handlers and stored results in `any` fields, so every
 * TOP_MEAN UI bug was a silent shape drift (event.result vs status.result,
 * missing interrupted, winners field renames). The typed contracts
 * (`TopMeanResultSummary`, `TopMeanStatusResponse`) already existed in the
 * engine modules; this union gives the consumer the same compile-time
 * coverage the OPEN_SCORE USD path already had via
 * `OpenScoreUsdReplayStreamEvent`.
 *
 * The consumer (`BatchBacktestService.runSp500TopMeanCoordinatorInner`) reads
 * this via `postBatchNdjson<TopMeanStreamEvent>`. Dispatch is by `event.type`
 * -> camelCase handler key and is non-exhaustive, so this union exists for
 * compiler coverage at the consumer, not runtime enforcement.
 *
 * Event shapes mirror the coordinator engine's actual emissions
 * (sp500-top-mean-coordinator-engine.ts):
 *   - `preflight`:        emitted once after pair enumeration.
 *   - `progress`:         emitted per phase.
 *   - `current_snapshot`: emitted once the phase-1 snapshot is computed.
 *   - `done`:             terminal. Carries `result` on success, or
 *                         `interrupted: true` on a Stop (see `emitInterrupted`).
 *   - `fatal`:            terminal failure; optionally carries the phase-1
 *                         snapshot computed before the replay failure.
 */
import type { CoverageCounts } from "./sp500-pair-enumerator";
import type { CurrentTopMeanResult } from "./sp500-top-mean-current-snapshot";
import type { TopMeanResultSummary } from "./sp500-top-mean-coordinator-engine";
import type { TopMeanPerformanceDiagnostic } from "./sp500-top-mean-performance";

/** Shared shape of the phase-1 current snapshot carried on several events. */
export type TopMeanCurrentSnapshot = CurrentTopMeanResult;

export type TopMeanStreamEvent =
    | { type: "preflight"; counts: CoverageCounts }
    | {
        type: "progress";
        phase: string;
        text: string;
        /** Present on the backtesting progress variant. */
        completed?: number;
        total?: number;
    }
    | {
        type: "current_snapshot";
        currentSnapshot: TopMeanCurrentSnapshot;
    }
    | { type: "done"; result: TopMeanResultSummary }
    | { type: "done"; interrupted: true; performance?: TopMeanPerformanceDiagnostic }
    | {
        type: "fatal";
        error: string;
        currentSnapshot?: TopMeanCurrentSnapshot;
        performance?: TopMeanPerformanceDiagnostic;
    };
