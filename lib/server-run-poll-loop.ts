/**
 * Shared browser-side status poll loop for a server-owned run ("reattach loop").
 *
 * Batch (`reattachToInProgressServerRun`), TOP_MEAN
 * (`reattachToInProgressTopMeanRun`), and Finder (`pollOwnedServerRunStatus`)
 * each implemented the same state machine: adopt a server run after a tab
 * reload, poll a `/status` route with a healthy cadence, retry transient
 * failures with backoff, terminate on terminal / run-lost / run-replaced
 * answers, and stay cancellable by Stop, a newer run, and dispose. This module
 * owns that machinery so a reattach hardening fix (new schedule, jitter,
 * ownership tightening) is a one-file change instead of a three-path port.
 *
 * The loop performs NO side effects beyond per-cycle progress reporting and
 * the transient-failure hook: every adoption, terminal interpretation, status
 * message, and persisted-record decision belongs to the call site, which maps
 * the returned {@link ServerRunPollOutcome} onto its own wire vocabulary and
 * copy.
 *
 * Leaf-safe browser module: depends only on `fetch`-adjacent DOM/ECMAScript
 * builtins (AbortController/AbortSignal, setTimeout). No Vite/server-plugin
 * imports — the same import-hygiene rule `vite-http-utils.ts` documents for
 * Vite-config bundles.
 */

/**
 * Capped backoff schedule for transient status-poll failures. A thrown fetch
 * engages backoff instead of abandoning the reattach.
 */
export const REATTACH_FAILURE_BACKOFF_MS = [2_000, 5_000, 10_000, 15_000] as const;

/**
 * After this many consecutive transient failures, the loop either terminates
 * with `connection_lost` (Finder) or enters a low-cadence retry phase when the
 * call site configures `connectionLostRetryMs` (Batch/TOP_MEAN pass 60s). The
 * run id remains owned until an authoritative terminal or mismatch response
 * arrives.
 */
export const MAX_REATTACH_CONSECUTIVE_FAILURES = 20;

/**
 * The backoff delay for the `consecutive`-th failure (1-based), clamped to the
 * last schedule entry once the schedule is exhausted.
 */
export function failureBackoffDelayMs(consecutive: number, schedule: readonly number[]): number {
    const index = Math.min(consecutive - 1, schedule.length - 1);
    return schedule[index]!;
}

/** One status request's answer, classified by the call site's `fetchStatus`. */
export type ServerRunStatusFetchResult<Snapshot> =
    | { kind: "snapshot"; snapshot: Snapshot }
    /** 404-class answer: the server has no such job (e.g. a dev-server restart). */
    | { kind: "not_found" }
    /** The server answered but the snapshot is not ours (runId mismatch, `ok: false`, or a server mismatch flag). */
    | { kind: "rejected" };

/**
 * Outcome of one poll-loop run. The call site that started the loop owns every
 * consequence: terminal adoption, presentation, and whether the persisted
 * active-run record is cleared.
 */
export type ServerRunPollOutcome<Snapshot> =
    | { kind: "terminal"; snapshot: Snapshot }
    | { kind: "not_found" }
    | { kind: "rejected" }
    /** More consecutive request failures than the budget allows, with no low-cadence retry configured. */
    | { kind: "connection_lost" }
    /** Stop, a newer run, or `abort()` took ownership; the loop touched nothing beyond onProgress. */
    | { kind: "cancelled" };

export interface ServerRunTransientFailureInfo {
    /** 1-based consecutive-failure count, computed before any give-up reset. */
    consecutive: number;
    /** The give-up threshold (for status text: "retrying (n/max)"). */
    max: number;
    /** True when this failure crossed the give-up threshold (and a low-cadence retry is configured). */
    gaveUp: boolean;
    error: unknown;
}

