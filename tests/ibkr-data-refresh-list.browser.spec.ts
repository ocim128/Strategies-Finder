import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { IbkrDataService } from '../lib/ibkr-data/ibkr-data-service';
import { IBKR_DATA_REQUIRED_IDS, type IbkrDataDom } from '../lib/ibkr-data/ibkr-data-dom';
import { createFakeElement } from './helpers/fake-element';

const originalFetch = globalThis.fetch;
const drain = () => new Promise<void>(resolve => setImmediate(resolve));
type FakeElement = ReturnType<typeof createFakeElement>;
type FakeDom = Record<(typeof IBKR_DATA_REQUIRED_IDS)[number], FakeElement>;
let dom: FakeDom;
let urls: string[];
let result: Response | Promise<Response>;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

beforeEach(async () => {
    dom = Object.fromEntries(IBKR_DATA_REQUIRED_IDS.map(id => [id, createFakeElement()])) as FakeDom;
    dom.ibkrDataSymbols.value = 'MY\nEXISTING\nLIST';
    dom.ibkrDataSource.value = 'ibkr';
    dom.ibkrDataPeriod.value = '4d';
    dom.ibkrDataInterval.value = '30m';
    urls = [];
    result = json({ ok: true, interval: '30m', candidates: [
        { symbol: 'LOVE', reason: 'missing_adjustment_history' },
        { symbol: 'LPCN', reason: 'missing_adjustment_history' },
    ] });
    globalThis.fetch = async (input, init) => {
        const url = String(input);
        if (url.includes('/sync/status')) return json({ running: false });
        urls.push(url);
        assert.notEqual(init?.method, 'POST', 'loading a list must not start a download');
        return result;
    };
    new IbkrDataService(dom as unknown as IbkrDataDom).init();
    await drain();
});
afterEach(() => { globalThis.fetch = originalFetch; });

describe('Alpaca refresh-list UI', () => {
    it('loads affected symbols and prepares an explicit max download', async () => {
        assert.equal(dom.ibkrDataAlpacaRefreshBtn.click(), true);
        assert.equal(dom.ibkrDataAlpacaRefreshBtn.disabled, true);
        await drain();
        assert.deepEqual(urls, ['/api/ibkr/alpaca-refresh-symbols?interval=30m']);
        assert.equal(dom.ibkrDataSymbols.value, 'LOVE\nLPCN');
        assert.equal(dom.ibkrDataSource.value, 'alpaca');
        assert.equal(dom.ibkrDataPeriod.value, 'max');
        assert.equal(dom.ibkrDataInterval.value, '30m');
        assert.match(dom.ibkrDataStatus.textContent, /Loaded 2.*Click Download CSV/);
        assert.match(dom.ibkrDataOutput.textContent, /LOVE: Missing adjustment history/);
        assert.equal(dom.ibkrDataAlpacaRefreshBtn.disabled, false);
        assert.equal(dom.ibkrDataDownloadBtn.disabled, false);
    });

    it('preserves the current inputs when no symbols need refreshing', async () => {
        result = json({ ok: true, interval: '30m', candidates: [] });
        dom.ibkrDataAlpacaRefreshBtn.click();
        await drain();
        assert.equal(dom.ibkrDataSymbols.value, 'MY\nEXISTING\nLIST');
        assert.equal(dom.ibkrDataSource.value, 'ibkr');
        assert.equal(dom.ibkrDataPeriod.value, '4d');
        assert.match(dom.ibkrDataStatus.textContent, /No Alpaca 30m stocks/);
    });

    it('preserves inputs and unlocks controls on an API failure', async () => {
        result = json({ ok: false, error: 'Unavailable' }, 500);
        dom.ibkrDataAlpacaRefreshBtn.click();
        await drain();
        assert.equal(dom.ibkrDataSymbols.value, 'MY\nEXISTING\nLIST');
        assert.equal(dom.ibkrDataPeriod.value, '4d');
        assert.equal(dom.ibkrDataSource.value, 'ibkr');
        assert.match(dom.ibkrDataStatus.textContent, /Unavailable/);
        assert.equal(dom.ibkrDataAlpacaRefreshBtn.disabled, false);
    });

    it('requires an Alpaca-supported timeframe before scanning', async () => {
        dom.ibkrDataInterval.value = '4h';
        dom.ibkrDataAlpacaRefreshBtn.click();
        await drain();
        assert.equal(urls.length, 0);
        assert.match(dom.ibkrDataStatus.textContent, /Choose 30m or 1d/);
    });

    it('ignores a list if the timeframe changes while the scan is pending', async () => {
        let resolve!: (response: Response) => void;
        const response = result as Response;
        result = new Promise<Response>(release => { resolve = release; });
        dom.ibkrDataAlpacaRefreshBtn.click();
        dom.ibkrDataInterval.value = '1d';
        resolve(response);
        await drain();
        assert.equal(dom.ibkrDataSymbols.value, 'MY\nEXISTING\nLIST');
        assert.match(dom.ibkrDataStatus.textContent, /Timeframe changed/);
    });
});
