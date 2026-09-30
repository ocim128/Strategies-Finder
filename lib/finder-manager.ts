import { StrategyParams, type OHLCVData } from "./strategies/index";
import { strategyRegistry, getStrategyList, loadBuiltInStrategyByKey, ensureStrategyKeysLoaded } from "../strategyRegistry";
import { state } from "./state";
import { backtestService } from "./backtest-service";
import { uiManager } from "./ui-manager";
import { settingsManager } from "./settings-manager";
import { cloneJsonCompatible, parseJsonPreservingNonFinite } from "./json-utils";

import { formatCapturedConfiguration } from "./finder/finder-config-capture";
import type { FinderSelectedStrategy } from "./finder/finder-runner";
import { FinderParamSpace } from "./finder/finder-param-space";
import { FinderUI } from "./finder/finder-ui";
import {
	ASSET_OPPORTUNITY_ALL_SORTS,
	deduplicateAssetOpportunityResultsBySymbol,
	sortAssetOpportunityResults,
} from "./finder/finder-asset-opportunity-metrics";
import { debugLogger } from "./debug-logger";
import { emptyFinderLatestResults } from "./finder/browser/finder-settings";
import type { FinderRunStatusSnapshot } from "./finder/server/finder-stream-types";
import {
	createFinderManagerDom,
	type FinderManagerDom,
} from "./finder/finder-manager-dom";
import {
	clearFinderLatestResultsSnapshot,
	readFinderActiveServerRun,
	readFinderLatestResultsSnapshot,
	writeFinderLatestResultsSnapshot,
	type FinderPersistedActiveServerRun,
} from "./finder/browser/finder-persistence";
import { FinderResultStore } from "./finder/browser/finder-result-store";
import { FinderStrategySelection } from "./finder/browser/finder-strategy-selection";
import { FinderResultActions } from "./finder/browser/finder-result-actions";
import { FinderServerSession, createFinderStatusRequestSignal, type FinderSessionHost } from "./finder/browser/finder-server-session";
import { FinderControls } from "./finder/browser/finder-controls";
import { FinderRunController } from "./finder/browser/finder-run-controller";
import {
	runAssetOpportunityBatchFinderServer,
	type BatchHoldoutRange,
} from "./finder/browser/workflows/asset-opportunity";
import type { FinderRunHost } from "./finder/browser/workflows/finder-run-host";
import {
	buildArmPerformanceDiagnosticsPayload,
	buildArmPerformanceRunConfigurationPayload,
	buildAssetOpportunityDiagnosticsPayload,
	buildCompactFinderDiagnosticsPayload,
	buildFinderRunConfigurationPayload,
	buildFinderTopResultsPayload,
	copyTextToClipboard,
} from "./finder/browser/finder-export";
import type {
    FinderArmPerformanceCandidate,
    FinderArmPerformanceRunContext,
	FinderLatestResults,
	FinderDiagnostics,
	FinderOptions,
	FinderScope,
	FinderResult,
	FinderAssetOpportunityResult,
	FinderStrategyQualityResult,
	FinderUniverseCandidate,
} from './types/finder';
import type { FinderArmPerformanceArm } from "./finder/finder-arm-performance-metrics";