export interface ServerRunPollLoopOptions<Snapshot> {
    /**
     * Cancellation signal from the owner (e.g. the session-level Stop
     * controller). Aborting it cancels the in-flight request, unblocks every
     * pending wait, and resolves `run()` with `cancelled`.
     */
    signal?: AbortSignal;
    /**
     * Ownership predicate, re-checked after every await. False turns any
     * in-flight work into `cancelled` — a stale response (a 404 included)
     * that lands after a newer run (or Stop) took over is discarded as
     * cancellation, never mapped to a missing-job outcome the caller would
     * report or persist.
     */
    isOwned(): boolean;
    /**
     * One status request. Throws for transient failures (network errors,
     * non-2xx statuses); returns `not_found`/`rejected` for definitive
     * non-ownership answers. Implementations must honor `signal` so `abort()`
     * cancels an in-flight request.
     */
    fetchStatus(signal: AbortSignal): Promise<ServerRunStatusFetchResult<Snapshot>>;
    /** Terminal predicate over a healthy snapshot. */
    isTerminal(snapshot: Snapshot): boolean;
    /**
     * Delay before the request that follows `pollIndex` completed healthy
     * cycles. `pollIndex` advances only on healthy non-terminal polls, so
     * retries never advance the healthy-cadence step-down.
     */
    nextRequestDelayMs(pollIndex: number): number;
    /** Delay before the first request; null/undefined issues it immediately. */
    initialDelayMs?: number | null;
    /** Per-healthy-poll reporting. May be async; awaited before the next wait.
     *  A rejection rides the same transient-failure backoff as a failed
     *  request — Batch's paged status-row drain times out through this path
     *  and recovers on the next status poll. */
    onProgress?(snapshot: Snapshot): void | Promise<void>;
    /** Defaults to {@link REATTACH_FAILURE_BACKOFF_MS}. */
    failureBackoffMs?: readonly number[];
    /** Defaults to {@link MAX_REATTACH_CONSECUTIVE_FAILURES}. */
    maxConsecutiveFailures?: number;
    /**
     * Policy after the give-up threshold. A number (or a callback returning
     * one) keeps the loop alive at that cadence with ownership preserved and
     * the failure counter reset — the call surface's "Stop remains available"
     * behavior. A callback returning null/undefined (or leaving this option
     * unset) terminates with `connection_lost`.
     */
    connectionLostRetryMs?: number | (() => number | null | undefined);
    /**
     * Retry cadence after a failure backoff: by default the retry fetch
     * follows the backoff directly; when true, the loop additionally re-waits
     * `nextRequestDelayMs(pollIndex)` first (Finder's adopted-reattach
     * pre-consolidation sequence: backoff, then interval).
     */
    waitIntervalAfterFailure?: boolean;
    /**
     * Per-request timeout: the signal passed to `fetchStatus` aborts
     * `requestTimeoutMs` after issue, or earlier when the loop cancels.
     * Unset means no timeout beyond the owner's signal.
     */
    requestTimeoutMs?: number | null;
    /**
     * Observability hook, invoked once per failed cycle (before any give-up
     * reset) with the 1-based consecutive count. Call sites log and surface
     * their own "retrying (n/max)" / "connection lost" copy here.
     */
    onTransientFailure?(info: ServerRunTransientFailureInfo): void;
}

/**
 * The status poll loop for one server run adoption. Construct one per
 * reattach/recovery, call `run()` once, and cancel via the owner `signal` or
 * `abort()`.
 */
export class ServerRunPollLoop<Snapshot> {
    private readonly options: ServerRunPollLoopOptions<Snapshot>;
    private readonly controller = new AbortController();
    private consecutiveFailures = 0;
    private pollIndex = 0;

    constructor(options: ServerRunPollLoopOptions<Snapshot>) {
        this.options = options;
        if (options.signal) {
            if (options.signal.aborted) {
                this.controller.abort();
            } else {
                options.signal.addEventListener("abort", () => this.controller.abort(), { once: true });
            }
        }
    }

    /**
     * Wakes a pending delay and cancels the in-flight request; `run()`
     * resolves `cancelled` at its next check. Safe to call more than once.
     */
    abort(): void {
        this.controller.abort();
    }

    async run(): Promise<ServerRunPollOutcome<Snapshot>> {
        const { options } = this;
        const signal = this.controller.signal;

        if (options.initialDelayMs != null) {
            if (!options.isOwned()) return { kind: "cancelled" };
            if (!await this.wait(options.initialDelayMs)) return { kind: "cancelled" };
        }
        for (;;) {
            if (signal.aborted || !options.isOwned()) return { kind: "cancelled" };
            const request = this.beginRequest();
            let fetchResult: ServerRunStatusFetchResult<Snapshot>;
            try {
                try {
                    fetchResult = await options.fetchStatus(request.signal);
                } finally {
                    // The request settled: drop its timeout timer and owner
                    // listener before any failure handling or wait, so nothing
                    // leaks or stays armed across cycles.
                    request.cleanup();
                }
            } catch (error) {
                const action = await this.recordTransientFailure(error);
                if (action === "cancelled") return { kind: "cancelled" };
                if (action === "connection_lost") return { kind: "connection_lost" };
                continue;
            }
            // Ownership re-check after the settle, BEFORE interpreting the
            // answer: a stale response of any kind (not_found included) that
            // lands after a takeover must be discarded as cancellation.
            if (signal.aborted || !options.isOwned()) return { kind: "cancelled" };
            if (fetchResult.kind === "not_found") return { kind: "not_found" };
            if (fetchResult.kind === "rejected") return { kind: "rejected" };
            const snapshot = fetchResult.snapshot;
            if (options.isTerminal(snapshot)) {
                return { kind: "terminal", snapshot };
            }
            try {
                await options.onProgress?.(snapshot);
            } catch (error) {
                const action = await this.recordTransientFailure(error);
                if (action === "cancelled") return { kind: "cancelled" };
                if (action === "connection_lost") return { kind: "connection_lost" };
                continue;
            }
            // Ownership re-check after the per-poll report's own awaits (a
            // paged row drain can take several requests): a takeover during
            // reporting must cancel instead of sleeping out the next interval.
            if (signal.aborted || !options.isOwned()) return { kind: "cancelled" };
            // A cycle is healthy only when both the status answer and its
            // per-poll report succeeded — resetting before onProgress would
            // let a persistently failing report oscillate the counter at 1
            // and never escalate to give-up.
            this.consecutiveFailures = 0;
            // Advance the counter BEFORE selecting the next delay so the wait
            // before request N uses pollIndex = N-1 — long-poll step-downs key
            // off completed healthy polls, and retries above never advanced it.
            this.pollIndex += 1;
            if (!await this.wait(options.nextRequestDelayMs(this.pollIndex))) {
                return { kind: "cancelled" };
            }
        }
    }

