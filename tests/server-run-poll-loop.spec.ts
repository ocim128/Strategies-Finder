import { expect } from "chai";
import { describe, it } from "node:test";
import {
    MAX_REATTACH_CONSECUTIVE_FAILURES,
    REATTACH_FAILURE_BACKOFF_MS,
    ServerRunPollLoop,
    failureBackoffDelayMs,
    type ServerRunPollOutcome,
    type ServerRunStatusFetchResult,
    type ServerRunTransientFailureInfo,
} from "../lib/server-run-poll-loop";

/**
 * The shared reattach poll loop behind the Batch, TOP_MEAN, and Finder
 * reattach flows. These tests lock the machinery the three call surfaces
 * depend on — the outcome taxonomy, the ownership-after-every-await rule, the
 * backoff schedule and give-up policy, and the "retries never advance the
 * step-down counter" invariant — so a change here is a one-file change instead
 * of a three-path port.
 *
 * All delays are injected at 1–5ms; no fake timers are needed.
 */

/** Test snapshot: a number; -1 is terminal. */
type Snap = number;

const terminalAtMinusOne = (snapshot: Snap): boolean => snapshot === -1;

const snap = (value: Snap): ServerRunStatusFetchResult<Snap> => ({ kind: "snapshot", snapshot: value });

function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((res) => {
        resolve = res;
    });
    return { promise, resolve };
}

interface StartOptions {
    isOwned?: () => boolean;
    signal?: AbortSignal;
    initialDelayMs?: number | null;
    nextRequestDelayMs?: (pollIndex: number) => number;
    onProgress?: (snapshot: Snap) => void | Promise<void>;
    failureBackoffMs?: readonly number[];
    maxConsecutiveFailures?: number;
    connectionLostRetryMs?: number | (() => number | null | undefined);
    waitIntervalAfterFailure?: boolean;
    requestTimeoutMs?: number | null;
    fetchStatus: (signal: AbortSignal) => Promise<ServerRunStatusFetchResult<Snap>>;
}

interface LoopHarness {
    outcome: Promise<ServerRunPollOutcome<Snap>>;
    loop: ServerRunPollLoop<Snap>;
    /** pollIndex values passed to nextRequestDelayMs, in call order. */
    delays: number[];
    failures: ServerRunTransientFailureInfo[];
    progress: Snap[];
}

function startLoop(options: StartOptions): LoopHarness {
    const delays: number[] = [];
    const failures: ServerRunTransientFailureInfo[] = [];
    const progress: Snap[] = [];
    const loop = new ServerRunPollLoop<Snap>({
        signal: options.signal,
        isOwned: options.isOwned ?? (() => true),
        fetchStatus: options.fetchStatus,
        isTerminal: terminalAtMinusOne,
        nextRequestDelayMs: options.nextRequestDelayMs
            ?? ((pollIndex) => {
                delays.push(pollIndex);
                return 1;
            }),
        initialDelayMs: options.initialDelayMs,
        onProgress: options.onProgress ?? ((snapshot) => {
            progress.push(snapshot);
        }),
        failureBackoffMs: options.failureBackoffMs ?? [1, 1, 1, 1],
        maxConsecutiveFailures: options.maxConsecutiveFailures,
        connectionLostRetryMs: options.connectionLostRetryMs,
        waitIntervalAfterFailure: options.waitIntervalAfterFailure,
        requestTimeoutMs: options.requestTimeoutMs,
        onTransientFailure: (info) => {
            failures.push(info);
        },
    });
    return { outcome: loop.run(), loop, delays, failures, progress };
}