export class FinderManager {
	/** Owns every result inventory, display limit, and the run-sort baseline. */
	private readonly resultStore = new FinderResultStore(
		(results) => this.saveLatestResultsSnapshot(results),
	);
	/** Owns the per-scope strategy selection sets and their checkbox DOM. */
	private readonly selection: FinderStrategySelection = new FinderStrategySelection({
		getDom: () => this.getDom(),
		getUiState: () => this.controls.uiState,
		isUniverseSelectionScope: () => this.usesUniverseStrategySelection(),
		persist: () => this.controls.saveUiState(),
	});
	/** Owns server run ownership, scoped Stop, and reattach/recovery polling. */
	private readonly session = new FinderServerSession();
	/** Owns editable UI state, form capture, readOptions, and scope visibility. */
	private readonly controls: FinderControls = new FinderControls({
		getDom: () => this.getDom(),
		setStatus: (text) => this.setStatus(text),
		renderLatestResults: () => this.renderLatestResults(),
		populateResortOptions: () => this.populateResortOptions(),
		applyResort: () => this.applyResort(),
		getArmPerformanceReplayMode: () => this.resultStore.latestResults.scope === "arm_performance"
			? this.resultStore.latestResults.results[0]?.replayMode
				?? this.resultStore.latestResults.runContext?.replayMode
				?? "horizon"
			: null,
		requestRun: () => void this.controller.runFinder(),
		renderRandomBenchmark: (mode, payload) => this.ui.renderRandomBenchmark(mode, payload as never),
		selection: this.selection,
	});
	/** Owns the browser run lifecycle flags and the Run/Stop orchestration. */
	private readonly controller: FinderRunController = new FinderRunController({
		host: () => this.runHost(),
		store: () => this.resultStore,
		session: () => this.session,
		isMultiAssetScope: () => this.usesUniverseStrategySelection() || this.isAssetOpportunityScope(),
		setRunningUI: (running) => {
			const dom = this.getDom();
			dom.runFinder.disabled = running;
			dom.runFinder.classList.toggle('is-loading', running);
			dom.runFinder.setAttribute('aria-busy', running ? 'true' : 'false');
			dom.stopFinder.style.display = running ? '' : 'none';
			if (typeof document !== 'undefined') {
				document.body.classList.toggle('finder-running', running);
			}
		},
		prepareRun: () => {
			this.lastFinderRunBacktestSettings = null;
			this.lastFinderOptions = null;
			this.lastFinderEvaluationData = null;
			this.latestDiagnostics = null;
			this.latestAssetOpportunityDiagnostics = null;
			this.resultStore.resetForNewRun();
			this.clearLatestResultsSnapshot();
		},
		captureRunSettings: () => {
			const snapshot = this.cloneBacktestSettings(settingsManager.getBacktestSettings());
			this.lastFinderRunBacktestSettings = this.cloneBacktestSettings(snapshot);
			return snapshot;
		},
		readOptions: (settingsSnapshot) => this.controls.readOptions(settingsSnapshot),
		setLastFinderOptions: (options) => { this.lastFinderOptions = this.cloneBacktestSettings(options); },
		getSelectedStrategies: () => this.getSelectedStrategies(),
		getUniverseSelectedStrategies: () => this.getUniverseSelectedStrategies(),
		resolveExitStrategyCandidates: (options, selectedStrategies) => this.resolveExitStrategyCandidates(options, selectedStrategies),
		generateParamSets: (defaultParams, options) => this.generateParamSets(defaultParams, options),
		retainEvaluationData: (data) => { this.lastFinderEvaluationData = data; },
		setDiagnostics: (diagnostics) => { this.latestDiagnostics = diagnostics; },
		setAssetDiagnostics: (diagnostics) => { this.latestAssetOpportunityDiagnostics = diagnostics; },
		readBatchHoldoutRange: () => this.controls.readBatchHoldoutRange(),
		isBatchMode: () => this.controls.isAssetOpportunityBatchMode(),
		getPairListText: () => this.getDom().finderUniverseSymbols.value,
		getSelectedArm: () => this.getDom().finderResort.value as FinderArmPerformanceArm,
	});
	/** Owns candidate Apply flows and the apply-in-flight guard. */
	private readonly resultActions = new FinderResultActions({
		getResultStore: () => this.resultStore,
		getLastRunBacktestSettings: () => this.lastFinderRunBacktestSettings,
		getLastFinderOptions: () => this.lastFinderOptions,
		getLastFinderEvaluationData: () => this.lastFinderEvaluationData,
	});
	private latestDiagnostics: FinderDiagnostics | null = null;
	private latestAssetOpportunityDiagnostics: FinderDiagnostics['assetOpportunity'] | null = null;
	private lastFinderRunBacktestSettings: ReturnType<typeof settingsManager.getBacktestSettings> | null = null;
	private lastFinderOptions: FinderOptions | null = null;
	private lastFinderEvaluationData: { interval: string; data: OHLCVData[] } | null = null;
	private readonly ui = new FinderUI();
	private readonly paramSpace = new FinderParamSpace();
	private dom: FinderManagerDom | null = null;
	private getDom(): FinderManagerDom {
		return this.dom ??= createFinderManagerDom();
	}

	public async invalidateLocalDataCaches(): Promise<boolean> {
		// Universe synthetic leg/pair caches now live in the Vite server. Keep
		// the existing invalidation contract used by IBKR/Crypto data sync so a
		// subsequent Finder run cannot reuse an in-memory series built before the
		// local files changed. Disk entries remain fingerprint-validated.
		try {
			const response = await fetch('/api/finder/invalidate-cache', { method: 'POST' });
			if (!response.ok) {
				throw new Error(`Finder cache invalidation failed (${response.status}).`);
			}
			const payload = await response.json() as { ok?: unknown };
			if (payload.ok !== true) {
				throw new Error('Finder cache invalidation was not accepted by the server.');
			}
			return true;
		} catch (error) {
			debugLogger.warn('finder.server.dataset_cache_invalidation_failed', {
				error: error instanceof Error ? error.message : String(error),
			});
			return false;
		}
	}

