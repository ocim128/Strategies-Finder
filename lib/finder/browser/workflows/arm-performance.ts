/**
 * Arm Performance scope workflow: one server job replays every configuration
 * across the synthetic-pair universe and streams per-candidate results. The
 * browser coalesces candidate renders per animation frame, retains the full
 * compact inventory for post-run re-sort, and adopts the authoritative
 * terminal inventory + run context from the terminal event.
 */
import { state } from "../../../state";
import { backtestService } from "../../../backtest-service";
import { settingsManager } from "../../../settings-manager";
import { uiManager } from "../../../ui-manager";
import { consumeNdjsonStream } from "../../../ndjson-stream";
import { coalesceAnimationFrame } from "../../../render-scheduler";
import { shouldUseRustEngine } from "../../../engine-preferences";
import type { FinderStreamEvent } from "../../server/finder-stream-types";
import {
	FINDER_ARM_PERFORMANCE_REPLAY_FIELDS,
	sortFinderArmPerformanceResults,
	type FinderArmPerformanceArm,
} from "../../finder-arm-performance-metrics";
import type {
	FinderArmPerformanceCandidate,
	FinderOptions,
} from "../../../types/finder";
import type { FinderResultStore } from "../finder-result-store";
import type { FinderServerSession } from "../finder-server-session";
import { clearFinderActiveServerRun, writeFinderActiveServerRun } from "../finder-persistence";
import type { FinderRunHost } from "./finder-run-host";

const ARM_PERFORMANCE_PREVIEW_PERSIST_INTERVAL_MS = 5_000;

export interface ArmPerformanceWorkflowArgs {
	host: FinderRunHost;
	store: FinderResultStore;
	session: FinderServerSession;
	options: FinderOptions;
	startTime: number;
	getUniverseSelectedStrategies(): Promise<import("../../../finder/finder-runner").FinderSelectedStrategy[]>;
	resolveExitStrategyCandidates(
		options: FinderOptions,
		selectedStrategies: import("../../../finder/finder-runner").FinderSelectedStrategy[],
	): Promise<import("../../../finder/finder-runner").FinderSelectedStrategy[] | undefined>;
	getPairListText(): string;
	/** The Arm sort the re-sort dropdown currently shows (render frames). */
	getSelectedArm(): FinderArmPerformanceArm;
	/** Mark the browser run cancelled (Stop) so run finalization reports it. */
	onCancelled(): void;
}

