/**
 * Asset Opportunity scope workflows: single-run and batch (holdout sweep)
 * server jobs. Consumes the NDJSON streams, retains the full scalar rows for
 * post-run re-sort, and adopts terminal inventories through the result
 * store. Batch renders only the latest completed iteration; prior iterations
 * were already archived server-side.
 */
import { state } from "../../../state";
import { backtestService } from "../../../backtest-service";
import { uiManager } from "../../../ui-manager";
import { debugLogger } from "../../../debug-logger";
import { consumeNdjsonStream } from "../../../ndjson-stream";
import { shouldUseRustEngine } from "../../../engine-preferences";
import {
	ASSET_OPPORTUNITY_ALL_SORTS,
	retainAssetOpportunityResultsForSymbols,
	sortAssetOpportunityResults,
	type FinderAssetOpportunityArchiveSort,
} from "../../finder-asset-opportunity-metrics";
import type {
	FinderAssetOpportunityBatchStreamEvent,
	FinderAssetOpportunityStreamEvent,
} from "../../server/finder-stream-types";
import type {
	FinderAssetOpportunityResult,
	FinderDiagnostics,
	FinderOptions,
} from "../../../types/finder";
import type { FinderResultStore } from "../finder-result-store";
import type { FinderServerSession } from "../finder-server-session";
import { clearFinderActiveServerRun, writeFinderActiveServerRun } from "../finder-persistence";
import type { FinderRunHost, FinderStrategySource } from "./finder-run-host";

/**
 * Trailing-edge flush interval for provisional Asset Opportunity rows.
 * Streamed rows can arrive in the thousands; sorting + re-rendering the full
 * list per row is O(n^2 log n) plus a DOM rebuild per event. State stays
 * event-accurate — only the render is coalesced.
 */
const ASSET_PROVISIONAL_RENDER_FLUSH_MS = 150;

interface ServerAssetOpportunityRunOutcome {
	results: FinderAssetOpportunityResult[];
	diagnostics: FinderDiagnostics | null;
	assetDiagnostics: FinderDiagnostics['assetOpportunity'] | null;
	assetsWithFreshEntry: number;
	failedAssets: number;
}

function assetDisplayedResults(store: FinderResultStore): FinderAssetOpportunityResult[] {
	return store.latestResults.scope === 'asset_opportunity' ? store.latestResults.results : [];
}

function buildAssetTotalsFallback(outcome: {
	assetDiagnostics: FinderDiagnostics['assetOpportunity'] | null;
	assetsWithFreshEntry: number;
	failedAssets: number;
}, symbolCount: number): FinderDiagnostics['assetOpportunity'] {
	return outcome.assetDiagnostics ?? {
		totalAssets: symbolCount,
		assetsWithFreshEntry: outcome.assetsWithFreshEntry,
		assetsWithNoFreshEntry: Math.max(0, symbolCount - outcome.assetsWithFreshEntry - outcome.failedAssets),
		selectGradeAssets: 0,
		watchGradeAssets: 0,
		rejectGradeAssets: 0,
		failedAssets: [],
	};
}

/** Strategy-loading + input seams supplied by the facade. */
export interface AssetOpportunityWorkflowArgs {
	host: FinderRunHost;
	store: FinderResultStore;
	session: FinderServerSession;
	strategies: FinderStrategySource;
	options: FinderOptions;
	startTime: number;
	getSelectedStrategies(): Promise<import("../../../finder/finder-runner").FinderSelectedStrategy[]>;
	/** Store terminal diagnostics on the facade. */
	onDiagnostics(diagnostics: FinderDiagnostics | null, assetDiagnostics: FinderDiagnostics['assetOpportunity'] | null): void;
}

export interface BatchHoldoutRange {
	start: number;
	end: number;
	error: string | null;
}