	/**
	 * Construction and wiring only: every mutable state category is owned by
	 * its collaborator (controls, selection, store, session, controller,
	 * actions) and the facade delegates to them.
	 */
	public init() {
		this.controls.loadUiState();
		const dom = this.getDom();
		this.controls.bindPersistenceLifecycle();
		this.controller.bindRunControls(dom.runFinder, dom.stopFinder);

		dom.resetFinderSettings.addEventListener('click', () => {
			this.controls.resetFinderSettings();
		});

		const copyTopButton = dom.finderCopyTopResults;
		copyTopButton.disabled = true;
		copyTopButton.addEventListener('click', () => {
			void this.copyTopResultsMetadata();
		});
		dom.finderCopyDiagnostics.disabled = true;
		dom.finderCopyDiagnostics.addEventListener('click', () => {
			void this.copyFinderDiagnostics();
		});

		dom.finderCopyConfiguration.addEventListener('click', () => {
			void this.copyRunConfiguration();
		});

		dom.finderList.addEventListener('click', (event) => {
			const target = event.target as HTMLElement | null;
			const button = target?.closest<HTMLButtonElement>('.finder-apply');
			if (!button) return;
			const index = Number(button.dataset.index);
			if (this.resultStore.latestResults.scope === "current_chart") {
				const result = this.resultStore.latestResults.results[index];
				if (result) {
					void this.resultActions.runFinderApply(() => this.resultActions.applyCurrentChartResult(result));
				}
				return;
			}
			if (this.resultStore.latestResults.scope === "asset_opportunity") {
				const assetResult = this.resultStore.latestResults.results[index];
				if (assetResult) {
					void this.resultActions.runFinderApply(() => this.resultActions.applyAssetOpportunityResult(assetResult));
				}
				return;
			}
			if (this.resultStore.latestResults.scope === "arm_performance") {
				const candidate = this.resultStore.latestResults.results[index];
				if (candidate) {
					void this.resultActions.runFinderApply(() => this.resultActions.applyArmPerformanceCandidate(candidate));
				}
				return;
			}
			if (this.resultStore.latestResults.scope === "strategy_quality") {
				return;
			}
			const candidate = this.resultStore.latestResults.results[index];
			if (candidate) {
				void this.resultActions.runFinderApply(() => this.resultActions.applyUniverseCandidate(candidate));
			}
		});

		this.selection.renderStrategySelection();
		this.controls.initStrategySelectionUI();

		this.controls.initSortingUI();
		this.controls.applyPersistedUiStateToDom();
		this.controls.initUniverseUI();
		this.controls.initTradeFilterUI();
		this.controls.initFinderSettingsPersistenceUI();
		this.controls.initOosValidationUI();
		this.getDom().finderResort.addEventListener("change", () => this.applyResort());
		for (const element of [
			dom.finderArmPerformanceExcludeTopContributor,
			dom.finderArmPerformanceEventFilterEnabled,
			dom.finderArmPerformanceMinEvents,
			dom.finderArmPerformanceMaxEvents,
		]) {
			element.addEventListener("input", () => this.applyArmPerformanceDisplaySettings());
			element.addEventListener("change", () => this.applyArmPerformanceDisplaySettings());
		}
		this.controls.applyScopeUi();
		this.loadPersistedLatestResults();
		this.populateResortOptions();
		if (this.resultStore.latestResults.scope === "arm_performance") {
			this.applyArmPerformanceDisplaySettings();
		}
		this.renderLatestResults();
		// Reattach to an in-flight or terminal server-owned job after a tab
		// reload. Finder is lazy-loaded, so this runs on first Finder
		// activation (not global startup). No-op when there is no persisted
		// active run id.
		void this.reattachToActiveServerRun();
	}

	/** Run/Stop orchestration lives in the controller. */
	public async runFinder(): Promise<void> {
		await this.controller.runFinder();
	}

	/** @internal facade seam preserving the batch consumer's positional contract for integration tests. */
	async runAssetOpportunityBatchFinderServer(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[],
		exitStrategyCandidates: FinderSelectedStrategy[] | undefined,
		runId: string,
		startTime: number,
		range: BatchHoldoutRange,
		archiveSort: import("./finder/finder-asset-opportunity-metrics").FinderAssetOpportunityArchiveSort | null = null,
	): Promise<unknown> {
		return runAssetOpportunityBatchFinderServer({
			host: this.runHost(),
			store: this.resultStore,
			session: this.session,
			options,
			selectedStrategies,
			exitStrategyCandidates,
			runId,
			startTime,
			range,
			archiveSort,
		});
	}

	private getScope(): FinderScope {
		return this.controls.getScope();
	}

	private isUniverseScope(): boolean {
		return this.getScope() === "symbol_universe";
	}

	private isAssetOpportunityScope(): boolean {
		return this.getScope() === "asset_opportunity";
	}

	private isStrategyQualityScope(): boolean {
		return this.getScope() === "strategy_quality";
	}

	private isArmPerformanceScope(): boolean {
		return this.getScope() === "arm_performance";
	}

	private usesUniverseStrategySelection(): boolean {
		return this.isUniverseScope() || this.isStrategyQualityScope() || this.isArmPerformanceScope();
	}