    /**
     * Shared transient-failure handling for a failed request or a rejected
     * per-poll report: cancellation (abort / lost ownership) never counts
     * against the backoff budget; real failures increment the counter, fire
     * the observability hook, and either engage the backoff, enter the
     * low-cadence retry phase, or exhaust the budget.
     */
    private async recordTransientFailure(error: unknown): Promise<"cancelled" | "connection_lost" | "retry"> {
        const { options } = this;
        const signal = this.controller.signal;
        // An abort from Stop / a newer run / abort() is cancellation, not a
        // transient failure — never count it against the backoff budget.
        if (signal.aborted || !options.isOwned()) return "cancelled";
        const failureBackoffMs = options.failureBackoffMs ?? REATTACH_FAILURE_BACKOFF_MS;
        const maxConsecutiveFailures = options.maxConsecutiveFailures ?? MAX_REATTACH_CONSECUTIVE_FAILURES;
        this.consecutiveFailures += 1;
        const gaveUp = this.consecutiveFailures > maxConsecutiveFailures;
        options.onTransientFailure?.({
            consecutive: this.consecutiveFailures,
            max: maxConsecutiveFailures,
            gaveUp,
            error,
        });
        if (gaveUp) {
            const configured = typeof options.connectionLostRetryMs === "function"
                ? options.connectionLostRetryMs()
                : options.connectionLostRetryMs;
            if (configured == null) return "connection_lost";
            // Low-cadence retry: ownership is preserved (the server may
            // still be executing and Stop must remain available); the
            // counter resets so recovery re-walks the backoff schedule.
            this.consecutiveFailures = 0;
            if (!await this.wait(configured)) return "cancelled";
            return "retry";
        }
        if (!await this.wait(failureBackoffDelayMs(this.consecutiveFailures, failureBackoffMs))) {
            return "cancelled";
        }
        // Per-caller retry cadence: by default the retry fetch follows
        // the backoff directly; opted-in surfaces re-wait the polling
        // interval first (their pre-consolidation sequence).
        if (options.waitIntervalAfterFailure) {
            if (!await this.wait(options.nextRequestDelayMs(this.pollIndex))) {
                return "cancelled";
            }
        }
        // Retries never advance the interval step-down counter.
        return "retry";
    }

    /**
     * Abort-aware wait: resolves true after `ms`, false as soon as the loop
     * is cancelled, so Stop / a newer run / abort() unblock a pending sleep
     * immediately.
     */
    private wait(ms: number): Promise<boolean> {
        const signal = this.controller.signal;
        if (signal.aborted) return Promise.resolve(false);
        return new Promise<boolean>((resolve) => {
            const onAbort = () => {
                clearTimeout(timer);
                resolve(false);
            };
            const timer = setTimeout(() => {
                signal.removeEventListener("abort", onAbort);
                resolve(true);
            }, ms);
            signal.addEventListener("abort", onAbort, { once: true });
        });
    }

    /**
     * Bounded-lifetime abort signal for one status request: times out after
     * `requestTimeoutMs` and aborts with the loop controller. The caller must
     * invoke `cleanup()` when the request settles so the timeout timer and the
     * controller listener never outlive the request.
     */
    private beginRequest(): { signal: AbortSignal; cleanup: () => void } {
        const parent = this.controller.signal;
        const timeoutMs = this.options.requestTimeoutMs;
        if (timeoutMs == null) {
            return { signal: parent, cleanup: () => undefined };
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        const abortFromParent = () => controller.abort();
        if (parent.aborted) {
            abortFromParent();
        } else {
            parent.addEventListener("abort", abortFromParent, { once: true });
        }
        return {
            signal: controller.signal,
            cleanup: () => {
                clearTimeout(timer);
                parent.removeEventListener("abort", abortFromParent);
            },
        };
    }
}
