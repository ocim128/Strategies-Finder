import {
    strategyRegistry,
    loadBuiltInStrategies,
    restoreCustomStrategies,
    type StrategyRegistryEvent,
} from "../strategyRegistry";
import { state } from "./state";
import { chartManager } from "./chart-manager";
import { dataManager } from "./data-manager";
import { uiManager } from "./ui-manager";
import { backtestService } from "./backtest-service";
import { editorManager } from "./editor-manager";
import { finderManager } from "./finder-manager";
import { debugLogger } from "./debug-logger";
import { initDebugPanel } from "./debug-panel";
import { walkForwardService } from "./walk-forward-service";
import { settingsManager } from "./settings-manager";
import { injectLayout } from "./layout-manager";
import { dataMiningManager } from "./data-mining-manager";
import { portfolioLabService } from "./portfolio-lab-service";
import { strategyEnsembleService } from "./strategy-ensemble-service";
import { scannerPanel } from "./scanner";
import { setupGlobalErrorHandlers } from "./handlers/global-error-handlers";
import { setupStateSubscriptions } from "./handlers/state-subscriptions";
import { setupEventHandlers } from "./handlers/ui-event-handlers";
import { setupSettingsHandlers } from "./handlers/settings-handlers";
import { initSettingsUX } from "./handlers/settings-ux-handlers";
import { initAlertHandlers } from "./handlers/alert-handlers";
import { initLivePositionsHandlers } from "./handlers/live-positions-handlers";
import { handleCrosshairMove } from "./app-actions";
import { initEngineStatusIndicator } from "./engine-status-indicator";
import { blockSelectorManager } from "./block-selector-manager";
import { quickViewManager } from "./quick-view";
import { bindFormAccessibility } from "./form-accessibility";
import { strategyPanelController } from "./strategy-panel-controller";
import { getOptionalElement } from "./dom-utils";
import { polymarketPanelService } from "./polymarket-panel-service";
import { initMonteCarloService } from "./monte-carlo-service";
import { huntService } from "./hunt/hunt-service";
import { setBinanceMarketType, setCurrentInterval, setCurrentStrategyKey, setCurrentSymbol } from "./state-actions";
import {
    runBootstrapFeatureStage,
    type AppBootstrapFeature,
} from "./bootstrap-feature-registry";

export interface AppBootstrapContext {
    savedSettings: ReturnType<typeof settingsManager.loadSettings>;
    shouldLoadData: boolean;
}

async function restoreSavedSettings(context: AppBootstrapContext): Promise<void> {
    const savedSettings = settingsManager.loadSettings();
    context.savedSettings = savedSettings;

    if (savedSettings) {
        if (savedSettings.currentStrategyKey && strategyRegistry.has(savedSettings.currentStrategyKey)) {
            setCurrentStrategyKey(savedSettings.currentStrategyKey);
            const strategySelect = getOptionalElement<HTMLSelectElement>("strategySelect");
            if (strategySelect) {
                strategySelect.value = savedSettings.currentStrategyKey;
            }
        }

        settingsManager.applySettings(savedSettings);

        if (savedSettings.currentSymbol && savedSettings.currentSymbol !== state.currentSymbol) {
            setCurrentSymbol(savedSettings.currentSymbol);
            context.shouldLoadData = false;
        }

        if (savedSettings.currentInterval && savedSettings.currentInterval !== state.currentInterval) {
            setCurrentInterval(savedSettings.currentInterval);
            context.shouldLoadData = false;
        }

        if (savedSettings.binanceMarketType && savedSettings.binanceMarketType !== state.binanceMarketType) {
            setBinanceMarketType(savedSettings.binanceMarketType);
            context.shouldLoadData = false;
        }

        debugLogger.event("app.init.settings_restored");
        return;
    }

    setCurrentStrategyKey(state.currentStrategyKey);
}

