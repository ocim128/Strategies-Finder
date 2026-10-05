/**
 * Finder run controller: owner of the browser run lifecycle — the running /
 * cancelled / startup-in-flight flags, the run abort controller, the control
 * task yielder, `runFinder` dispatch across the scope workflows, and the
 * Run/Stop control wiring. Browser-only.
 *
 * Server run ownership (run id, polling, aborts) lives in the session; the
 * controller only stops the browser-side poll and drops ownership when Stop
 * is pressed. Running state is never duplicated on the facade.
 */
import { state } from "../../state";
import { dataManager } from "../../data-manager";
import { uiManager } from "../../ui-manager";
import { debugLogger } from "../../debug-logger";
import { createTaskYielder } from "../../task-yield";
import { emptyFinderLatestResults } from "./finder-settings";
import { buildFailureDiagnostics } from "./finder-run-diagnostics";
import type { FinderResultStore } from "./finder-result-store";
import type { FinderServerSession } from "./finder-server-session";
import type {
	FinderRunHost,
	FinderStrategySource,
} from "./workflows/finder-run-host";
import { runCurrentChartFinder } from "./workflows/current-chart";
import { runUniverseFinder } from "./workflows/symbol-universe";
import {
	runAssetOpportunityFinder,
	runAssetOpportunityBatchFinder,
	type BatchHoldoutRange,
} from "./workflows/asset-opportunity";
import { runArmPerformanceFinder } from "./workflows/arm-performance";
import { runStrategyQualityFinder } from "./workflows/strategy-quality";
import type { FinderDiagnostics, FinderOptions } from "../../types/finder";
import { settingsManager } from "../../settings-manager";

/** Run-context and input seams supplied by the facade. */
export interface FinderRunControllerDeps {
	host(): FinderRunHost;
	store(): FinderResultStore;
	session(): FinderServerSession;
	/** False only for the current-chart scope (which needs chart data). */
	isMultiAssetScope(): boolean;
	/** Run/Stop button + finder-running body state. */
	setRunningUI(running: boolean): void;
	/** Null diagnostics + retained run context, reset inventories + snapshot. */
	prepareRun(): void;
	/** Clone the live backtest settings into the run context; return the snapshot. */
	captureRunSettings(): ReturnType<typeof settingsManager.getBacktestSettings>;
	readOptions(settingsSnapshot: ReturnType<typeof settingsManager.getBacktestSettings>): FinderOptions;
	setLastFinderOptions(options: FinderOptions): void;
	getSelectedStrategies(): Promise<import("../../finder/finder-runner").FinderSelectedStrategy[]>;
	getUniverseSelectedStrategies(): Promise<import("../../finder/finder-runner").FinderSelectedStrategy[]>;
	resolveExitStrategyCandidates(
		options: FinderOptions,
		selectedStrategies: import("../../finder/finder-runner").FinderSelectedStrategy[],
	): Promise<import("../../finder/finder-runner").FinderSelectedStrategy[] | undefined>;
	generateParamSets(
		defaultParams: import("../../types/strategies").StrategyParams,
		options: FinderOptions,
	): import("../../types/strategies").StrategyParams[];
	retainEvaluationData(data: { interval: string; data: import("../../types/strategies").OHLCVData[] }): void;
	setDiagnostics(diagnostics: FinderDiagnostics | null): void;
	setAssetDiagnostics(diagnostics: FinderDiagnostics['assetOpportunity'] | null): void;
	readBatchHoldoutRange(): BatchHoldoutRange;
	isBatchMode(): boolean;
	getPairListText(): string;
	getSelectedArm(): import("../finder-arm-performance-metrics").FinderArmPerformanceArm;
}

export class FinderRunController {
	private isRunning = false;
	private runStartupInFlight = false;
	private isCancelled = false;
	private finderRunAbortController: AbortController | null = null;
	private readonly taskYielder = createTaskYielder();

	constructor(private readonly deps: FinderRunControllerDeps) {}

	/**
	 * Running state for a server-owned job (reattach). The controller owns the
	 * flags; the facade mirrors them onto the Run/Stop controls.
	 */
	setServerRunning(running: boolean): void {
		this.isRunning = running;
		this.isCancelled = false;
		this.deps.setRunningUI(running);
	}

	isServerRunOwned(): boolean {
		return this.isRunning;
	}

	/** Cooperative yield between worker batches (exposed through the run host). */
	yieldControl(): Promise<void> {
		return this.taskYielder.yieldControl();
	}

	/** Browser-cancellation flag for the run in flight (Stop). */
	isRunCancelled(): boolean {
		return this.isCancelled;
	}

