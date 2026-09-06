import {
    strategyRegistry,
    loadBuiltInStrategies,
    loadBuiltInStrategyByKey,
    restoreCustomStrategies,
    type StrategyRegistryEvent,
} from "../strategyRegistry";
import { state } from "./state";
import { chartManager } from "./chart-manager";
import { dataManager } from "./data-manager";
import { uiManager } from "./ui-manager";
import { backtestService } from "./backtest-service";
import { editorManager } from "./editor-manager";
import { debugLogger } from "./debug-logger";
import { settingsManager } from "./settings-manager";
import { injectLayout } from "./layout-manager";
import { setupGlobalErrorHandlers } from "./handlers/global-error-handlers";
import { setupStateSubscriptions } from "./handlers/state-subscriptions";
import { setupEventHandlers } from "./handlers/ui-event-handlers";
import { setupSettingsHandlers } from "./handlers/settings-handlers";
import { initSettingsUX } from "./handlers/settings-ux-handlers";
import { initLivePositionsHandlers } from "./handlers/live-positions-handlers";
import { handleCrosshairMove } from "./app-actions";
import { initEngineStatusIndicator } from "./engine-status-indicator";
import { blockSelectorManager } from "./block-selector-manager";
import { bindFormAccessibility } from "./form-accessibility";
import { strategyPanelController } from "./strategy-panel-controller";
import { getOptionalElement } from "./dom-utils";
import { initCrossSymbolUI } from "./cross-symbol-ui";
import { setBinanceMarketType, setCurrentInterval, setCurrentStrategyKey, setCurrentSymbol } from "./state-actions";
import { getLocalDailyAsset, isIbkrSymbol, isStockMarketSymbol } from "./local-daily-datasets";
import { coalesceAnimationFrame } from "./render-scheduler";
import { markAppTiming, logAppTimingSnapshot } from "./app-timing";
import { DEFAULT_BUILT_IN_STRATEGY_KEY } from "./strategy-defaults";
import {
    registerLazyFeature,
    attachLazyFeatureTrigger,
    attachTabLazyListener,
    isLazyFeatureInitialized,
} from "./lazy-feature-init";

export interface AppBootstrapContext {
    savedSettings: ReturnType<typeof settingsManager.loadSettings>;
    shouldLoadData: boolean;
}