export const APP_BOOTSTRAP_FEATURES: readonly AppBootstrapFeature<AppBootstrapContext>[] = [
    {
        id: "layout",
        stage: "pre_restore",
        init: () => injectLayout(),
    },
    {
        id: "global-errors",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: () => setupGlobalErrorHandlers(),
    },
    {
        id: "strategy-library",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: async () => {
            await loadBuiltInStrategies();
            restoreCustomStrategies();
        },
    },
    {
        id: "strategy-registry-subscription",
        stage: "pre_restore",
        dependsOn: ["strategy-library"],
        init: () => {
            strategyRegistry.subscribe((event: StrategyRegistryEvent) => {
                uiManager.updateStrategyDropdown(state.currentStrategyKey);
                if (event.strategyKey === state.currentStrategyKey) {
                    state.emit("currentStrategyKey", state.currentStrategyKey);
                    if (state.ohlcvData.length > 0 && state.currentBacktestResult) {
                        void backtestService.runCurrentBacktest();
                    }
                }
            });
        },
    },
    {
        id: "charts",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: () => {
            chartManager.initCharts();
            let crosshairRaf: number | null = null;
            state.chart.subscribeCrosshairMove((param) => {
                if (crosshairRaf !== null) {
                    cancelAnimationFrame(crosshairRaf);
                }
                crosshairRaf = requestAnimationFrame(() => {
                    handleCrosshairMove(param);
                    crosshairRaf = null;
                });
            });
        },
    },
    {
        id: "strategy-panel",
        stage: "pre_restore",
        dependsOn: ["charts"],
        init: () => strategyPanelController.init(),
    },
    {
        id: "state-subscriptions",
        stage: "pre_restore",
        dependsOn: ["charts"],
        init: () => setupStateSubscriptions(),
    },
    {
        id: "ui-events",
        stage: "pre_restore",
        dependsOn: ["state-subscriptions"],
        init: () => setupEventHandlers(),
    },
    {
        id: "block-selector",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => blockSelectorManager.init(),
    },
    {
        id: "finder",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => finderManager.init(),
    },
    {
        id: "hunt",
        stage: "pre_restore",
        dependsOn: ["finder"],
        init: () => huntService.init(),
    },
    {
        id: "data-mining",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => dataMiningManager.init(),
    },
    {
        id: "walk-forward",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => walkForwardService.initUI(),
    },
    {
        id: "portfolio-lab",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => portfolioLabService.init(),
    },
    {
        id: "strategy-ensemble",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => strategyEnsembleService.init(),
    },
    {
        id: "polymarket-panel",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => polymarketPanelService.init(),
    },
    {
        id: "monte-carlo",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: () => initMonteCarloService(),
    },
    {
        id: "alert-handlers",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => initAlertHandlers(),
    },
    {
        id: "live-positions-handlers",
        stage: "pre_restore",
        dependsOn: ["ui-events"],
        init: () => initLivePositionsHandlers(),
    },
    {
        id: "debug-panel",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: () => initDebugPanel(),
    },
    {
        id: "engine-status",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: () => initEngineStatusIndicator(),
    },
    {
        id: "quick-view",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: () => quickViewManager.init(),
    },
    {
        id: "scanner-shortcut",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: () => {
            window.addEventListener("keydown", (event) => {
                if (event.ctrlKey && event.shiftKey && event.key === "S") {
                    event.preventDefault();
                    scannerPanel.toggle();
                }
            });
        },
    },
    {
        id: "scanner-load-symbol",
        stage: "pre_restore",
        dependsOn: ["layout"],
        init: () => {
            window.addEventListener("scanner:load-symbol", ((event: CustomEvent<{ symbol: string }>) => {
                setCurrentSymbol(event.detail.symbol);
                scannerPanel.hide();
            }) as EventListener);
        },
    },
    {
        id: "editor",
        stage: "pre_restore",
        dependsOn: ["strategy-library"],
        init: () => {
            editorManager.init(() => {
                uiManager.updateStrategyDropdown(state.currentStrategyKey);
            });
        },
    },
    {
        id: "initial-ui-sync",
        stage: "pre_restore",
        dependsOn: ["editor"],
        init: () => {
            uiManager.updateStrategyDropdown(state.currentStrategyKey);
            uiManager.updateStrategyParams(state.currentStrategyKey);
        },
    },
    {
        id: "settings-state",
        stage: "pre_restore",
        dependsOn: ["initial-ui-sync", "strategy-library"],
        restore: async (context) => restoreSavedSettings(context),
    },
    {
        id: "settings-handlers",
        stage: "post_restore",
        dependsOn: ["settings-state"],
        init: () => setupSettingsHandlers(),
    },
    {
        id: "settings-ux",
        stage: "post_restore",
        dependsOn: ["settings-handlers"],
        init: () => initSettingsUX(),
    },
    {
        id: "form-accessibility",
        stage: "post_restore",
        dependsOn: ["settings-handlers"],
        init: () => bindFormAccessibility(document),
    },
    {
        id: "settings-autosave",
        stage: "post_restore",
        dependsOn: ["settings-handlers"],
        init: () => settingsManager.setupAutoSave(),
    },
    {
        id: "initial-data-load",
        stage: "post_restore",
        dependsOn: ["settings-autosave"],
        init: async (context) => {
            if (context.shouldLoadData) {
                await dataManager.loadData();
            }
        },
    },
] as const;

export async function bootstrapApp(): Promise<void> {
    const context: AppBootstrapContext = {
        savedSettings: null,
        shouldLoadData: true,
    };

    debugLogger.event("app.init.start");
    await runBootstrapFeatureStage(APP_BOOTSTRAP_FEATURES, "pre_restore", "init", context);
    await runBootstrapFeatureStage(APP_BOOTSTRAP_FEATURES, "pre_restore", "restore", context);
    await runBootstrapFeatureStage(APP_BOOTSTRAP_FEATURES, "post_restore", "init", context);
    debugLogger.event("app.init.ready");
}