	/** Abort signal for the browser run in flight, when one exists. */
	abortSignal(): AbortSignal | undefined {
		return this.finderRunAbortController?.signal;
	}

	/** Wire the Run/Stop controls. Stop coordinates browser + server ownership. */
	bindRunControls(
		runButton: HTMLElement,
		stopButton: HTMLElement,
	): void {
		runButton.addEventListener('click', () => {
			void this.runFinder();
		});
		stopButton.addEventListener('click', () => {
			this.isCancelled = true;
			this.finderRunAbortController?.abort();
			// Cancel any in-flight reattach poll immediately so Stop changes UI
			// ownership before the next poll iteration.
			const session = this.deps.session();
			session.stopReattachPoll();
			// Server-owned scopes: the job lives in the dev server, so
			// `isCancelled` alone does NOT stop it — the server checks
			// ownership loss + abort via POST /api/finder/stop with the active
			// run id (Stop is scoped by run id so a stale tab cannot cancel a
			// newer run). Fire-and-forget; only POST when a run is in flight
			// AND the active run id is known.
			const activeRunId = session.activeRunId;
			if (this.isRunning && activeRunId) {
				// Drop local ownership immediately so late stream callbacks cannot
				// mutate the stopped view. Keep the persisted marker until the server
				// confirms Stop; on a network failure a reload can still reattach.
				session.activeRunId = null;
				void session.stopServerRun(activeRunId, { setStatus: (text) => this.deps.host().setStatus(text) });
			}
		});
	}

