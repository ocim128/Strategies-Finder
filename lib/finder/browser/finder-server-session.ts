/**
 * Finder server-run session: browser-side ownership of one server Finder job.
 * Owns the active run id (the ownership token every stream/poll callback
 * checks after an await), the scoped Stop call, status-request timeout
 * signals, and the reattach/recovery poll loops with their timer + abort
 * cleanup. Browser-only.
 *
 * Terminal result interpretation is scope-specific and stays with the
 * workflows/facade through the `interpretTerminal` callback; this module only
 * guarantees that interpretation runs for the run that still owns the id.
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
 * `FINDER_STATUS_REQUEST_TIMEOUT_MS` and aborts with the parent (Stop / new
 * run). The caller must invoke `cleanup()` when the request settles.
 */
export function createFinderStatusRequestSignal(parentSignal: AbortSignal): {
	signal: AbortSignal;
	cleanup: () => void;
} {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), FINDER_STATUS_REQUEST_TIMEOUT_MS);
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

export class FinderServerSession {
	/**
	 * Active server-run id for the server job currently in flight (or null).
	 * Acts as the ownership token: every stream + poll callback checks
	 * `session.isActive(runId)` before mutating UI state so a stale tab cannot
	 * clobber a newer run.
	 */
	activeRunId: string | null = null;
	/**
	 * Reattach poller state. `pollingStopped` is the cancel token;
	 * `timerResolve` lets Stop / a new Run unblock a pending poll sleep
	 * immediately. `abortController` aborts any in-flight `/api/finder/status`
	 * fetch so Stop / a new Run cannot leave a hung status request pending
	 * (and its late response adopting stale run state).
	 */
	pollingStopped = false;
	timer: ReturnType<typeof setTimeout> | null = null;
	timerResolve: (() => void) | null = null;
	abortController: AbortController | null = null;

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

