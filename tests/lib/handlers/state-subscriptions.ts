import { state } from "../state";
import { timeKey } from "../strategies/backtest/backtest-utils";
import { debugLogger } from "../debug-logger";
import { uiManager } from "../ui-manager";
import { dataManager } from "../data-manager";
import { chartManager } from "../chart-manager";
import { backtestService } from "../backtest-service";
import { strategyRegistry } from "../../strategyRegistry";
import { paramManager } from "../param-manager";
import { getRequiredElement } from "../dom-utils";
import { SYMBOL_MAP } from "../constants";
import { clearAll } from "../app-actions";
import { formatPolymarketDisplayName } from "../dataProviders/polymarket";
import { livePositionsService } from "../live-positions-service";
import { isBinanceDataProvider } from "../binance-market";
import {
    SAME_EVENT_SUPPORTED_RANK_MODES,
    isPolymarketOneSecondSignalExitExecutionModel,
    isSameEventPolymarketExitMode,
} from "../polymarket-exit-mode";
import { resolvePolymarketDomSettings } from "../polymarket-dom-reader";
import { activateLazyFeature } from "../lazy-feature-init";
import {
    logBacktestResultUiFailure,
    runBacktestResultUiSteps,
} from "./backtest-result-ui-steps";
import {
    createStateSubscriptionsDom,
    getFinderPolymarketRankModeSelect,
    type StateSubscriptionsDom,
} from "./state-subscriptions-dom";
import type { Time } from "lightweight-charts";

function updatePolymarketEntryOffsetVisibility(dom: StateSubscriptionsDom, interval: string = state.currentInterval): void {
    const rows = dom.polymarketSettingsRows;
    const annotationToggle = dom.polymarketAnnotationToggle;
    const annotationEnabled = annotationToggle?.checked ?? false;
    const polymarketSettings = resolvePolymarketDomSettings();
    const isNative5mSession = polymarketSettings.outcomeInterval === '5m';
    const isOneSecondInterval = interval === '1s';
    const supportsLimitEntry = annotationEnabled && isNative5mSession;
    const limitEntryEnabled = supportsLimitEntry && polymarketSettings.postSignalLimitEntryEnabled;
    const usesFixedLimitEntry = polymarketSettings.postSignalLimitEntryMode === 'fixed_price';
    const usesSignalOffsetEntry = polymarketSettings.postSignalLimitEntryMode === 'signal_offset';
    const limitExitEnabled = limitEntryEnabled && polymarketSettings.postSignalLimitExitEnabled;
    const usesFixedLimitExit = polymarketSettings.postSignalLimitExitMode === 'fixed_price';
    const supportsSignalExit = interval === '1m'
        ? polymarketSettings.executionModel === 'next_open'
        : isOneSecondInterval && isPolymarketOneSecondSignalExitExecutionModel(polymarketSettings.executionModel);
    const isSameEventExit = supportsSignalExit
        && isSameEventPolymarketExitMode(polymarketSettings.exitMode);
    const usesActualEntryMinute = polymarketSettings.entrySelectionMode === 'actual_entry_minute';
    const showsEntryBridgeControls = interval === '1m' && isNative5mSession && annotationEnabled && !isSameEventExit;

    const visibilityRules: Array<[HTMLElement | null, boolean]> = [
        [rows.outcomeIntervalRow, annotationEnabled],
        [rows.entrySelectionModeRow, showsEntryBridgeControls],
        [rows.offsetRow, showsEntryBridgeControls && !usesActualEntryMinute],
        [rows.entryDelayBarsRow, annotationEnabled && isOneSecondInterval && supportsSignalExit],
        [rows.entryPriceFilterCentsRow, annotationEnabled],
        [rows.backtestSlippageCentsRow, annotationEnabled],
        [rows.protectionTakeProfitRow, annotationEnabled && isOneSecondInterval],
        [rows.protectionStopLossRow, annotationEnabled && isOneSecondInterval],
        [rows.exitModeRow, annotationEnabled],
        [rows.signalExitAllowMultipleTradesPerEventRow, annotationEnabled && isSameEventExit],
        [rows.postSignalLimitEntryEnabledRow, supportsLimitEntry],
        [rows.postSignalLimitEntryModeRow, limitEntryEnabled],
        [rows.postSignalLimitEntryPriceCentsRow, limitEntryEnabled && usesFixedLimitEntry],
        [rows.postSignalLimitEntryOffsetCentsRow, limitEntryEnabled && usesSignalOffsetEntry],
        [rows.postSignalLimitExitEnabledRow, limitEntryEnabled],
        [rows.postSignalLimitExitModeRow, limitExitEnabled],
        [rows.postSignalLimitExitPriceCentsRow, limitExitEnabled && usesFixedLimitExit],
        [rows.postSignalLimitExitOffsetCentsRow, limitExitEnabled && !usesFixedLimitExit],
        [rows.outcomeSymbolRow, annotationEnabled],
    ];
    for (const [row, visible] of visibilityRules) {
        if (row) row.style.display = visible ? 'block' : 'none';
    }

    const exitModeSelect = dom.polymarketExitModeSelect;
    const resolveHoldOption = exitModeSelect
        ? Array.from(exitModeSelect.options).find((option) => option.value === 'resolve_hold')
        : undefined;
    const signalExitOption = exitModeSelect
        ? Array.from(exitModeSelect.options).find((option) => option.value === 'signal_exit_same_event')
        : undefined;
    const chartExitOption = exitModeSelect
        ? Array.from(exitModeSelect.options).find((option) => option.value === 'chart_exit_same_event')
        : undefined;
    if (resolveHoldOption) {
        resolveHoldOption.disabled = false;
        resolveHoldOption.hidden = false;
    }
    if (signalExitOption) {
        signalExitOption.disabled = !supportsSignalExit;
    }
    if (chartExitOption) {
        chartExitOption.disabled = !supportsSignalExit;
    }
    if (exitModeSelect) {
        if (isSameEventPolymarketExitMode(exitModeSelect.value as any) && !supportsSignalExit) {
            exitModeSelect.value = 'resolve_hold';
        }
    }
    updateFinderRankModeOptions(dom);
}

