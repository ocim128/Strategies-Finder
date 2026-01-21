import {
	strategyRegistry,
	loadBuiltInStrategies,
	restoreCustomStrategies,
	StrategyRegistryEvent,
} from "./strategyRegistry";

import { state } from "./lib/state";
import { chartManager } from "./lib/chartManager";
import { dataManager } from "./lib/dataManager";
import { uiManager } from "./lib/uiManager";
import { backtestService } from "./lib/backtestService";
import { editorManager } from "./lib/editorManager";
import { finderManager } from "./lib/finderManager";
import { debugLogger } from "./lib/debugLogger";
import { initDebugPanel } from "./lib/debugPanel";
import { walkForwardService } from "./lib/walkForwardService";
import { monteCarloService } from "./lib/monteCarloService";
import { settingsManager } from "./lib/settingsManager";
import { injectLayout } from "./lib/layoutManager";
import { commandPaletteManager } from "./lib/commandPalette";
import { combinerManager } from "./lib/combinerManager";
import { replayManager, ReplayChartAdapter, ReplayUI } from "./lib/replay";

// Handlers
import { setupGlobalErrorHandlers } from "./lib/handlers/globalErrorHandlers";
import { setupStateSubscriptions } from "./lib/handlers/stateSubscriptions";
import { setupEventHandlers } from "./lib/handlers/uiEventHandlers";
import { setupSettingsHandlers } from "./lib/handlers/settingsHandlers";
import { handleCrosshairMove } from "./lib/appActions";

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
	walkForwardService.initUI();
	monteCarloService.initUI();
	combinerManager.init();
	initDebugPanel();

	// Initialize replay feature
	const replayUI = new ReplayUI(replayManager);
	const replayChartAdapter = new ReplayChartAdapter(chartManager, replayManager);
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
		debugLogger.event('app.init.settings_restored');
	} else {
		state.set('currentStrategyKey', state.currentStrategyKey); // Initial sync
	}

	// Setup settings event handlers
	setupSettingsHandlers();

	// Setup auto-save for settings changes
	settingsManager.setupAutoSave();

	await dataManager.loadData();
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
}
