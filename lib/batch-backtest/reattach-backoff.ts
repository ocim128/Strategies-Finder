/**
 * Shared transient-failure backoff for the Batch + TOP_MEAN reattach poll loops
 * (audit Finding 1).
 *
 * `reattachToInProgressServerRun` and `reattachToInProgressTopMeanRun` in
 * batch-backtest-service.ts each inlined the same reliability machinery:
 *   - a consecutive-failure counter
 *   - the same `FAILURE_BACKOFF_MS = [2s, 5s, 10s, 15s]` schedule and the same
 *     `Math.min(consecutive - 1, len - 1)` index formula
 *   - the same `MAX_REATTACH_CONSECUTIVE_FAILURES = 20` give-up threshold
 *   - the same cancellable-delay pattern (a `setTimeout` whose resolve is
 *     exposed so Stop can cancel mid-delay instead of waiting the full delay)
 *
 * The two loops diverge in every other way (the server loop has a 2s->5s
 * healthy-poll step-down + a paged row drain; the TOP_MEAN loop has a fixed 2s
 * healthy delay + terminal-status rendering). This controller therefore owns
 * ONLY the shared transient-failure state machine — the consecutive counter,
 * the backoff index, the give-up decision, and a cancellable delay. The healthy
 * poll cadence, the fetch, and the render stay at each call site.
 *
 * A backoff bug fix (e.g. a new schedule, a jitter, an ownership-predicate
 * tightening) is now a one-file change instead of a two-path port — the
 * documented "next hardening fix lands in one path and misses the other" risk.
 */

/**
 * Capped backoff schedule for transient status-poll failures. A non-2xx status
 * or a thrown fetch engages backoff instead of abandoning the reattach.
 */
export const REATTACH_FAILURE_BACKOFF_MS = [2_000, 5_000, 10_000, 15_000] as const;

/**
 * After this many consecutive transient failures, stop retrying and surface the
 * "click Run / TOP_MEAN to reattach" state. ~5 min at the 15s ceiling
 * (20 × 15s) — comfortably longer than a Vite dev-server restart.
 */
export const MAX_REATTACH_CONSECUTIVE_FAILURES = 20;

/**
 * Result of {@link ReattachBackoffController.recordFailure}. The call site
 * branches on `gaveUp` (restore buttons + surface give-up status) vs. the
 * transient path (surface "retrying (n/max)" + wait `backoffDelayMs` via the
 * loop's own cancellable timer).
 */
export interface ReattachFailureOutcome {
    /** True when the consecutive-failure count exceeded the give-up threshold. */
    gaveUp: boolean;
    /** Current consecutive-failure count (1-based, for status text). */
    consecutive: number;
    /** The give-up threshold (for status text: "retrying (n/max)"). */
    max: number;
    /** The delay to wait before the next retry (the loop applies its own cancellable timer). */
    backoffDelayMs: number;
}

/**
 * State machine for one reattach poll loop's transient-failure backoff.
 *
 * Construct one per active reattach (the server-run and TOP_MEAN loops each own
 * their own instance). Owns the consecutive-failure counter, the backoff index
 * formula, and the give-up threshold — the three things that were verbatim
 * duplicated and most likely to drift.
 *
 * The loops keep their own cancellable timer fields + their `isStillOwned` /
 * `activeXxxRunId` ownership predicates at the call site. The two loops express
 * ownership differently (a `reattachPollingStopped` boolean vs.
 * `activeTopMeanRunId === runId` as the loop condition) and their healthy-poll
 * cadences differ (server: 2s->5s step-down; TOP_MEAN: fixed 2s), so those stay
 * per-loop. A backoff bug fix (schedule, jitter, give-up threshold) is now a
 * one-file change here instead of a two-path port.
 */
export class ReattachBackoffController {
    private consecutive = 0;
    private readonly failureBackoffMs: readonly number[];
    private readonly maxConsecutiveFailures: number;

    constructor(options?: { failureBackoffMs?: readonly number[]; maxConsecutiveFailures?: number }) {
        this.failureBackoffMs = options?.failureBackoffMs ?? REATTACH_FAILURE_BACKOFF_MS;
        this.maxConsecutiveFailures = options?.maxConsecutiveFailures ?? MAX_REATTACH_CONSECUTIVE_FAILURES;
    }

    /** Reset the consecutive-failure counter at the start of a reattach run. */
    reset(): void {
        this.consecutive = 0;
    }

    /** A successful poll resets the counter. */
    recordSuccess(): void {
        this.consecutive = 0;
    }

    /** Current consecutive-failure count (0 after a success / reset). */
    getConsecutive(): number {
        return this.consecutive;
    }

    /**
     * Record a transient failure. Returns the outcome the call site branches on:
     *   - `gaveUp === true`: restore buttons, surface the give-up status, exit.
     *   - `gaveUp === false`: surface "retrying (consecutive/max)", then wait
     *     `backoffDelayMs` via the loop's own cancellable timer.
     */
    recordFailure(): ReattachFailureOutcome {
        this.consecutive += 1;
        const gaveUp = this.consecutive > this.maxConsecutiveFailures;
        const backoffIndex = Math.min(this.consecutive - 1, this.failureBackoffMs.length - 1);
        return {
            gaveUp,
            consecutive: this.consecutive,
            max: this.maxConsecutiveFailures,
            backoffDelayMs: this.failureBackoffMs[backoffIndex]!,
        };
    }
}

