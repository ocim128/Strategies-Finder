import { state } from "../state";
import { debugLogger } from "../debug-logger";
import { createUiEventHandlersDom } from "./ui-event-handlers-dom";

import { backtestService } from "../backtest-service";
import { clearAll } from "../app-actions";
import { uiManager } from "../ui-manager";
import { chartManager } from "../chart-manager";
import { dataManager } from "../data-manager";
import { strategyPanelController } from "../strategy-panel-controller";
import { parsePolymarketEventInput } from "../dataProviders/polymarket";
import { copyToClipboard } from "../browser-transfer";
import {
    setCurrentInterval,
    setDarkTheme,
    setCurrentStrategyKey,
} from "../state-actions";
import { loadBuiltInStrategyByKey } from "../../strategyRegistry";
import { setupSymbolSearch } from "./symbol-search-handler";
import { setupSettingsSections } from "./settings-section-handlers";

export function setupEventHandlers() {
    const dom = createUiEventHandlersDom();

    setupSymbolSearch(dom);
    setupSettingsSections(dom);

    // Timeframe tabs
    document.querySelectorAll('.timeframe-tab').forEach(tab => {
        tab.addEventListener('click', async (e) => {
            const currentTarget = e.currentTarget as HTMLElement;
            const interval = currentTarget.dataset.interval;
            const action = currentTarget.dataset.action;
            if (action === "polymarket") {
                if (dataManager.getProvider(state.currentSymbol) === "polymarket") {
                    debugLogger.event("ui.polymarket_picker.open", {
                        symbol: state.currentSymbol,
                        interval: state.currentInterval,
                    });
                    setCurrentInterval("1m");
                    return;
                }

                const rawInput = window.prompt("Enter a Polymarket event URL or slug to open the market.");
                if (rawInput === null) {
                    return;
                }

                const parsed = parsePolymarketEventInput(rawInput);
                if (!parsed) {
                    uiManager.showToast("Enter a valid Polymarket slug or event URL.", "error");
                    return;
                }

                debugLogger.event("ui.polymarket_picker.open", {
                    symbol: parsed.canonicalSymbol,
                });
                setCurrentInterval("1m");
                return;
            }

            if (!interval) return;
            debugLogger.event('ui.interval.select', { interval });
            setCurrentInterval(interval);
        });
    });

    const timeframeMinutesInput = dom.timeframeMinutesInput;
    const timeframeMinutesApply = dom.timeframeMinutesApply;
    const MAX_CUSTOM_MINUTES = 60 * 24 * 7;
    const visibleCandlesInput = dom.visibleCandlesInput;
    const visibleCandlesApply = dom.visibleCandlesApply;
    const MIN_VISIBLE_CANDLES = 200;
    const MAX_VISIBLE_CANDLES = 50000;

    const applyCustomMinutes = () => {
        if (!timeframeMinutesInput) return;
        const rawValue = timeframeMinutesInput.value.trim();
        const minutes = parseInt(rawValue, 10);

        if (!Number.isFinite(minutes)) {
            uiManager.showToast('Enter minutes between 1 and 10080.', 'error');
            return;
        }

        const clamped = Math.min(MAX_CUSTOM_MINUTES, Math.max(1, minutes));
        if (clamped !== minutes) {
            uiManager.showToast('Minutes must be between 1 and 10080.', 'error');
            timeframeMinutesInput.value = String(clamped);
        }

        const interval = `${clamped}m`;
        debugLogger.event('ui.interval.custom', { interval, minutes: clamped });
        setCurrentInterval(interval);
    };

    if (timeframeMinutesInput) {
        timeframeMinutesInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyCustomMinutes();
            }
        });
    }

    if (timeframeMinutesApply) {
        timeframeMinutesApply.addEventListener('click', applyCustomMinutes);
    }

    const applyVisibleCandles = async () => {
        if (!visibleCandlesInput) return;
        const raw = visibleCandlesInput.value.trim();
        const parsed = Number.parseInt(raw, 10);
        if (!Number.isFinite(parsed)) {
            uiManager.showToast(`Enter candles between ${MIN_VISIBLE_CANDLES} and ${MAX_VISIBLE_CANDLES}.`, 'error');
            const lookback = dataManager.getChartLookbackBars();
            visibleCandlesInput.value = String(lookback ?? Math.max(MIN_VISIBLE_CANDLES, state.ohlcvData.length || 15000));
            return;
        }

        const clamped = Math.max(MIN_VISIBLE_CANDLES, Math.min(MAX_VISIBLE_CANDLES, Math.floor(parsed)));
        if (clamped !== parsed) {
            uiManager.showToast(`Candles must be between ${MIN_VISIBLE_CANDLES} and ${MAX_VISIBLE_CANDLES}.`, 'error');
        }

        visibleCandlesInput.value = String(clamped);
        dataManager.setChartLookbackBars(clamped);
        await dataManager.loadData(state.currentSymbol, state.currentInterval);
        uiManager.showToast(`Reloaded with ${clamped} candles.`, 'success');
    };

    if (visibleCandlesInput) {
        const lookback = dataManager.getChartLookbackBars();
        visibleCandlesInput.value = String(lookback ?? Math.max(MIN_VISIBLE_CANDLES, state.ohlcvData.length || 15000));
        visibleCandlesInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                void applyVisibleCandles();
            }
        });
    }

    if (visibleCandlesApply) {
        visibleCandlesApply.addEventListener('click', () => {
            void applyVisibleCandles();
        });
    }

    // Theme toggle
    dom.themeToggle.addEventListener('click', () => {
        setDarkTheme(!state.isDarkTheme);
    });

    // Strategy selector
    const strategySelect = dom.strategySelect;
    strategySelect.addEventListener('change', async () => {
        const key = strategySelect.value;
        await loadBuiltInStrategyByKey(key);
        setCurrentStrategyKey(key);
    });

    let runBacktestEndpointPreviewBusy = false;
    let copyBacktestEndpointBusy = false;
    const syncBacktestEndpointState = () => {
        const canPreviewEndpoint = backtestService.canRunLatestUiBacktestEndpointPreview();
        const canCopyEndpoint = backtestService.canCopyLatestUiBacktestEndpointRequest();
        dom.runBacktestEndpointPreview.disabled = runBacktestEndpointPreviewBusy
            || copyBacktestEndpointBusy
            || !canPreviewEndpoint;
        dom.copyBacktestEndpoint.disabled = copyBacktestEndpointBusy
            || runBacktestEndpointPreviewBusy
            || !canCopyEndpoint;
    };

    dom.runBacktestEndpointPreview.addEventListener('click', async () => {
        runBacktestEndpointPreviewBusy = true;
        syncBacktestEndpointState();

        try {
            const preview = await backtestService.runLatestUiBacktestEndpointPreview();
            if (!preview) {
                uiManager.showToast(
                    'Run a regular backtest first, or switch back to the symbol/timeframe used by that backtest, before previewing the endpoint result.',
                    'error'
                );
                return;
            }

            debugLogger.event('ui.backtest_endpoint.preview', {
                strategy: preview.strategyKey,
                engineUsed: preview.engineUsed,
                matchesCurrentUiResult: preview.matchesCurrentUiResult,
                previousNetProfitPercent: preview.previousUiMetrics.netProfitPercent,
                endpointNetProfitPercent: preview.endpointMetrics.netProfitPercent,
                previousWinRate: preview.previousUiMetrics.winRate,
                endpointWinRate: preview.endpointMetrics.winRate,
            });

            const engineLabel = preview.engineUsed === 'rust' ? 'rust' : 'typescript';
            if (preview.matchesCurrentUiResult) {
                uiManager.showToast(
                    `Endpoint preview loaded (${engineLabel}) and matches the previous UI result.`,
                    'success'
                );
                return;
            }

            uiManager.showToast(
                `Endpoint preview loaded (${engineLabel}). Previous UI result differed: ${preview.previousUiMetrics.netProfitPercent.toFixed(2)}% / ${preview.previousUiMetrics.winRate.toFixed(1)}% vs endpoint ${preview.endpointMetrics.netProfitPercent.toFixed(2)}% / ${preview.endpointMetrics.winRate.toFixed(1)}%.`,
                'warning'
            );
        } catch (error) {
            debugLogger.error('ui.backtest_endpoint.preview_failed', {
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
            uiManager.showToast(
                error instanceof Error ? error.message : 'Failed to preview endpoint backtest.',
                'error'
            );
        } finally {
            runBacktestEndpointPreviewBusy = false;
            syncBacktestEndpointState();
        }
    });

    dom.copyBacktestEndpoint.addEventListener('click', async () => {
        copyBacktestEndpointBusy = true;
        syncBacktestEndpointState();

        try {
            const payload = await backtestService.buildLatestUiBacktestEndpointCopyBundle(window.location.origin);
            if (!payload) {
                uiManager.showToast(
                    'Run a regular backtest first, or switch back to the symbol/timeframe used by that backtest, before copying an endpoint request.',
                    'error'
                );
                return;
            }

            const copied = await copyToClipboard(JSON.stringify(payload.bundle.payload, null, 2));
            if (!copied) {
                uiManager.showToast('Failed to copy endpoint request.', 'error');
                return;
            }

            const engineModeLabel = payload.bundle.payload.context.engineMode === 'rust_preferred'
                ? 'rust_preferred'
                : 'typescript';
            const copyMode = payload.datasetUploaded
                ? 'payload_only_uploaded_dataset_ref'
                : 'payload_only_placeholder_dataset_ref';

            debugLogger.event('ui.backtest_endpoint.copy', {
                strategy: payload.strategyKey,
                symbol: payload.bundle.payload.symbol,
                interval: payload.bundle.payload.interval,
                engineMode: payload.bundle.payload.context.engineMode,
                uiCapitalMatchesEndpoint: payload.uiCapitalMatchesEndpoint,
                datasetRef: payload.datasetRef,
                candleCount: payload.candleCount,
                datasetUploaded: payload.datasetUploaded,
                datasetUploadError: payload.datasetUploadError,
                copyMode,
            });

            if (!payload.datasetUploaded) {
                uiManager.showToast(
                    `Endpoint JSON body copied with placeholder dataset.ref. ${payload.datasetUploadError ?? 'Start the Vite dev server and upload candles before running it.'}`,
                    'warning'
                );
                return;
            }

            if (payload.uiCapitalMatchesEndpoint) {
                uiManager.showToast(
                    `Endpoint JSON body copied (${engineModeLabel}) for POST /api/backtest/${payload.strategyKey}. datasetRef ${payload.datasetRef}.`,
                    'success'
                );
                return;
            }

            uiManager.showToast(
                `Endpoint JSON body copied for POST /api/backtest/${payload.strategyKey}. datasetRef ${payload.datasetRef}. UI capital still differs from the endpoint fixed $1000 / 0.1% profile.`,
                'info'
            );
        } catch (error) {
            debugLogger.error('ui.backtest_endpoint.copy_failed', {
                error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
            });
            uiManager.showToast(
                error instanceof Error ? error.message : 'Failed to prepare endpoint request.',
                'error'
            );
        } finally {
            copyBacktestEndpointBusy = false;
            syncBacktestEndpointState();
        }
    });

    // Run backtest button
    dom.runBacktest.addEventListener('click', () => backtestService.runCurrentBacktest());

    // Clear trades button
    dom.clearTradesBtn.addEventListener('click', clearAll);

    // Zoom controls
    dom.zoomInTool.addEventListener('click', () => {
        chartManager.zoomIn(0.7);
    });

    dom.zoomOutTool.addEventListener('click', () => {
        chartManager.zoomOut(1.4);
    });

    dom.fitTool.addEventListener('click', () => {
        state.chart.timeScale().fitContent();
        state.equityChart.timeScale().fitContent();
    });

    // Screenshot button
    const screenshotBtn = dom.screenshotTool;
    if (screenshotBtn) {
        screenshotBtn.addEventListener('click', async () => {
            try {
                const dataUrl = await chartManager.captureScreenshot();
                chartManager.downloadScreenshot(dataUrl);
                uiManager.showToast('Screenshot saved!', 'success');
            } catch (error) {
                debugLogger.error('ui.screenshot_failed', { error: error instanceof Error ? error.message : String(error) });
                uiManager.showToast('Screenshot failed - try again', 'error');
            }
        });
    }

    // Copy chart to clipboard button
    const copyChartBtn = dom.copyChartBtn;
    if (copyChartBtn) {
        copyChartBtn.addEventListener('click', async () => {
            try {
                const dataUrl = await chartManager.captureScreenshot();
                const success = await chartManager.copyScreenshotToClipboard(dataUrl);
                if (success) {
                    uiManager.showToast('Chart copied to clipboard!', 'success');
                } else {
                    uiManager.showToast('Copy failed - check browser permissions', 'error');
                }
            } catch (error) {
                debugLogger.error('ui.copy_failed', { error: error instanceof Error ? error.message : String(error) });
                uiManager.showToast('Copy failed - try again', 'error');
            }
        });
    }

    state.subscribe('currentBacktestResult', syncBacktestEndpointState);
    state.subscribe('currentSymbol', syncBacktestEndpointState);
    state.subscribe('currentInterval', syncBacktestEndpointState);
    state.subscribe('ohlcvData', syncBacktestEndpointState);
    syncBacktestEndpointState();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && e.ctrlKey) backtestService.runCurrentBacktest();

        if (e.altKey && e.key >= '1' && e.key <= '9') {
            e.preventDefault();
            const shortcut = e.key;
            if (strategyPanelController.switchToShortcut(shortcut)) {
                debugLogger.event('ui.shortcut.tab_switch', { shortcut });
            }
        }
    });

}