	private loadPersistedLatestResults(): void {
		const snapshot = readFinderLatestResultsSnapshot();
		if (!snapshot) return;

		const restoredResults = snapshot.results.scope === 'asset_opportunity'
			? {
				scope: 'asset_opportunity' as const,
				results: deduplicateAssetOpportunityResultsBySymbol(snapshot.results.results),
			}
			: snapshot.results;
		this.resultStore.latestResults = restoredResults;
		if (restoredResults.scope === 'asset_opportunity') {
			this.resultStore.assetOpportunityRunResults = [...restoredResults.results];
			this.resultStore.assetOpportunityDefaultResults = [...restoredResults.results];
		} else if (restoredResults.scope === 'arm_performance') {
			this.resultStore.armPerformanceRunResults = [...restoredResults.results];
			this.resultStore.armPerformanceDefaultResults = [...restoredResults.results];
			this.resultStore.armPerformanceRunContext = restoredResults.runContext;
			this.resultStore.armPerformanceInventoryComplete = restoredResults.inventoryComplete;
			this.resultStore.armPerformanceDisplayLimit = Math.max(1, this.controls.uiState.topN);
			this.getDom().finderCopyDiagnostics.disabled = !restoredResults.runContext && restoredResults.results.length === 0;
		}
		debugLogger.event("finder.latest_results_restored", {
			scope: restoredResults.scope,
			count: restoredResults.results.length,
			symbol: snapshot.symbol,
			interval: snapshot.interval,
			savedAt: snapshot.savedAt,
		});
	}

	private saveLatestResultsSnapshot(results: FinderLatestResults): void {
		writeFinderLatestResultsSnapshot({
			symbol: state.currentSymbol,
			interval: state.currentInterval,
			results,
		});
	}

	private clearLatestResultsSnapshot(): void {
		clearFinderLatestResultsSnapshot();
	}

	private loadPersistedActiveServerRun(): FinderPersistedActiveServerRun | null {
		return readFinderActiveServerRun();
	}

	/**
	 * Reattach to an in-flight or terminal server-owned Finder job after a
	 * tab reload (Finder is lazy-loaded, so this runs on first Finder
	 * activation). The session owns the poll loop; the facade supplies the
	 * scope/UI/terminal-interpretation capabilities. With no persisted
	 * record, still try to recover the server's full Arm inventory behind an
	 * incomplete saved preview.
	 */
	private async reattachToActiveServerRun(): Promise<void> {
		if (!this.loadPersistedActiveServerRun()) {
			await this.restoreSavedArmPerformanceInventory();
			return;
		}
		await this.session.reattachToActiveServerRun(this.reattachHost());
	}

	/** Restore the persisted job's scope before any terminal snapshot lands. */
	private restoreServerRunScope(scope: FinderScope): void {
		const dom = this.getDom();
		if (this.controls.uiState.scope !== scope) {
			this.controls.uiState.scope = scope;
			dom.finderScope.value = scope;
			this.controls.applyScopeUi();
			this.controls.saveUiState();
		}
	}

	private resetForServerRunAdoption(): void {
		const activeRun = this.loadPersistedActiveServerRun();
		const currentResults = this.resultStore.latestResults;
		const armPreview = activeRun?.scope === 'arm_performance'
			&& currentResults.scope === 'arm_performance'
			&& !currentResults.inventoryComplete
			&& currentResults.results.some((candidate) => candidate.candidateId.startsWith(`${activeRun.runId}:candidate-`))
			? currentResults
			: null;
		this.resultStore.resetForNewRun();
		this.resultStore.setRunDisplayLimits(this.controls.uiState.topN);
		if (armPreview) {
			// Keep the last bounded checkpoint for this exact server run visible
			// while counts-only status polling waits for the authoritative result.
			this.resultStore.armPerformanceRunResults = [...armPreview.results];
			this.resultStore.armPerformanceDefaultResults = [...armPreview.results];
			this.resultStore.armPerformanceRunContext = armPreview.runContext;
			this.resultStore.armPerformanceInventoryComplete = false;
			this.resultStore.armPerformanceDisplayLimit = Math.max(1, this.controls.uiState.topN);
			this.resultStore.setLatestResults(armPreview, false);
		} else {
			this.clearLatestResultsSnapshot();
			this.resultStore.setLatestResults(emptyFinderLatestResults(this.controls.uiState.scope), false);
		}
		this.renderLatestResults();
	}

	private setServerRunRunning(running: boolean): void {
		this.controller.setServerRunning(running);
	}