	async runFinder(): Promise<void> {
		if (this.isRunning || this.runStartupInFlight) return;
		this.runStartupInFlight = true;
		// Starting a new run cancels any stale reattach poll before changing
		// UI ownership so late poll updates cannot mutate the new run's state.
		const host = this.deps.host();
		try {
			this.deps.session().stopReattachPoll();
			this.deps.session().activeRunId = null;
			if (!this.deps.isMultiAssetScope() && state.ohlcvData.length === 0) {
				host.setStatus('Data not loaded. Attempting to load...');
				await dataManager.loadData();

				if (state.ohlcvData.length === 0) {
					host.setStatus('Load data before running the finder.');
					return;
				}
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			debugLogger.error('finder.preflight_failed', { error: message });
			host.setStatus(`Finder data load failed. ${message}`);
			uiManager.showToast('Finder data load failed. Check the status panel for details.', 'error');
			return;
		} finally {
			this.runStartupInFlight = false;
		}

		this.finderRunAbortController?.abort();
		this.finderRunAbortController = new AbortController();
		this.isCancelled = false;
		this.isRunning = true;
		const startTime = performance.now();
		this.deps.prepareRun();

		const settingsSnapshot = this.deps.captureRunSettings();
		const options = this.deps.readOptions(settingsSnapshot);
		this.deps.setLastFinderOptions(options);
		if (options.scope === 'arm_performance') {
			this.deps.store().armPerformanceInventoryComplete = false;
		}
		this.deps.store().setRunDisplayLimits(options.topN);

		// Copy Diagnostics belongs to the previous run until new diagnostics
		// are adopted; starting a run invalidates it.
		host.showDiagnosticsAvailability(false);
		this.deps.setRunningUI(true);
		host.setProgress(true, 0, 'Preparing...');
		host.setStatus('Running strategy finder...');
		host.renderRandomBenchmark(options.mode);
		// Run-start clear is a volatile UI reset; the previous snapshot was
		// already cleared explicitly via clearLatestResultsSnapshot().
		if (options.scope === 'arm_performance') {
			this.deps.store().setArmPerformanceLatestResults([], false, options.topN, false);
		} else {
			this.deps.store().setLatestResults(emptyFinderLatestResults(options.scope ?? 'current_chart'), false);
		}
		host.populateResortOptions(true);
		host.renderLatestResults();

		let progressFinalized = false;
		const finalizeProgress = (percent: number, text: string) => {
			host.setProgress(false, percent, text);
			progressFinalized = true;
		};

		try {
			const strategies: FinderStrategySource = {
				getSelectedStrategies: () => this.deps.getSelectedStrategies(),
				getUniverseSelectedStrategies: () => this.deps.getUniverseSelectedStrategies(),
				resolveExitStrategyCandidates: (finderOptions, selected) => this.deps.resolveExitStrategyCandidates(finderOptions, selected),
			};
			const completed = options.scope === 'symbol_universe'
				? await runUniverseFinder({
					host, store: this.deps.store(), session: this.deps.session(), strategies, options, startTime,
					getUniverseSelectedStrategies: () => this.deps.getUniverseSelectedStrategies(),
					onDiagnostics: (diagnostics) => { this.deps.setDiagnostics(diagnostics); },
				})
				: options.scope === 'asset_opportunity'
					? this.deps.isBatchMode()
						? await runAssetOpportunityBatchFinder({
							host, store: this.deps.store(), session: this.deps.session(), strategies, options, startTime,
							getSelectedStrategies: () => this.deps.getSelectedStrategies(),
							onDiagnostics: (diagnostics, assetDiagnostics) => {
								this.deps.setDiagnostics(diagnostics);
								this.deps.setAssetDiagnostics(assetDiagnostics);
							},
							range: this.deps.readBatchHoldoutRange(),
						})
						: await runAssetOpportunityFinder({
							host, store: this.deps.store(), session: this.deps.session(), strategies, options, startTime,
							getSelectedStrategies: () => this.deps.getSelectedStrategies(),
							onDiagnostics: (diagnostics, assetDiagnostics) => {
								this.deps.setDiagnostics(diagnostics);
								this.deps.setAssetDiagnostics(assetDiagnostics);
							},
						})
					: options.scope === 'arm_performance'
						? await runArmPerformanceFinder({
							host, store: this.deps.store(), session: this.deps.session(), options, startTime,
							getUniverseSelectedStrategies: () => this.deps.getUniverseSelectedStrategies(),
							resolveExitStrategyCandidates: (finderOptions, selected) => this.deps.resolveExitStrategyCandidates(finderOptions, selected),
							getPairListText: () => this.deps.getPairListText(),
							getSelectedArm: () => this.deps.getSelectedArm(),
							onCancelled: () => { this.isCancelled = true; },
						})
					: options.scope === 'strategy_quality'
						? await runStrategyQualityFinder({
							host, store: this.deps.store(), options, startTime,
							getUniverseSelectedStrategies: () => this.deps.getUniverseSelectedStrategies(),
							onDiagnostics: (diagnostics) => { this.deps.setDiagnostics(diagnostics); },
						})
						: await runCurrentChartFinder({
							host, store: this.deps.store(), strategies, options, startTime,
							getSelectedStrategies: () => this.deps.getSelectedStrategies(),
							generateParamSets: (defaultParams, finderOptions) => this.deps.generateParamSets(defaultParams, finderOptions),
							retainEvaluationData: (data) => { this.deps.retainEvaluationData(data); },
							onDiagnostics: (diagnostics) => { this.deps.setDiagnostics(diagnostics); },
						});

			if (!completed) {
				finalizeProgress(0, '');
			} else if (this.isCancelled) {
				finalizeProgress(0, '');
				host.setStatus(`Finder stopped by user after ${Math.round(performance.now() - startTime)}ms.`);
			} else {
				finalizeProgress(100, '');
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			if (this.isCancelled && (message.includes('stopped') || message.includes('cancel'))) {
				host.setStatus('Finder stopped by user.');
				uiManager.showToast('Finder stopped.', 'info');
			} else {
				debugLogger.error('finder.run_failed', {
					scope: options.scope ?? 'current_chart',
					symbol: state.currentSymbol,
					interval: state.currentInterval,
					mode: options.mode,
					error: message,
				});
				host.setStatus(`Finder failed. ${message}`);
				uiManager.showToast('Finder run failed. Check the status panel for details.', 'error');
				// latestDiagnostics stays null on any mid-run failure, which
				// silently disables the Copy Diagnostics button exactly when
				// the user needs it most. Build a minimal diagnostics so the
				// user can copy and share why the run failed. Universe load
				// failures carry a per-symbol loadFailures map (richer detail);
				// any other failure (engine throw, OOS re-load error, etc.)
				// gets a minimal diagnostics with the error reason surfaced as
				// a bottleneck line.
				const loadFailures = (error as Error & { loadFailures?: Map<string, { error?: string }> }).loadFailures;
				const diagnostics = loadFailures && loadFailures.size > 0
					? buildFailureDiagnostics({
						kind: 'load',
						options,
						elapsedMs: performance.now() - startTime,
						loadFailures,
					})
					: buildFailureDiagnostics({
						kind: 'run',
						options,
						elapsedMs: performance.now() - startTime,
						error: message,
					});
				this.deps.setDiagnostics(diagnostics);
				host.showDiagnosticsAvailability(Boolean(diagnostics));
			}
		} finally {
			if (!progressFinalized) {
				finalizeProgress(0, '');
			}
			this.isCancelled = false;
			this.finderRunAbortController?.abort();
			this.finderRunAbortController = null;
			this.deps.setRunningUI(false);
			this.isRunning = false;
		}
	}
}