export async function runArmPerformanceFinder(args: ArmPerformanceWorkflowArgs): Promise<boolean> {
	const { host, store, session, options, startTime } = args;
	const selectedStrategies = await args.getUniverseSelectedStrategies();
	if (selectedStrategies.length === 0) {
		host.setStatus('Select at least one strategy for Arm Performance.');
		return false;
	}
	if (options.mode !== 'grid' && options.mode !== 'random') {
		host.setStatus('Arm Performance supports Grid Sweep and Random Search only.');
		return false;
	}
	const exitStrategyCandidates = await args.resolveExitStrategyCandidates(options, selectedStrategies);
	const runId = session.generateRunId();
	session.activeRunId = runId;
	writeFinderActiveServerRun({ runId, scope: 'arm_performance', startedAt: startTime });
	store.armPerformanceDisplayLimit = Math.max(1, options.topN);
	store.initializeArmPerformanceDisplayFilter({
		measurement: options.armPerformance?.measurement ?? 'return',
		rankingSort: options.armPerformance?.rankingSort ?? 'overall_ordering',
		rankingHorizon: options.armPerformance?.replayMode === 'asset_switch' ? options.armPerformance?.rankingHorizon : options.armPerformance?.horizon,
		basis: options.armPerformance?.scoringBasis ?? 'raw',
		eventFilterEnabled: options.armPerformance?.eventFilterEnabled ?? false,
		minEvents: options.armPerformance?.minEvents ?? 1,
		maxEvents: options.armPerformance?.maxEvents ?? null,
	});
	const outcome = await runArmPerformanceFinderServer({
		host,
		store,
		session,
		options,
		selectedStrategies,
		exitStrategyCandidates,
		runId,
		getPairListText: args.getPairListText,
		getSelectedArm: args.getSelectedArm,
	});
	if (session.isActive(runId)) {
		session.activeRunId = null;
		clearFinderActiveServerRun();
	}
	if (outcome.cancelled) {
		args.onCancelled();
		host.setStatus(`Arm Performance stopped after ${store.armPerformanceRunResults.length} completed configurations.`);
		return false;
	}
	if (!outcome.ok) {
		host.setStatus(`Arm Performance stopped at ${store.armPerformanceRunResults.length} completed configurations. ${outcome.error ?? 'See server status for details.'}`);
		uiManager.showToast('Arm Performance stopped after a candidate failure. Completed rows were retained.', 'error');
		return false;
	}
	const skippedPairCount = store.armPerformanceRunContext?.skippedPairs?.length ?? 0;
	const failedPairCount = store.armPerformanceRunContext?.failedPairs?.filter((failure) => failure.failureKind === 'missing_data').length ?? 0;
	const skippedPairNoun = skippedPairCount === 1 ? 'pair' : 'pairs';
	const runtimeFailedPairNoun = failedPairCount === 1 ? 'pair' : 'pairs';
	const skippedPairSummary = skippedPairCount > 0 ? `; skipped ${skippedPairCount} ${skippedPairNoun} before evaluation` : '';
	const runtimeFailedPairSummary = failedPairCount > 0 ? `; skipped ${failedPairCount} ${runtimeFailedPairNoun} with missing data during evaluation` : '';
	host.setStatus(`Arm Performance completed ${store.armPerformanceRunResults.length} configurations across ${store.armPerformanceRunContext?.pairs.length ?? 0} pairs${skippedPairSummary}${runtimeFailedPairSummary} (${Math.round(performance.now() - startTime)}ms).`);
	return true;
}