export async function runAssetOpportunityFinder(args: AssetOpportunityWorkflowArgs): Promise<boolean> {
	const { host, store, session, options, startTime } = args;
	const selectedStrategies = await args.getSelectedStrategies();
	if (selectedStrategies.length === 0) {
		host.setStatus('Select at least one strategy for Asset Opportunity mode.');
		return false;
	}
	const symbols = options.assetOpportunity?.symbols ?? [];
	if (symbols.length === 0) {
		host.setStatus('Add at least one symbol for Asset Opportunity mode.');
		return false;
	}

	const exitStrategyCandidates = await args.strategies.resolveExitStrategyCandidates(options, selectedStrategies);
	const runId = session.generateRunId();
	session.activeRunId = runId;
	writeFinderActiveServerRun({ runId, scope: 'asset_opportunity', startedAt: startTime });

	const outcome = await runAssetOpportunityFinderServer({
		host,
		store,
		session,
		options,
		selectedStrategies,
		exitStrategyCandidates,
		runId,
		startTime,
	});

	if (session.isActive(runId)) {
		session.activeRunId = null;
		clearFinderActiveServerRun();
	}
	const assetDiagnostics = buildAssetTotalsFallback(outcome, symbols.length);
	args.onDiagnostics(outcome.diagnostics, assetDiagnostics);
	host.showDiagnosticsAvailability(Boolean(outcome.diagnostics || assetDiagnostics));
	host.renderRandomBenchmark('random');

	if (!host.isCancelled() && session.activeRunId === null) {
		const terminalAssetDiagnostics = outcome.assetDiagnostics;
		const totalAssets = terminalAssetDiagnostics?.totalAssets ?? symbols.length;
		const freshAssets = terminalAssetDiagnostics?.assetsWithFreshEntry ?? outcome.assetsWithFreshEntry;
		const failedAssets = terminalAssetDiagnostics?.failedAssets.length ?? outcome.failedAssets;
		host.setStatus(
			`Asset Opportunity complete. ${outcome.results.length}/${totalAssets} fresh opportunities` +
			` | ${freshAssets} fresh assets | ${failedAssets} failed` +
			` | ${Math.round(performance.now() - startTime)}ms`,
		);
	}
	return true;
}

