import {
	strategyRegistry,
	loadBuiltInStrategies,
	restoreCustomStrategies,
	StrategyRegistryEvent,
} from "./strategyRegistry";

import { state } from "./lib/state";
import { chartManager } from "./lib/chart-manager";
import { dataManager } from "./lib/data-manager";
import { uiManager } from "./lib/ui-manager";
import { backtestService } from "./lib/backtest-service";
import { editorManager } from "./lib/editor-manager";
import { finderManager } from "./lib/finder-manager";
import { debugLogger } from "./lib/debug-logger";
import { initDebugPanel } from "./lib/debug-panel";
import { walkForwardService } from "./lib/walk-forward-service";
import { monteCarloService } from "./lib/monte-carlo-service";
import { logicTestService } from "./lib/logic-test-service";
import { settingsManager } from "./lib/settings-manager";
import { injectLayout } from "./lib/layout-manager";
import { commandPaletteManager } from "./lib/command-palette";
import { pairCombinerManager } from "./lib/pair-combiner-manager";
import { analysisPanel } from "./lib/analysis-panel";
import { dataMiningManager } from "./lib/data-mining-manager";

import { replayManager, ReplayChartAdapter, ReplayUI } from "./lib/replay";
import { initConfirmationStrategyUI } from "./lib/confirmation-strategies";
import { scannerPanel, scannerManager } from "./lib/scanner";

// Handlers
import { setupGlobalErrorHandlers } from "./lib/handlers/global-error-handlers";
import { setupStateSubscriptions } from "./lib/handlers/state-subscriptions";
import { setupEventHandlers } from "./lib/handlers/ui-event-handlers";
import { setupSettingsHandlers } from "./lib/handlers/settings-handlers";
import { initSettingsUX } from "./lib/handlers/settings-ux-handlers";
import { initAlertHandlers } from "./lib/handlers/alert-handlers";
import { handleCrosshairMove } from "./lib/app-actions";
import { initEngineStatusIndicator } from "./lib/engine-status-indicator";

async function init() {
	injectLayout();
	debugLogger.event('app.init.start');
	setupGlobalErrorHandlers();
	await loadBuiltInStrategies();
	restoreCustomStrategies();

	strategyRegistry.subscribe((event: StrategyRegistryEvent) => {
		uiManager.updateStrategyDropdown(state.currentStrategyKey);
		if (event.strategyKey === state.currentStrategyKey) {
			state.emit('currentStrategyKey', state.currentStrategyKey); // Trigger reactive update
			if (state.ohlcvData.length > 0 && state.currentBacktestResult) {
				backtestService.runCurrentBacktest();
			}
		}
	});

	chartManager.initCharts();
	state.chart.subscribeCrosshairMove(handleCrosshairMove);

	setupStateSubscriptions();
	setupEventHandlers();
	finderManager.init();
	pairCombinerManager.init();
	dataMiningManager.init();
	walkForwardService.initUI();
	monteCarloService.initUI();
	logicTestService.initUI();
	analysisPanel.init();
	initAlertHandlers();

	initConfirmationStrategyUI();
	initDebugPanel();
	initEngineStatusIndicator(); // Show Rust vs TypeScript engine status

	// Initialize scanner panel with keyboard shortcut
	window.addEventListener('keydown', (e) => {
		if (e.ctrlKey && e.shiftKey && e.key === 'S') {
			e.preventDefault();
			scannerPanel.toggle();
		}
	});

	// Handle scanner symbol load events
	window.addEventListener('scanner:load-symbol', ((e: CustomEvent<{ symbol: string }>) => {
		const { symbol } = e.detail;
		state.set('currentSymbol', symbol);
		dataManager.loadData();
		scannerPanel.hide();
	}) as EventListener);

	// Initialize replay feature
	const replayUI = new ReplayUI(replayManager);
	const replayChartAdapter = new ReplayChartAdapter(replayManager);
	replayChartAdapter.connect();

	// Initialize replay UI when tab becomes active
	const initReplayUIOnTabChange = () => {
		const replayTab = document.querySelector('.panel-tab[data-tab="replay"]');
		if (replayTab) {
			replayTab.addEventListener('click', () => {
				// Small delay to ensure DOM is ready
				setTimeout(() => replayUI.reinit(), 50);
			});
		}
	};
	initReplayUIOnTabChange();

	editorManager.init(() => {
		uiManager.updateStrategyDropdown(state.currentStrategyKey);
	});

	uiManager.updateStrategyDropdown(state.currentStrategyKey);
	uiManager.updateStrategyParams(state.currentStrategyKey); // Load initial params

	// Load saved settings from localStorage
	let shouldLoadData = true;
	const savedSettings = settingsManager.loadSettings();
	if (savedSettings) {
		// Apply saved strategy key first
		if (savedSettings.currentStrategyKey && strategyRegistry.has(savedSettings.currentStrategyKey)) {
			state.set('currentStrategyKey', savedSettings.currentStrategyKey);
			const strategySelect = document.getElementById('strategySelect') as HTMLSelectElement | null;
			if (strategySelect) {
				strategySelect.value = savedSettings.currentStrategyKey;
			}
		}
		// Apply other settings
		settingsManager.applySettings(savedSettings);

		if (savedSettings.currentSymbol && savedSettings.currentSymbol !== state.currentSymbol) {
			state.set('currentSymbol', savedSettings.currentSymbol);
			shouldLoadData = false;
		}

		if (savedSettings.currentInterval && savedSettings.currentInterval !== state.currentInterval) {
			state.set('currentInterval', savedSettings.currentInterval);
			shouldLoadData = false;
		}

		debugLogger.event('app.init.settings_restored');
	} else {
		state.set('currentStrategyKey', state.currentStrategyKey); // Initial sync
	}

	// Setup settings event handlers
	setupSettingsHandlers();
	initSettingsUX();

	// Setup auto-save for settings changes
	settingsManager.setupAutoSave();

	if (shouldLoadData) {
		await dataManager.loadData();
	}
	debugLogger.event('app.init.ready');
}

// Start the app
init();

// Expose globals for debugging
if (typeof window !== 'undefined') {
	(window as any).__state = state;
	(window as any).__debug = debugLogger;
	(window as any).__commandPalette = commandPaletteManager;
	(window as any).__replayManager = replayManager;
	(window as any).__scannerPanel = scannerPanel;
	(window as any).__scannerManager = scannerManager;
}
