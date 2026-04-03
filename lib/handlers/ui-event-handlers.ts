import { state, type ChartMode, type MockChartModel } from "../state";
import { debugLogger } from "../debug-logger";
import { debounce } from "../debounce";
import { MAX_MOCK_BARS, MIN_MOCK_BARS } from "../dataProviders/mock";
import { createUiEventHandlersDom } from "./ui-event-handlers-dom";

import { backtestService } from "../backtest-service";
import { clearAll } from "../app-actions";
import { uiManager } from "../ui-manager";
import { chartManager } from "../chart-manager";
import { dataManager } from "../data-manager";
import { assetSearchService, Asset } from "../asset-search-service";
import { getLocalSp500Assets } from "../local-sp500-catalog";
import { finderManager } from "../finder-manager";
import { scannerManager } from "../scanner/scanner-manager";
import { isTwoHourInterval } from "../interval-utils";
import { strategyPanelController } from "../strategy-panel-controller";
import { STRATEGY_PANEL_SETTINGS_SECTIONS } from "../strategy-panel-settings-registry";
import { parseInputNumber } from "../dom-input-readers";
import { parsePolymarketEventInput } from "../dataProviders/polymarket";
import { ADVANCED_SIZING_SUBSECTION_IDS } from "../advanced-sizing-dom";
import { TAKE_PROFIT_MODE_PANEL_IDS } from "../take-profit-dom";
import { getBinanceMarketTypeForProvider, isBinanceDataProvider, type BinanceMarketType } from "../binance-market";
import {
    setBinanceMarketType,
    setChartMode,
    setCurrentInterval,
    setCurrentStrategyKey,
    setCurrentSymbol,
    setDarkTheme,
    setMockChartBars,
    setMockChartModel,
    setStrategyTimeframeSettings,
    setTwoHourCloseParity,
} from "../state-actions";

