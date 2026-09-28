/**
 * Symbol Universe scope workflow: ONE server job owns IS evaluation, survivor
 * merge, and the optional OOS pass; the browser is the control + rendering
 * layer. Consumes the NDJSON survivor stream, guards every callback with the
 * session's run-id token, and adopts the server's authoritative terminal
 * inventory through the result store.
 */
import { state } from "../../../state";
import { backtestService } from "../../../backtest-service";
import { debugLogger } from "../../../debug-logger";
import { consumeNdjsonStream } from "../../../ndjson-stream";
import { coalesceAnimationFrame } from "../../../render-scheduler";
import { shouldUseRustEngine } from "../../../engine-preferences";
import type { FinderStreamEvent } from "../../server/finder-stream-types";
import { sortFinderUniverseCandidates } from "../../finder-universe-metrics";
import type {
	FinderDiagnostics,
	FinderOptions,
	FinderUniverseCandidate,
} from "../../../types/finder";
import type { FinderResultStore } from "../finder-result-store";
import type { FinderServerSession } from "../finder-server-session";
import { clearFinderActiveServerRun, writeFinderActiveServerRun } from "../finder-persistence";
import type { FinderRunHost, FinderStrategySource } from "./finder-run-host";

/**
 * Outcome of a server-owned Finder Universe job. The server owns IS
 * evaluation, survivor merge, and OOS; the browser only renders.
 * `oosRemoved` reflects the server-side OOS aggregate-fail filter count
 * (0 when OOS is disabled).
 */
export interface ServerUniverseRunOutcome {
	results: FinderUniverseCandidate[];
	diagnostics: FinderDiagnostics | null;
	loadedSymbols: number;
	failedSymbolCount: number;
	oosRemoved: number;
}

export interface UniverseWorkflowArgs {
	host: FinderRunHost;
	store: FinderResultStore;
	session: FinderServerSession;
	strategies: FinderStrategySource;
	options: FinderOptions;
	startTime: number;
	/** The UNIVERSE selection feeds Symbol Universe runs (not the chart list). */
	getUniverseSelectedStrategies(): Promise<import("../../../finder/finder-runner").FinderSelectedStrategy[]>;
	/** Store the terminal run diagnostics on the facade. */
	onDiagnostics(diagnostics: FinderDiagnostics | null): void;
}

export async function runUniverseFinder(args: UniverseWorkflowArgs): Promise<boolean> {
	const { host, store, session, options, startTime } = args;
	const selectedStrategies = await args.getUniverseSelectedStrategies();
	if (selectedStrategies.length === 0) {
		host.setStatus('Select at least one strategy for Symbol Universe mode.');
		return false;
	}
	if (!options.universe || options.universe.symbols.length === 0) {
		host.setStatus('Add at least one symbol for Symbol Universe mode.');
		return false;
	}
	const exitStrategyCandidates = await args.strategies.resolveExitStrategyCandidates(options, selectedStrategies);

	// ONE server job owns all selected strategies: IS evaluation, survivor
	// merge, and the optional OOS pass all run server-side. The browser is
	// the control + rendering layer. Persist the active run id before fetch
	// so a tab reload can reattach to the same server job.
	const runId = session.generateRunId();
	session.activeRunId = runId;
	writeFinderActiveServerRun({ runId, scope: 'symbol_universe', startedAt: startTime });

	const outcome = await runUniverseFinderServer({
		host,
		store,
		session,
		options,
		selectedStrategies,
		exitStrategyCandidates,
		runId,
		startTime,
	});

	// A stale run that lost ownership (Stop, newer run) must not persist
	// its active-run record or overwrite rendered state. The stream
	// consumer already guards against stale run ids; this clears the
	// record only when THIS run is still the active one.
	if (session.isActive(runId)) {
		session.activeRunId = null;
		clearFinderActiveServerRun();
	}

	args.onDiagnostics(outcome.diagnostics);
	host.showDiagnosticsAvailability(Boolean(outcome.diagnostics));
	host.renderRandomBenchmark(options.mode);

	if (!host.isCancelled() && session.activeRunId === null) {
		const totalSymbols = options.universe.symbols.length;
		const survivors = outcome.results.length;
		const segments = [
			`Universe Finder complete. ${survivors} survivor${survivors === 1 ? '' : 's'}`,
			`${selectedStrategies.length} strateg${selectedStrategies.length === 1 ? 'y' : 'ies'}`,
			`${outcome.loadedSymbols}/${totalSymbols} symbols loaded`,
		];
		if (outcome.oosRemoved > 0) {
			segments.push(`${outcome.oosRemoved} filtered by OOS gate`);
		}
		if (outcome.failedSymbolCount > 0) {
			segments.push(`${outcome.failedSymbolCount} load failure${outcome.failedSymbolCount === 1 ? '' : 's'}`);
		}
		segments.push(`${Math.round(performance.now() - startTime)}ms`);
		host.setStatus(segments.join(' | '));
	}
	return true;
}