async function runArmPerformanceFinderServer(args: {
	host: FinderRunHost;
	store: FinderResultStore;
	session: FinderServerSession;
	options: FinderOptions;
	selectedStrategies: import("../../../finder/finder-runner").FinderSelectedStrategy[];
	exitStrategyCandidates: import("../../../finder/finder-runner").FinderSelectedStrategy[] | undefined;
	runId: string;
	getPairListText(): string;
	getSelectedArm(): FinderArmPerformanceArm;
}): Promise<{ ok: boolean; cancelled: boolean; error: string | null }> {
	const { host, store, session, options, selectedStrategies, exitStrategyCandidates, runId } = args;
	const settings = backtestService.getBacktestSettings();
	const capitalSettings = backtestService.getCapitalSettings();
	store.armPerformanceApplyContext = {
		interval: state.currentInterval,
		uiBacktestSettings: settingsManager.getBacktestSettings(),
		capitalSettings,
	};
	const response = await fetch('/api/finder/arm-performance-run', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			runId,
			pairListText: args.getPairListText(),
			interval: state.currentInterval,
			options,
			settings,
			uiBacktestSettings: settingsManager.getBacktestSettings(),
			capitalSettings,
			strategyKeys: selectedStrategies.map(({ key }) => key),
			exitStrategyKeys: exitStrategyCandidates?.map(({ key }) => key),
			useRustEnginePreference: shouldUseRustEngine(),
		}),
	});
	if (response.status === 404 || response.status === 405) {
		throw new Error('Arm Performance requires a Vite server runtime; static-only deployments are unsupported.');
	}
	if (!response.ok || !response.body) {
		const text = await response.text();
		let payload: { error?: string } = {};
		try { payload = JSON.parse(text); } catch { /* ignore */ }
		throw new Error(payload.error ?? `Server Arm Performance run failed (${response.status}).`);
	}

	const isStillActive = (): boolean => session.isActive(runId);
	const candidatesById = new Map<string, FinderArmPerformanceCandidate>();
	let terminal: { ok: boolean; cancelled: boolean; error: string | null } | null = null;
	let streamError: unknown = null;
	let finalized = false;
	let lastPreviewPersistedAt = 0;
	const renderFrame = coalesceAnimationFrame(() => {
		if (!finalized && isStillActive()) {
			const selectedArm = args.getSelectedArm();
			const availableArms = Object.keys(FINDER_ARM_PERFORMANCE_REPLAY_FIELDS) as FinderArmPerformanceArm[];
			const sortArm = availableArms.includes(selectedArm) ? selectedArm : 'TOP_RAW_PROFIT_NOW';
			const inventory = [...candidatesById.values()];
			store.armPerformanceRunResults = inventory;
			const sorted = sortFinderArmPerformanceResults(inventory, sortArm, store.armPerformanceDisplayFilter);
			// Keep a bounded local preview available across a browser reload while
			// the server-owned run continues. Checkpoint at most every few seconds
			// so localStorage serialization does not run on every render frame.
			const now = Date.now();
			const shouldPersistPreview = lastPreviewPersistedAt === 0
				|| now - lastPreviewPersistedAt >= ARM_PERFORMANCE_PREVIEW_PERSIST_INTERVAL_MS;
			store.setArmPerformanceLatestResults(sorted, shouldPersistPreview, options.topN, false);
			if (shouldPersistPreview) lastPreviewPersistedAt = now;
			host.renderLatestResults();
		}
	});
	try {
		await consumeNdjsonStream<FinderStreamEvent>(response.body, {
			onArmStart: (event) => {
				if (event.runId !== runId || !isStillActive()) return;
				const skippedPairCount = event.skippedPairCount ?? 0;
				const skippedPairNoun = skippedPairCount === 1 ? 'pair' : 'pairs';
				const skippedPairSummary = skippedPairCount > 0
					? ` · skipped ${skippedPairCount} ${skippedPairNoun} with missing data`
					: '';
				const replayLabel = event.replayMode === "asset_switch"
					? "hold until asset changes"
					: `horizon ${event.horizon ?? "?"}`;
				host.setStatus(`Arm Performance: ${event.plannedCandidates} configurations × ${event.pairCount} pairs · ${replayLabel}${skippedPairSummary}`);
			},
			onArmProgress: (event) => {
				if (event.runId !== runId || !isStillActive()) return;
				host.setProgress(true, event.percent, event.text);
				host.setStatus(`Arm Performance ${event.candidateOrdinal + 1}/${event.totalCandidates} · ${event.strategyName} · ${event.childPhase}`);
			},
			onArmCandidate: (event) => {
				if (event.runId !== runId || !isStillActive()) return;
				candidatesById.set(event.candidateId, event.candidate);
				renderFrame.schedule();
			},
			onArmDone: (event) => {
				if (event.runId !== runId) return;
				terminal = { ok: event.ok, cancelled: event.cancelled, error: event.error };
				finalized = true;
				if (isStillActive() || (host.isCancelled() && session.activeRunId === null)) {
					store.adoptArmPerformanceResults(event.results, event.runContext, true);
					host.stashAndResetResort();
					host.populateResortOptions();
					host.renderLatestResults();
				}
			},
		}, { requireTerminal: true, terminalTypes: ['arm_done'] });
	} catch (error) {
		streamError = error;
	}

	if (streamError !== null && terminal === null && isStillActive()) {
		const recovered = await session.recoverActiveServerRun(runId, 'arm_performance', host);
		if (recovered?.terminalArmPerformanceResults) {
			store.adoptArmPerformanceResults(
				recovered.terminalArmPerformanceResults,
				recovered.armPerformanceRunContext ?? null,
				true,
			);
			host.stashAndResetResort();
			host.populateResortOptions();
			host.renderLatestResults();
			terminal = {
				ok: recovered.phase === 'done',
				cancelled: recovered.cancelled,
				error: recovered.error,
			};
			finalized = true;
		}
	}
	if (streamError !== null && terminal === null) {
		if (host.isCancelled() && !isStillActive()) return { ok: false, cancelled: true, error: null };
		throw streamError;
	}
	if (terminal === null) throw new Error('Arm Performance stream ended without a terminal result.');
	host.setProgress(false, terminal.ok ? 100 : 0, '');
	return terminal;
}