	/**
	 * Adopt a terminal reattach snapshot for its scope. Ownership (run id +
	 * terminal) has already been re-checked by the session.
	 */
	private interpretTerminalServerRunSnapshot(
		snapshot: Parameters<FinderSessionHost['interpretTerminal']>[0],
		persistedScope: 'symbol_universe' | 'asset_opportunity' | 'asset_opportunity_batch' | 'arm_performance',
	): void {
		const dom = this.getDom();
		if (persistedScope === 'arm_performance' && snapshot.terminalArmPerformanceResults) {
			this.resultStore.armPerformanceDisplayLimit = Math.max(1, this.controls.uiState.topN);
			this.adoptArmPerformanceResults(
				snapshot.terminalArmPerformanceResults,
				snapshot.armPerformanceRunContext ?? null,
				true,
			);
			this.populateResortOptions();
			this.stashAndResetResort();
			this.renderLatestResults();
		} else if ((persistedScope === 'asset_opportunity' || persistedScope === 'asset_opportunity_batch')
			&& snapshot.terminalAssets) {
			this.resultStore.assetOpportunityRunResults = sortAssetOpportunityResults([...snapshot.terminalAssets]);
			this.resultStore.assetOpportunityDefaultResults = [...this.resultStore.assetOpportunityRunResults];
			this.resultStore.setAssetOpportunityLatestResults(this.resultStore.assetOpportunityRunResults);
			this.stashAndResetResort();
			this.renderLatestResults();
			this.latestDiagnostics = snapshot.diagnostics;
			this.latestAssetOpportunityDiagnostics = snapshot.assetDiagnostics ?? (snapshot.assetTotals
				? {
					totalAssets: snapshot.assetTotals.totalAssets,
					assetsWithFreshEntry: snapshot.assetTotals.assetsWithFreshEntry,
					assetsWithNoFreshEntry: Math.max(0, snapshot.assetTotals.totalAssets - snapshot.assetTotals.assetsWithFreshEntry - snapshot.assetTotals.failedAssets),
					selectGradeAssets: snapshot.assetTotals.selectGradeAssets,
					watchGradeAssets: snapshot.assetTotals.watchGradeAssets,
					rejectGradeAssets: snapshot.assetTotals.rejectGradeAssets,
					failedAssets: [],
					...(snapshot.assetTotals.engineUsage ? { engineUsage: snapshot.assetTotals.engineUsage } : {}),
				}
				: null);
			dom.finderCopyDiagnostics.disabled = !snapshot.diagnostics && !this.latestAssetOpportunityDiagnostics;
		} else if (snapshot.phase === "done" && snapshot.terminalCandidates) {
			// The terminal snapshot is the full scalar run inventory. Keep it
			// for post-run re-sort and display only the persisted topN.
			this.resultStore.adoptSymbolUniverseResults(snapshot.terminalCandidates);
			this.populateResortOptions();
			this.renderLatestResults();
			this.latestDiagnostics = snapshot.diagnostics;
			dom.finderCopyDiagnostics.disabled = !snapshot.diagnostics;
		}
	}

	private reattachHost(): FinderSessionHost {
		return {
			setProgress: (active, percent, text) => this.setProgress(active, percent, text),
			setStatus: (text) => this.setStatus(text),
			restoreScope: (scope) => this.restoreServerRunScope(scope),
			resetForServerRunAdoption: () => this.resetForServerRunAdoption(),
			setRunning: (running) => this.setServerRunRunning(running),
			interpretTerminal: (snapshot, persistedScope) => this.interpretTerminalServerRunSnapshot(snapshot, persistedScope),
		};
	}

	/** Recover the server's retained full inventory when localStorage has only the bounded preview. */
	private async restoreSavedArmPerformanceInventory(): Promise<void> {
		const saved = this.resultStore.latestResults;
		if (saved.scope !== 'arm_performance' || saved.inventoryComplete) return;
		const candidateRunId = saved.results
			.map((candidate) => candidate.candidateId.match(/^(.+):candidate-\d+$/)?.[1])
			.find((runId): runId is string => Boolean(runId));
		const runId = saved.runContext?.runId ?? candidateRunId;
		if (!runId) return;
		const abortController = new AbortController();
		this.session.adoptAbortController(abortController);
		const request = createFinderStatusRequestSignal(abortController.signal);
		try {
			const response = await fetch(`/api/finder/status?runId=${encodeURIComponent(runId)}`, {
				cache: 'no-store',
				signal: request.signal,
			});
			if (!response.ok) return;
			const snapshot = parseJsonPreservingNonFinite(await response.text()) as FinderRunStatusSnapshot;
			if (
				this.session.pollingStopped
				|| this.session.activeRunId !== null
				|| this.resultStore.latestResults !== saved
				|| !snapshot.ok
				|| !snapshot.terminal
				|| snapshot.runId !== runId
				|| snapshot.jobKind !== 'arm_performance'
				|| !snapshot.terminalArmPerformanceResults
			) return;
			this.resultStore.armPerformanceDisplayLimit = Math.max(1, this.controls.uiState.topN);
			this.adoptArmPerformanceResults(
				snapshot.terminalArmPerformanceResults,
				snapshot.armPerformanceRunContext ?? saved.runContext,
				true,
			);
			this.populateResortOptions();
			this.stashAndResetResort();
			this.renderLatestResults();
			this.setStatus(`Restored all ${snapshot.terminalArmPerformanceResults.length} Arm Performance configurations from the server.`);
		} catch {
			// Keep the persisted preview available if the server cannot be reached.
		} finally {
			request.cleanup();
			this.session.releaseAbortController(abortController);
		}
	}