/**
 * Server-owned Finder Universe path: POST ONE request containing all
 * selected entry strategy keys + a browser-generated runId, consume the
 * NDJSON stream of scalar survivor candidates, and adopt the server's
 * authoritative terminal inventory + diagnostics. The server sequences
 * strategies, merges survivors, runs OOS, and publishes one terminal
 * snapshot; the browser only renders.
 *
 * `runId` guards every stream + poll callback so a stale tab cannot
 * mutate newer Finder state (the active-server-run token). Disconnecting
 * the initiating stream does not cancel the server job — reattach polling
 * on Finder init recovers an in-flight or terminal job after reload.
 */
export async function runUniverseFinderServer(args: {
	host: FinderRunHost;
	store: FinderResultStore;
	session: FinderServerSession;
	options: FinderOptions;
	selectedStrategies: import("../../../finder/finder-runner").FinderSelectedStrategy[];
	exitStrategyCandidates: import("../../../finder/finder-runner").FinderSelectedStrategy[] | undefined;
	runId: string;
	startTime: number;
}): Promise<ServerUniverseRunOutcome> {
	const { host, store, session, options, selectedStrategies, exitStrategyCandidates, runId, startTime } = args;
	const settings = backtestService.getBacktestSettings();
	const capitalSettings = backtestService.getCapitalSettings();
	const universeSymbols = options.universe?.symbols ?? [];
	const response = await fetch('/api/finder/universe-run', {
		method: 'POST',
		headers: { 'Content-Type': 'application/json' },
		body: JSON.stringify({
			runId,
			symbols: universeSymbols,
			interval: state.currentInterval,
			options,
			settings,
			capitalSettings,
			strategyKeys: selectedStrategies.map((s) => s.key),
			exitStrategyKeys: exitStrategyCandidates?.map((c) => c.key),
			useRustEnginePreference: shouldUseRustEngine(),
		}),
	});

	if (response.status === 404 || response.status === 405) {
		throw new Error("Finder Universe requires a Vite server runtime; static-only deployments are unsupported.");
	}
	if (!response.ok || !response.body) {
		const text = await response.text();
		let payload: { error?: string } = {};
		try { payload = JSON.parse(text); } catch { /* ignore */ }
		throw new Error(payload.error ?? `Server Finder run failed (${response.status}).`);
	}

	// runId guard: every callback checks `session.isActive(runId)`
	// before mutating UI state, so a stale tab (or a stale stream consumed
	// after a newer run started) cannot clobber the current view.
	const isStillActive = (): boolean => session.isActive(runId);
	const survivorByKey = new Map<string, FinderUniverseCandidate>();
	const identityKey = (c: FinderUniverseCandidate) =>
		`${c.strategyKey}|${JSON.stringify(c.params)}|${c.exitStrategyKey ?? ''}|${JSON.stringify(c.exitStrategyParams ?? {})}`;
	const sortPriority = options.universe?.sortPriority ?? [];
	let terminalDiagnostics: FinderDiagnostics | null = null;
	let terminalCandidates: FinderUniverseCandidate[] | null = null;
	let loadedSymbols = 0;
	let failedSymbolCount = 0;
	let oosRemoved = 0;

	const renderMerged = (): void => {
		if (!isStillActive()) return;
		const merged = sortFinderUniverseCandidates([...survivorByKey.values()], sortPriority)
			.slice(0, options.topN);
		// Candidate events are incremental, but a candidate displaced from the
		// topN can never return under the fixed comparator. Release its large
		// per-symbol metrics array instead of retaining every provisional row.
		survivorByKey.clear();
		for (const candidate of merged) {
			survivorByKey.set(identityKey(candidate), candidate);
		}
		// Provisional candidate merge — no persistence until the terminal
		// slice is adopted in onDone.
		store.setLatestResults({ scope: 'symbol_universe', results: merged }, false);
		host.renderLatestResults();
	};
	// Coalesce candidate arrivals into one render per animation frame. The
	// server dedups identities, but a throttled snapshot can ship several
	// candidate events back-to-back in one chunk. `finalized` guards the
	// race where a candidate event in the SAME chunk as `done` would defer
	// a render that fires AFTER the authoritative terminal slice render.
	let finalized = false;
	const renderFrame = coalesceAnimationFrame(() => {
		if (!finalized) {
			renderMerged();
		}
	});
	const scheduleRender = (): void => {
		if (!finalized) renderFrame.schedule();
	};

	let streamError: unknown = null;
	try {
		await consumeNdjsonStream<FinderStreamEvent>(response.body, {
			onStart: (event) => {
				if (!isStillActive()) return;
				const strategyCount = event.strategyCount ?? selectedStrategies.length;
				host.setStatus(`Universe Finder: ${strategyCount} strateg${strategyCount === 1 ? 'y' : 'ies'}, 0/${event.totalSymbols} symbols (evaluating ~${event.totalCandidates} candidates)...`);
			},
			onProgress: (event) => {
				if (!isStillActive()) return;
				host.setProgress(true, event.percent, event.text);
				const si = event.strategyIndex ?? 0;
				const sc = event.strategyCount ?? selectedStrategies.length;
				const phaseLabel = event.phase === 'oos' ? 'OOS' : `${Math.min(si + 1, sc)}/${sc}`;
				host.setStatus(`Universe Finder [${phaseLabel}]: ${event.status}`);
			},
			onCandidate: (event) => {
				if (!isStillActive()) return;
				survivorByKey.set(identityKey(event.candidate), event.candidate);
				scheduleRender();
			},
			onSymbolFailed: (event) => {
				debugLogger.warn('finder.server.symbol_failed', { symbol: event.symbol, error: event.error });
			},
			onDone: (event) => {
				terminalDiagnostics = event.diagnostics;
				loadedSymbols = event.totals?.loadedSymbols ?? 0;
				failedSymbolCount = event.totals?.failedSymbols ?? 0;
				oosRemoved = event.totals?.oosRemoved ?? 0;
				// Adopt the authoritative terminal slice (server-owned IS
				// + OOS). The merged map is provisional; done.candidates is
				// the source of truth including OOS fields.
				terminalCandidates = event.candidates ?? null;
				if (terminalCandidates && isStillActive()) {
					const displayed = sortFinderUniverseCandidates(terminalCandidates, sortPriority, {
						useOosValues: terminalCandidates.some((candidate) => candidate.oosAggregate !== undefined),
					});
					store.adoptSymbolUniverseResults(displayed, true, options.topN);
					host.stashAndResetResort();
					host.populateResortOptions();
					host.renderLatestResults();
				}
				finalized = true;
			},
			onFatal: (event) => {
				throw new Error(event.error);
			},
		}, { requireTerminal: true });
	} catch (error) {
		streamError = error;
	}

	if (streamError !== null && terminalCandidates === null && isStillActive()) {
		const recovered = await session.recoverActiveServerRun(runId, 'symbol_universe', host);
		if (recovered?.phase === "fatal") {
			throw new Error(recovered.error ?? recovered.summary ?? recovered.statusText);
		}
		if (recovered?.terminalCandidates) {
			terminalCandidates = recovered.terminalCandidates;
			terminalDiagnostics = recovered.diagnostics;
			loadedSymbols = recovered.totals?.loadedSymbols ?? 0;
			failedSymbolCount = recovered.totals?.failedSymbols ?? 0;
			oosRemoved = recovered.totals?.oosRemoved ?? 0;
			finalized = true;
			if (isStillActive()) {
				store.adoptSymbolUniverseResults(terminalCandidates);
				host.stashAndResetResort();
				host.populateResortOptions();
				host.renderLatestResults();
			}
		}
	}

	if (streamError !== null && terminalCandidates === null) {
		if (host.isCancelled() && !isStillActive()) {
			throw new Error("Finder stopped.");
		}
		const message = streamError instanceof Error ? streamError.message : String(streamError);
		if (isStillActive()) {
			host.setStatus(`Server Finder failed: ${message}`);
		}
		throw streamError;
	}

	const finalResults = terminalCandidates
		?? sortFinderUniverseCandidates([...survivorByKey.values()], sortPriority);

	if (!host.isCancelled() && isStillActive()) {
		host.setStatus(`Server Finder: ${finalResults.length} survivors (${Math.round(performance.now() - startTime)}ms)`);
	}

	return {
		results: finalResults,
		diagnostics: terminalDiagnostics,
		loadedSymbols,
		failedSymbolCount,
		oosRemoved,
	};
}