async function runAssetOpportunityFinderServer(args: {
	host: FinderRunHost;
	store: FinderResultStore;
	session: FinderServerSession;
	options: FinderOptions;
	selectedStrategies: import("../../../finder/finder-runner").FinderSelectedStrategy[];
	exitStrategyCandidates: import("../../../finder/finder-runner").FinderSelectedStrategy[] | undefined;
	runId: string;
	startTime: number;
}): Promise<ServerAssetOpportunityRunOutcome> {
	const { host, store, session, options, selectedStrategies, exitStrategyCandidates, runId, startTime } = args;
	const settings = backtestService.getBacktestSettings();
	const capitalSettings = backtestService.getCapitalSettings();
	const symbols = options.assetOpportunity?.symbols ?? [];

	const response = await fetch('/api/finder/asset-opportunity-run', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			runId,
			symbols,
			interval: state.currentInterval,
			options,
			settings,
			capitalSettings,
			strategyKeys: selectedStrategies.map((candidate) => candidate.key),
			exitStrategyKeys: exitStrategyCandidates?.map((candidate) => candidate.key),
			useRustEnginePreference: shouldUseRustEngine(),
		}),
	});
	if (response.status === 404 || response.status === 405) {
		throw new Error("Asset Opportunity requires a Vite server runtime; static-only deployments are unsupported.");
	}
	if (!response.ok || !response.body) {
		const text = await response.text();
		let payload: { error?: string } = {};
		try { payload = JSON.parse(text); } catch { /* ignore */ }
		throw new Error(payload.error ?? `Server Asset Opportunity run failed (${response.status}).`);
	}

	const isStillActive = (): boolean => session.isActive(runId);
	const submittedAssetSymbols = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
	const provisionalAssetResults = new Map<string, FinderAssetOpportunityResult>();
	const assetResultKey = (result: FinderAssetOpportunityResult): string =>
		`${result.symbol.trim().toUpperCase()}\u0000${result.strategyKey}`;
	const retainSubmittedAssetResults = (
		results: readonly FinderAssetOpportunityResult[],
	): FinderAssetOpportunityResult[] => {
		const retained = retainAssetOpportunityResultsForSymbols(results, submittedAssetSymbols);
		if (retained.length !== results.length) {
			debugLogger.warn("finder.asset_opportunity.stale_result_ignored", {
				runId,
				ignoredSymbols: results
					.filter((result) => !submittedAssetSymbols.has(result.symbol.trim().toUpperCase()))
					.map((result) => result.symbol),
			});
		}
		return retained;
	};
	let terminalResults: FinderAssetOpportunityResult[] | null = null;
	let terminalDiagnostics: FinderDiagnostics | null = null;
	let assetDiagnostics: FinderDiagnostics['assetOpportunity'] | null = null;
	let assetsWithFreshEntry = 0;
	let failedAssets = 0;
	let streamError: unknown = null;
	// Coalesced provisional rendering: sort + render at most once per
	// flush interval. The terminal asset_done render cancels any pending
	// flush, and a late flush after terminal adoption is a no-op.
	let provisionalRenderTimer: ReturnType<typeof setTimeout> | null = null;
	const flushProvisionalRender = (): void => {
		provisionalRenderTimer = null;
		if (terminalResults !== null) return;
		store.assetOpportunityRunResults = sortAssetOpportunityResults([
			...provisionalAssetResults.values(),
		]);
		// Provisional streamed asset — no persistence until terminal
		// asset_done adoption.
		store.setAssetOpportunityLatestResults(store.assetOpportunityRunResults, false, options.topN);
		host.renderLatestResults();
	};
	const scheduleProvisionalRender = (): void => {
		if (provisionalRenderTimer !== null) return;
		provisionalRenderTimer = setTimeout(flushProvisionalRender, ASSET_PROVISIONAL_RENDER_FLUSH_MS);
	};
	const cancelProvisionalRender = (): void => {
		if (provisionalRenderTimer === null) return;
		clearTimeout(provisionalRenderTimer);
		provisionalRenderTimer = null;
	};
	try {
		await consumeNdjsonStream<FinderAssetOpportunityStreamEvent>(response.body, {
			onAssetStart: (event) => {
				if (isStillActive()) host.setStatus(`Asset Opportunity: ${event.strategyNames.join(', ')}, 0/${event.totalAssets} assets`);
			},
			onAssetProgress: (event) => {
				if (!isStillActive()) return;
				host.setProgress(true, event.percent, event.text);
				host.setStatus(`Asset Opportunity: ${event.status}`);
			},
			onAssetComplete: (event) => {
				if (!isStillActive()) return;
				if (!submittedAssetSymbols.has(event.asset.symbol.trim().toUpperCase())) {
					debugLogger.warn("finder.asset_opportunity.stale_result_ignored", {
						runId,
						ignoredSymbols: [event.asset.symbol],
					});
					return;
				}
				assetsWithFreshEntry += 1;
				provisionalAssetResults.set(assetResultKey(event.asset), event.asset);
				scheduleProvisionalRender();
			},
			onAssetDone: (event) => {
				if (event.runId !== runId) return;
				terminalResults = retainSubmittedAssetResults(event.assets ?? []);
				terminalDiagnostics = event.diagnostics;
				assetDiagnostics = event.assetDiagnostics;
				assetsWithFreshEntry = event.totals.assetsWithFreshEntry;
				failedAssets = event.totals.failedAssets;
				cancelProvisionalRender();
				if (isStillActive()) {
					store.assetOpportunityRunResults = sortAssetOpportunityResults([...(terminalResults ?? [])]);
					store.assetOpportunityDefaultResults = [...store.assetOpportunityRunResults];
					store.setAssetOpportunityLatestResults(store.assetOpportunityRunResults, true, options.topN);
					host.stashAndResetResort();
					host.renderLatestResults();
				}
			},
			onAssetFatal: (event) => {
				throw new Error(event.error);
			},
		}, { requireTerminal: true, terminalTypes: ['asset_done', 'asset_fatal'] });
	} catch (error) {
		streamError = error;
	}
	cancelProvisionalRender();
	if (terminalResults === null && streamError === null) {
		// Stream ended without a terminal event carrying rows (e.g. an
		// empty run): still surface the latest provisional state once.
		flushProvisionalRender();
	}

	if (streamError) {
		if (isStillActive()) {
			const recovered = await session.recoverActiveServerRun(runId, 'asset_opportunity', host);
			if (recovered?.phase === 'fatal') {
				throw new Error(recovered.error ?? recovered.summary ?? 'Asset Opportunity failed.');
			}
			if (recovered?.terminalAssets) {
				terminalResults = retainSubmittedAssetResults(recovered.terminalAssets);
				terminalDiagnostics = recovered.diagnostics;
				assetDiagnostics = recovered.assetDiagnostics ?? (recovered.assetTotals
					? {
						totalAssets: recovered.assetTotals.totalAssets,
						assetsWithFreshEntry: recovered.assetTotals.assetsWithFreshEntry,
						assetsWithNoFreshEntry: Math.max(0, recovered.assetTotals.totalAssets - recovered.assetTotals.assetsWithFreshEntry - recovered.assetTotals.failedAssets),
						selectGradeAssets: recovered.assetTotals.selectGradeAssets,
						watchGradeAssets: recovered.assetTotals.watchGradeAssets,
						rejectGradeAssets: recovered.assetTotals.rejectGradeAssets,
						failedAssets: [],
						...(recovered.assetTotals.engineUsage ? { engineUsage: recovered.assetTotals.engineUsage } : {}),
					}
					: null);
				assetsWithFreshEntry = recovered.assetTotals?.assetsWithFreshEntry ?? terminalResults.length;
				failedAssets = recovered.assetTotals?.failedAssets ?? 0;
				store.assetOpportunityRunResults = sortAssetOpportunityResults([...terminalResults]);
				store.assetOpportunityDefaultResults = [...store.assetOpportunityRunResults];
				store.setAssetOpportunityLatestResults(store.assetOpportunityRunResults, true, options.topN);
				host.stashAndResetResort();
				host.renderLatestResults();
			} else if (!host.isCancelled()) {
				throw streamError;
			}
		}
	}

	const results = terminalResults ?? assetDisplayedResults(store);
	if (!host.isCancelled() && isStillActive()) {
		host.setStatus(`Server Asset Opportunity: ${results.length} opportunities (${Math.round(performance.now() - startTime)}ms)`);
	}
	if (terminalDiagnostics && assetDiagnostics) {
		terminalDiagnostics.assetOpportunity = assetDiagnostics;
	}
	return { results, diagnostics: terminalDiagnostics, assetDiagnostics, assetsWithFreshEntry, failedAssets };
}