	/**
	 * Presentation/lifecycle capabilities shared by every scope workflow.
	 * Mutable state stays in the result store and session; this only forwards
	 * to the UI, render dispatch, and the browser-cancellation flag.
	 */
	private runHost(): FinderRunHost {
		return {
			setProgress: (active, percent, text) => this.setProgress(active, percent, text),
			setStatus: (text) => this.setStatus(text),
			isCancelled: () => this.controller.isRunCancelled(),
			getAbortSignal: () => this.controller.abortSignal(),
			yieldControl: () => this.controller.yieldControl(),
			renderRandomBenchmark: (mode, payload) => this.ui.renderRandomBenchmark(mode, payload as never),
			renderLatestResults: () => this.renderLatestResults(),
			stashAndResetResort: () => this.stashAndResetResort(),
			populateResortOptions: () => this.populateResortOptions(),
			showDiagnosticsAvailability: (available) => {
				this.getDom().finderCopyDiagnostics.disabled = !available;
			},
		};
	}

	private generateParamSets(defaultParams: StrategyParams, options: FinderOptions): StrategyParams[] {
		return this.paramSpace.generateParamSets(defaultParams, options);
	}

	private async loadSelectedStrategy(strategyKey: string): Promise<FinderSelectedStrategy | null> {
		if (!strategyRegistry.has(strategyKey)) {
			await loadBuiltInStrategyByKey(strategyKey);
		}
		const strategy = strategyRegistry.get(strategyKey);
		return strategy ? { key: strategyKey, name: strategy.name, strategy } : null;
	}

	private async getSelectedStrategies(): Promise<FinderSelectedStrategy[]> {
		const results: FinderSelectedStrategy[] = [];
		for (const key of this.controls.uiState.currentChartSelectedStrategyKeys) {
			const selection = await this.loadSelectedStrategy(key);
			if (selection) {
				results.push(selection);
			}
		}
		return results;
	}

	private async getUniverseSelectedStrategies(): Promise<FinderSelectedStrategy[]> {
		const results: FinderSelectedStrategy[] = [];
		for (const key of this.controls.uiState.universeSelectedStrategyKeys) {
			const selection = await this.loadSelectedStrategy(key);
			if (selection) {
				results.push(selection);
			}
		}
		return results;
	}

	private async resolveExitStrategyCandidates(
		options: FinderOptions,
		selectedStrategies: FinderSelectedStrategy[]
	): Promise<FinderSelectedStrategy[] | undefined> {
		if (!options.exitStrategyOverrideEnabled) {
			return undefined;
		}
		if (selectedStrategies.length === 0) {
			options.exitStrategyOverrideEnabled = false;
			return undefined;
		}
		// Exit-side sampling must draw from the FULL strategy library, not just the
		// entry selection. Returning `selectedStrategies` here previously pinned the
		// exit pool to whatever the user ticked as entries, so e.g. a 2-entry run
		// could only ever sample between those same 2 libs on the exit side.
		const library = getStrategyList();
		await ensureStrategyKeysLoaded(library.map((entry) => entry.key));
		const candidates: FinderSelectedStrategy[] = [];
		for (const entry of library) {
			const strategy = strategyRegistry.get(entry.key);
			if (strategy) {
				candidates.push({ key: entry.key, name: strategy.name, strategy });
			}
		}
		return candidates.length > 0 ? candidates : undefined;
	}
	private adoptArmPerformanceResults(
		results: readonly FinderArmPerformanceCandidate[],
		context: FinderArmPerformanceRunContext | null,
		complete: boolean,
		persist = true,
	): void {
		this.resultStore.adoptArmPerformanceResults(results, context, complete, persist);
		this.getDom().finderCopyDiagnostics.disabled = !context && results.length === 0;
	}

	private getCurrentChartResults(): FinderResult[] {
		return this.resultStore.latestResults.scope === 'current_chart' ? this.resultStore.latestResults.results : [];
	}

	private getUniverseResults(): FinderUniverseCandidate[] {
		return this.resultStore.latestResults.scope === 'symbol_universe' ? this.resultStore.latestResults.results : [];
	}

	private getAssetOpportunityResults(): FinderAssetOpportunityResult[] {
		return this.resultStore.latestResults.scope === 'asset_opportunity' ? this.resultStore.latestResults.results : [];
	}

	private getStrategyQualityResults(): FinderStrategyQualityResult[] {
		return this.resultStore.latestResults.scope === 'strategy_quality' ? this.resultStore.latestResults.results : [];
	}

	private getArmPerformanceResults(): FinderArmPerformanceCandidate[] {
		return this.resultStore.latestResults.scope === 'arm_performance' ? this.resultStore.latestResults.results : [];
	}


	/**
	 * Populate the post-run re-sort dropdown options for the current scope.
	 * Metric availability comes from the result store; this only writes the DOM.
	 */
	private populateResortOptions(): void {
		const dom = this.getDom();
		const options = this.resultStore.getResortOptions();
		// Preserve the current selection if it's still valid for this scope.
		const previousValue = dom.finderResort.value;
		dom.finderResort.innerHTML = '<option value="">Run Sort</option>';
		for (const opt of options) {
			const el = document.createElement("option");
			el.value = opt.value;
			el.textContent = opt.label;
			dom.finderResort.appendChild(el);
		}
		// Reset to default on scope change; the previous metric may not apply.
		dom.finderResort.value = "";
		dom.finderResort.disabled = false;
		void previousValue;
	}

