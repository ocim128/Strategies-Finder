/**
 * Finder server-run session: browser-side ownership of one server Finder job.
 * Owns the active run id (the ownership token every stream/poll callback
 * checks after an await), the scoped Stop call, status-request timeout
 * signals, and the ONE owned-run status poll loop shared by stream recovery
 * and reload reattach, with its abort cleanup. Browser-only.
 *
 * Terminal result interpretation is scope-specific and stays with the
 * workflows/facade through the `interpretTerminal` callback; this module only
 * guarantees that interpretation runs for the run that still owns the id.
 *
 * Polling structure: `pollOwnedServerRunStatus` is the single request/retry/
 * wait mechanism for a run this session owns. Its callers —
 * `recoverActiveServerRun` (interrupted NDJSON stream recovery) and
 * `reattachToActiveServerRun` (reload adoption) — keep their distinct
 * responsibilities: what to adopt, what to present, and whether the persisted
 * active-run record may be cleared.
 */
import { parseJsonPreservingNonFinite } from "../../json-utils";
import { debugLogger } from "../../debug-logger";
import {
	clearFinderActiveServerRun,
	readFinderActiveServerRun,
	type FinderServerRunScope,
} from "./finder-persistence";
import type { FinderRunStatusSnapshot } from "../server/finder-stream-types";
import type { FinderScope } from "../../types/finder";

export const FINDER_STATUS_REQUEST_TIMEOUT_MS = 15_000;

export type FinderServerJobKind = FinderServerRunScope;

/**
 * Bounded-lifetime abort signal for one status request: times out after
 * `timeoutMs` and aborts with the parent (Stop / new run). The caller must
 * invoke `cleanup()` when the request settles so the timeout timer and the
 * parent listener never outlive the request.
 */
export function createFinderStatusRequestSignal(
	parentSignal: AbortSignal,
	timeoutMs: number = FINDER_STATUS_REQUEST_TIMEOUT_MS,
): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	const abortFromParent = () => controller.abort();
	if (parentSignal.aborted) {
		abortFromParent();
	} else {
		parentSignal.addEventListener("abort", abortFromParent, { once: true });
	}
	return {
		signal: controller.signal,
		cleanup: () => {
			clearTimeout(timer);
			parentSignal.removeEventListener("abort", abortFromParent);
		},
	};
}

/** Presentation + adoption capabilities the session needs from the facade. */
export interface FinderSessionHost {
	setProgress(active: boolean, percent: number, text: string): void;
	setStatus(text: string): void;
	/** Restore the persisted job's scope before any terminal snapshot lands. */
	restoreScope(scope: FinderScope): void;
	/** Clear retained inventories + the results snapshot before showing progress. */
	resetForServerRunAdoption(): void;
	/** Toggle Run/Stop controls for a server run in flight. */
	setRunning(running: boolean): void;
	/** Adopt a terminal snapshot for its scope; must check ownership again. */
	interpretTerminal(snapshot: FinderRunStatusSnapshot, persistedScope: FinderServerJobKind): void;
}

const POLL_INTERVAL_MS = 2000;
const LONG_POLL_INTERVAL_MS = 5000;
const FAST_POLL_COUNT = 150; // 5 min at 2s before stepping down
const FAILURE_BACKOFF_MS = [2_000, 5_000, 10_000, 15_000] as const;
const MAX_REATTACH_CONSECUTIVE_FAILURES = 20;

/**
 * Poll timing policy shared by both owned-run entrypoints. Production code
 * never mutates this object; the browser lifecycle harness shortens the
 * delays so Stop-during-sleep, backoff, and retry-exhaustion cases run
 * instantly.
 */
interface FinderPollTiming {
	/** Delay between two status requests while the job is running. */
	pollIntervalMs: number;
	/** Interval stepped down to after `fastPollCount` adopted-run polls. */
	longPollIntervalMs: number;
	fastPollCount: number;
	/** Delay before retry `n` (clamped to the last entry). */
	failureBackoffMs: readonly number[];
	/** Loop terminates with connection lost when failures exceed this. */
	maxConsecutiveFailures: number;
}