/**
 * Asset Opportunity BATCH mode: one server-owned job sweeps the validated
 * holdout range in ascending order and appends each top-N payload to
 * `archive/asset opportunity/`. The browser renders only the latest
 * completed iteration; Stop and reload reattach reuse the existing
 * owner/run-id machinery.
 */
export async function runAssetOpportunityBatchFinder(args: AssetOpportunityWorkflowArgs & {
	/** Validated holdout range from the batch inputs. */
	range: BatchHoldoutRange;
}): Promise<boolean> {
	const { host, store, session, options, startTime, range } = args;
	const selectedStrategies = await args.getSelectedStrategies();
	if (selectedStrategies.length === 0) {
		host.setStatus('Select at least one strategy for Asset Opportunity mode.');
		return false;
	}
	const symbols = options.assetOpportunity?.symbols ?? [];
	if (symbols.length === 0) {
		host.setStatus('Add at least one symbol for Asset Opportunity mode.');
		return false;
	}
	if (range.error !== null) {
		host.setStatus(range.error);
		uiManager.showToast(range.error, 'error');
		return false;
	}
	const archiveSort: FinderAssetOpportunityArchiveSort | null = ASSET_OPPORTUNITY_ALL_SORTS;

	const exitStrategyCandidates = await args.strategies.resolveExitStrategyCandidates(options, selectedStrategies);
	const runId = session.generateRunId();
	session.activeRunId = runId;
	writeFinderActiveServerRun({ runId, scope: 'asset_opportunity_batch', startedAt: startTime });

	const outcome = await runAssetOpportunityBatchFinderServer({
		host,
		store,
		session,
		options,
		selectedStrategies,
		exitStrategyCandidates,
		runId,
		startTime,
		range,
		archiveSort,
	});

	if (session.isActive(runId)) {
		session.activeRunId = null;
		clearFinderActiveServerRun();
	}
	const assetDiagnostics = buildAssetTotalsFallback(outcome, symbols.length);
	args.onDiagnostics(outcome.diagnostics, assetDiagnostics);
	host.showDiagnosticsAvailability(Boolean(outcome.diagnostics || assetDiagnostics));
	host.renderRandomBenchmark('random');

	if (!host.isCancelled() && session.activeRunId === null) {
		const totalAssets = outcome.assetDiagnostics?.totalAssets ?? symbols.length;
		const freshAssets = outcome.assetDiagnostics?.assetsWithFreshEntry ?? outcome.assetsWithFreshEntry;
		const failedAssets = outcome.assetDiagnostics?.failedAssets.length ?? outcome.failedAssets;
		host.setStatus(
			`Asset Opportunity batch complete (${range.start}–${range.end} holdout bars). ` +
			`Last holdout: ${outcome.results.length}/${totalAssets} fresh opportunities` +
			` | ${freshAssets} fresh assets | ${failedAssets} failed` +
			` | ${Math.round(performance.now() - startTime)}ms`,
		);
	}
	return true;
}