	/**
	 * Apply the selected re-sort metric to the retained results and re-render.
	 * When the metric is empty ("Run Sort"), restore the original run-time
	 * ordering from the stashed snapshot.
	 */
	private applyResort(): void {
		const metric = this.getDom().finderResort.value;
		if (this.resultStore.latestResults.scope === "arm_performance") {
			this.applyArmPerformanceDisplaySettings();
			return;
		}
		if (!metric) {
			this.resultStore.restoreRunSort();
			this.renderLatestResults();
			return;
		}
		if (this.resultStore.latestResults.scope === 'asset_opportunity' && metric === ASSET_OPPORTUNITY_ALL_SORTS) {
			this.setStatus('All Sorts is for batch archive output; choose a specific metric to re-sort displayed results.');
			return;
		}
		this.resultStore.applyResortMetric(metric);
		this.renderLatestResults();
	}

	private applyArmPerformanceDisplaySettings(): void {
		if (this.resultStore.latestResults.scope !== "arm_performance") return;
		const dom = this.getDom();
		const minRaw = Number(dom.finderArmPerformanceMinEvents.value);
		const maxText = dom.finderArmPerformanceMaxEvents.value.trim();
		const maxRaw = maxText === "" ? null : Number(maxText);
		const selected = dom.finderResort.value;
		const arm = (selected || "TOP_RAW_PROFIT_NOW") as FinderArmPerformanceArm;
		this.resultStore.setArmPerformanceDisplayFilter({
			basis: dom.finderArmPerformanceExcludeTopContributor.checked ? "exclude_top_contributor" : "raw",
			eventFilterEnabled: dom.finderArmPerformanceEventFilterEnabled.checked,
			minEvents: Number.isInteger(minRaw) && minRaw >= 0 ? minRaw : 1,
			maxEvents: maxRaw !== null && Number.isInteger(maxRaw) && maxRaw >= 0 ? maxRaw : null,
		}, arm);
		this.renderLatestResults();
	}

	/**
	 * Reset the re-sort dropdown to "Run Sort" and stash the current results
	 * as the run-time baseline. Called at run completion.
	 */
	private stashAndResetResort(): void {
		const dom = this.getDom();
		dom.finderResort.value = "";
		this.resultStore.stashRunSortBaseline();
	}

	private renderLatestResults(): void {
		if (this.getScope() === 'symbol_universe') {
			const results = this.resultStore.latestResults.scope === 'symbol_universe' ? this.resultStore.latestResults.results : [];
			this.ui.renderUniverseResults(results);
			return;
		}
		if (this.getScope() === 'asset_opportunity') {
			const results = this.resultStore.latestResults.scope === 'asset_opportunity' ? this.resultStore.latestResults.results : [];
			this.ui.renderAssetOpportunityResults(results);
			return;
		}
		if (this.getScope() === 'strategy_quality') {
			const results = this.resultStore.latestResults.scope === 'strategy_quality' ? this.resultStore.latestResults.results : [];
			this.ui.renderStrategyQualityResults(results);
			return;
		}
		if (this.getScope() === 'arm_performance') {
			const results = this.resultStore.latestResults.scope === 'arm_performance' ? this.resultStore.latestResults.results : [];
			const currentArm = this.getDom().finderResort.value as FinderArmPerformanceArm || 'TOP_RAW_PROFIT_NOW';
			this.ui.renderArmPerformanceResults(
				results,
				this.resultStore.latestResults.scope === 'arm_performance' ? this.resultStore.latestResults.runContext : null,
				currentArm,
				this.resultStore.latestResults.scope === 'arm_performance' && !this.resultStore.latestResults.inventoryComplete,
				this.resultStore.armPerformanceDisplayFilter.basis ?? "raw",
				this.resultStore.armPerformanceDisplayFilter,
				this.resultStore.armPerformanceRunResults.some((candidate) =>
					!candidate.metricsExTopContributor?.[currentArm]),
			);
			return;
		}
		const results = this.resultStore.latestResults.scope === 'current_chart' ? this.resultStore.latestResults.results : [];
		this.ui.renderResults(results);
	}

