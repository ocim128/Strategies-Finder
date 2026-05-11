import { state, type ChartMode, type MockChartModel } from "../state";
import { debugLogger } from "../debug-logger";
import { debounce } from "../debounce";
import { MAX_MOCK_BARS, MIN_MOCK_BARS } from "../dataProviders/mock";
import { dataManager } from "../data-manager";
import { assetSearchService, type Asset } from "../asset-search-service";
import {
    encodeLocalDailyAssetSelection,
    getLocalDailyAssets,
    parseLocalDailyAssetSelection,
    type LocalDailyAsset,
} from "../local-daily-datasets";
import { uiManager } from "../ui-manager";
import {
    getBinanceMarketTypeForProvider,
    isBinanceDataProvider,
    type BinanceMarketType,
} from "../binance-market";
import {
    setBinanceMarketType,
    setChartMode,
    setCurrentInterval,
    setCurrentSymbol,
    setMockChartBars,
    setMockChartModel,
} from "../state-actions";
import type { UiEventHandlersDom } from "./ui-event-handlers-dom";

export function setupSymbolSearch(dom: UiEventHandlersDom): void {
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
    const localDailyAssetBySelection = new Map<string, LocalDailyAsset>();
    const localDailySelectionBySymbol = new Map<string, string>();
    const getActiveBinanceMarketType = (): BinanceMarketType => state.binanceMarketType;
    const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

    const syncLocalDailyPicker = () => {
        if (!localSp500Select) return;
        const currentSymbol = state.currentSymbol.trim().toUpperCase();
        const selection = localDailySelectionBySymbol.get(currentSymbol);
        if (selection) {
            localSp500Select.value = selection;
            return;
        }
        localSp500Select.value = '';
    };

    const applyLocalDailySelection = (selectionValue: string) => {
        const parsed = parseLocalDailyAssetSelection(selectionValue);
        if (!parsed) return;

        const asset = localDailyAssetBySelection.get(selectionValue);
        const normalizedSymbol = parsed.symbol;
        dataManager.setProviderOverride(normalizedSymbol, asset?.provider ?? 'local-daily');
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
                'Reloading local daily seed data.'
            );
            void dataManager.loadData(normalizedSymbol, '1d');
        }

        debugLogger.event('ui.symbol.local_daily_select', {
            symbol: normalizedSymbol,
            dataset: parsed.dataset,
            interval: '1d',
        });
    };

    const initializeLocalDailyPicker = async () => {
        if (!localSp500Select) return;

        localSp500Select.disabled = true;
        localSp500Select.innerHTML = '<option value="">Loading local tickers...</option>';

        try {
            const assets = await getLocalDailyAssets();
            localDailyAssetBySelection.clear();
            localDailySelectionBySymbol.clear();
            localSp500Select.innerHTML = '';

            if (assets.length === 0) {
                localSp500Select.innerHTML = '<option value="">Local seed catalogs not found</option>';
                localSp500Select.disabled = true;
                return;
            }

            const placeholder = document.createElement('option');
            placeholder.value = '';
            placeholder.textContent = 'Pick local 1D seed...';
            localSp500Select.appendChild(placeholder);

            const groups = new Map<string, HTMLOptGroupElement>();
            assets.forEach((asset) => {
                const selection = encodeLocalDailyAssetSelection(asset);
                localDailyAssetBySelection.set(selection, asset);
                if (!localDailySelectionBySymbol.has(asset.symbol)) {
                    localDailySelectionBySymbol.set(asset.symbol, selection);
                }

                let group = groups.get(asset.dataset);
                if (!group) {
                    group = document.createElement('optgroup');
                    group.label = asset.datasetLabel;
                    groups.set(asset.dataset, group);
                    localSp500Select.appendChild(group);
                }

                const option = document.createElement('option');
                option.value = selection;
                option.textContent = `${asset.symbol} - ${asset.name}`;
                group.appendChild(option);
            });

            localSp500Select.disabled = false;
            syncLocalDailyPicker();
        } catch {
            localSp500Select.innerHTML = '<option value="">Failed to load local tickers</option>';
            localSp500Select.disabled = true;
        }
    };

    if (localSp500Select) {
        localSp500Select.addEventListener('change', () => {
            const selectionValue = localSp500Select.value.trim();
            if (!selectionValue) return;
            applyLocalDailySelection(selectionValue);
        });

        void initializeLocalDailyPicker();
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

    const renderSearchResults = (assets: Asset[], query: string = '') => {
        if (!symbolSearchResults) return;

        const existingItems = symbolSearchResults.querySelectorAll('.symbol-search-item, .symbol-search-results-header');
        existingItems.forEach(item => item.remove());

        symbolSearchLoading?.classList.add('is-hidden');
        symbolSearchEmpty?.classList.add('is-hidden');

        if (assets.length === 0) {
            symbolSearchEmpty?.classList.remove('is-hidden');
            return;
        }

        const headerText = query ? `Results for &quot;${esc(query)}&quot;` : 'Popular Assets';
        const html = `<div class="symbol-search-results-header">${headerText}</div>` +
            assets.map(asset => {
                const active = asset.symbol === state.currentSymbol ? ' active' : '';
                const bc = asset.type === 'crypto' ? 'crypto' : asset.type === 'stock' ? 'stock' : asset.type === 'forex' ? 'forex' : 'commodity';
                const icon = esc((asset.baseAsset?.substring(0, 3) || asset.symbol.substring(0, 3)));
                const bt = asset.provider === 'binance-futures' ? 'Futures' : asset.type === 'crypto' ? 'Crypto' : asset.type === 'stock' ? 'Stock' : asset.type === 'forex' ? 'Forex' : 'Commodity';
                return `<div class="symbol-search-item${active}" data-symbol="${esc(asset.symbol)}" data-provider="${esc(asset.provider)}" data-display-name="${esc(asset.displayName)}" role="button" tabindex="0"><div class="symbol-item-icon">${icon}</div><div class="symbol-item-details"><div class="symbol-item-name">${esc(asset.displayName)}<span class="symbol-item-badge ${bc}">${bt}</span></div><div class="symbol-item-pair">${esc(asset.symbol)}</div></div></div>`;
            }).join('');

        symbolSearchResults.insertAdjacentHTML('afterbegin', html);
        selectedIndex = -1;
    };

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
        if (provider === 'local-daily' && state.currentInterval !== '1d') {
            setCurrentInterval('1d');
        }

        document.querySelectorAll('.symbol-search-item, .dropdown-item').forEach(i => i.classList.remove('active'));
        const selectedItem = document.querySelector(`[data-symbol="${symbol}"]`);
        selectedItem?.classList.add('active');

        symbolDropdown.classList.remove('active');

        if (symbolSearchInput) {
            symbolSearchInput.value = '';
        }
        symbolSearchClear?.classList.add('is-hidden');

        if (symbol !== state.currentSymbol) {
            debugLogger.event('ui.symbol.select', { symbol, displayName, provider });
            setCurrentSymbol(symbol);
        } else if ((provider === 'bybit-tradfi' || provider === 'local-daily') && state.currentInterval === '1d') {
            syncLocalDailyPicker();
        }
    };

    const handleItemSelect = (el: HTMLElement) => {
        selectSymbol(el.dataset.symbol!, el.dataset.displayName, el.dataset.provider as Asset['provider'] | undefined);
    };
    symbolSearchResults?.addEventListener('click', (e) => {
        const item = (e.target as HTMLElement).closest('.symbol-search-item') as HTMLElement | null;
        if (item) handleItemSelect(item);
    });
    symbolSearchResults?.addEventListener('keydown', (e) => {
        if (e.key !== 'Enter' && e.key !== ' ') return;
        const item = (e.target as HTMLElement).closest('.symbol-search-item') as HTMLElement | null;
        if (!item) return;
        e.preventDefault();
        handleItemSelect(item);
    });

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

    symbolSelector.addEventListener('click', (e) => {
        e.stopPropagation();
        symbolDropdown.classList.toggle('active');

        if (symbolDropdown.classList.contains('active')) {
            initializeSearch();
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

    document.addEventListener('click', (e) => {
        if (!symbolDropdown.contains(e.target as Node) && !symbolSelector.contains(e.target as Node)) {
            symbolDropdown.classList.remove('active');
        }
    });

    if (symbolSearchInput) {
        symbolSearchInput.addEventListener('click', (e) => e.stopPropagation());

        symbolSearchInput.addEventListener('input', (e) => {
            const query = (e.target as HTMLInputElement).value;

            if (query) {
                symbolSearchClear?.classList.remove('is-hidden');
            } else {
                symbolSearchClear?.classList.add('is-hidden');
            }

            performSearch(query);
        });

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

    symbolSearchClear?.addEventListener('click', (e) => {
        e.stopPropagation();
        if (symbolSearchInput) {
            symbolSearchInput.value = '';
            symbolSearchInput.focus();
        }
        symbolSearchClear.classList.add('is-hidden');
        performSearch('');
    });

    const updateKeyboardSelection = (items: NodeListOf<Element>) => {
        items.forEach((item, index) => {
            item.classList.toggle('keyboard-focus', index === selectedIndex);
        });

        if (selectedIndex >= 0 && items[selectedIndex]) {
            (items[selectedIndex] as HTMLElement).scrollIntoView({ block: 'nearest' });
        }
    };

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

    if (localSp500Select) {
        state.subscribe('currentSymbol', () => {
            syncLocalDailyPicker();
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

    document.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') symbolDropdown.classList.remove('active');
    });
}