async function restoreSavedSettings(context: AppBootstrapContext): Promise<void> {
    const savedSettings = settingsManager.loadSettings();
    context.savedSettings = savedSettings;

    if (savedSettings) {
        if (savedSettings.currentStrategyKey) {
            if (!strategyRegistry.has(savedSettings.currentStrategyKey)) {
                await loadBuiltInStrategyByKey(savedSettings.currentStrategyKey);
            }
            if (strategyRegistry.has(savedSettings.currentStrategyKey)) {
                setCurrentStrategyKey(savedSettings.currentStrategyKey);
                const strategySelect = getOptionalElement<HTMLSelectElement>("strategySelect");
                if (strategySelect) {
                    strategySelect.value = savedSettings.currentStrategyKey;
                }
            }
        }

        settingsManager.applySettings(savedSettings);

        if (savedSettings.currentSymbol) {
            // Skip the 6-catalog local-daily lookup on the critical startup
            // path for symbols that cannot be in any local-daily dataset.
            // Stock-market symbols are always diamond-marked at runtime; the
            // unmarked S&P 500 / Indonesian datasets only hold short bare
            // all-letter tickers. Crypto/forex/commodity/polymarket symbols
            // therefore can never match and would otherwise force six network
            // catalog fetches + parses just to conclude "no match".
            const candidate = savedSettings.currentSymbol.trim().toUpperCase();
            const mightBeLocalDaily = isStockMarketSymbol(candidate)
                || isIbkrSymbol(candidate)
                || (/^[A-Z]{1,6}$/.test(candidate) && !candidate.endsWith("USDT"));
            if (mightBeLocalDaily) {
                const localDailyAsset = await getLocalDailyAsset(candidate);
                if (localDailyAsset) {
                    dataManager.setProviderOverride(localDailyAsset.symbol, localDailyAsset.provider);
                }
            }
        }

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

async function toggleScannerPanel(): Promise<void> {
    const { scannerPanel } = await import("./scanner");
    scannerPanel.toggle();
}

async function hideScannerPanel(): Promise<void> {
    const { scannerPanel } = await import("./scanner");
    scannerPanel.hide();
}

function logScannerLoadError(error: unknown): void {
    debugLogger.error("scanner.load_failed", { error: error instanceof Error ? error.message : String(error) });
}

function nowMs(): number {
    return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function roundedDurationMs(startedAt: number): number {
    return Math.round((nowMs() - startedAt) * 10) / 10;
}

/**
 * Runs one named startup step, emitting the same `app.bootstrap.feature_complete`
 * / `app.bootstrap.feature_failed` telemetry the prior declarative registry
 * produced, so observability and error handling stay identical. Steps are
 * awaited in the order they appear in {@link bootstrapApp} — no scheduler, no
 * dependency graph — because startup is strictly sequential and the prior
 * `dependsOn` declarations were documented as advisory only.
 */
async function runBootstrapStep(
    id: string,
    stage: "pre_restore" | "post_restore",
    step: () => void | Promise<void>
): Promise<void> {
    const startedAt = nowMs();
    try {
        await step();
        try {
            debugLogger.event("app.bootstrap.feature_complete", {
                id,
                stage,
                handler: "init",
                durationMs: roundedDurationMs(startedAt),
            });
        } catch {
            // Bootstrap telemetry must never change bootstrap control flow.
        }
    } catch (error) {
        try {
            debugLogger.error("app.bootstrap.feature_failed", {
                id,
                stage,
                handler: "init",
                durationMs: roundedDurationMs(startedAt),
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
        } catch {
            // Bootstrap telemetry must never change bootstrap control flow.
        }
        throw error;
    }
}

export async function bootstrapApp(): Promise<void> {
    const context: AppBootstrapContext = {
        savedSettings: null,
        shouldLoadData: true,
    };

    registerLazyFeatures();

    markAppTiming("bootstrapStart");
    debugLogger.event("app.init.start");

    // --- pre_restore: layout, registries, charts, handlers, UI sync ---
    await runBootstrapStep("layout", "pre_restore", () => injectLayout());
    await runBootstrapStep("global-errors", "pre_restore", () => setupGlobalErrorHandlers());
    await runBootstrapStep("strategy-library", "pre_restore", async () => {
        markAppTiming("manifestLoadStart");
        await loadBuiltInStrategies([DEFAULT_BUILT_IN_STRATEGY_KEY]);
        markAppTiming("manifestLoadEnd");
        restoreCustomStrategies();
    });
    await runBootstrapStep("strategy-registry-subscription", "pre_restore", () => {
        strategyRegistry.subscribe((event: StrategyRegistryEvent) => {
            uiManager.updateStrategyDropdown(state.currentStrategyKey);
            if (event.strategyKey === state.currentStrategyKey) {
                state.emit("currentStrategyKey", state.currentStrategyKey);
                if (state.ohlcvData.length > 0 && state.currentBacktestResult) {
                    void backtestService.runCurrentBacktest();
                }
            }
        });
    });
    await runBootstrapStep("charts", "pre_restore", () => {
        chartManager.initCharts();
        let latestCrosshairParam: Parameters<typeof handleCrosshairMove>[0] | null = null;
        const crosshairFrame = coalesceAnimationFrame(() => {
            if (latestCrosshairParam !== null) {
                handleCrosshairMove(latestCrosshairParam);
                latestCrosshairParam = null;
            }
        });
        state.chart.subscribeCrosshairMove((param) => {
            latestCrosshairParam = param;
            crosshairFrame.schedule();
        });
    });
    await runBootstrapStep("strategy-panel", "pre_restore", () => strategyPanelController.init());
    await runBootstrapStep("state-subscriptions", "pre_restore", () => setupStateSubscriptions());
    await runBootstrapStep("ui-events", "pre_restore", () => setupEventHandlers());
    await runBootstrapStep("block-selector", "pre_restore", () => blockSelectorManager.init());
    await runBootstrapStep("cross-symbol", "pre_restore", () => initCrossSymbolUI());
    await runBootstrapStep("live-positions-handlers", "pre_restore", () => initLivePositionsHandlers());
    await runBootstrapStep("engine-status", "pre_restore", () => initEngineStatusIndicator());
    await runBootstrapStep("scanner-shortcut", "pre_restore", () => {
        window.addEventListener("keydown", (event) => {
            if (event.ctrlKey && event.shiftKey && event.key === "S") {
                event.preventDefault();
                void toggleScannerPanel().catch(logScannerLoadError);
            }
        });
    });
    await runBootstrapStep("scanner-load-symbol", "pre_restore", () => {
        window.addEventListener("scanner:load-symbol", ((event: CustomEvent<{ symbol: string }>) => {
            setCurrentSymbol(event.detail.symbol);
            void hideScannerPanel().catch(logScannerLoadError);
        }) as EventListener);
    });
    await runBootstrapStep("editor", "pre_restore", () => {
        editorManager.init(() => {
            uiManager.updateStrategyDropdown(state.currentStrategyKey);
        });
    });
    await runBootstrapStep("initial-ui-sync", "pre_restore", () => {
        uiManager.updateStrategyDropdown(state.currentStrategyKey);
        uiManager.updateStrategyParams(state.currentStrategyKey);
    });

    // pre_restore restore hook: saved-settings load happens after initial UI
    // sync and strategy library so the dropdown/params are populated before
    // the saved strategy/symbol/interval are applied.
    {
        const startedAt = nowMs();
        try {
            await restoreSavedSettings(context);
            try {
                debugLogger.event("app.bootstrap.feature_complete", {
                    id: "settings-state",
                    stage: "pre_restore",
                    handler: "restore",
                    durationMs: roundedDurationMs(startedAt),
                });
            } catch {
                // Bootstrap telemetry must never change bootstrap control flow.
            }
        } catch (error) {
            try {
                debugLogger.error("app.bootstrap.feature_failed", {
                    id: "settings-state",
                    stage: "pre_restore",
                    handler: "restore",
                    durationMs: roundedDurationMs(startedAt),
                    error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
                });
            } catch {
                // Bootstrap telemetry must never change bootstrap control flow.
            }
            throw error;
        }
    }

    // --- post_restore: settings handlers, autosave, initial data load ---
    await runBootstrapStep("settings-handlers", "post_restore", () => setupSettingsHandlers());
    await runBootstrapStep("settings-ux", "post_restore", () => initSettingsUX());
    await runBootstrapStep("form-accessibility", "post_restore", () => bindFormAccessibility(document));
    await runBootstrapStep("settings-autosave", "post_restore", () => settingsManager.setupAutoSave());
    await runBootstrapStep("initial-data-load", "post_restore", async () => {
        if (context.shouldLoadData) {
            markAppTiming("dataLoadStart");
            await dataManager.loadData();
            markAppTiming("dataLoadEnd");
        }
    });

    bindDirectLazyFeatureTriggers();
    attachTabLazyListener();
    const activeTabId = strategyPanelController.getActiveTabId();
    if (activeTabId) {
        window.dispatchEvent(new CustomEvent("strategy-panel:tab-change", {
            detail: { tabId: activeTabId },
        }));
    }
    markAppTiming("bootstrapReady");
    debugLogger.event("app.init.ready");
    logAppTimingSnapshot();
}

function registerLazyFeatures(): void {
    registerLazyFeature("debug-panel", async () => (await import("./debug-panel")).initDebugPanel());
    registerLazyFeature("quick-view", async () => (await import("./quick-view")).quickViewManager.init());
    registerLazyFeature("finder", async () => (await import("./finder-manager")).finderManager.init());
    registerLazyFeature("alerts", async () => (await import("./handlers/alert-handlers")).initAlertHandlers());
    registerLazyFeature("hunt", async () => (await import("./hunt/hunt-service")).huntService.init());
    registerLazyFeature("batch-backtest", async () => (await import("./batch-backtest/batch-backtest-service")).batchBacktestService.init());
    registerLazyFeature("ledger-sweep", async () => (await import("./batch-backtest/trade-ledger-sweep-service")).tradeLedgerSweepService.init());
    registerLazyFeature("selection-rules", async () => (await import("./selection-rules/service")).selectionRulesService.init());
    registerLazyFeature("rank-pairs", async () => (await import("./rank-pairs/rank-pairs-service")).rankPairsService.init());
    registerLazyFeature("data-mining", async () => (await import("./data-mining-manager")).dataMiningManager.init());
    registerLazyFeature("ibkr-data", async () => (await import("./ibkr-data/ibkr-data-service")).ibkrDataService.init());
    registerLazyFeature("crypto-data", async () => (await import("./crypto-data/crypto-data-service")).cryptoDataService.init());
    registerLazyFeature("walk-forward", async () => (await import("./walk-forward-service")).walkForwardService.initUI());
    registerLazyFeature("polymarket-panel", async () => (await import("./polymarket-panel-service")).polymarketPanelService.init());
    registerLazyFeature("execution-lab", async () => (await import("./execution-lab/execution-lab-service")).executionLabService.init());
    registerLazyFeature("monte-carlo", async () => (await import("./monte-carlo-service")).initMonteCarloService());
    registerLazyFeature("strategy-library-admin", async () => (await import("./strategy-library-admin-service")).strategyLibraryAdminService.init());
}

function bindDirectLazyFeatureTriggers(): void {
    const debugToggle = getOptionalElement<HTMLButtonElement>("debugToggle");
    if (debugToggle) {
        attachLazyFeatureTrigger<PointerEvent>({
            featureId: "debug-panel",
            target: debugToggle,
            eventName: "pointerdown",
            shouldActivate: () => !isLazyFeatureInitialized("debug-panel"),
        });
        attachLazyFeatureTrigger<KeyboardEvent>({
            featureId: "debug-panel",
            target: debugToggle,
            eventName: "keydown",
            shouldActivate: (event) =>
                !isLazyFeatureInitialized("debug-panel")
                && (event.key === "Enter" || event.key === " "),
        });
        attachLazyFeatureTrigger<KeyboardEvent>({
            featureId: "debug-panel",
            target: window,
            eventName: "keydown",
            shouldActivate: (event) =>
                !isLazyFeatureInitialized("debug-panel")
                && event.ctrlKey
                && event.shiftKey
                && event.key.toLowerCase() === "d",
            afterActivate: (event) => {
                event.preventDefault();
                debugToggle.click();
            },
        });
    }

    const quickViewButton = getOptionalElement<HTMLButtonElement>("quickViewBtn");
    if (quickViewButton) {
        attachLazyFeatureTrigger<PointerEvent>({
            featureId: "quick-view",
            target: quickViewButton,
            eventName: "pointerdown",
            shouldActivate: () => !isLazyFeatureInitialized("quick-view"),
        });
        attachLazyFeatureTrigger<KeyboardEvent>({
            featureId: "quick-view",
            target: quickViewButton,
            eventName: "keydown",
            shouldActivate: (event) =>
                !isLazyFeatureInitialized("quick-view")
                && (event.key === "Enter" || event.key === " "),
        });
    }

    const strategyLibraryMenu = getOptionalElement<HTMLDetailsElement>("strategyLibraryMenu");
    if (strategyLibraryMenu) {
        attachLazyFeatureTrigger<Event>({
            featureId: "strategy-library-admin",
            target: strategyLibraryMenu,
            eventName: "toggle",
            shouldActivate: () =>
                strategyLibraryMenu.open
                && !isLazyFeatureInitialized("strategy-library-admin"),
        });
    }
}