	/** Cancel any in-flight reattach poll loop immediately. */
	stopReattachPoll(): void {
		this.pollingStopped = true;
		// Abort a hung status fetch so the reattach/recovery loop cannot wait
		// on a request that will never resolve while the UI is being stopped.
		this.abortController?.abort();
		this.abortController = null;
		if (this.timer) {
			clearTimeout(this.timer);
			this.timer = null;
		}
		if (this.timerResolve) {
			this.timerResolve();
			this.timerResolve = null;
		}
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
			clearFinderActiveServerRun();
		} catch (error) {
			debugLogger.warn('finder.server.stop_failed', {
				runId,
				error: error instanceof Error ? error.message : String(error),
			});
			host.setStatus('Finder Stop was rejected by the server; reload to reattach.');
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
		let consecutiveFailures = 0;

		const abortController = new AbortController();
		this.abortController = abortController;
		try {
			while (this.activeRunId === runId) {
				const statusRequest = createFinderStatusRequestSignal(abortController.signal);
				try {
					const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, {
						cache: "no-store",
						signal: statusRequest.signal,
					});
					if (response.status === 404) return null;
					if (!response.ok) throw new Error(`status ${response.status}`);
					const snapshot = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
					// Ownership check after the await: a stale response that lands
					// after a new run (or Stop) changed activeRunId must be
					// discarded, never adopted.
					if (this.activeRunId !== runId) return null;
					if (!snapshot.ok) return null;
					consecutiveFailures = 0;
					if (snapshot.terminal) {
						debugLogger.warn("finder.server.stream_recovered_via_status", {
							runId,
							phase: snapshot.phase,
							candidates: snapshot.terminalCandidates?.length ?? 0,
							assets: snapshot.terminalAssets?.length ?? 0,
						});
						return snapshot;
					}
					host.setProgress(true, snapshot.progressPercent, snapshot.statusText);
					const label = jobKind === 'asset_opportunity' || jobKind === 'asset_opportunity_batch'
						? 'Asset Opportunity'
						: jobKind === 'arm_performance' ? 'Arm Performance' : 'Universe Finder';
					host.setStatus(`${label}: ${snapshot.statusText}`);
					await new Promise<void>((resolve) => setTimeout(resolve, 2_000));
				} catch (error) {
					// An abort (Stop / new run) is not a transient failure — bail
					// out without counting it against the backoff budget.
					if (this.activeRunId !== runId) return null;
					consecutiveFailures += 1;
					debugLogger.warn("finder.server.stream_recovery_poll_failed", {
						runId,
						consecutive: consecutiveFailures,
						error: error instanceof Error ? error.message : String(error),
					});
					if (consecutiveFailures > MAX_REATTACH_CONSECUTIVE_FAILURES) return null;
					const backoffIndex = Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1);
					await new Promise<void>((resolve) => setTimeout(resolve, FAILURE_BACKOFF_MS[backoffIndex]!));
				} finally {
					statusRequest.cleanup();
				}
			}
			return null;
		} finally {
			this.releaseAbortController(abortController);
		}
	}

	/**
	 * Reattach to an in-flight or terminal server-owned Finder job after a
	 * tab reload. Called from Finder init (Finder is lazy-loaded, so reattach
	 * begins on first Finder activation — not at global startup). Reads the
	 * persisted active run id; if the server still has a matching job,
	 * restores progress + Stop state, then polls summary-only status at a
	 * bounded interval until terminal. On terminal, delegates interpretation
	 * to `host.interpretTerminal` (which re-checks ownership), persists
	 * through the completed-results snapshot, and clears the active-run
	 * record.
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
		const initialRequest = createFinderStatusRequestSignal(abortController.signal);
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
		// activeRunId and make every later callback mis-scope.
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
		const jobLabel = persisted.scope === 'asset_opportunity' || persisted.scope === 'asset_opportunity_batch'
			? 'Asset Opportunity'
			: persisted.scope === 'arm_performance' ? 'Arm Performance' : 'Universe Finder';
		host.setStatus(`Reattached to ${jobLabel}: ${initial.statusText}`);
		let clearPersistedRecord = false;
		let terminalReached = false;
		const applyTerminalSnapshot = (snapshot: FinderRunStatusSnapshot): void => {
			if (!snapshot.terminal || this.activeRunId !== runId) return;
			terminalReached = true;
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

		let consecutiveFailures = 0;

		const sleep = (ms: number): Promise<void> => new Promise<void>((resolve) => {
			this.timerResolve = resolve;
			this.timer = setTimeout(resolve, ms);
		});

		for (let poll = 0; !terminalReached; poll += 1) {
			if (this.pollingStopped || this.activeRunId !== runId) break;
			const delay = poll >= FAST_POLL_COUNT ? LONG_POLL_INTERVAL_MS : POLL_INTERVAL_MS;
			await sleep(delay);
			if (this.pollingStopped || this.activeRunId !== runId) break;

			let snapshot: FinderRunStatusSnapshot | null = null;
			const statusRequest = createFinderStatusRequestSignal(abortController.signal);
			try {
				const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, {
					cache: "no-store",
					signal: statusRequest.signal,
				});
				if (!response.ok) {
					// 404 means the server job is gone (restart). Stop polling
					// and clear the record; don't claim completion.
					if (response.status === 404) {
						clearPersistedRecord = true;
						this.setStatusHost(host, "Server Finder run lost (dev server restarted).");
						break;
					}
					throw new Error(`status ${response.status}`);
				}
				snapshot = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
			} catch (error) {
				if (this.pollingStopped || this.activeRunId !== runId) break;
				consecutiveFailures += 1;
				debugLogger.warn("finder.server.reattach_poll_failed", {
					runId,
					consecutive: consecutiveFailures,
					error: error instanceof Error ? error.message : String(error),
				});
				if (consecutiveFailures > MAX_REATTACH_CONSECUTIVE_FAILURES) {
					this.setStatusHost(host, "Server connection lost — reload to retry Universe Finder reattach.");
					break;
				}
				const backoffIndex = Math.min(consecutiveFailures - 1, FAILURE_BACKOFF_MS.length - 1);
				poll -= 1; // don't advance into long-poll step-down due to retries
				await sleep(FAILURE_BACKOFF_MS[backoffIndex]!);
				continue;
			} finally {
				statusRequest.cleanup();
			}

			consecutiveFailures = 0;
			if (!snapshot || !snapshot.ok) {
				// Server no longer has this run id — stop and clear.
				clearPersistedRecord = true;
				this.setStatusHost(host, "Server Finder run no longer active.");
				break;
			}

			// Update progress from the summary-only snapshot (no candidate
			// payload while running).
			host.setProgress(true, snapshot.progressPercent, snapshot.statusText);
			this.setStatusHost(host, `${jobLabel}: ${snapshot.statusText}`);

			applyTerminalSnapshot(snapshot);
		}

		// Teardown: only the reattach path that still owns the run id clears it.
		if (this.activeRunId === runId) {
			this.activeRunId = null;
			if (clearPersistedRecord) {
				clearFinderActiveServerRun();
			}
		}
		this.timer = null;
		this.timerResolve = null;
		this.releaseAbortController(abortController);
		host.setRunning(false);
		host.setProgress(false, 0, "");
	}

	private setStatusHost(host: { setStatus(text: string): void }, text: string): void {
		host.setStatus(text);
	}
}
