import assert from 'node:assert/strict';
import { afterEach, describe, it, type TestContext } from 'node:test';
import { setupSymbolSearch } from '../lib/handlers/symbol-search-handler';
import type { UiEventHandlersDom } from '../lib/handlers/ui-event-handlers-dom';
import { assetSearchService, type Asset } from '../lib/asset-search-service';
import { dataMiningManager } from '../lib/data-mining-manager';
import { dataManager } from '../lib/data-manager';
import { uiManager } from '../lib/ui-manager';
import { chartManager } from '../lib/chart-manager';
import { state } from '../lib/state';
import { getSyntheticPairMetadata, setSyntheticPairMetadata } from '../lib/synthetic-pair-session';
import { createFakeElement } from './helpers/fake-element';
import { parseIntervalSeconds } from '../lib/interval-utils';
import type { OHLCVData } from '../lib/types/index';

const originalDocument = Object.getOwnPropertyDescriptor(globalThis, 'document');
const originalState = {
    currentSymbol: state.currentSymbol, currentInterval: state.currentInterval,
    ohlcvData: state.ohlcvData, equitySeries: state.equitySeries,
    indicators: state.indicators, currentBacktestResult: state.currentBacktestResult,
};
afterEach(() => {
    Object.assign(state, originalState);
    setSyntheticPairMetadata(null);
    if (originalDocument) Object.defineProperty(globalThis, 'document', originalDocument);
    else Reflect.deleteProperty(globalThis, 'document');
});

async function harness(t: TestContext) {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    t.mock.method(state, 'subscribe', () => () => {});
    const input = Object.assign(createFakeElement(), { focus() {} });
    const dropdown = createFakeElement();
    dropdown.classList.add('active');
    const spinner = createFakeElement();
    const item = Object.assign(createFakeElement(), {
        dataset: {} as Record<string, string>,
        closest() { return this; },
        scrollIntoView() {},
    });
    let html = '';
    const results = Object.assign(createFakeElement(), {
        querySelectorAll: (selector?: string) => selector === '.symbol-search-item' && html ? [item] : [],
        insertAdjacentHTML(_position: string, markup: string) {
            html = markup;
            for (const [, key, value] of markup.matchAll(/data-([\w-]+)="([^"]*)"/g)) {
                item.dataset[key.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase())] = value;
            }
        },
    });
    Object.defineProperty(globalThis, 'document', { configurable: true, value: {
        addEventListener() {}, querySelectorAll: () => [], querySelector: () => null,
    } });
    const asset: Asset = {
        symbol: 'AAPL•+NVDA•', displayName: 'AAPL• / NVDA•', type: 'stock', provider: 'ibkr-local',
    };
    t.mock.method(assetSearchService, 'searchAssets', async () => [asset]);
    setupSymbolSearch({
        symbolSelector: createFakeElement(), symbolDropdown: dropdown,
        symbolSearchInput: input, symbolSearchResults: results, symbolSearchSpinner: spinner,
    } as unknown as UiEventHandlersDom);
    input.value = asset.symbol;
    input.dispatchEvent({ type: 'input', target: input });
    t.mock.timers.tick(250);
    await new Promise<void>(resolve => setImmediate(resolve));
    return { input, dropdown, spinner, results, item, html };
}

