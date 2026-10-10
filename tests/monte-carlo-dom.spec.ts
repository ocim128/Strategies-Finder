import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { it } from 'node:test';
import puppeteer from 'puppeteer';
import { MONTE_CARLO_REQUIRED_IDS } from '../lib/monte-carlo-dom';

it('Monte Carlo controls and results survive lazy tab extraction', async () => {
    const markup = readFileSync('html-partials/tab-monte-carlo.html', 'utf8');
    const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
    try {
        const page = await browser.newPage();
        const layout = await page.evaluate((html, ids) => {
            const template = document.createElement('template');
            template.innerHTML = html.trim();
            const loadedPanel = template.content.querySelector('#montecarloTab')!;
            const panel = document.createElement('div');
            panel.id = 'montecarloTab';
            // Match ensureStrategyPanelTabMarkup: only the root's children load.
            panel.replaceChildren(...Array.from(loadedPanel.childNodes));
            document.body.append(panel);
            const results = panel.querySelector<HTMLElement>('#mc-results')!;
            return {
                missing: ids.filter(id => !document.getElementById(id)),
                resultsOutsideContainer: Array.from(panel.querySelectorAll('[id]'))
                    .filter(el => /^mc-(risk-|dd-|method-|ci-|profit-|sharpe-|equity-|fan-|ruin-rate|expected-trades|median-trades)/.test(el.id))
                    .filter(el => !results.contains(el))
                    .map(el => el.id),
                resultsDisplay: getComputedStyle(results).display,
                emptyStateInsideResults: results.contains(panel.querySelector('#mc-empty-state')),
            };
        }, markup, [...MONTE_CARLO_REQUIRED_IDS]);
        assert.deepEqual(layout.missing, [], 'required elements must stay inside the lazy tab root');
        assert.deepEqual(layout.resultsOutsideContainer, [], 'result sections must share the results visibility container');
        assert.equal(layout.resultsDisplay, 'none');
        assert.equal(layout.emptyStateInsideResults, false);
    } finally {
        await browser.close();
    }
});