/**
 * Outcome of one owned-run poll loop (`pollOwnedServerRunStatus`). The
 * wrapper that started the loop owns every side effect: terminal adoption,
 * presentation, and whether the persisted active-run record is cleared.
 */
type FinderOwnedRunPollOutcome =
	| { kind: "terminal"; snapshot: FinderRunStatusSnapshot }
	/** 404: the server has no such job (e.g. a dev-server restart). */
	| { kind: "not_found" }
	/** The server answered but rejected the run id (`ok: false`). */
	| { kind: "rejected" }
	/** Stop or a newer run took ownership; the loop must not touch anything. */
	| { kind: "cancelled" }
	/** More consecutive request failures than the budget allows. */
	| { kind: "connection_lost" };

function finderJobLabel(scope: FinderServerJobKind): string {
	return scope === "asset_opportunity" || scope === "asset_opportunity_batch"
		? "Asset Opportunity"
		: scope === "arm_performance" ? "Arm Performance" : "Universe Finder";
}

export class FinderServerSession {
	/**
	 * Active server-run id for the server job currently in flight (or null).
	 * Acts as the ownership token: every stream + poll callback checks
	 * `session.isActive(runId)` before mutating UI state so a stale tab cannot
	 * clobber a newer run.
	 */
	private ownedRunId: string | null = null;
	private ownershipVersion = 0;

	get activeRunId(): string | null {
		return this.ownedRunId;
	}

	set activeRunId(runId: string | null) {
		if (runId !== this.ownedRunId) this.ownershipVersion += 1;
		this.ownedRunId = runId;
	}

	/**
	 * Cancel token for the pre-adoption phases (probe, detached Arm preview
	 * recovery). Stop sets it before a newer run can exist, so a resolved
	 * probe never adopts a run the user just stopped. Once a run is adopted,
	 * `activeRunId` is the ownership signal: Stop and a new Run both clear it.
	 */
	pollingStopped = false;

	/**
	 * Controller of the run currently issuing status requests (poll loop,
	 * probe, or a detached Arm preview recovery). Stop / a new run aborts it
	 * so no request outlives its owner; `releaseAbortController` drops only
	 * the controller that invocation owns.
	 */
	abortController: AbortController | null = null;

	/** Test seams: production code reads these, only the harness mutates them. */
	timing: FinderPollTiming = {
		pollIntervalMs: POLL_INTERVAL_MS,
		longPollIntervalMs: LONG_POLL_INTERVAL_MS,
		fastPollCount: FAST_POLL_COUNT,
		failureBackoffMs: FAILURE_BACKOFF_MS,
		maxConsecutiveFailures: MAX_REATTACH_CONSECUTIVE_FAILURES,
	};
	statusRequestTimeoutMs = FINDER_STATUS_REQUEST_TIMEOUT_MS;

	isActive(runId: string): boolean {
		return this.activeRunId === runId;
	}

	/**
	 * Generate a unique browser-side run id for a server Finder job. Used
	 * as the ownership token + persisted before fetch so a reload can
	 * identify the same server job.
	 */
	generateRunId(): string {
		const rand = Math.random().toString(36).slice(2, 10);
		return `finder-${Date.now().toString(36)}-${rand}`;
	}

	/** Cancel any in-flight reattach/recovery poll loop immediately. */
	stopReattachPoll(): void {
		this.pollingStopped = true;
		// Abort the owned status controller: a hung /status fetch rejects and
		// every abort-aware wait unblocks, so the loop notices cancellation at
		// its next check instead of waiting out a sleep.
		this.abortController?.abort();
		this.abortController = null;
	}

	releaseAbortController(controller: AbortController): void {
		if (this.abortController === controller) {
			this.abortController = null;
		}
	}