export function setupEventHandlers() {
    const dom = createUiEventHandlersDom();

    // Symbol dropdown with search
    const symbolSelector = dom.symbolSelector;
    const symbolDropdown = dom.symbolDropdown;
    const binanceMarketTypeSelect = dom.binanceMarketTypeSelect;
    const symbolSearchInput = dom.symbolSearchInput;
    const symbolSearchResults = dom.symbolSearchResults;
    const symbolSearchSpinner = dom.symbolSearchSpinner;
    const symbolSearchClear = dom.symbolSearchClear;
    const symbolSearchLoading = dom.symbolSearchLoading;
    const symbolSearchEmpty = dom.symbolSearchEmpty;
    const localSp500Select = dom.localSp500Select;
    const mockModelSelect = dom.mockModelSelect;
    const mockBarsInput = dom.mockBarsInput;
    const chartModeToggle = dom.chartModeToggle;
    const chartModeLabel = dom.chartModeLabel;

    let isSearchInitialized = false;
    let selectedIndex = -1;
    const localSp500Symbols = new Set<string>();
    const getActiveBinanceMarketType = (): BinanceMarketType => state.binanceMarketType;

    const syncLocalSp500Picker = () => {
        if (!localSp500Select) return;
        const currentSymbol = state.currentSymbol.trim().toUpperCase();
        if (localSp500Symbols.has(currentSymbol)) {
            localSp500Select.value = currentSymbol;
            return;
        }
        localSp500Select.value = '';
    };

    const applyLocalSp500Symbol = (symbol: string) => {
        const normalizedSymbol = symbol.trim().toUpperCase();
        if (!normalizedSymbol) return;

        dataManager.setProviderOverride(normalizedSymbol, 'bybit-tradfi');
        symbolDropdown.classList.remove('active');

        const symbolChanged = normalizedSymbol !== state.currentSymbol;
        const intervalChanged = state.currentInterval !== '1d';

        if (intervalChanged) {
            setCurrentInterval('1d');
        }
        if (symbolChanged) {
            setCurrentSymbol(normalizedSymbol);
        }
        if (!symbolChanged && !intervalChanged) {
            uiManager.updateSymbolDataSource(
                'Loading',
                'loading',
                'Reloading local seed data and refreshing the latest Bybit candle.'
            );
            void dataManager.loadData(normalizedSymbol, '1d');
        }

        debugLogger.event('ui.symbol.local_sp500_select', { symbol: normalizedSymbol, interval: '1d' });
    };

    const initializeLocalSp500Picker = async () => {
        if (!localSp500Select) return;

        localSp500Select.disabled = true;
        localSp500Select.innerHTML = '<option value="">Loading local tickers...</option>';

        try {
            const assets = await getLocalSp500Assets();
            localSp500Symbols.clear();
            localSp500Select.innerHTML = '';

            if (assets.length === 0) {
                localSp500Select.innerHTML = '<option value="">Local S&P500 catalog not found</option>';
                localSp500Select.disabled = true;
                return;
            }

            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Pick local 1D seed...';
            localSp500Select.appendChild(placeholder);

            assets.forEach((asset) => {
                localSp500Symbols.add(asset.symbol);
                const option = document.createElement('option');
                option.value = asset.symbol;
                option.textContent = `${asset.symbol} - ${asset.name}`;
                localSp500Select.appendChild(option);
            });

            localSp500Select.disabled = false;
            syncLocalSp500Picker();
        } catch {
            localSp500Select.innerHTML = '<option value="">Failed to load local tickers</option>';
            localSp500Select.disabled = true;
        }
    };

    if (localSp500Select) {
        localSp500Select.addEventListener('change', () => {
            const selectedSymbol = localSp500Select.value.trim();
            if (!selectedSymbol) return;
            applyLocalSp500Symbol(selectedSymbol);
        });

        void initializeLocalSp500Picker();
    }

    if (mockModelSelect) {
        const allowedMockModels = new Set<MockChartModel>(['simple', 'hard', 'v3', 'v4', 'v5', 'v6']);
        mockModelSelect.value = state.mockChartModel;
        mockModelSelect.addEventListener('change', () => {
            const value = mockModelSelect.value;
            if (allowedMockModels.has(value as MockChartModel)) {
                setMockChartModel(value as MockChartModel);
            }
        });
    }

    // Chart mode toggle (Candlestick / Heikin Ashi)
    const syncChartModeToggle = () => {
        if (!chartModeToggle || !chartModeLabel) return;
        const isHA = state.chartMode === 'heikin-ashi';
        chartModeLabel.textContent = isHA ? 'HA' : 'Candle';
        chartModeToggle.classList.toggle('active', isHA);
        chartModeToggle.title = isHA ? 'Switch to Candlestick' : 'Switch to Heikin Ashi';
    };
    syncChartModeToggle();

    if (chartModeToggle) {
        chartModeToggle.addEventListener('click', () => {
            const newMode: ChartMode = state.chartMode === 'candlestick' ? 'heikin-ashi' : 'candlestick';
            debugLogger.event('ui.chartMode.toggle', { mode: newMode });
            setChartMode(newMode);
            syncChartModeToggle();
        });
    }

    if (mockBarsInput) {
        mockBarsInput.value = String(state.mockChartBars);

        const applyMockBars = () => {
            const rawValue = mockBarsInput.value.trim();
            const bars = parseInt(rawValue, 10);

            if (!Number.isFinite(bars)) {
                uiManager.showToast('Enter a valid mock candle count.', 'error');
                mockBarsInput.value = String(state.mockChartBars);
                return;
            }

            const clamped = Math.min(MAX_MOCK_BARS, Math.max(MIN_MOCK_BARS, Math.floor(bars)));
            if (clamped !== bars) {
                uiManager.showToast(`Mock candles must be between ${MIN_MOCK_BARS} and ${MAX_MOCK_BARS}.`, 'error');
            }

            mockBarsInput.value = String(clamped);
            if (clamped !== state.mockChartBars) {
                debugLogger.event('ui.mock.bars', { bars: clamped });
                setMockChartBars(clamped);
            }
        };

        mockBarsInput.addEventListener('change', applyMockBars);
        mockBarsInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter') {
                e.preventDefault();
                applyMockBars();
            }
        });
    }

    // Render search results
    const renderSearchResults = (assets: Asset[], query: string = '') => {
        if (!symbolSearchResults) return;

        // Clear existing results (except loading/empty states)
        const existingItems = symbolSearchResults.querySelectorAll('.symbol-search-item, .symbol-search-results-header');
        existingItems.forEach(item => item.remove());

        // Hide loading and empty states
        symbolSearchLoading?.classList.add('is-hidden');
        symbolSearchEmpty?.classList.add('is-hidden');

        if (assets.length === 0) {
            symbolSearchEmpty?.classList.remove('is-hidden');
            return;
        }

        // Add header
        const header = document.createElement('div');
        header.className = 'symbol-search-results-header';
        header.textContent = query ? `Results for "${query}"` : 'Popular Assets';
        symbolSearchResults.insertBefore(header, symbolSearchResults.firstChild);

        // Add result items
        assets.forEach((asset) => {
            const item = document.createElement('div');
            item.className = 'symbol-search-item';
            item.dataset.symbol = asset.symbol;
            item.dataset.provider = asset.provider;
            item.role = 'button';
            item.tabIndex = 0;

            // Mark active if current symbol matches
            if (asset.symbol === state.currentSymbol) {
                item.classList.add('active');
            }

            // Get badge class based on asset type
            const badgeClass = asset.type === 'crypto' ? 'crypto' :
                asset.type === 'stock' ? 'stock' :
                    asset.type === 'forex' ? 'forex' : 'commodity';

            // Get icon text (first 2-3 letters)
            const iconText = asset.baseAsset?.substring(0, 3) || asset.symbol.substring(0, 3);

            // Get badge text
            const badgeText = asset.provider === 'binance-futures' ? 'Futures' :
                asset.type === 'crypto' ? 'Crypto' :
                asset.type === 'stock' ? 'Stock' :
                    asset.type === 'forex' ? 'Forex' : 'Commodity';

            const icon = document.createElement('div');
            icon.className = 'symbol-item-icon';
            icon.textContent = iconText;

            const details = document.createElement('div');
            details.className = 'symbol-item-details';

            const name = document.createElement('div');
            name.className = 'symbol-item-name';
            name.textContent = asset.displayName;

            const badge = document.createElement('span');
            badge.className = `symbol-item-badge ${badgeClass}`;
            badge.textContent = badgeText;
            name.appendChild(badge);

            const pair = document.createElement('div');
            pair.className = 'symbol-item-pair';
            pair.textContent = asset.symbol;

            details.appendChild(name);
            details.appendChild(pair);
            item.appendChild(icon);
            item.appendChild(details);

            // Click handler
            item.addEventListener('click', () => selectSymbol(asset.symbol, asset.displayName, asset.provider));

            // Keyboard handler
            item.addEventListener('keydown', (e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    selectSymbol(asset.symbol, asset.displayName, asset.provider);
                }
            });

            symbolSearchResults.insertBefore(item, symbolSearchLoading);
        });

        selectedIndex = -1;
    };

    // Select symbol handler
    const selectSymbol = (symbol: string, displayName?: string, provider?: Asset['provider']) => {
        if (provider && isBinanceDataProvider(provider)) {
            const nextMarketType = getBinanceMarketTypeForProvider(provider);
            if (nextMarketType !== state.binanceMarketType) {
                setBinanceMarketType(nextMarketType);
            }
        }
        if (provider && provider !== 'mock') {
            dataManager.setProviderOverride(symbol, provider);
        }

        // Update UI
        document.querySelectorAll('.symbol-search-item, .dropdown-item').forEach(i => i.classList.remove('active'));
        const selectedItem = document.querySelector(`[data-symbol="${symbol}"]`);
        selectedItem?.classList.add('active');

        // Close dropdown
        symbolDropdown.classList.remove('active');

        // Clear search input
        if (symbolSearchInput) {
            symbolSearchInput.value = '';
        }
        symbolSearchClear?.classList.add('is-hidden');

        if (symbol !== state.currentSymbol) {
            debugLogger.event('ui.symbol.select', { symbol, displayName, provider });
            setCurrentSymbol(symbol);
        } else if (provider === 'bybit-tradfi' && state.currentInterval === '1d') {
            syncLocalSp500Picker();
        }
    };

    // Search function with debounce
    const performSearch = debounce(async (query: string) => {
        symbolSearchSpinner?.classList.remove('is-hidden');

        try {
            const results = await assetSearchService.searchAssets(query, 20, {
                binanceMarketType: getActiveBinanceMarketType(),
            });
            renderSearchResults(results, query);
        } catch (error) {
            debugLogger.error('ui.asset_search_failed', { error: error instanceof Error ? error.message : String(error) });
            symbolSearchEmpty?.classList.remove('is-hidden');
        } finally {
            symbolSearchSpinner?.classList.add('is-hidden');
        }
    }, 250);

    // Initialize search on first open
    const initializeSearch = async () => {
        if (isSearchInitialized) return;
        isSearchInitialized = true;

        symbolSearchLoading?.classList.remove('is-hidden');

        try {
            const popularAssets = await assetSearchService.searchAssets('', 20, {
                binanceMarketType: getActiveBinanceMarketType(),
            });
            renderSearchResults(popularAssets);
        } catch (error) {
            debugLogger.error('ui.asset_search_init_failed', { error: error instanceof Error ? error.message : String(error) });
        }
    };

    if (binanceMarketTypeSelect) {
        binanceMarketTypeSelect.value = state.binanceMarketType;
        binanceMarketTypeSelect.addEventListener('change', () => {
            const nextMarketType = binanceMarketTypeSelect.value === 'futures' ? 'futures' : 'spot';
            if (nextMarketType === state.binanceMarketType) {
                return;
            }
            setBinanceMarketType(nextMarketType);
            if (symbolDropdown.classList.contains('active')) {
                performSearch(symbolSearchInput?.value ?? '');
            }
        });
    }

    // Toggle dropdown
    symbolSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        symbolDropdown.classList.toggle('active');

        if (symbolDropdown.classList.contains('active')) {
            initializeSearch();
            // Focus search input when opening
            setTimeout(() => symbolSearchInput?.focus(), 50);
        }
    });

    symbolSelector.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            symbolDropdown.classList.toggle('active');
            if (symbolDropdown.classList.contains('active')) {
                initializeSearch();
                setTimeout(() => symbolSearchInput?.focus(), 50);
            }
        }
    });

    // Close dropdown when clicking outside
    document.addEventListener('click', (e) => {
        if (!symbolDropdown.contains(e.target as Node) && !symbolSelector.contains(e.target as Node)) {
            symbolDropdown.classList.remove('active');
        }
    });

    // Search input handlers
    if (symbolSearchInput) {
        // Prevent dropdown from closing when clicking in search
        symbolSearchInput.addEventListener('click', (e) => e.stopPropagation());

        symbolSearchInput.addEventListener('input', (e) => {
            const query = (e.target as HTMLInputElement).value;

            // Show/hide clear button
            if (query) {
                symbolSearchClear?.classList.remove('is-hidden');
            } else {
                symbolSearchClear?.classList.add('is-hidden');
            }

            performSearch(query);
        });

        // Keyboard navigation
        symbolSearchInput.addEventListener('keydown', (e) => {
            const items = symbolSearchResults?.querySelectorAll('.symbol-search-item');
            if (!items || items.length === 0) return;

            if (e.key === 'ArrowDown') {
                e.preventDefault();
                selectedIndex = Math.min(selectedIndex + 1, items.length - 1);
                updateKeyboardSelection(items as NodeListOf<Element>);
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                selectedIndex = Math.max(selectedIndex - 1, 0);
                updateKeyboardSelection(items as NodeListOf<Element>);
            } else if (e.key === 'Enter' && selectedIndex >= 0) {
                e.preventDefault();
                const selected = items[selectedIndex] as HTMLElement;
                if (selected) {
                    const symbol = selected.dataset.symbol!;
                    const displayName = selected.querySelector('.symbol-item-name')?.textContent?.trim();
                    const provider = selected.dataset.provider as Asset['provider'] | undefined;
                    selectSymbol(symbol, displayName, provider);
                }
            } else if (e.key === 'Escape') {
                symbolDropdown.classList.remove('active');
            }
        });
    }

    // Clear button handler
    symbolSearchClear?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (symbolSearchInput) {
            symbolSearchInput.value = '';
            symbolSearchInput.focus();
        }
        symbolSearchClear.classList.add('is-hidden');
        performSearch('');
    });

    // Update keyboard selection highlight
    const updateKeyboardSelection = (items: NodeListOf<Element>) => {
        items.forEach((item, index) => {
            item.classList.toggle('keyboard-focus', index === selectedIndex);
        });

        // Scroll selected item into view
        if (selectedIndex >= 0 && items[selectedIndex]) {
            (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
        }
    };

    // Handle clicks on static dropdown items (stocks, forex, etc.)
    document.querySelectorAll('#symbolDropdown .dropdown-item').forEach(item => {
        item.addEventListener('click', (e) => {
            e.stopPropagation();
            const target = e.currentTarget as HTMLElement;
            const symbol = target.dataset.symbol;
            if (!symbol) return;
            selectSymbol(symbol);
        });

        item.addEventListener('keydown', (e: Event) => {
            const keyboardEvent = e as KeyboardEvent;
            if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
                e.preventDefault();
                (item as HTMLElement).click();
            }
        });
    });

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
                setCurrentSymbol(parsed.canonicalSymbol);
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
    strategySelect.addEventListener('change', () => {
        setCurrentStrategyKey(strategySelect.value);
    });

    // Run backtest button
    dom.runBacktest.addEventListener('click', () => backtestService.runCurrentBacktest());

    // Clear trades button
    dom.clearTradesBtn.addEventListener('click', clearAll);

    // Zoom controls - using enhanced chartManager methods
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

    // Strategy section feature toggles
    const sectionFeatureBindings = {
        riskSettingsToggle: {
            toggle: dom.riskSettingsToggle,
            content: dom.riskSettings,
        },
        tradeFilterSettingsToggle: {
            toggle: dom.tradeFilterSettingsToggle,
            content: dom.tradeFilterSettings,
        },
    } as const;

    STRATEGY_PANEL_SETTINGS_SECTIONS.forEach((sectionDef) => {
        if (!sectionDef.featureToggleId || !sectionDef.featureContentId) {
            return;
        }

        const binding = sectionFeatureBindings[sectionDef.featureToggleId as keyof typeof sectionFeatureBindings];
        if (!binding) {
            return;
        }

        const applyState = () => {
            const enabled = binding.toggle.checked;
            binding.content.classList.toggle('is-hidden', !enabled);
            binding.content.toggleAttribute('inert', !enabled);
            binding.content.setAttribute('aria-hidden', enabled ? 'false' : 'true');
        };

        binding.toggle.addEventListener('change', applyState);
        applyState();
    });

    const setDisabledState = (
        inputs: ArrayLike<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
        enabled: boolean
    ) => {
        for (let i = 0; i < inputs.length; i++) {
            inputs[i].disabled = !enabled;
        }
    };

    const setGroupDisabledState = (groups: ArrayLike<HTMLElement>, enabled: boolean) => {
        for (let i = 0; i < groups.length; i++) {
            groups[i].classList.toggle('is-disabled', !enabled);
        }
    };

    const setSectionVisibility = (section: HTMLElement | null, visible: boolean) => {
        if (!section) {
            return;
        }
        section.classList.toggle('is-hidden', !visible);
    };

    const setInteractiveSectionState = (section: HTMLElement | null, enabled: boolean) => {
        if (!section) {
            return;
        }
        setSectionVisibility(section, enabled);
        setDisabledState(section.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>('input, select, textarea'), enabled);
        setGroupDisabledState(section.querySelectorAll<HTMLElement>('.param-group'), enabled);
    };

    const setInputGroupState = (
        inputs: ArrayLike<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>,
        enabled: boolean
    ) => {
        for (let i = 0; i < inputs.length; i++) {
            const input = inputs[i];
            input.disabled = !enabled;
            input.closest<HTMLElement>('.param-group')?.classList.toggle('is-disabled', !enabled);
        }
    };

    const riskModeSelect = dom.riskMode;
    const takeProfitModeSelect = dom.takeProfitMode;
    const riskSimpleAdvanced = dom.riskSimpleAdvanced;
    const riskPercentage = dom.riskPercentage;
    const riskAdvanced = dom.riskAdvanced;
    const riskAdvancedGroups = Array.from(riskAdvanced.querySelectorAll<HTMLElement>('.param-group'));
    const riskAdvancedInputs = Array.from(riskAdvanced.querySelectorAll<HTMLInputElement>('input'));

    const riskPercentageGroups = riskPercentage ? Array.from(riskPercentage.querySelectorAll<HTMLElement>('.param-group')) : [];
    const riskPercentageInputs = riskPercentage ? Array.from(riskPercentage.querySelectorAll<HTMLInputElement>('input')) : [];
    const riskPercentageSelects = riskPercentage ? Array.from(riskPercentage.querySelectorAll<HTMLSelectElement>('select')) : [];
    const takeProfitModePanels = riskPercentage
        ? Array.from(riskPercentage.querySelectorAll<HTMLElement>('[data-tp-mode-panel]'))
        : [];
    const sharedTakeProfitFieldIds = [
        'takeProfitAdaptiveLookbackTrades',
        'takeProfitAdaptiveRecentWindow',
        'takeProfitAdaptiveMinMultiplier',
        'takeProfitAdaptiveMaxMultiplier',
        'takeProfitAdaptiveGridSteps',
        'takeProfitAdaptiveRegimeBlend',
        'takeProfitAdaptiveIcScale',
    ] as const;
    const syncSharedTakeProfitFields = () => {
        if (!riskPercentage) return;
        sharedTakeProfitFieldIds.forEach((fieldId) => {
            const canonical = document.getElementById(fieldId) as HTMLInputElement | HTMLSelectElement | null;
            if (!canonical) return;
            const mirrors = riskPercentage.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-shared-tp-field="${fieldId}"]`);
            mirrors.forEach((mirror) => {
                mirror.value = canonical.value;
                mirror.disabled = canonical.disabled;
            });
        });
    };
    const bindSharedTakeProfitFieldMirrors = () => {
        if (!riskPercentage) return;
        sharedTakeProfitFieldIds.forEach((fieldId) => {
            const canonical = document.getElementById(fieldId) as HTMLInputElement | HTMLSelectElement | null;
            if (!canonical) return;
            riskPercentage.querySelectorAll<HTMLInputElement | HTMLSelectElement>(`[data-shared-tp-field="${fieldId}"]`).forEach((mirror) => {
                mirror.addEventListener('input', () => {
                    canonical.value = mirror.value;
                    canonical.dispatchEvent(new Event('input', { bubbles: true }));
                });
                mirror.addEventListener('change', () => {
                    canonical.value = mirror.value;
                    canonical.dispatchEvent(new Event('change', { bubbles: true }));
                });
            });
        });
        syncSharedTakeProfitFields();
    };

    const applyTakeProfitMode = () => {
        const mode = takeProfitModeSelect.value;
        const activePanelId = TAKE_PROFIT_MODE_PANEL_IDS[mode as keyof typeof TAKE_PROFIT_MODE_PANEL_IDS] ?? null;
        takeProfitModePanels.forEach((panel) => {
            const panelMode = panel.dataset.tpModePanel;
            const shouldShow = panelMode === mode && (mode === 'mfe_bootstrap' || panel.id === activePanelId);
            setInteractiveSectionState(panel, shouldShow);
        });
        syncSharedTakeProfitFields();
    };

    const applyRiskMode = () => {
        const mode = riskModeSelect.value;
        const isAdvanced = mode === 'advanced';
        const isPercentage = mode === 'percentage';
        const isSimpleOrAdvanced = mode === 'simple' || mode === 'advanced';

        if (riskSimpleAdvanced) {
            setSectionVisibility(riskSimpleAdvanced, isSimpleOrAdvanced);
        }
        if (riskPercentage) {
            setSectionVisibility(riskPercentage, isPercentage);
        }

        setSectionVisibility(riskAdvanced, isAdvanced);
        setGroupDisabledState(riskAdvancedGroups, isAdvanced);
        setDisabledState(riskAdvancedInputs, isAdvanced);

        setGroupDisabledState(riskPercentageGroups, isPercentage);
        setDisabledState(riskPercentageInputs, isPercentage);
        setDisabledState(riskPercentageSelects, isPercentage);

        if (isPercentage) {
            applyTakeProfitMode();
        } else {
            takeProfitModePanels.forEach((panel) => {
                setInteractiveSectionState(panel, false);
            });
        }
    };

    riskModeSelect.addEventListener('change', applyRiskMode);
    takeProfitModeSelect.addEventListener('change', applyTakeProfitMode);
    bindSharedTakeProfitFieldMirrors();
    applyRiskMode();

    const tradeDirectionSelect = dom.tradeDirection;
    const flipLossStreakSettingsRow = dom.flipLossStreakSettingsRow;
    const flipLossStreakInputs = [
        dom.flipAfterConsecutiveLosses,
        dom.flipCooldownTrades,
        dom.minTradesBeforeFirstFlip,
    ];

    const applyTradeDirectionMode = () => {
        const isFlipLossMode = tradeDirectionSelect.value === 'both_flip_loss_2';
        setSectionVisibility(flipLossStreakSettingsRow, isFlipLossMode);
        setInputGroupState(flipLossStreakInputs, isFlipLossMode);
    };

    tradeDirectionSelect.addEventListener('change', applyTradeDirectionMode);
    applyTradeDirectionMode();

    const tradeFilterModeSelect = dom.tradeFilterMode;
    const tradeFilterFieldConfig: Array<{ inputId: string; modes: string[] }> = [
        { inputId: 'htfBiasEmaPeriod', modes: ['trend_htf_bias'] },
        { inputId: 'executionTrendEmaPeriod', modes: ['trend_exec_alignment'] },
        { inputId: 'confirmLookback', modes: ['close', 'trend', 'htf_drift'] },
        { inputId: 'volumeSmaPeriod', modes: ['volume'] },
        { inputId: 'volumeMultiplier', modes: ['volume'] },
        { inputId: 'confirmRsiPeriod', modes: ['rsi'] },
        { inputId: 'confirmRsiBullish', modes: ['rsi'] },
        { inputId: 'confirmRsiBearish', modes: ['rsi'] },
    ];
    const tradeFilterFields = tradeFilterFieldConfig.map(({ inputId, modes }) => {
        const inputMap: Record<string, HTMLInputElement> = {
            htfBiasEmaPeriod: dom.htfBiasEmaPeriod,
            executionTrendEmaPeriod: dom.executionTrendEmaPeriod,
            confirmLookback: dom.confirmLookback,
            volumeSmaPeriod: dom.volumeSmaPeriod,
            volumeMultiplier: dom.volumeMultiplier,
            confirmRsiPeriod: dom.confirmRsiPeriod,
            confirmRsiBullish: dom.confirmRsiBullish,
            confirmRsiBearish: dom.confirmRsiBearish,
        };
        const input = inputMap[inputId];
        const group = input.closest<HTMLElement>('.param-group');
        if (!group) {
            throw new Error(`Trade filter input #${inputId} must be inside .param-group`);
        }
        return { input, group, modes };
    });
    const tradeFilterRows = Array.from(
        new Set(
            tradeFilterFields
                .map(({ group }) => group.closest<HTMLElement>('.param-row'))
                .filter((row): row is HTMLElement => Boolean(row))
        )
    );

    const applyTradeFilterMode = () => {
        const mode = tradeFilterModeSelect.value;

        tradeFilterFields.forEach(({ input, group, modes }) => {
            const isRelevant = modes.includes(mode);
            group.classList.toggle('is-hidden', !isRelevant);
            setGroupDisabledState([group], isRelevant);
            setDisabledState([input], isRelevant);
        });

        tradeFilterRows.forEach((row) => {
            const hasVisibleGroup = Array.from(row.querySelectorAll<HTMLElement>('.param-group'))
                .some((group) => !group.classList.contains('is-hidden'));
            row.classList.toggle('is-hidden', !hasVisibleGroup);
        });
    };

    tradeFilterModeSelect.addEventListener('change', applyTradeFilterMode);
    applyTradeFilterMode();

    // Snapshot entry filter toggle → enable/disable sibling min/max inputs
    const snapshotFiltersBody = document.getElementById('snapshotFiltersBody');
    if (snapshotFiltersBody) {
        const applySnapshotToggleState = (toggle: HTMLInputElement) => {
            const row = toggle.closest('.snapshot-filter-row');
            if (!row) return;
            const inputs = row.querySelectorAll<HTMLInputElement>('input[type="number"]');
            for (let i = 0; i < inputs.length; i++) {
                inputs[i].disabled = !toggle.checked;
            }
        };

        const snapshotToggles = snapshotFiltersBody.querySelectorAll<HTMLInputElement>('.snapshot-filter-toggle');
        snapshotToggles.forEach((toggle) => {
            toggle.addEventListener('change', () => applySnapshotToggleState(toggle));
            applySnapshotToggleState(toggle);
        });
    }

    const strategyTimeframeToggle = dom.strategyTimeframeToggle;
    const strategyTimeframeMinutes = dom.strategyTimeframeMinutes;
    const strategyTimeframeMinutesGroup = dom.strategyTimeframeMinutesGroup;
    const syncStrategyTimeframeState = () => {
        const parsedMinutes = parseInputNumber(strategyTimeframeMinutes.value);
        setStrategyTimeframeSettings({
            enabled: strategyTimeframeToggle.checked,
            minutes: typeof parsedMinutes === 'number' && Number.isFinite(parsedMinutes)
                ? Math.max(1, Math.floor(parsedMinutes))
                : 120,
        });
    };

    const applyStrategyTimeframeMode = () => {
        const enabled = strategyTimeframeToggle.checked;
        strategyTimeframeMinutes.disabled = !enabled;
        if (strategyTimeframeMinutesGroup) {
            strategyTimeframeMinutesGroup.classList.toggle('is-disabled', !enabled);
        }
        syncStrategyTimeframeState();
    };

    strategyTimeframeToggle.addEventListener('change', applyStrategyTimeframeMode);
    strategyTimeframeMinutes.addEventListener('input', syncStrategyTimeframeState);
    strategyTimeframeMinutes.addEventListener('change', syncStrategyTimeframeState);
    applyStrategyTimeframeMode();

    const twoHourCloseParity = dom.twoHourCloseParity;
    if (twoHourCloseParity) {
        const parityHint = twoHourCloseParity.parentElement?.querySelector('.param-hint') as HTMLElement | null;
        const defaultParityHint = parityHint?.textContent ?? '';
        const applyParityAvailability = () => {
            const currentIntervalIsTwoHour = isTwoHourInterval(state.currentInterval);
            twoHourCloseParity.disabled = !currentIntervalIsTwoHour;
            twoHourCloseParity.parentElement?.classList.toggle('is-disabled', !currentIntervalIsTwoHour);
            if (parityHint) {
                parityHint.textContent = currentIntervalIsTwoHour
                    ? defaultParityHint
                    : 'Available only on 2H interval.';
            }
        };

        const resolveParityMode = (value: string): 'odd' | 'even' | 'both' => {
            if (value === 'even' || value === 'both') return value;
            return 'odd';
        };
        const syncParityState = () => {
            setTwoHourCloseParity(resolveParityMode(twoHourCloseParity.value));
        };

        let lastAppliedParity: 'odd' | 'even' | 'both' = resolveParityMode(twoHourCloseParity.value);
        twoHourCloseParity.addEventListener('change', () => {
            const nextParity: 'odd' | 'even' | 'both' = resolveParityMode(twoHourCloseParity.value);
            syncParityState();
            if (!isTwoHourInterval(state.currentInterval)) {
                lastAppliedParity = nextParity;
                return;
            }
            if (nextParity === lastAppliedParity) {
                return;
            }

            lastAppliedParity = nextParity;
            finderManager.clearTimeframeCache();
            scannerManager.clearCache();
            debugLogger.event('ui.settings.2h_close_parity', { parity: nextParity });

            // During startup/config bootstrap, settings can be applied before data is loaded.
            if (state.ohlcvData.length === 0) {
                return;
            }

            if (nextParity === 'both') {
                uiManager.showToast('2H parity compare mode enabled (odd + even). Run backtest to view both results.', 'info');
                return;
            }

            void dataManager.loadData(state.currentSymbol, state.currentInterval).then(() => {
                uiManager.showToast(`2H close parity set to ${nextParity}. Data reloaded.`, 'info');
            }).catch((error) => {
                debugLogger.error('ui.parity_reload_failed', { error: error instanceof Error ? error.message : String(error) });
                uiManager.showToast('Failed to reload data for new 2H parity.', 'error');
            });
        });

        state.subscribe('currentInterval', () => {
            applyParityAvailability();
        });
        applyParityAvailability();
        syncParityState();
    }

    if (localSp500Select) {
        state.subscribe('currentSymbol', () => {
            syncLocalSp500Picker();
        });
    }

    state.subscribe('binanceMarketType', (marketType) => {
        if (binanceMarketTypeSelect && binanceMarketTypeSelect.value !== marketType) {
            binanceMarketTypeSelect.value = marketType;
        }
        if (symbolDropdown.classList.contains('active')) {
            performSearch(symbolSearchInput?.value ?? '');
        }
    });

    // Finder settings toggles
    const finderTradesToggle = dom.finderTradesToggle;
    const finderTradeFilters = dom.finderTradeFilters;
    const applyFinderTradeFilterState = () => {
        finderTradeFilters.classList.toggle('disabled', !finderTradesToggle.checked);
    };

    finderTradesToggle.addEventListener('change', applyFinderTradeFilterState);
    applyFinderTradeFilterState();

    // Trade sizing mode toggle
    const fixedTradeToggle = dom.fixedTradeToggle;
    const initialCapitalGroup = dom.initialCapitalGroup;
    const fixedTradeGroup = dom.fixedTradeGroup;
    const tradeSizingModeGroup = dom.tradeSizingModeGroup;
    const positionSizeGroup = dom.positionSizeGroup;
    const initialCapitalInput = dom.initialCapital;
    const tradeSizingModeInput = dom.tradeSizingMode;
    const fixedTradeAmountInput = dom.fixedTradeAmount;
    const positionSizeInput = dom.positionSize;
    const advancedSizingPanel = dom.advancedSizingSettingsPanel;
    const martingaleBaseSizeInput = dom.martingaleBaseSize;
    const advancedSizingSubsections = [
        dom.kellySettings,
        dom.volatilityTargetingSettings,
        dom.riskParitySettings,
        dom.martingaleSettings,
        dom.optimalFSettings,
    ];

    const applyTradeSizingMode = () => {
        const useAlternativeSizing = fixedTradeToggle.checked;
        const selectedMode = useAlternativeSizing ? tradeSizingModeInput.value : 'percent';
        const usesDirectFractionSizing = selectedMode === 'kelly_criterion'
            || selectedMode === 'optimal_f'
            || selectedMode === 'secure_f';
        const usesPercentBase = useAlternativeSizing
            && (selectedMode === 'martingale' || selectedMode === 'anti_martingale')
            && martingaleBaseSizeInput.value === 'percent';

        initialCapitalGroup.classList.toggle('is-hidden', false);
        fixedTradeGroup.classList.toggle('is-hidden', !useAlternativeSizing || usesDirectFractionSizing || usesPercentBase);
        tradeSizingModeGroup.classList.toggle('is-hidden', !useAlternativeSizing);
        positionSizeGroup.classList.toggle('is-hidden', useAlternativeSizing && !usesPercentBase);

        initialCapitalInput.disabled = false;
        tradeSizingModeInput.disabled = !useAlternativeSizing;
        fixedTradeAmountInput.disabled = !useAlternativeSizing || usesDirectFractionSizing || usesPercentBase;
        positionSizeInput.disabled = useAlternativeSizing && !usesPercentBase;

        const activeSubsectionId = ADVANCED_SIZING_SUBSECTION_IDS[selectedMode as keyof typeof ADVANCED_SIZING_SUBSECTION_IDS];
        const hasAdvancedPanel = useAlternativeSizing && Boolean(activeSubsectionId);
        advancedSizingPanel.classList.toggle('is-hidden', !hasAdvancedPanel);

        advancedSizingSubsections.forEach((section) => {
            section.classList.toggle('is-hidden', !hasAdvancedPanel || section.id !== activeSubsectionId);
        });
    };

    fixedTradeToggle.addEventListener('change', applyTradeSizingMode);
    tradeSizingModeInput.addEventListener('change', applyTradeSizingMode);
    martingaleBaseSizeInput.addEventListener('change', applyTradeSizingMode);
    applyTradeSizingMode();

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') symbolDropdown.classList.remove('active');
        if (e.key === 'Enter' && e.ctrlKey) backtestService.runCurrentBacktest();

        // Alt + 1-9 for tab switching (uses data-shortcut attribute)
        if (e.altKey && e.key >= '1' && e.key <= '9') {
            e.preventDefault();
            const shortcut = e.key;
            if (strategyPanelController.switchToShortcut(shortcut)) {
                debugLogger.event('ui.shortcut.tab_switch', { shortcut });
            }
        }
    });

}