describe('Pair search synthetic selection', () => {
    for (const selection of ['click', 'keyboard'] as const) {
        it(`loads cached synthetic candles and metadata through ${selection}`, async t => {
            state.currentSymbol = 'ETHUSDT';
            state.currentInterval = selection === 'keyboard' ? '4h' : '1d';
            state.ohlcvData = [];
            state.equitySeries = { setData() {} } as unknown as typeof state.equitySeries;
            const times = selection === 'keyboard'
                ? [172800, 187200, 259200, 273600, 518400, 532800]
                : [172800];
            const bars: OHLCVData[] = times.map(time => ({
                time: time as OHLCVData['time'], open: 2, high: 3, low: 1, close: 2, volume: 10,
            }));
            t.mock.method(dataManager, 'getImportedData', (symbol: string, interval: string) => {
                assert.equal(symbol, 'AAPL•+NVDA•');
                assert.equal(interval, state.currentInterval);
                return bars;
            });
            const register = t.mock.method(dataManager, 'registerImportedData', () => {});
            const override = t.mock.method(dataManager, 'setProviderOverride', () => {});
            t.mock.method(dataManager, 'updateCacheEntryFor', () => {});
            t.mock.method(dataManager, 'stopStreaming', () => {});
            const suppress = t.mock.method(dataManager, 'suppressNextAutoReload', () => {});
            t.mock.method(chartManager, 'clearIndicators', () => {});
            t.mock.method(uiManager, 'clearUI', () => {});
            const { input, dropdown, results, item, html } = await harness(t);
            assert.ok(html.includes('Synthetic'));
            if (selection === 'click') {
                results.dispatchEvent({ type: 'click', target: item });
            } else {
                input.dispatchEvent({ type: 'keydown', key: 'ArrowDown', preventDefault() {} });
                input.dispatchEvent({ type: 'keydown', key: 'Enter', preventDefault() {} });
            }
            await new Promise<void>(resolve => setImmediate(resolve));
            assert.equal(state.currentSymbol, 'AAPL•+NVDA•');
            assert.strictEqual(state.ohlcvData, bars);
            assert.deepEqual(getSyntheticPairMetadata(), { baseSymbol: 'AAPL•', quoteSymbol: 'NVDA•' });
            assert.equal(register.mock.callCount(), 1);
            assert.equal(suppress.mock.callCount(), 1);
            assert.equal(override.mock.callCount(), 0, 'a synthetic pair must not be routed as a single IBKR ticker');
            assert.equal(dropdown.classList.contains('active'), false);
            assert.equal(input.value, '');
        });
    }

    for (const targetInterval of ['1d', '4h']) {
    it(`builds a fresh ${targetInterval} ratio with stock session gaps and rejects a coarser cache`, async t => {
        state.currentSymbol = 'ETHUSDT';
        state.currentInterval = targetInterval;
        state.ohlcvData = [];
        state.equitySeries = { setData() {} } as unknown as typeof state.equitySeries;
        t.mock.method(dataManager, 'getImportedData', () => targetInterval === '1d' ? null : [
            172800, 259200, 345600,
        ].map(time => ({ time: time as OHLCVData['time'], open: 99, high: 99, low: 99, close: 99, volume: 10 })));
        const fetch = t.mock.method(dataManager, 'fetchHistoricalData', async (symbol: string, interval: string) => {
            assert.ok(['AAPL•', 'NVDA•'].includes(symbol));
            const step = parseIntervalSeconds(interval)!;
            const price = symbol === 'AAPL•' ? 200 : 100;
            const sessionSeconds = targetInterval === '4h' ? 8 * 3600 : 86400;
            return [0, 1, 4].flatMap(day => Array.from({ length: sessionSeconds / step }, (_, i): OHLCVData => ({
                time: (172800 + day * 86400 + i * step) as OHLCVData['time'],
                open: price, high: price * 1.1, low: price * 0.9, close: price, volume: 10,
            })));
        });
        t.mock.method(dataManager, 'registerImportedData', () => {});
        t.mock.method(dataManager, 'updateCacheEntryFor', () => {});
        t.mock.method(dataManager, 'stopStreaming', () => {});
        t.mock.method(dataManager, 'suppressNextAutoReload', () => {});
        t.mock.method(chartManager, 'clearIndicators', () => {});
        t.mock.method(uiManager, 'clearUI', () => {});
        const { results, item } = await harness(t);
        results.dispatchEvent({ type: 'click', target: item });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(fetch.mock.callCount(), 2);
        assert.equal(state.currentSymbol, 'AAPL•+NVDA•');
        assert.equal(state.currentInterval, targetInterval);
        const expectedTimes = targetInterval === '4h'
            ? [172800, 187200, 259200, 273600, 518400, 532800]
            : [172800, 259200, 518400];
        assert.deepEqual(state.ohlcvData.map(bar => ({ time: bar.time, close: bar.close })),
            expectedTimes.map(time => ({ time, close: 2 })));
        assert.deepEqual(getSyntheticPairMetadata(), { baseSymbol: 'AAPL•', quoteSymbol: 'NVDA•' });
    });
    }

    it('leaves the current chart and query intact after a failed build, and allows retry', async t => {
        state.currentSymbol = 'ETHUSDT';
        const load = t.mock.method(dataMiningManager, 'regenerateSyntheticPair', async () => false);
        const { input, dropdown, spinner, results, item } = await harness(t);
        results.dispatchEvent({ type: 'click', target: item });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(state.currentSymbol, 'ETHUSDT');
        assert.equal(input.value, 'AAPL•+NVDA•');
        assert.equal(dropdown.classList.contains('active'), true);
        assert.equal(spinner.classList.contains('is-hidden'), true);
        results.dispatchEvent({ type: 'click', target: item });
        await new Promise<void>(resolve => setImmediate(resolve));
        assert.equal(load.mock.callCount(), 2);
    });
});