	private async copyTopResultsMetadata(): Promise<void> {
		const chartResults = this.getCurrentChartResults();
		const universeResults = this.getUniverseResults();
		const assetResults = this.getAssetOpportunityResults();
		const qualityResults = this.getStrategyQualityResults();
		const armResults = this.getArmPerformanceResults();
		if (chartResults.length === 0 && universeResults.length === 0 && assetResults.length === 0 && qualityResults.length === 0 && armResults.length === 0) {
			uiManager.showToast('No results to copy', 'info');
			return;
		}

		const payload = buildFinderTopResultsPayload({
			latestResults: this.resultStore.latestResults,
			armRunContext: this.resultStore.armPerformanceRunContext,
			armInventoryComplete: this.resultStore.armPerformanceInventoryComplete,
			selectedArm: (this.getDom().finderResort.value || 'TOP_RAW_PROFIT_NOW') as FinderArmPerformanceArm,
			scoringBasis: this.resultStore.armPerformanceDisplayFilter.basis ?? "raw",
			displayFilter: this.resultStore.armPerformanceDisplayFilter,
		});

		try {
			await this.copyTextToClipboard(JSON.stringify(payload, null, 2));
			uiManager.showToast('Top results metadata copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_metadata_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	/**
	 * Clipboard transport seam. The implementation lives in
	 * `finder-export.ts`; keeping the call on `this` lets tests stub the
	 * transport without touching payload assembly.
	 */
	private copyTextToClipboard(text: string): Promise<void> {
		return copyTextToClipboard(text);
	}

	/**
	 * Copy the complete run configuration (Finder UI state + backtest settings) as
	 * JSON. The AO batch archives a config.txt with backtest settings only; the
	 * payload in `finder-export.ts` carries the Finder-side settings so archive
	 * runs are fully reproducible.
	 */
	private async copyRunConfiguration(): Promise<void> {
		if (this.resultStore.latestResults.scope === 'arm_performance') {
			if (!this.resultStore.armPerformanceRunContext) {
				uiManager.showToast('Arm Performance run context is unavailable in this cached preview.', 'error');
				return;
			}
			const payload = buildArmPerformanceRunConfigurationPayload(
				this.resultStore.armPerformanceRunContext,
				this.resultStore.armPerformanceRunResults.length,
				this.resultStore.armPerformanceInventoryComplete,
			);
			try {
				await this.copyTextToClipboard(formatCapturedConfiguration(payload));
				uiManager.showToast('Arm Performance configuration copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_configuration_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}
		this.controls.captureFinderUiState();
		const payload = buildFinderRunConfigurationPayload({
			uiState: this.controls.uiState,
			backtestSettings: backtestService.getBacktestSettings(),
			capitalSettings: backtestService.getCapitalSettings(),
		});
		try {
			await this.copyTextToClipboard(formatCapturedConfiguration(payload));
			uiManager.showToast('Finder configuration copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_configuration_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private async copyFinderDiagnostics(): Promise<void> {
		if (this.resultStore.latestResults.scope === 'arm_performance') {
			try {
				await this.copyTextToClipboard(JSON.stringify(buildArmPerformanceDiagnosticsPayload({
					runContext: this.resultStore.armPerformanceRunContext,
					inventoryComplete: this.resultStore.armPerformanceInventoryComplete,
					results: this.resultStore.armPerformanceRunResults,
				}), null, 2));
				uiManager.showToast('Arm Performance diagnostics copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}
		if (this.resultStore.latestResults.scope === 'asset_opportunity' && this.latestAssetOpportunityDiagnostics) {
			try {
				await this.copyTextToClipboard(JSON.stringify(
					buildAssetOpportunityDiagnosticsPayload(this.latestAssetOpportunityDiagnostics),
					null,
					2,
				));
				uiManager.showToast('Asset Opportunity diagnostics copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}

		if (!this.latestDiagnostics) {
			if (!this.latestAssetOpportunityDiagnostics) {
				uiManager.showToast('No Finder diagnostics to copy', 'info');
				return;
			}
			try {
				await this.copyTextToClipboard(JSON.stringify(
					buildAssetOpportunityDiagnosticsPayload(this.latestAssetOpportunityDiagnostics),
					null,
					2,
				));
				uiManager.showToast('Asset Opportunity diagnostics copied', 'success');
			} catch (error) {
				debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
				uiManager.showToast('Copy failed - check browser permissions', 'error');
			}
			return;
		}

		try {
			await this.copyTextToClipboard(JSON.stringify(buildCompactFinderDiagnosticsPayload(this.latestDiagnostics), null, 2));
			uiManager.showToast('Compact Finder diagnostics copied', 'success');
		} catch (error) {
			debugLogger.error('finder.copy_diagnostics_failed', { error: error instanceof Error ? error.message : String(error) });
			uiManager.showToast('Copy failed - check browser permissions', 'error');
		}
	}

	private setProgress(active: boolean, percent: number, text: string): void {
		this.ui.setProgress(active, percent, text);
	}

	private setStatus(text: string): void {
		this.ui.setStatus(text);
	}

	private cloneBacktestSettings<T>(settings: T): T {
		return cloneJsonCompatible(settings);
	}

	public getLatestResults(): FinderLatestResults {
		return this.cloneBacktestSettings(this.resultStore.latestResults);
	}

	public getLatestCandidate(): FinderResult | FinderUniverseCandidate | FinderAssetOpportunityResult | FinderStrategyQualityResult | FinderArmPerformanceCandidate | null {
		if (this.resultStore.latestResults.results.length === 0) return null;
		return this.cloneBacktestSettings(this.resultStore.latestResults.results[0]);
	}

	public getLastRunBacktestSettings(): ReturnType<typeof settingsManager.getBacktestSettings> | null {
		return this.lastFinderRunBacktestSettings
			? this.cloneBacktestSettings(this.lastFinderRunBacktestSettings)
			: null;
	}
}

export const finderManager = new FinderManager();