export async function runAssetOpportunityBatchFinderServer(args: {
	host: FinderRunHost;
	store: FinderResultStore;
	session: FinderServerSession;
	options: FinderOptions;
	selectedStrategies: import("../../../finder/finder-runner").FinderSelectedStrategy[];
	exitStrategyCandidates: import("../../../finder/finder-runner").FinderSelectedStrategy[] | undefined;
	runId: string;
	startTime: number;
	range: BatchHoldoutRange;
	archiveSort: FinderAssetOpportunityArchiveSort | null;
}): Promise<ServerAssetOpportunityRunOutcome> {
	const { host, store, session, options, selectedStrategies, exitStrategyCandidates, runId, startTime, range } = args;
	const archiveSort: FinderAssetOpportunityArchiveSort | null = ASSET_OPPORTUNITY_ALL_SORTS;
	const settings = backtestService.getBacktestSettings();
	const capitalSettings = backtestService.getCapitalSettings();
	const symbols = options.assetOpportunity?.symbols ?? [];

	const response = await fetch('/api/finder/asset-opportunity-batch-run', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			runId,
			symbols,
			interval: state.currentInterval,
			options,
			settings,
			capitalSettings,
			strategyKeys: selectedStrategies.map((candidate) => candidate.key),
			exitStrategyKeys: exitStrategyCandidates?.map((candidate) => candidate.key),
			useRustEnginePreference: shouldUseRustEngine(),
			archiveSort,
			batch: {
				startHoldoutBars: range.start,
				endHoldoutBars: range.end,
			},
		}),
	});
	if (response.status === 404 || response.status === 405) {
		throw new Error("Asset Opportunity batch requires a Vite server runtime; static-only deployments are unsupported.");
	}
	if (!response.ok || !response.body) {
		const text = await response.text();
		let payload: { error?: string } = {};
		try { payload = JSON.parse(text); } catch { /* ignore */ }
		throw new Error(payload.error ?? `Server Asset Opportunity batch run failed (${response.status}).`);
	}

	const isStillActive = (): boolean => session.isActive(runId);
	const submittedAssetSymbols = new Set(symbols.map((symbol) => symbol.trim().toUpperCase()).filter(Boolean));
	const retainSubmittedAssetResults = (
		results: readonly FinderAssetOpportunityResult[],
	): FinderAssetOpportunityResult[] => {
		const retained = retainAssetOpportunityResultsForSymbols(results, submittedAssetSymbols);
		if (retained.length !== results.length) {
			debugLogger.warn("finder.asset_opportunity_batch.stale_result_ignored", {
				runId,
				ignoredSymbols: results
					.filter((result) => !submittedAssetSymbols.has(result.symbol.trim().toUpperCase()))
					.map((result) => result.symbol),
			});
		}
		return retained;
	};
	// Renders ONLY the latest completed iteration; prior iterations are not
	// retained (their rows were already appended to the archive server-side).
	const adoptIterationRows = (rows: readonly FinderAssetOpportunityResult[], persist: boolean): void => {
		store.assetOpportunityRunResults = sortAssetOpportunityResults([...rows]);
		store.assetOpportunityDefaultResults = [...store.assetOpportunityRunResults];
		store.setAssetOpportunityLatestResults(store.assetOpportunityRunResults, persist, options.topN);
		host.stashAndResetResort();
		host.renderLatestResults();
	};
	let terminalResults: FinderAssetOpportunityResult[] | null = null;
	let terminalDiagnostics: FinderDiagnostics | null = null;
	let assetDiagnostics: FinderDiagnostics['assetOpportunity'] | null = null;
	let assetsWithFreshEntry = 0;
	let failedAssets = 0;
	let streamError: unknown = null;
	try {
		await consumeNdjsonStream<FinderAssetOpportunityBatchStreamEvent>(response.body, {
			onAssetBatchStart: (event) => {
				if (isStillActive()) {
					host.setStatus(
						`Asset Opportunity batch ${event.startHoldoutBars}–${event.endHoldoutBars} holdout bars, ` +
						`${event.totalIterations} iterations × ${event.totalAssets} assets: ${event.strategyNames.join(', ')}`,
					);
				}
			},
			onAssetBatchProgress: (event) => {
				if (!isStillActive()) return;
				host.setProgress(true, event.percent, event.statusText);
				host.setStatus(`Asset Opportunity batch [${event.holdoutBars} bars, ${event.iterationIndex + 1}/${event.totalIterations}]: ${event.statusText}`);
			},
			onAssetBatchIterationDone: (event) => {
				if (!isStillActive()) return;
				terminalDiagnostics = event.diagnostics;
				assetDiagnostics = event.assetDiagnostics;
				assetsWithFreshEntry = event.assetDiagnostics?.assetsWithFreshEntry ?? event.totals.assetsWithFreshEntry;
				failedAssets = event.assetDiagnostics?.failedAssets.length ?? event.totals.failedAssets;
				// Render the latest completed iteration only; the archive file
				// name is surfaced in the status so the operator knows where
				// the top-N payload landed.
				adoptIterationRows(event.assets ?? [], false);
				host.setStatus(
					`Asset Opportunity batch: holdout ${event.holdoutBars} bars complete (${event.iterationIndex + 1}/${event.totalIterations})` +
					` | ${event.assets.length} opportunities` +
					(event.archiveFilename ? ` | archived ${event.archiveFilename}` : ''),
				);
				debugLogger.event("finder.asset_opportunity_batch.iteration_received", {
					runId,
					holdoutBars: event.holdoutBars,
					iterationIndex: event.iterationIndex,
					totalIterations: event.totalIterations,
					assets: event.assets.length,
					archiveFilename: event.archiveFilename,
				});
			},
			onAssetBatchDone: (event) => {
				if (event.runId !== runId) return;
				terminalResults = retainSubmittedAssetResults(event.assets ?? []);
				terminalDiagnostics = event.diagnostics;
				assetDiagnostics = event.assetDiagnostics;
				assetsWithFreshEntry = event.assetDiagnostics?.assetsWithFreshEntry
					?? event.totals?.assetsWithFreshEntry
					?? terminalResults.length;
				failedAssets = event.assetDiagnostics?.failedAssets.length
					?? event.totals?.failedAssets
					?? 0;
				if (isStillActive()) {
					adoptIterationRows(terminalResults, true);
					host.setStatus(`Asset Opportunity batch ${event.summary}`);
				}
				debugLogger.event("finder.asset_opportunity_batch.complete_received", {
					runId,
					completedIterations: event.completedIterations,
					failedIterations: event.failedIterations,
					assets: terminalResults.length,
				});
			},
			onAssetBatchFatal: (event) => {
				throw new Error(event.error);
			},
		}, { requireTerminal: true, terminalTypes: ['asset_batch_done', 'asset_batch_fatal'] });
	} catch (error) {
		streamError = error;
	}

	if (streamError) {
		if (isStillActive()) {
			const recovered = await session.recoverActiveServerRun(runId, 'asset_opportunity_batch', host);
			if (recovered?.phase === 'fatal') {
				throw new Error(recovered.error ?? recovered.summary ?? 'Asset Opportunity batch failed.');
			}
			if (recovered?.terminalAssets) {
				terminalResults = retainSubmittedAssetResults(recovered.terminalAssets);
				terminalDiagnostics = recovered.diagnostics;
				assetDiagnostics = recovered.assetDiagnostics ?? null;
				assetsWithFreshEntry = recovered.assetDiagnostics?.assetsWithFreshEntry
					?? recovered.assetTotals?.assetsWithFreshEntry
					?? terminalResults.length;
				failedAssets = recovered.assetDiagnostics?.failedAssets.length
					?? recovered.assetTotals?.failedAssets
					?? 0;
				adoptIterationRows(terminalResults, true);
			} else if (!host.isCancelled()) {
				throw streamError;
			}
		}
	}

	const results = terminalResults ?? assetDisplayedResults(store);
	if (!host.isCancelled() && isStillActive()) {
		host.setStatus(`Server Asset Opportunity batch: ${results.length} opportunities (${Math.round(performance.now() - startTime)}ms)`);
	}
	if (terminalDiagnostics && assetDiagnostics) {
		terminalDiagnostics.assetOpportunity = assetDiagnostics;
	}
	return { results, diagnostics: terminalDiagnostics, assetDiagnostics, assetsWithFreshEntry, failedAssets };
}