describe("server-run-poll-loop", () => {
    it("keeps the documented backoff schedule and give-up threshold", () => {
        expect(REATTACH_FAILURE_BACKOFF_MS).to.deep.equal([2_000, 5_000, 10_000, 15_000]);
        expect(MAX_REATTACH_CONSECUTIVE_FAILURES).to.equal(20);
    });

    it("clamps the backoff index to the last step after the schedule is exhausted", () => {
        const steps: number[] = [];
        for (let i = 1; i <= 6; i += 1) {
            steps.push(failureBackoffDelayMs(i, REATTACH_FAILURE_BACKOFF_MS));
        }
        expect(steps).to.deep.equal([2_000, 5_000, 10_000, 15_000, 15_000, 15_000]);
    });

    it("returns the terminal snapshot without reporting progress for it", async () => {
        let calls = 0;
        const { outcome, progress } = startLoop({
            fetchStatus: async () => {
                calls += 1;
                return snap(calls === 1 ? 1 : -1);
            },
        });
        expect(await outcome).to.deep.equal({ kind: "terminal", snapshot: -1 });
        expect(progress).to.deep.equal([1]);
    });

    it("maps a 404-class answer to not_found", async () => {
        const { outcome } = startLoop({ fetchStatus: async () => ({ kind: "not_found" }) });
        expect(await outcome).to.deep.equal({ kind: "not_found" });
    });

    it("maps a classified non-ownership answer to rejected", async () => {
        const { outcome } = startLoop({ fetchStatus: async () => ({ kind: "rejected" }) });
        expect(await outcome).to.deep.equal({ kind: "rejected" });
    });

    it("discards a stale not_found as cancellation when ownership dropped mid-fetch", async () => {
        const gate = deferred<ServerRunStatusFetchResult<Snap>>();
        let owned = true;
        const { outcome } = startLoop({
            isOwned: () => owned,
            nextRequestDelayMs: () => 1,
            fetchStatus: () => gate.promise,
        });
        owned = false;
        // The stale answer would have been not_found; the loop must never map
        // it to a missing-job outcome the caller would report or persist.
        gate.resolve({ kind: "not_found" });
        expect(await outcome).to.deep.equal({ kind: "cancelled" });
    });

    it("resolves cancelled promptly when aborted during the initial delay", async () => {
        const started = Date.now();
        const { outcome, loop } = startLoop({
            initialDelayMs: 60_000,
            nextRequestDelayMs: () => 1,
            fetchStatus: async () => snap(1),
        });
        setTimeout(() => loop.abort(), 5);
        expect(await outcome).to.deep.equal({ kind: "cancelled" });
        expect(Date.now() - started).to.be.lessThan(5_000);
    });

    it("treats an aborted in-flight request as cancellation, not a backoff failure", async () => {
        const { outcome, loop, failures } = startLoop({
            nextRequestDelayMs: () => 1,
            fetchStatus: (signal) => new Promise<ServerRunStatusFetchResult<Snap>>((_, reject) => {
                signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
            }),
        });
        setTimeout(() => loop.abort(), 5);
        expect(await outcome).to.deep.equal({ kind: "cancelled" });
        expect(failures).to.deep.equal([]);
    });

    it("resolves cancelled when the owner signal aborts during a poll delay", async () => {
        const owner = new AbortController();
        const { outcome } = startLoop({
            signal: owner.signal,
            nextRequestDelayMs: () => 60_000,
            fetchStatus: async () => snap(1),
        });
        setTimeout(() => owner.abort(), 5);
        expect(await outcome).to.deep.equal({ kind: "cancelled" });
    });

    it("survives exactly the failure budget and resets the counter after one healthy poll", async () => {
        let calls = 0;
        const { outcome, failures } = startLoop({
            fetchStatus: async () => {
                calls += 1;
                // MAX consecutive failures, one healthy poll, then MAX more —
                // the budget must have reset, so no give-up and no gaveUp hook.
                const healthy = calls === MAX_REATTACH_CONSECUTIVE_FAILURES + 1 || calls > 2 * MAX_REATTACH_CONSECUTIVE_FAILURES + 1;
                if (!healthy) throw new Error(`status ${calls}`);
                return snap(calls > 2 * MAX_REATTACH_CONSECUTIVE_FAILURES + 1 ? -1 : 1);
            },
        });
        expect(await outcome).to.deep.equal({ kind: "terminal", snapshot: -1 });
        expect(failures.some((info) => info.gaveUp)).to.equal(false);
    });

    it("terminates with connection_lost after the budget with no retry policy", async () => {
        const { outcome, failures } = startLoop({
            fetchStatus: async () => {
                throw new Error("status 502");
            },
        });
        expect(await outcome).to.deep.equal({ kind: "connection_lost" });
        expect(failures.at(-1)).to.deep.equal({
            consecutive: MAX_REATTACH_CONSECUTIVE_FAILURES + 1,
            max: MAX_REATTACH_CONSECUTIVE_FAILURES,
            gaveUp: true,
            error: failures.at(-1)!.error,
        });
    });

    it("keeps polling at the low cadence after give-up when a retry policy is set", async () => {
        let calls = 0;
        const { outcome, failures } = startLoop({
            connectionLostRetryMs: 1,
            fetchStatus: async () => {
                calls += 1;
                if (calls <= MAX_REATTACH_CONSECUTIVE_FAILURES + 1) throw new Error("status 503");
                return snap(calls === MAX_REATTACH_CONSECUTIVE_FAILURES + 2 ? 1 : -1);
            },
        });
        expect(await outcome).to.deep.equal({ kind: "terminal", snapshot: -1 });
        const gaveUp = failures.filter((info) => info.gaveUp);
        expect(gaveUp).to.have.length(1);
        expect(gaveUp[0]!.consecutive).to.equal(MAX_REATTACH_CONSECUTIVE_FAILURES + 1);
    });

    it("lets the retry-policy callback terminate the loop (unscoped discovery)", async () => {
        const { outcome } = startLoop({
            connectionLostRetryMs: () => null,
            fetchStatus: async () => {
                throw new Error("status 502");
            },
        });
        expect(await outcome).to.deep.equal({ kind: "connection_lost" });
    });

    it("never advances the healthy-cadence step-down for retries", async () => {
        let calls = 0;
        const { outcome, delays } = startLoop({
            fetchStatus: async () => {
                calls += 1;
                // Five transient failures, then two healthy polls; the second
                // healthy poll must see pollIndex 2, not 2 + 5 retries.
                if (calls <= 5) throw new Error("status 500");
                return snap(calls === 8 ? -1 : 1);
            },
        });
        expect(await outcome).to.deep.equal({ kind: "terminal", snapshot: -1 });
        expect(delays).to.deep.equal([1, 2]);
    });

    it("rides a rejected onProgress through the same backoff as a failed request", async () => {
        let calls = 0;
        const { outcome, failures, delays } = startLoop({
            fetchStatus: async () => {
                calls += 1;
                // First poll reports fine; the second poll's per-cycle report
                // (e.g. a timed-out continuation page) rejects; the next poll
                // recovers and terminates.
                return snap(calls === 4 ? -1 : 1);
            },
            onProgress: (_snapshot) => {
                if (calls === 2) throw new Error("status row page timed out");
            },
        });
        expect(await outcome).to.deep.equal({ kind: "terminal", snapshot: -1 });
        expect(failures.map((info) => info.consecutive)).to.deep.equal([1]);
        // The retry did not advance the step-down: the healthy polls waited at
        // pollIndex 1 and 2 only.
        expect(delays).to.deep.equal([1, 2]);
    });

    it("escalates the failure budget when onProgress keeps failing while the fetch is healthy", async () => {
        const { outcome, failures } = startLoop({
            maxConsecutiveFailures: 3,
            fetchStatus: async () => snap(1),
            onProgress: () => {
                throw new Error("status row page timed out");
            },
        });
        expect(await outcome).to.deep.equal({ kind: "connection_lost" });
        // The counter must accumulate ACROSS cycles (the reset happens only
        // after a fully healthy cycle) — otherwise a persistently failing
        // report oscillates at 1 and never reaches give-up.
        expect(failures.map((info) => info.consecutive)).to.deep.equal([1, 2, 3, 4]);
        expect(failures.at(-1)!.gaveUp).to.equal(true);
    });

    it("re-checks ownership after onProgress resolves instead of sleeping the interval", async () => {
        const gate = deferred<void>();
        let owned = true;
        const started = Date.now();
        const { outcome } = startLoop({
            isOwned: () => owned,
            nextRequestDelayMs: () => 60_000,
            fetchStatus: async () => snap(1),
            onProgress: async () => {
                // Ownership flips while the per-poll report is in flight.
                owned = false;
                await gate.promise;
            },
        });
        gate.resolve();
        expect(await outcome).to.deep.equal({ kind: "cancelled" });
        expect(Date.now() - started).to.be.lessThan(5_000);
    });

    it("re-waits the polling interval after a backoff step when opted in", async () => {
        let calls = 0;
        const { outcome, delays } = startLoop({
            waitIntervalAfterFailure: true,
            fetchStatus: async () => {
                calls += 1;
                if (calls === 1) throw new Error("status 500");
                return snap(calls === 3 ? -1 : 1);
            },
        });
        expect(await outcome).to.deep.equal({ kind: "terminal", snapshot: -1 });
        // Retry after failure 1 re-waits the interval at pollIndex 0; healthy
        // poll 1 waits at pollIndex 1; healthy poll 2 is terminal (no delay).
        expect(delays).to.deep.equal([0, 1]);
    });

    it("issues the first request immediately when initialDelayMs is null", async () => {
        let firstCallAt = 0;
        const started = Date.now();
        const { outcome } = startLoop({
            initialDelayMs: null,
            fetchStatus: async () => {
                firstCallAt = Date.now();
                return snap(-1);
            },
        });
        await outcome;
        expect(firstCallAt - started).to.be.lessThan(50);
    });

    it("awaits async onProgress before the next poll", async () => {
        let calls = 0;
        let completed = 0;
        const progress: Snap[] = [];
        const { outcome } = startLoop({
            fetchStatus: async () => {
                calls += 1;
                return snap(calls === 2 ? -1 : 1);
            },
            onProgress: async (snapshot) => {
                await new Promise((resolve) => setTimeout(resolve, 5));
                progress.push(snapshot);
                completed += 1;
            },
        });
        expect(await outcome).to.deep.equal({ kind: "terminal", snapshot: -1 });
        // The terminal poll never reaches onProgress; the healthy poll's async
        // report completed before the next request was issued.
        expect(completed).to.equal(1);
        expect(progress).to.deep.equal([1]);
    });

    it("counts a per-request timeout abort as a transient failure and retries", async () => {
        let attempt = 0;
        const { outcome, failures } = startLoop({
            requestTimeoutMs: 5,
            fetchStatus: (signal) => new Promise<ServerRunStatusFetchResult<Snap>>((resolve, reject) => {
                attempt += 1;
                if (attempt === 1) {
                    signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true });
                    return;
                }
                resolve(snap(-1));
            }),
        });
        expect(await outcome).to.deep.equal({ kind: "terminal", snapshot: -1 });
        expect(failures).to.have.length(1);
        expect(failures[0]).to.deep.equal({
            consecutive: 1,
            max: MAX_REATTACH_CONSECUTIVE_FAILURES,
            gaveUp: false,
            error: failures[0]!.error,
        });
    });
});