	/**
	 * Register a detached status request's controller (e.g. the Arm preview
	 * recovery) so Stop can abort it via `stopReattachPoll`.
	 */
	adoptAbortController(controller: AbortController): void {
		this.abortController = controller;
	}

	/**
	 * POST /api/finder/stop scoped to one run id so a stale tab cannot cancel
	 * a newer run. The persisted record is only cleared when the server
	 * confirms; on a network failure a reload can still reattach.
	 */
	async stopServerRun(runId: string, host: { setStatus(text: string): void }): Promise<void> {
		const ownershipVersion = this.ownershipVersion;
		try {
			const response = await fetch('/api/finder/stop', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ runId }),
			});
			if (!response.ok) {
				throw new Error(`status ${response.status}`);
			}
			const payload = await response.json() as { ok?: unknown; stopped?: unknown };
			if (payload.ok !== true) {
				throw new Error('server rejected the stop request');
			}
			// The matching run was stopped or was already terminal.
			if (readFinderActiveServerRun()?.runId === runId) {
				clearFinderActiveServerRun();
			}
		} catch (error) {
			debugLogger.warn('finder.server.stop_failed', {
				runId,
				error: error instanceof Error ? error.message : String(error),
			});
			const persistedRun = readFinderActiveServerRun();
			if (this.ownershipVersion === ownershipVersion
				&& (this.activeRunId === null || this.activeRunId === runId)
				&& (!persistedRun || persistedRun.runId === runId)) {
				host.setStatus('Finder Stop was rejected by the server; reload to reattach.');
			}
		}
	}

	/**
	 * Recover the initiating tab when its NDJSON connection ends before the
	 * terminal event. The server job keeps running, so poll the scoped status
	 * endpoint instead of treating provisional streamed candidates as final or
	 * allowing a replacement run to orphan the active server job. Returns the
	 * terminal snapshot, or null when ownership was lost / the job is gone.
	 */
	async recoverActiveServerRun(
		runId: string,
		jobKind: FinderServerJobKind,
		host: Pick<FinderSessionHost, 'setProgress' | 'setStatus'>,
	): Promise<FinderRunStatusSnapshot | null> {
		const abortController = new AbortController();
		this.abortController = abortController;
		try {
			const label = finderJobLabel(jobKind);
			const outcome = await this.pollOwnedServerRunStatus({
				runId,
				abortController,
				logEvent: "finder.server.stream_recovery_poll_failed",
				// Recovery's first request is immediate: the stream just died.
				initialDelayMs: null,
				nextRequestDelayMs: () => this.timing.pollIntervalMs,
				waitIntervalAfterFailure: false,
				onProgress: (snapshot) => {
					host.setProgress(true, snapshot.progressPercent, snapshot.statusText);
					host.setStatus(`${label}: ${snapshot.statusText}`);
				},
			});
			if (outcome.kind !== "terminal") return null;
			debugLogger.warn("finder.server.stream_recovered_via_status", {
				runId,
				phase: outcome.snapshot.phase,
				candidates: outcome.snapshot.terminalCandidates?.length ?? 0,
				assets: outcome.snapshot.terminalAssets?.length ?? 0,
			});
			return outcome.snapshot;
		} finally {
			this.releaseAbortController(abortController);
		}
	}

	/**
	 * Reattach to an in-flight or terminal server-owned Finder job after a
	 * tab reload. Called from Finder init (Finder is lazy-loaded, so reattach
	 * begins on first Finder activation — not at global startup). Reads the
	 * persisted active run id; if the server still has a matching job,
	 * restores progress + Stop state, then polls summary-only status through
	 * the shared owned-run loop until terminal. On terminal, delegates
	 * interpretation to `host.interpretTerminal` (which re-checks ownership),
	 * persists through the completed-results snapshot, and clears the
	 * active-run record.
	 *
	 * Reattach only survives a browser reload while the same Vite process
	 * remains alive; a Vite restart loses the in-memory job and the reattach
	 * clears its record.
	 */
	async reattachToActiveServerRun(host: FinderSessionHost): Promise<void> {
		const persisted = readFinderActiveServerRun();
		if (!persisted) {
			return;
		}
		const runId = persisted.runId;

		// Probe whether the server still has this job. The controller is
		// shared with stopReattachPoll so Stop can abort a hung probe.
		const abortController = new AbortController();
		this.abortController = abortController;
		const initialRequest = createFinderStatusRequestSignal(abortController.signal, this.statusRequestTimeoutMs);
		let initial: FinderRunStatusSnapshot | null = null;
		let confirmedMissing = false;
		try {
			const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, {
				cache: "no-store",
				signal: initialRequest.signal,
			});
			if (response.ok) {
				initial = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
			} else if (response.status === 404) {
				confirmedMissing = true;
			} else {
				this.releaseAbortController(abortController);
				return;
			}
		} catch {
			// Transient network error (or an abort from Stop) on the probe —
			// leave the persisted record intact; the user can reload again.
			// Do not claim completion.
			this.releaseAbortController(abortController);
			return;
		} finally {
			initialRequest.cleanup();
		}
		// Ownership check after the probe's await: a delayed response must not
		// adopt an old run after a new Run has started (or Stop was pressed)
		// while the probe was in flight — that would clobber the new run's
		// activeRunId and make every later callback mis-scope. `pollingStopped`
		// is the only cancellation signal here: the run is not adopted yet, so
		// activeRunId is still null even when Stop already fired.
		if (this.pollingStopped || this.activeRunId !== null) {
			this.releaseAbortController(abortController);
			return;
		}
		if (confirmedMissing || !initial || !initial.ok) {
			// Server has no matching job (Vite restart, or a different run
			// already completed). Clear the stale record so reattach doesn't
			// loop forever.
			this.releaseAbortController(abortController);
			clearFinderActiveServerRun();
			return;
		}

		// The server job exists. Adopt it as the active run.
		this.activeRunId = runId;
		this.pollingStopped = false;
		// The persisted ownership record identifies the job kind. Restore
		// that scope before any terminal snapshot is adopted so it cannot replace
		// a current-chart view while the UI still claims current-chart scope.
		// A batch job reattaches as the same asset_opportunity scope (the batch
		// is an orchestration detail, not a distinct render scope).
		const uiScope: FinderScope = persisted.scope === 'asset_opportunity_batch'
			? 'asset_opportunity'
			: persisted.scope;
		host.restoreScope(uiScope);
		host.setRunning(true);
		host.resetForServerRunAdoption();
		debugLogger.event("finder.server.reattach_started", {
			runId,
			phase: initial.phase,
			terminal: initial.terminal,
		});

		host.setProgress(true, initial.progressPercent, initial.statusText);
		const jobLabel = finderJobLabel(persisted.scope);
		host.setStatus(`Reattached to ${jobLabel}: ${initial.statusText}`);

		let clearPersistedRecord = false;
		const applyTerminalSnapshot = (snapshot: FinderRunStatusSnapshot): void => {
			if (!snapshot.terminal || this.activeRunId !== runId) return;
			clearPersistedRecord = true;
			host.interpretTerminal(snapshot, persisted.scope);
			this.setStatusHost(host, snapshot.error ?? snapshot.summary ?? snapshot.statusText);
			debugLogger.event("finder.server.reattach_terminal", {
				runId,
				phase: snapshot.phase,
				candidates: snapshot.terminalCandidates?.length ?? 0,
				assets: snapshot.terminalAssets?.length ?? 0,
				arms: snapshot.terminalArmPerformanceResults?.length ?? 0,
			});
		};
		applyTerminalSnapshot(initial);

		if (!clearPersistedRecord) {
			const outcome = await this.pollOwnedServerRunStatus({
				runId,
				abortController,
				logEvent: "finder.server.reattach_poll_failed",
				// Adopted reattach waits before subsequent requests, then
				// steps down after `fastPollCount` polls, and re-waits the
				// interval after every failure backoff before retrying.
				initialDelayMs: this.timing.pollIntervalMs,
				nextRequestDelayMs: (pollIndex) => pollIndex >= this.timing.fastPollCount
					? this.timing.longPollIntervalMs
					: this.timing.pollIntervalMs,
				waitIntervalAfterFailure: true,
				onProgress: (snapshot) => {
					host.setProgress(true, snapshot.progressPercent, snapshot.statusText);
					this.setStatusHost(host, `${jobLabel}: ${snapshot.statusText}`);
				},
			});
			// Guard the outcome-driven writes on ownership: the loop checks
			// after every await, but every caller-visible consequence (status
			// messages, terminal adoption, record clearing) must also re-verify
			// that this run still owns the session before touching anything.
			if (this.activeRunId === runId) {
				switch (outcome.kind) {
					case "terminal":
						applyTerminalSnapshot(outcome.snapshot);
						break;
					case "not_found":
						// Server job is gone (restart). Stop polling and clear the
						// record; don't claim completion.
						clearPersistedRecord = true;
						this.setStatusHost(host, "Server Finder run lost (dev server restarted).");
						break;
					case "rejected":
						clearPersistedRecord = true;
						this.setStatusHost(host, "Server Finder run no longer active.");
						break;
					case "connection_lost":
						this.setStatusHost(host, "Server connection lost — reload to retry Universe Finder reattach.");
						break;
					case "cancelled":
						// Stop / a newer run owns the session now; the teardown
						// below decides what may still be touched.
						break;
				}
			}
		}

		// Teardown. Only the path that still owns the run id clears ownership
		// and the persisted record. The run UI is reverted only when no newer
		// run owns it (that run's lifecycle owns its UI now); Stop leaves
		// activeRunId null, so Stop still reverts the UI here.
		const ownershipIntact = this.activeRunId === runId;
		if (ownershipIntact) {
			this.activeRunId = null;
			if (clearPersistedRecord) {
				clearFinderActiveServerRun();
			}
		}
		if (ownershipIntact || this.activeRunId === null) {
			host.setRunning(false);
			host.setProgress(false, 0, "");
		}
		this.releaseAbortController(abortController);
	}

	/**
	 * THE status poll loop for a run this session owns. Fetches and parses
	 * the scoped summary snapshot, waits between requests (abort-aware, so
	 * Stop / a new run unblock a pending sleep immediately), retries with the
	 * failure backoff, and terminates on terminal / missing / cancellation /
	 * connection exhaustion. It performs NO side effects beyond per-cycle
	 * progress reporting: every adoption, terminal interpretation, status
	 * message, and persisted-record decision belongs to the caller.
	 *
	 * Ownership (`activeRunId === runId`) is re-checked after every await and
	 * before any progress update or terminal return, so a stale response can
	 * never leak into a newer run's UI.
	 */
	private async pollOwnedServerRunStatus(args: {
		runId: string;
		abortController: AbortController;
		/** debugLogger event name for a failed request cycle. */
		logEvent: string;
		/** Delay before the first request; null issues it immediately. */
		initialDelayMs: number | null;
		/**
		 * Delay before the request that follows the pollIndex-th completed
		 * cycle (pollIndex has already been incremented for the upcoming
		 * request, so the delay before request N uses N-1).
		 */
		nextRequestDelayMs: (pollIndex: number) => number;
		/**
		 * Retry-delay policy after a failure backoff: recovery's retry follows
		 * the backoff directly (false); adopted reattach additionally re-waits
		 * the polling interval before retrying, matching its pre-consolidation
		 * cadence (true).
		 */
		waitIntervalAfterFailure: boolean;
		onProgress: (snapshot: FinderRunStatusSnapshot) => void;
	}): Promise<FinderOwnedRunPollOutcome> {
		const { runId, abortController } = args;
		// Once a run is adopted, Stop and a new Run both drop its run id, so
		// the active id is the single ownership/cancellation signal here.
		const owned = (): boolean => this.activeRunId === runId;

		if (args.initialDelayMs !== null) {
			if (!owned()) return { kind: "cancelled" };
			if (!await this.waitWithAbort(args.initialDelayMs, abortController.signal)) {
				return { kind: "cancelled" };
			}
		}
		let consecutiveFailures = 0;
		let pollIndex = 0;
		for (;;) {
			if (!owned()) return { kind: "cancelled" };
			const statusRequest = createFinderStatusRequestSignal(abortController.signal, this.statusRequestTimeoutMs);
			let snapshot: FinderRunStatusSnapshot | null = null;
			try {
				const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, {
					cache: "no-store",
					signal: statusRequest.signal,
				});
				// Ownership check immediately after the await, BEFORE reading the
				// HTTP status: a stale response of any kind (404 included) that
				// lands after a new run (or Stop) took over must be discarded as
				// cancellation, never mapped to a missing-job outcome that the
				// caller would report or persist.
				if (!owned()) return { kind: "cancelled" };
				if (response.status === 404) return { kind: "not_found" };
				if (!response.ok) throw new Error(`status ${response.status}`);
				snapshot = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
			} catch (error) {
				// An abort from Stop / a new run is cancellation, not a
				// transient failure — never count it against the backoff budget.
				if (!owned()) return { kind: "cancelled" };
				consecutiveFailures += 1;
				debugLogger.warn(args.logEvent, {
					runId,
					consecutive: consecutiveFailures,
					error: error instanceof Error ? error.message : String(error),
				});
				if (consecutiveFailures > this.timing.maxConsecutiveFailures) {
					return { kind: "connection_lost" };
				}
				const backoffIndex = Math.min(consecutiveFailures - 1, this.timing.failureBackoffMs.length - 1);
				if (!await this.waitWithAbort(this.timing.failureBackoffMs[backoffIndex]!, abortController.signal)) {
					return { kind: "cancelled" };
				}
				// Per-caller retry cadence: recovery fetches right after the
				// backoff; adopted reattach re-waits the polling interval first
				// (its pre-consolidation sequence: backoff, then interval).
				if (args.waitIntervalAfterFailure) {
					if (!await this.waitWithAbort(args.nextRequestDelayMs(pollIndex), abortController.signal)) {
						return { kind: "cancelled" };
					}
				}
				// Retries never advance the interval step-down counter.
				continue;
			} finally {
				// The request settled: drop its timeout timer and parent
				// listener before any wait so nothing leaks across cycles.
				statusRequest.cleanup();
			}
			// Belt-and-braces ownership re-check after the settle: the fetch
			// path above already guards, so this only fires for future code
			// added between them.
			if (!owned()) return { kind: "cancelled" };
			if (!snapshot || !snapshot.ok) return { kind: "rejected" };
			consecutiveFailures = 0;
			if (snapshot.terminal) {
				return { kind: "terminal", snapshot };
			}
			args.onProgress(snapshot);
			// Advance the counter BEFORE selecting the next delay so the wait
			// before request N uses pollIndex = N-1 — exactly the pre-shared
			// reattach semantics (long-poll step-down after fastPollCount
			// completed polls, i.e. before request fastPollCount + 2).
			pollIndex += 1;
			if (!await this.waitWithAbort(args.nextRequestDelayMs(pollIndex), abortController.signal)) {
				return { kind: "cancelled" };
			}
		}
	}

	/**
	 * Abort-aware wait: resolves true after `ms`, false as soon as `signal`
	 * aborts. Used for every poll interval and failure backoff so Stop / a
	 * new run unblock a pending sleep immediately.
	 */
	private waitWithAbort(ms: number, signal: AbortSignal): Promise<boolean> {
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

	private setStatusHost(host: { setStatus(text: string): void }, text: string): void {
		host.setStatus(text);
	}
}