function updateFinderRankModeOptions(dom: StateSubscriptionsDom): void {
    const isSameEventExit = isSameEventPolymarketExitMode(resolvePolymarketDomSettings().exitMode);
    const isOneSecondChart = state.currentInterval === "1s";

    const select = dom.finderPolymarketRankModeSelect;
    if (!select) {
        return;
    }

    for (const option of Array.from(select.options)) {
        if (!isSameEventExit || isOneSecondChart) {
            option.disabled = false;
            continue;
        }
        option.disabled = !SAME_EVENT_SUPPORTED_RANK_MODES.has(option.value as any);
    }
    if (isSameEventExit && select.selectedOptions[0]?.disabled) {
        const firstValid = Array.from(select.options).find(o => !o.disabled);
        if (firstValid) select.value = firstValid.value;
    }
}

export function setupStateSubscriptions() {
    const dom = createStateSubscriptionsDom();
    updatePolymarketEntryOffsetVisibility(dom);
    [
        { element: dom.polymarketAnnotationToggle, refreshRankModes: false },
        { element: dom.polymarketExitModeSelect, refreshRankModes: true },
        { element: dom.polymarketSignalExitAllowMultipleTradesToggle, refreshRankModes: false },
        { element: dom.polymarketEntrySelectionModeSelect, refreshRankModes: false },
        { element: dom.polymarketOutcomeIntervalSelect, refreshRankModes: true },
        { element: dom.polymarketPostSignalLimitEntryToggle, refreshRankModes: false },
        { element: dom.polymarketPostSignalLimitEntryModeSelect, refreshRankModes: false },
        { element: dom.polymarketPostSignalLimitExitToggle, refreshRankModes: false },
        { element: dom.polymarketPostSignalLimitExitModeSelect, refreshRankModes: false },
        { element: dom.executionModelSelect, refreshRankModes: true },
    ].forEach(({ element, refreshRankModes }) => {
        element?.addEventListener('change', () => {
            updatePolymarketEntryOffsetVisibility(dom);
            if (refreshRankModes) updateFinderRankModeOptions(dom);
        });
    });
    window.addEventListener("strategy-panel:tab-markup-loaded", ((event: CustomEvent<{ tabId?: string }>) => {
        if (event.detail?.tabId === 'finder') {
            dom.finderPolymarketRankModeSelect = getFinderPolymarketRankModeSelect();
            updateFinderRankModeOptions(dom);
        }
    }) as EventListener);

    updateFinderRankModeOptions(dom);

    const setPriceLoading = () => {
        const priceEl = getRequiredElement('symbolPrice');
        const changeEl = getRequiredElement('symbolChange');
        priceEl.textContent = 'Loading...';
        priceEl.className = 'symbol-price';
        changeEl.textContent = '--';
        changeEl.className = 'symbol-change';
        uiManager.updateSymbolDataSource(
            'Loading',
            'loading',
            'Loading chart data for the selected symbol and timeframe.'
        );
    };

    const applyDefaultVisibleRange = (dataLength: number) => {
        const visibleBars = Math.max(50, Math.min(1000, dataLength));
        state.chart.timeScale().setVisibleLogicalRange({
            from: Math.max(0, dataLength - visibleBars),
            to: dataLength,
        });
    };

    let lastDataLength = 0;

    let reloadTimeout: number | null = null;
    let deferredBacktestUiFrame: number | null = null;
    const isPanelVisible = (tabId: string) => {
        const panel = document.getElementById(`${tabId}Tab`) as HTMLElement | null;
        return Boolean(panel && !panel.hidden && panel.style.display !== 'none');
    };
    const jumpToTrade = (time: Time) => {
        const dataIndex = state.ohlcvData.findIndex(d => d.time === time);
        if (dataIndex !== -1) {
            const from = Math.max(0, dataIndex - 20);
            const to = Math.min(state.ohlcvData.length - 1, dataIndex + 20);
            state.chart.timeScale().setVisibleLogicalRange({ from, to });
        }
    };
    const renderTradesForCurrentState = async () => {
        const result = state.currentBacktestResult;
        if (!result) {
            uiManager.updateTradeBadge(0);
            return;
        }

        await uiManager.updateTradesList(result.trades, jumpToTrade);
    };
    const scheduleDataReload = () => {
        if (reloadTimeout !== null) {
            clearTimeout(reloadTimeout);
        }
        reloadTimeout = window.setTimeout(() => {
            reloadTimeout = null;
            if (dataManager.shouldSkipAutoReload()) {
                return;
            }
            setPriceLoading();
            clearAll();
            dataManager.loadData(state.currentSymbol, state.currentInterval);
        }, 0);
    };

    // Sync chart data
    state.subscribe('ohlcvData', (data) => {
        debugLogger.event('data.apply', {
            symbol: state.currentSymbol,
            interval: state.currentInterval,
            candles: data.length,
        });
        // Rebuild O(1) time→data index for crosshair hot-path
        const timeMap = new Map<string, import('../strategies/index').OHLCVData>();
        for (const candle of data) {
            timeMap.set(timeKey(candle.time), candle);
        }
        state._ohlcvTimeMap = timeMap;
        // Use chartManager to apply chart mode transformation (Heikin Ashi if enabled)
        chartManager.updateChartData();
        uiManager.updatePriceDisplay();
        livePositionsService.syncActiveChartPrice();

        getRequiredElement('dataPoints').textContent = `${data.length} candles`;
        const candlesInput = document.getElementById('visibleCandlesInput') as HTMLInputElement | null;
        if (candlesInput) {
            candlesInput.value = String(data.length);
        }
        getRequiredElement('lastUpdate').textContent = `Last update: ${new Date().toLocaleTimeString()}`;

        const timeScale = state.chart.timeScale();
        const prevLength = lastDataLength;
        lastDataLength = data.length;
        const isRealtimeUpdate = prevLength > 0 && Math.abs(data.length - prevLength) <= 2;
        if (isRealtimeUpdate) {
            const scrollPos = timeScale.scrollPosition();
            if (scrollPos <= 1) {
                timeScale.scrollToPosition(0, false);
            }
        } else {
            applyDefaultVisibleRange(data.length);
        }

        if (state.currentBacktestResult && state.currentBacktestResultSource === 'backtest') {
            void backtestService.runCurrentBacktest().catch((error) => {
                debugLogger.error('backtest.auto_refresh_failed', {
                    source: state.currentBacktestResultSource,
                    error: error instanceof Error ? error.message : String(error),
                });
            });
        }
    });

    // Sync backtest results
    state.subscribe('currentBacktestResult', (result) => {
        if (deferredBacktestUiFrame !== null) {
            cancelAnimationFrame(deferredBacktestUiFrame);
            deferredBacktestUiFrame = null;
        }


        if (result) {
            const strategy = strategyRegistry.get(state.currentStrategyKey);
            const params = strategy ? paramManager.getValues(strategy) : {};

            runBacktestResultUiSteps([
                {
                    step: "strategy_indicators",
                    run: () => backtestService.addStrategyIndicators(params),
                },
                {
                    step: "equity_curve",
                    run: () => chartManager.displayEquityCurve(result.equityCurve),
                },
                {
                    step: "results_panel",
                    run: () => uiManager.updateResultsUI(result),
                },
                {
                    step: "trades_panel",
                    run: () => {
                        if (isPanelVisible('trades')) {
                            void uiManager.updateTradesList(result.trades, jumpToTrade)
                                .catch((error) => logBacktestResultUiFailure("trades_list", error));
                        } else {
                            uiManager.updateTradeBadge(result.trades.length);
                        }
                    },
                },
            ]);

            deferredBacktestUiFrame = requestAnimationFrame(() => {
                deferredBacktestUiFrame = null;
                if (state.currentBacktestResult !== result) {
                    return;
                }

                runBacktestResultUiSteps([
                    {
                        step: "trade_markers",
                        run: () => chartManager.displayTradeMarkers(result.trades, uiManager.formatPrice),
                    },
                ]);
                void activateLazyFeature("quick-view")
                    .then(async () => {
                        if (state.currentBacktestResult !== result) {
                            return;
                        }

                        const { quickViewManager } = await import("../quick-view");
                        quickViewManager.setJumpToTrade(jumpToTrade);
                        return quickViewManager.onBacktestComplete(result);
                    })
                    .catch((error) => {
                        debugLogger.warn("quick_view.lazy_init_failed", {
                            error: error instanceof Error ? error.message : String(error),
                        });
                    });
            });
        }
    });

    window.addEventListener("strategy-panel:tab-change", ((event: CustomEvent<{ tabId?: string }>) => {
        if (event.detail?.tabId !== 'trades' || !state.currentBacktestResult) {
            return;
        }
        void renderTradesForCurrentState();
    }) as EventListener);
    livePositionsService.subscribe(() => {
        if (!state.currentBacktestResult || !isPanelVisible('trades')) {
            return;
        }

        if (
            state.currentBacktestResultSource !== 'backtest'
            || !isSameEventPolymarketExitMode(state.currentBacktestResult.polymarketTradeSummary?.evaluationMode)
        ) {
            return;
        }

        void renderTradesForCurrentState();
    });

    // Theme changes
    state.subscribe('isDarkTheme', (isDark) => {
        document.body.classList.toggle('light-theme', !isDark);
        chartManager.updateTheme();
        getRequiredElement('moonIcon').style.display = isDark ? 'block' : 'none';
        getRequiredElement('sunIcon').style.display = isDark ? 'none' : 'block';
    });

    // Symbol/Interval changes
    state.subscribe('currentSymbol', (symbol) => {
        debugLogger.event('state.currentSymbol', { symbol });

        // Get display name from map, or generate one for Binance pairs
        let displayName = SYMBOL_MAP[symbol];
        const polymarketLabel = formatPolymarketDisplayName(symbol);
        if (polymarketLabel) {
            displayName = polymarketLabel;
        }
        if (!displayName) {
            // For Binance pairs like BTCUSDT, format as BTC/USDT
            if (symbol.endsWith('USDT')) {
                displayName = `${symbol.slice(0, -4)}/USDT`;
            } else if (symbol.endsWith('BUSD')) {
                displayName = `${symbol.slice(0, -4)}/BUSD`;
            } else if (symbol.endsWith('BTC')) {
                displayName = `${symbol.slice(0, -3)}/BTC`;
            } else if (symbol.endsWith('ETH')) {
                displayName = `${symbol.slice(0, -3)}/ETH`;
            } else if (symbol.endsWith('BNB')) {
                displayName = `${symbol.slice(0, -3)}/BNB`;
            } else if (symbol.endsWith('+')) {
                const base = symbol.slice(0, -1);
                displayName = /^[A-Z]{6}$/.test(base)
                    ? `${base.slice(0, 3)}/${base.slice(3, 6)}`
                    : base;
            } else if (symbol.toUpperCase().endsWith('.S')) {
                displayName = symbol.slice(0, -2);
            } else {
                displayName = symbol;
            }
        }

        getRequiredElement('symbolName').textContent = displayName;
        scheduleDataReload();
    });

    state.subscribe('currentInterval', (interval) => {
        debugLogger.event('state.currentInterval', { interval });
        uiManager.updateTimeframeUI(interval);
        updatePolymarketEntryOffsetVisibility(dom, interval);
        updateFinderRankModeOptions(dom);
        scheduleDataReload();
    });

    state.subscribe('binanceMarketType', (binanceMarketType) => {
        debugLogger.event('state.binanceMarketType', { binanceMarketType });
        if (!isBinanceDataProvider(dataManager.getProvider(state.currentSymbol))) {
            return;
        }
        scheduleDataReload();
    });

    state.subscribe('mockChartModel', (mockChartModel) => {
        debugLogger.event('state.mockChartModel', { mockChartModel });
        if (!dataManager.isMockSymbol(state.currentSymbol)) return;
        scheduleDataReload();
    });

    state.subscribe('mockChartBars', (mockChartBars) => {
        debugLogger.event('state.mockChartBars', { mockChartBars });
        const input = document.getElementById('mockBarsInput') as HTMLInputElement | null;
        if (input) {
            input.value = String(mockChartBars);
        }
        if (!dataManager.isMockSymbol(state.currentSymbol)) return;
        scheduleDataReload();
    });

    // Chart mode changes (Candlestick / Heikin Ashi)
    state.subscribe('chartMode', (chartMode) => {
        debugLogger.event('state.chartMode', { chartMode });
        const toggle = dom.chartModeToggle;
        const label = dom.chartModeLabel;
        if (toggle) {
            const isHA = chartMode === 'heikin-ashi';
            toggle.classList.toggle('active', isHA);
            toggle.title = isHA ? 'Switch to Candlestick' : 'Switch to Heikin Ashi';
            if (label) label.textContent = isHA ? 'HA' : 'Candle';
        }
        if (state.ohlcvData.length > 0) {
            chartManager.updateChartData();
        }
    });

    // Strategy selection
    state.subscribe('currentStrategyKey', (key) => {
        uiManager.updateStrategyDropdown(key);
        uiManager.updateStrategyParams(key);
    });

}
