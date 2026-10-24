import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { resolve, join } from 'node:path';
import type { Page } from 'puppeteer';
import { universeCandles } from './monte-carlo-universe-fixture';

/** Real lazy tab + real authorized routes + bundled worker, using local deterministic candles. */
export async function verifyMonteCarloUniverse(parent: Page): Promise<void> {
    const context = await parent.browser().createBrowserContext(), page = await context.newPage();
    const dir = resolve('price-data/ibkr/csv/1d'); await fs.mkdir(dir, { recursive: true });
    const files: string[] = [];
    try {
        for (const [index, symbol] of ['MCE2EBASE', 'MCE2EQUOTE'].entries()) {
            const file = join(dir, `${symbol}.csv`); files.push(file);
            await fs.writeFile(file, 'time,open,high,low,close,volume\n' + universeCandles(index === 1).map(b => [b.time, b.open, b.high, b.low, b.close, b.volume].join(',')).join('\n'));
        }
        await page.setViewport({ width: 1440, height: 1000 });
        await page.evaluateOnNewDocument(() => localStorage.setItem('playground_app_settings', JSON.stringify({ schema: 'settings.app', version: 1,
            data: { currentSymbol: 'MOCK_STOCK', currentInterval: '1d', currentStrategyKey: 'ema_confirmation' } })));
        await page.goto(parent.url(), { waitUntil: 'domcontentloaded' });
        await page.waitForSelector('#strategySelect');
        await page.select('#strategySelect', 'ema_confirmation');
        await page.waitForFunction(() => (window as any).__state?.currentStrategyKey === 'ema_confirmation' && !!document.getElementById('param_emaPeriod'));
        await page.evaluate(() => {
            const s = (window as any).__state; s.currentSymbol = 'MCE2EBASE\u2022'; s.currentInterval = '1d'; s.blockRange = null;
            s.set('currentBacktestResult', null);
            (document.getElementById('param_emaPeriod') as HTMLInputElement).value = '3';
            (document.getElementById('fixedTradeToggle') as HTMLInputElement).checked = true;
            (document.getElementById('tradeSizingMode') as HTMLSelectElement).value = 'fixed';
            (document.getElementById('fixedTradeAmount') as HTMLInputElement).value = '1000';
            (document.getElementById('tradeDirection') as HTMLSelectElement).value = 'combined';
        });
        await page.click('#panelMoreTrigger'); await page.click('#panelMoreMenu [data-tab="montecarlo"]');
        await page.waitForFunction(() => document.getElementById('mc-status')?.textContent === 'Please run a backtest first');
        await page.select('#mc-scope', 'universe');
        await page.waitForFunction(() => !(document.getElementById('mc-run-btn') as HTMLButtonElement).disabled && (document.getElementById('mc-chart-scope-container') as HTMLElement).hidden);
        await page.evaluate(() => {
            (document.getElementById('mc-universe-symbols') as HTMLTextAreaElement).value = 'MCE2EBASE\u2022\nMCE2EBASE\u2022+MCE2EQUOTE\u2022\nMCE2EBASE\u2022+MCE2EQUOTE\u2022@';
            (document.getElementById('mc-universe-paths') as HTMLInputElement).value = '250';
            (document.getElementById('mc-universe-minimum') as HTMLInputElement).value = '5';
        });
        const [response] = await Promise.all([page.waitForResponse(response => response.url().endsWith('/api/monte-carlo/universe/run')), page.click('#mc-run-btn')]);
        assert.equal(response.status(), 202, await response.text());
        const { runId } = await response.json();
        await page.waitForFunction(() => document.getElementById('mc-universe-summary')?.textContent?.includes('Complete (completed)'), { timeout: 20000 });
        assert.equal(await page.$$eval('#mc-universe-rows tr', rows => rows.length), 3);
        const inventory = await page.evaluate(async id => (await fetch(`/api/monte-carlo/universe/status?runId=${id}`)).json(), runId);
        assert.equal(inventory.counts.evaluated, 3, JSON.stringify(inventory.rows));
        assert.equal(inventory.configuration.simulation.initialCapital, 10000);
        await page.click('#mc-universe-rows button[data-detail="2"]');
        await page.waitForFunction(() => document.getElementById('mc-source-badge')?.textContent?.includes('Symbol Universe'), { timeout: 15000 });
        await page.evaluate(() => {
            const original = URL.createObjectURL;
            URL.createObjectURL = blob => { void (blob as Blob).text().then(text => { (window as any).__universeExport = text; }); return original(blob); };
        });
        await page.click('#mc-universe-json'); await page.waitForFunction(() => !!(window as any).__universeExport);
        const exported = await page.evaluate(() => JSON.parse((window as any).__universeExport));
        assert.equal(exported.rows.length, 3); assert.equal('replay' in exported.rows[0], false);
        const origin = new URL(page.url()).origin;
        await context.overridePermissions(origin, ['clipboard-read', 'clipboard-write', 'clipboard-sanitized-write']);
        await page.click('#mc-universe-csv');
        await page.waitForFunction(async () => (await navigator.clipboard.readText()).includes('MCE2EBASE'));
        await page.reload({ waitUntil: 'domcontentloaded' });
        await page.click('#panelMoreTrigger'); await page.click('#panelMoreMenu [data-tab="montecarlo"]');
        await page.waitForFunction(() => document.getElementById('mc-universe-summary')?.textContent?.includes('Complete (completed)'), { timeout: 15000 });
        assert.equal(await page.$eval('#mc-scope', el => (el as HTMLSelectElement).value), 'universe');
        // Gate worker bundle resolution in the browser capture path, then Stop before submission settles.
        await page.evaluate(async () => {
            const { uiManager } = await import(location.origin + '/lib/ui-manager.ts');
            const original = uiManager.waitForStrategySelection.bind(uiManager);
            uiManager.waitForStrategySelection = () => new Promise<void>(resolveSelection => {
                (window as any).__releaseUniverseSelection = () => { uiManager.waitForStrategySelection = original; resolveSelection(); };
            });
        });
        await page.click('#mc-run-btn'); await page.waitForFunction(() => !!(window as any).__releaseUniverseSelection);
        await Promise.all([page.waitForResponse(r => r.url().endsWith('/api/monte-carlo/universe/stop')), page.click('#mc-cancel-btn')]);
        await page.evaluate(() => (window as any).__releaseUniverseSelection());
        await page.waitForFunction(() => document.getElementById('mc-universe-summary')?.textContent?.includes('Partial (cancelled)'), { timeout: 15000 });
        assert.match(await page.$eval('#mc-universe-summary', el => el.textContent ?? ''), /not processed/);
        await page.setViewport({ width: 420, height: 900 });
        assert.equal(await page.$eval('.mc-universe-table-scroll', el => getComputedStyle(el).overflowX), 'auto');
        await page.select('#mc-scope', 'chart'); assert.equal(await page.$eval('#mc-chart-scope-container', el => (el as HTMLElement).hidden), false);
        console.log('Universe Monte Carlo: real mixed-instrument run, saved detail, exports, reload and pending Stop passed.');
    } catch (error) { console.error('Universe E2E failure:', error, await page.$eval('#mc-status', el => el.textContent).catch(() => 'no status')); throw error; }
    finally { await context.close(); for (const file of files) await fs.unlink(file); }
}
