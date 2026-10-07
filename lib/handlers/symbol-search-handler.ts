import { state, type ChartMode } from "../state";
import { debugLogger } from "../debug-logger";
import { debounce } from "../debounce";
import { MAX_MOCK_BARS, MIN_MOCK_BARS } from "../dataProviders/mock";
import { dataManager } from "../data-manager";
import { assetSearchService, type Asset } from "../asset-search-service";
import { uiManager } from "../ui-manager";
import { escapeHtml } from "../html-escape";
import { parseSyntheticPairToken } from "../synthetic-pair-token";
import {
    getBinanceMarketTypeForProvider,
    isBinanceDataProvider,
    type BinanceMarketType,
} from "../binance-market";
import {
    setBinanceMarketType,
    setChartMode,
    setCurrentSymbol,
    setMockChartBars,
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
    const mockBarsInput = dom.mockBarsInput;
    const chartModeToggle = dom.chartModeToggle;
    const chartModeLabel = dom.chartModeLabel;

    let isSearchInitialized = false;
    let selectedIndex = -1;
    const getActiveBinanceMarketType = (): BinanceMarketType => state.binanceMarketType;
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

        const headerText = query ? `Results for &quot;${escapeHtml(query)}&quot;` : 'Popular Assets';
        const html = `<div class="symbol-search-results-header">${headerText}</div>` +
            assets.map(asset => {
                const active = asset.symbol === state.currentSymbol ? ' active' : '';
                const bc = asset.type === 'crypto' ? 'crypto' : asset.type === 'stock' ? 'stock' : asset.type === 'forex' ? 'forex' : 'commodity';
                const icon = escapeHtml((asset.baseAsset?.substring(0, 3) || asset.symbol.substring(0, 3)));
                const bt = parseSyntheticPairToken(asset.symbol) ? 'Synthetic' : asset.provider === 'binance-futures' ? 'Futures' : asset.type === 'crypto' ? 'Crypto' : asset.type === 'stock' ? 'Stock' : asset.type === 'forex' ? 'Forex' : 'Commodity';
                return `<div class="symbol-search-item${active}" data-symbol="${escapeHtml(asset.symbol)}" data-provider="${escapeHtml(asset.provider)}" data-display-name="${escapeHtml(asset.displayName)}" role="button" tabindex="0"><div class="symbol-item-icon">${icon}</div><div class="symbol-item-details"><div class="symbol-item-name">${escapeHtml(asset.displayName)}<span class="symbol-item-badge ${bc}">${bt}</span></div><div class="symbol-item-pair">${escapeHtml(asset.symbol)}</div></div></div>`;
            }).join('');

        symbolSearchResults.insertAdjacentHTML('afterbegin', html);
        selectedIndex = -1;
    };

    let isSelectingSynthetic = false;
    const selectSymbol = async (symbol: string, displayName?: string, provider?: Asset['provider']) => {
        if (isSelectingSynthetic) return;
        const syntheticPair = parseSyntheticPairToken(symbol);
        if (syntheticPair) {
            isSelectingSynthetic = true;
            symbolSearchSpinner?.classList.remove('is-hidden');
            try {
                // Reuse the Data Mining loader so ratio construction, imported
                // caches, and saved configuration metadata stay consistent.
                const { dataMiningManager } = await import('../data-mining-manager');
                const loaded = await dataMiningManager.regenerateSyntheticPair(
                    syntheticPair.baseSymbol, syntheticPair.quoteSymbol, state.currentInterval,
                );
                if (!loaded) return;
                debugLogger.event('ui.symbol.select', { symbol, displayName, provider, syntheticPair });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                debugLogger.error('ui.synthetic_pair_load_failed', { symbol, error: message });
                uiManager.showToast(`Synthetic pair failed: ${message}`, 'error');
                return;
            } finally {
                isSelectingSynthetic = false;
                symbolSearchSpinner?.classList.add('is-hidden');
            }
            symbolDropdown.classList.remove('active');
            if (symbolSearchInput) symbolSearchInput.value = '';
            symbolSearchClear?.classList.add('is-hidden');
            return;
        }
        if (provider && isBinanceDataProvider(provider)) {
            const nextMarketType = getBinanceMarketTypeForProvider(provider);
            if (nextMarketType !== state.binanceMarketType) {
                setBinanceMarketType(nextMarketType);
            }
        }
        if (provider && provider !== 'mock') {
            dataManager.setProviderOverride(symbol, provider);
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
        }
    };

    const handleItemSelect = (el: HTMLElement) => {
        void selectSymbol(el.dataset.symbol!, el.dataset.displayName, el.dataset.provider as Asset['provider'] | undefined);
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

    // Search fan-out resolves out of order across providers; only the newest
    // query may render, or a slow broad-query response overwrites fresh results.
    let searchSequence = 0;
    const performSearch = debounce(async (query: string) => {
        const runId = ++searchSequence;
        symbolSearchSpinner?.classList.remove('is-hidden');

        try {
            const results = await assetSearchService.searchAssets(query, 20, {
                binanceMarketType: getActiveBinanceMarketType(),
            });
            if (runId !== searchSequence) return;
            renderSearchResults(results, query);
        } catch (error) {
            if (runId !== searchSequence) return;
            debugLogger.error('ui.asset_search_failed', { error: error instanceof Error ? error.message : String(error) });
            symbolSearchEmpty?.classList.remove('is-hidden');
        } finally {
            if (runId === searchSequence) {
                symbolSearchSpinner?.classList.add('is-hidden');
            }
        }
    }, 250);

    const initializeSearch = async () => {
        if (isSearchInitialized) return;
        isSearchInitialized = true;

        // The popular-assets fetch races performSearch when the user opens the
        // dropdown and types before it resolves; only the newest request may
        // render, so the initial fill obeys the same sequence guard.
        const runId = ++searchSequence;
        symbolSearchLoading?.classList.remove('is-hidden');

        try {
            const popularAssets = await assetSearchService.searchAssets('', 20, {
                binanceMarketType: getActiveBinanceMarketType(),
            });
            if (runId !== searchSequence) return;
            renderSearchResults(popularAssets);
        } catch (error) {
            if (runId !== searchSequence) return;
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
                    void selectSymbol(symbol, displayName, provider);
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
            void selectSymbol(symbol);
        });

        item.addEventListener('keydown', (e: Event) => {
            const keyboardEvent = e as KeyboardEvent;
            if (keyboardEvent.key === 'Enter' || keyboardEvent.key === ' ') {
                e.preventDefault();
                (item as HTMLElement).click();
            }
        });
    });

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
