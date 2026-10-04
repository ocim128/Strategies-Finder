import puppeteer, { Page } from 'puppeteer';
import { spawn, spawnSync, type ChildProcess } from 'child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

const requireFromHere = createRequire(import.meta.url);
const vitePackagePath = requireFromHere.resolve('vite/package.json');
const viteCliPath = path.join(path.dirname(vitePackagePath), 'bin', 'vite.js');

// Helper to wait
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

console.log('Script starting...');

function stopProcessTree(child: ChildProcess): void {
    if (!child.pid) return;
    if (process.platform === 'win32') {
        const result = spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
        if (result.error) {
            try {
                child.kill();
            } catch {
                // ignore cleanup errors
            }
        }
        return;
    }
    try {
        child.kill('SIGTERM');
    } catch {
        // ignore cleanup errors
    }
}

type DebugEntry = {
    ts: number;
    level: string;
    message: string;
    data?: any;
};

type DebugSnapshot = {
    state: null | {
        currentSymbol: string;
        currentInterval: string;
        ohlcv: number;
        indicators: number;
        backtest: boolean;
    };
    logs: DebugEntry[];
};

const waitForCondition = async (page: Page, fn: () => boolean, timeoutMs: number, label: string) => {
    try {
        await page.waitForFunction(fn, { timeout: timeoutMs });
    } catch (error) {
        await logDebugSnapshot(page, label);
        throw new Error(`Timeout waiting for ${label}`);
    }
};

const getDebugSnapshot = async (page: Page): Promise<DebugSnapshot> => {
    return page.evaluate(() => {
        const state = (window as any).__state;
        const debug = (window as any).__debug;
        return {
            state: state ? {
                currentSymbol: state.currentSymbol,
                currentInterval: state.currentInterval,
                ohlcv: Array.isArray(state.ohlcvData) ? state.ohlcvData.length : 0,
                indicators: Array.isArray(state.indicators) ? state.indicators.length : 0,
                backtest: Boolean(state.currentBacktestResult),
            } : null,
            logs: debug && typeof debug.getEntries === 'function' ? debug.getEntries() : [],
        };
    });
};

const logDebugSnapshot = async (page: Page, label: string) => {
    try {
        const snapshot = await getDebugSnapshot(page);
        const logs = snapshot.logs.slice(-50);
        console.log(`[Debug Snapshot] ${label}`);
        console.log(JSON.stringify({ ...snapshot, logs }, null, 2));
    } catch (error) {
        console.warn(`Failed to capture debug snapshot: ${error}`);
    }
};

const assertNoDebugErrors = async (page: Page, errors: string[]) => {
    const snapshot = await getDebugSnapshot(page);
    const debugErrors = snapshot.logs.filter(entry => {
        if (entry.level !== 'error') return false;
        if (entry.message === 'data.stream.error' && (entry.data as { error?: string } | undefined)?.error === '[object Event]') {
            // Benign websocket teardown event while switching symbol/interval.
            return false;
        }
        return true;
    });
    if (debugErrors.length > 0) {
        errors.push(`Debug errors detected: ${debugErrors.map(entry => entry.message).join(', ')}`);
    }
};

const verifyLayout = async (page: Page): Promise<string[]> => {
    return page.evaluate(() => {
        const issues: string[] = [];

        // Targeted check for critical scroll containers
        const containers = [
            '.panel-content',
            '.trades-list',
            '.finder-list',
            '.debug-log',
            '.modal-body'
        ];

        for (const selector of containers) {
            const el = document.querySelector(selector) as HTMLElement;
            if (el) {
                const style = window.getComputedStyle(el);
                const isOverflowing = el.scrollHeight > el.clientHeight + 2; // 2px tolerance
                const isScrollable = style.overflowY === 'auto' || style.overflowY === 'scroll';

                if (isOverflowing && !isScrollable) {
                    issues.push(`Element "${selector}" content is clipped (scrollHeight: ${el.scrollHeight}, clientHeight: ${el.clientHeight}) but overflow-y is "${style.overflowY}".`);
                }
            }
        }

        // 2. Check for unexpected element sizes (Aesthetic breakage)
        const sizeChecks = [
        ];

        for (const check of sizeChecks) {
            const el = document.querySelector(check.selector) as HTMLElement;
            if (el) {
                const height = el.offsetHeight;
                if (height > check.maxHeight) {
                    issues.push(`${check.label} is too large (Current height: ${height}px, Max expected: ${check.maxHeight}px).`);
                }
            }
        }

        return issues;
    });
};

const verifySettingsWorkspace = async (page: Page): Promise<void> => {
    await page.click('.panel-tab[data-tab="settings"]');
    await page.waitForSelector('#settingsSearch', { visible: true });
    await page.evaluate(() => {
        const header = document.getElementById('strategyWorkspaceHeader')!;
        const sections = document.getElementById('strategyWorkspaceSections')!;
        if (sections.getBoundingClientRect().left < header.getBoundingClientRect().right) throw new Error('Wide Settings panel did not split into columns');
        if (document.querySelectorAll('#strategyWorkspaceSections > .settings-section').length !== 6) throw new Error('Settings sections escaped their container');
        if (!document.getElementById('settingsConfigStatus')!.textContent!.includes('TestConfig · Matches saved setup')) throw new Error('Saved configuration was not tracked');
        (document.querySelector('[data-preset="simple"]') as HTMLButtonElement).click();
    });
    await page.type('#settingsSearch', 'slippage');
    await page.evaluate(() => {
        if (document.querySelector('#settingsSearchResults button')!.textContent!.includes('inactive')) throw new Error('A collapsed control was marked inactive');
    });
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'slippageBps');
    await page.evaluate(() => {
        if (document.getElementById('settingsTab')!.dataset.preset !== 'standard') throw new Error('Search did not reveal a Standard section');
        const header = document.querySelector('[data-target="realismBody"]')!;
        if (header.getAttribute('aria-expanded') !== 'true') throw new Error('Search did not open the execution accordion');
        (document.getElementById('slippageBps') as HTMLInputElement).value = '17';
        document.getElementById('slippageBps')!.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('settingsSaveStatus')!.dataset.state === 'pending');
    await page.waitForFunction(() => document.getElementById('settingsSaveStatus')!.dataset.state === 'saved');
    await page.evaluate(() => {
        if (!document.querySelector('[data-settings-summary="realism"]')!.textContent!.includes('17 bps')) throw new Error('Live section summary missed slippage edit');
        if (!document.getElementById('settingsConfigStatus')!.textContent!.includes('Modified')) throw new Error('Configuration drift was not shown');
        const saved = JSON.parse(localStorage.getItem('playground_strategy_configs')!).data.find((config: any) => config.name === 'TestConfig');
        if (saved.backtestSettings.slippageBps === 17) throw new Error('Autosave overwrote the named configuration');
        (document.getElementById('slippageBps') as HTMLInputElement).value = String(saved.backtestSettings.slippageBps);
        document.getElementById('slippageBps')!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await page.waitForFunction(() => document.getElementById('settingsConfigStatus')!.textContent!.includes('Matches saved setup'));
    await page.evaluate(() => {
        const input = document.querySelector<HTMLInputElement>('#strategyParams input[type="number"]')!;
        input.value = String(Number(input.value) + 1);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        (document.getElementById('configSelect') as HTMLSelectElement).value = '';
    });
    await page.waitForFunction(() => !((document.getElementById('restoreSettingsConfigBtn') as HTMLButtonElement).disabled));
    await page.click('#restoreSettingsConfigBtn');
    await page.waitForFunction(() => document.getElementById('settingsConfigStatus')!.textContent!.includes('Matches saved setup'));
    await page.waitForFunction(() => document.getElementById('settingsSaveStatus')!.dataset.state === 'saved');
    await page.evaluate(() => {
        const manager = (window as any).__settingsManager;
        const saved = manager.loadStrategyConfig('TestConfig');
        for (const [key, value] of Object.entries(saved.strategyParams)) {
            const control = document.getElementById(`param_${key}`) as HTMLInputElement;
            if (Number(control.value) !== value) throw new Error(`Restore missed strategy parameter ${key}`);
        }
        if (manager.getBacktestSettings().slippageBps !== saved.backtestSettings.slippageBps) throw new Error('Restore missed execution settings');
        (document.getElementById('riskSettingsToggle') as HTMLInputElement).checked = false;
        document.getElementById('riskSettingsToggle')!.dispatchEvent(new Event('change', { bubbles: true }));
        const search = document.getElementById('settingsSearch') as HTMLInputElement;
        search.value = 'ATR Period'; search.dispatchEvent(new Event('input', { bubbles: true }));
        document.querySelector<HTMLButtonElement>('#settingsSearchResults button')!.click();
        if ((document.getElementById('riskSettingsToggle') as HTMLInputElement).checked) throw new Error('Searching enabled a risk feature');
        if (document.activeElement !== document.querySelector('[data-target="riskSectionBody"]')) throw new Error('Inactive result did not focus its section');
        search.value = ''; search.dispatchEvent(new Event('input', { bubbles: true }));
        const panel = document.querySelector<HTMLElement>('.panel-content')!;
        panel.scrollTop = 0;
    });
    await page.waitForFunction(() => document.getElementById('settingsSaveStatus')!.dataset.state === 'saved');
    await page.screenshot({ path: 'artifacts/settings-workspace-desktop.png', fullPage: true });
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => {
        const workspace = document.querySelector<HTMLElement>('#settingsTab .strategy-workspace')!;
        const panel = document.querySelector<HTMLElement>('.panel-content')!;
        if (getComputedStyle(workspace).gridTemplateColumns.split(' ').length !== 1) throw new Error('Narrow Settings panel did not stack');
        if (panel.scrollWidth > panel.clientWidth) throw new Error('Narrow Settings panel overflowed horizontally');
        (document.querySelector('#settingsQuickNav button[aria-controls="directionBody"]') as HTMLButtonElement).click();
        if (document.querySelector('[data-target="directionBody"]')!.getAttribute('aria-expanded') !== 'true') throw new Error('Quick navigation did not open Direction');
    });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(() => { document.querySelector<HTMLElement>('.panel-content')!.scrollTop = 0; });
    console.log('Settings layout, search, autosave feedback, configuration drift and restore passed.');
};

const verifyRankingCards = async (page: Page): Promise<void> => {
    let replayRequests = 0;
    const observe = (request: { url(): string }) => {
        if (request.url().includes('/api/finder/arm-performance-run')) replayRequests += 1;
    };
    page.on('request', observe);
    try {
        await page.click('.panel-tab[data-tab="finder"]');
        await page.waitForSelector('#finderScope', { visible: true });
        await page.evaluate(async () => {
            const managerPath = '/lib/finder-manager.ts';
            const typesPath = '/lib/batch-backtest/open-score-replay/types.ts';
            const { finderManager: manager } = await import(managerPath);
            const { createEmptyRankingMeasurement } = await import(typesPath);
            for (const [id, value] of [
                ['finderScope', 'arm_performance'],
                ['finderArmPerformanceMeasurement', 'ranking_consistency'],
                ['finderArmPerformanceHorizon', '20'],
                ['finderArmPerformanceRankingSort', 'overall_ordering'],
            ]) {
                const element = document.getElementById(id) as HTMLSelectElement;
                element.value = value!;
                element.dispatchEvent(new Event('change', { bubbles: true }));
            }
            manager.resultStore.armPerformanceDisplayLimit = 1;
            const rows = [0, 1].map((ordinal) => {
                const rankingMeasurement = createEmptyRankingMeasurement(20);
                Object.assign(rankingMeasurement.arms.topRawProfitNow, {
                    scoredEvents: 100, eligibleEvents: 100, comparisons: 1000, meanAccuracy: 0.8,
                    top1Superiority: ordinal === 0 ? 0.6 : 0.9, ciLower: ordinal === 0 ? 0.7 : 0.6,
                    ciUpper: 0.9, status: 'available', blockCount: 10,
                    soleFirstPlaceCount: 20, sharedFirstPlaceCount: 10, soleFirstPlaceRate: 0.2, sharedFirstPlaceRate: 0.1,
                    measurementWindowSec: 11 * 86400, timeBlockWidthSec: 22 * 86400, timeCoverageSec: 220 * 86400,
                });
                return {
                    candidateId: `ranking-card-${ordinal}`, candidateOrdinal: ordinal,
                    strategyKey: 'ema_confirmation', strategyName: `Ranking fixture ${ordinal}`,
                    params: { fastPeriod: 12 }, backtestSettings: {}, replayMode: 'horizon', horizon: 20,
                    requestedEngineMode: 'typescript', actualEngineMode: 'typescript',
                    pairCoverage: { requestedPairs: 5, completedPairs: 5, failedPairs: 0, replayTargetLoadFailures: 0, noTradePairs: 0 },
                    metrics: { TOP_RAW_PROFIT_NOW: { events: 100, topMean: 0.01, randomMean: 0, delta: 0.01, ciLower: 0, ciUpper: 0.02 } },
                    rankingMeasurement,
                };
            });
            manager.adoptArmPerformanceResults(rows, null, true, false);
            manager.populateResortOptions();
            manager.renderLatestResults();
            if (manager.getLatestCandidate().candidateOrdinal !== 0) throw new Error('Overall ordering sort failed');
            const sort = document.getElementById('finderArmPerformanceRankingSort') as HTMLSelectElement;
            sort.value = 'selected_asset';
            const originalDisplayUpdate = manager.resultStore.setArmPerformanceDisplayFilter;
            let displayUpdates = 0;
            try {
                manager.resultStore.setArmPerformanceDisplayFilter = (...args: any[]) => {
                    displayUpdates += 1;
                    return originalDisplayUpdate.apply(manager.resultStore, args);
                };
                sort.dispatchEvent(new Event('input', { bubbles: true }));
                sort.dispatchEvent(new Event('change', { bubbles: true }));
                await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
                if (displayUpdates !== 1) throw new Error('Duplicate Arm control events must coalesce into one display update');
                sort.dispatchEvent(new Event('change', { bubbles: true }));
                // Hide before the next frame: apply the pending view and flush its checkpoint.
                window.dispatchEvent(new Event('pagehide'));
                const saved = JSON.parse(localStorage.getItem('playground_finder_latest_results')!).data.results;
                if (saved.results[0]?.candidateOrdinal !== 1) throw new Error('Pagehide lost the pending Arm display checkpoint');
            } finally {
                manager.resultStore.setArmPerformanceDisplayFilter = originalDisplayUpdate;
            }
            if (manager.getLatestCandidate().candidateOrdinal !== 1 || manager.resultStore.armPerformanceRunResults.length !== 2) {
                throw new Error('Selected asset sort must use the full inventory before Top Results');
            }
        });
        const panel = '#finderList details.finder-measurement-details';
        const inspect = () => page.$eval(panel, (element) => ({
            open: (element as HTMLDetailsElement).open,
            readable: element.textContent?.includes('width 22 days'),
            panelHeight: element.getBoundingClientRect().height,
            applyEnabled: !(element.closest('.finder-row')!.querySelector('.finder-apply') as HTMLButtonElement).disabled,
        }));
        const initial = await inspect();
        if (!initial.open || !initial.readable || !initial.applyEnabled) throw new Error(`Expanded ranking card contract failed: ${JSON.stringify(initial)}`);
        const visibleCount = await page.$eval('#finderList .finder-row', (row) =>
            Array.from(row.querySelectorAll('.finder-metrics > span')).some((chip) => chip.textContent === 'Scored events 100' && !chip.closest('details')));
        if (!visibleCount) throw new Error('Scored events must be outside Measurement details');
        await page.click(`${panel} summary`);
        const closed = await inspect();
        if (closed.open || closed.panelHeight >= initial.panelHeight) throw new Error('Measurement details collapse failed');
        await page.click(`${panel} summary`);
        const opened = await inspect();
        if (!opened.open || opened.panelHeight <= closed.panelHeight || !opened.applyEnabled) throw new Error('Measurement details expansion failed');
        await page.evaluate(() => {
            const selector = document.getElementById('finderResort') as HTMLSelectElement;
            for (const arm of ['TOP_COVERAGE', 'TOP_STABLE_SUPPORT', 'TOP_FRESH_SUPPORT', 'TOP_PRICE_STRENGTH', 'TOP_GRAPH_STRENGTH']) {
                if (!Array.from(selector.options).some((option) => option.value === arm)) throw new Error('Missing Finder arm ' + arm);
                selector.value = arm; selector.dispatchEvent(new Event('change', { bubbles: true }));
                if (!document.getElementById('finderList')!.textContent!.includes('Rerun required')) throw new Error('Legacy arm availability must require rerun: ' + arm);
            }
        });
        await page.evaluate(async () => {
            const managerPath = '/lib/finder-manager.ts', typesPath = '/lib/batch-backtest/open-score-replay/types.ts';
            const contractPath = '/lib/batch-backtest/open-score-replay/arm-contract.ts';
            const definitionsPath = '/lib/batch-backtest/open-score-replay/causal-arm-constants.ts';
            const { finderManager: manager } = await import(managerPath);
            const { createEmptyRankingMeasurement } = await import(typesPath);
            const { REPLAY_ARM_TO_FINDER_ARM, CAUSAL_ARM_FIELDS } = await import(contractPath);
            const { FINDER_CAUSAL_ARMS_V1 } = await import(definitionsPath);
            const sourceRows = manager.resultStore.armPerformanceRunResults;
            for (const mode of ['horizon', 'asset_switch']) {
                const rows = sourceRows.map((row: any) => {
                    const rankingMeasurement = createEmptyRankingMeasurement(20, true);
                    for (const field of Object.keys(REPLAY_ARM_TO_FINDER_ARM)) rankingMeasurement.arms[field] = { ...row.rankingMeasurement.arms.topRawProfitNow };
                    const metrics = Object.fromEntries(Object.values(REPLAY_ARM_TO_FINDER_ARM).map((arm) => [arm, {
                        events: 100, topMean: 0.01 + row.candidateOrdinal * 0.01, randomMean: 0, delta: 0.01,
                        topMedian: 0.01, ciLower: 0, ciUpper: 0.02, positiveBlocks: 10, totalBlocks: 10,
                    }]));
                    const assetSwitchMetrics = Object.fromEntries(Object.values(REPLAY_ARM_TO_FINDER_ARM).map((arm) => [arm, {
                        status: 'complete', enteredCount: 100, completedTrades: 100, realizedNetPnl: 10 + row.candidateOrdinal,
                        totalNetPnl: 10 + row.candidateOrdinal, openPositionNetPnl: 0, partialRealizedNetPnl: 10,
                        completedHoldingDurationSec: 1000, averageCompletedHoldingDurationSec: 10, totalCosts: 1,
                        openPosition: null, pendingOrder: null,
                        diagnosticCounts: { missingTarget: 0, invalidTimestamp: 0, invalidPrice: 0, dataGap: 0, staleMark: 0, unvaluedPosition: 0 },
                    }]));
                    return { ...row, replayMode: mode, horizon: mode === 'horizon' ? 20 : undefined,
                        metrics: mode === 'horizon' ? metrics : undefined, assetSwitchMetrics: mode === 'asset_switch' ? assetSwitchMetrics : undefined,
                        rankingMeasurement, causalArmDefinitions: FINDER_CAUSAL_ARMS_V1,
                        causalArmDiagnostics: { eligibleCandidates: Object.fromEntries(CAUSAL_ARM_FIELDS.map((field: string) => [field, 600])),
                            unavailableDegree: 0, unavailableSupportHistory: 1, unavailablePriceHistory: 2, graphExcludedCandidates: 3, graphSolverFailures: 0,
                            priceUnavailableReasons: { insufficient_history: 2 } },
                    };
                });
                manager.adoptArmPerformanceResults(rows, null, true, false);
                manager.populateResortOptions();
                for (const measurement of ['return', 'ranking_consistency']) {
                    const control = document.getElementById('finderArmPerformanceMeasurement') as HTMLSelectElement;
                    control.value = measurement; control.dispatchEvent(new Event('change', { bubbles: true }));
                    for (const field of CAUSAL_ARM_FIELDS) {
                        const selector = document.getElementById('finderResort') as HTMLSelectElement;
                        selector.value = REPLAY_ARM_TO_FINDER_ARM[field]; selector.dispatchEvent(new Event('change', { bubbles: true }));
                        const list = document.getElementById('finderList')!;
                        if (!list.textContent!.includes('Eligible candidate observations: 600') || list.textContent!.includes('Rerun required')) throw new Error('Missing calculated arm details: ' + mode + '/' + measurement + '/' + field);
                        if (manager.getLatestCandidate().candidateOrdinal !== 1) throw new Error('New arms must sort the complete inventory locally');
                        if ((list.querySelector('.finder-apply') as HTMLButtonElement).disabled) throw new Error('New-arm Apply unavailable');
                    }
                }
            }
        });
        if (replayRequests !== 0) throw new Error('Local ranking sort launched a replay');
        console.log('Ranking card expansion and local sorting passed.');
    } finally {
        page.off('request', observe);
    }
};

const verifyFinderWorkspace = async (page: Page): Promise<void> => {
    await page.evaluate(async () => {
        const managerPath = '/lib/finder-manager.ts';
        const { finderManager: manager } = await import(managerPath);
        const tableButton = document.getElementById('finderViewTable') as HTMLButtonElement;
        tableButton.focus(); tableButton.click();
        if (document.activeElement !== tableButton || tableButton.getAttribute('aria-pressed') !== 'true') throw new Error('Finder view lost focus or active state');
        if (!document.querySelector('.finder-comparison-table') || document.querySelector('#finderList .finder-row')) throw new Error('Finder table view did not replace cards');
        const rankingSort = document.getElementById('finderArmPerformanceRankingSort') as HTMLSelectElement;
        rankingSort.value = 'overall_ordering'; rankingSort.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (manager.getLatestCandidate().candidateOrdinal !== 0) throw new Error('Table ranking did not restore overall ordering');
        rankingSort.value = 'selected_asset'; rankingSort.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (manager.getLatestCandidate().candidateOrdinal !== 1 || manager.resultStore.armPerformanceRunResults.length !== 2) throw new Error('Table ranking truncated the source inventory');
        if (!document.querySelector('.finder-comparison-table tbody')!.textContent!.includes('Ranking fixture 1')) throw new Error('Table did not follow Re-Sort');
        const apply = document.querySelector<HTMLButtonElement>('.finder-comparison-table .finder-apply')!;
        if (apply.disabled || apply.dataset.index !== '0') throw new Error('Table Apply index/availability drifted');
        const originalApply = manager.resultActions.applyArmPerformanceCandidate;
        const originalGuard = manager.resultActions.runFinderApply;
        let applied: any;
        try {
            manager.resultActions.runFinderApply = (action: () => Promise<void>) => action();
            manager.resultActions.applyArmPerformanceCandidate = async (candidate: any) => { applied = candidate; };
            apply.click();
            if (applied?.candidateOrdinal !== 1) throw new Error('Table Apply selected the wrong candidate');
        } finally {
            manager.resultActions.applyArmPerformanceCandidate = originalApply;
            manager.resultActions.runFinderApply = originalGuard;
        }
        const risk = document.getElementById('finderFreezeRiskManagementToggle') as HTMLInputElement;
        const riskDetails = risk.closest('details')!;
        if (riskDetails.open) throw new Error('Advanced settings should start collapsed');
        riskDetails.open = true;
        const previous = risk.checked;
        risk.checked = true; risk.dispatchEvent(new Event('change', { bubbles: true }));
        riskDetails.open = false;
        if (!riskDetails.querySelector('summary')!.textContent!.includes('Risk settings fixed')) throw new Error('Collapsed summary missed an enabled option');
        risk.checked = previous; risk.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const wide = await page.evaluate(() => {
        const config = document.getElementById('finderConfiguration')!.getBoundingClientRect();
        const results = document.getElementById('finderResultsPanel')!.getBoundingClientRect();
        return results.left >= config.right;
    });
    if (!wide) throw new Error('Wide Finder panel did not split configuration and results');
    await page.screenshot({ path: 'artifacts/finder-workspace-desktop.png', fullPage: true });
    const sticky = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.panel-content')!;
        panel.scrollTop = 500;
        const panelRect = panel.getBoundingClientRect();
        const bar = document.getElementById('finderExecutionBar')!.getBoundingClientRect();
        return bar.top >= panelRect.top - 2 && bar.top < panelRect.top + 24;
    });
    if (!sticky) throw new Error('Finder execution bar did not remain visible while scrolling');
    await page.setViewport({ width: 390, height: 844 });
    const narrow = await page.evaluate(() => {
        const panel = document.querySelector<HTMLElement>('.panel-content')!;
        panel.scrollTop = 0;
        return {
            columns: getComputedStyle(document.getElementById('finderWorkspace')!).gridTemplateColumns.split(' ').length,
            overflow: panel.scrollWidth > panel.clientWidth,
            tableScrollable: document.querySelector('.finder-comparison-wrap')!.scrollWidth > document.querySelector('.finder-comparison-wrap')!.clientWidth,
        };
    });
    if (narrow.columns !== 1 || narrow.overflow || !narrow.tableScrollable) throw new Error('Narrow Finder layout failed: ' + JSON.stringify(narrow));
    await page.screenshot({ path: 'artifacts/finder-workspace-mobile.png', fullPage: true });
    await page.setViewport({ width: 1440, height: 1000 });
    await page.evaluate(async () => {
        const uiPath = '/lib/finder/finder-ui.ts';
        const statsPath = '/lib/strategies/backtest/position-stats.ts';
        const universePath = '/lib/finder/finder-universe-metrics.ts';
        const { FinderUI } = await import(uiPath);
        const { createEmptyBacktestResult } = await import(statsPath);
        const { buildFinderUniverseCandidate } = await import(universePath);
        const ui = new FinderUI(); ui.setResultsView('table');
        const result = { ...createEmptyBacktestResult(), netProfit: 123, profitFactor: 2, expectancy: 4, totalTrades: 50, sharpeRatio: 1 };
        const checker = { check(metric: string, readOnly = false) {
            const row = document.querySelector('.finder-comparison-table tbody tr')!;
            if (!row || !row.textContent!.includes(metric)) throw new Error('Scope table lost metric: ' + metric);
            if (Boolean(row.querySelector('.finder-apply')) === readOnly) throw new Error('Scope table Apply contract failed');
            if (!row.querySelector('details.finder-table-details')) throw new Error('Scope table lost details');
        } };
        ui.renderResults([{ key: 'fixture', name: 'Current Chart fixture', params: { period: 12 }, result, selectionResult: result,
            oosResult: result, oosVerdict: 'pass' }]);
        checker.check('$123');
        if (!document.querySelector('.finder-comparison-table th[scope="row"] > .finder-oos-pass')) throw new Error('Table hid the OOS verdict');
        const candidate = buildFinderUniverseCandidate({ strategyKey: 'fixture', strategyName: 'Universe fixture', params: {},
            symbols: [{ symbol: 'AAA', status: 'profitable', barCount: 100, result }] });
        ui.renderUniverseResults([candidate]); checker.check('4.00');
        const symbolDetails = document.querySelector<HTMLDetailsElement>('.finder-table-details .finder-main > details')!;
        if (symbolDetails.querySelector('.finder-symbol-row')) throw new Error('Table eagerly populated symbol details');
        symbolDetails.open = true;
        await new Promise(resolve => setTimeout(resolve, 0));
        if (!symbolDetails.querySelector('.finder-symbol-row')) throw new Error('Table lost lazy breakdown listeners');
        ui.renderAssetOpportunityResults([{ symbol: 'AAA', strategyKey: 'fixture', strategyName: 'Asset fixture', params: {},
            historicalRank: 1, totalCandidatesEvaluated: 5, freshStatus: 'fresh', direction: 'long', latestSignalTime: null,
            signalAgeBars: 0, fillTiming: 'signal_close', selectionResult: result, grade: 'select',
            support: { freshSameDirection: 2, poolSize: 3, directionAgreementRatio: 2 / 3 } }]);
        checker.check('2/3');
        ui.renderStrategyQualityResults([{ strategyKey: 'fixture', strategyName: 'Audit fixture', params: {}, symbols: [],
            requestedSymbols: 1, loadedSymbols: 1, failedSymbols: 0, activeSymbols: 1, profitableSymbols: 1,
            losingSymbols: 0, noTradeSymbols: 0, totalTrades: 50, totalNetProfit: 123, averageExpectancy: 4,
            medianExpectancy: 4, averageProfitFactor: 2, profitFactor: 2, averageSharpe: 1, sharpeAvailableSymbols: 1,
            weightedWinRate: 50, worstMaxDrawdownPercent: 2 }]);
        checker.check('$123', true);
        document.getElementById('finderViewCards')!.click();
        if (document.querySelector('.finder-comparison-table')) throw new Error('Finder cards did not restore');
        document.querySelector<HTMLElement>('.panel-content')!.scrollTop = 0;
    });
    console.log('Finder split layout, sticky execution, all scope tables, Apply and collapsed summaries passed.');
};

const verifyBatchCausalArms = async (page: Page): Promise<void> => {
    await page.click('.panel-tab[data-tab="batchbacktest"]');
    await page.waitForSelector('#batchBacktestSp500TopMeanDetailsSelector', { visible: true });
    await page.evaluate(async () => {
        const servicePath = '/lib/batch-backtest/batch-backtest-service.ts';
        const contractPath = '/lib/batch-backtest/open-score-replay/arm-contract.ts';
        const definitionsPath = '/lib/batch-backtest/open-score-replay/causal-arm-constants.ts';
        const switchPath = '/lib/batch-backtest/open-score-replay/asset-switch.ts';
        const storePath = '/lib/batch-backtest/browser/batch-browser-store.ts';
        const { batchBacktestService: service } = await import(servicePath);
        const { CAUSAL_ARM_FIELDS, REPLAY_ARM_TO_FINDER_ARM } = await import(contractPath);
        const { FINDER_CAUSAL_ARMS_V1 } = await import(definitionsPath);
        const { createEmptyAssetSwitchSummary } = await import(switchPath);
        const { persistLatestTopMeanResult, readLatestTopMeanResult } = await import(storePath);
        service.init();
        const comparison = { events: 1, topMean: 0.01, randomMean: 0, delta: 0.01, topMedian: 0.01,
            blockMeans: [], ciLower: null, ciUpper: null, positiveBlocks: 1, totalBlocks: 1 };
        const armComparisons = Object.fromEntries(CAUSAL_ARM_FIELDS.map((field: string) => [REPLAY_ARM_TO_FINDER_ARM[field], comparison]));
        const selections = CAUSAL_ARM_FIELDS.map((field: string) => ({ selector: REPLAY_ARM_TO_FINDER_ARM[field], direction: 'long',
            asset: field, tiedAssets: [], score: 7, mean: 1, activePairs: 7, eligibleCandidates: 6,
            reason: 'selected', rankingScore: -0.25,
            topCandidates: [{ asset: field, score: 7, mean: 1, activePairs: 7, rankingScore: -0.25 }] }));
        for (const mode of ['horizon', 'asset_switch']) {
            const summary: any = { runId: 'batch-causal-e2e', completed: true, replayMode: mode, counts: {}, warnings: [], reportLines: [],
                causalArmDefinitions: { ...FINDER_CAUSAL_ARMS_V1 },
                horizons: mode === 'horizon' ? [{ horizon: 5, events: 1, topMean: comparison, topAssets: [], armComparisons, latestArms: armComparisons }] : [],
                latestSelections: mode === 'horizon' ? { decisionTime: 1_700_000_000, selections } : undefined,
                openScoreEventDetails: mode === 'horizon' ? CAUSAL_ARM_FIELDS.map((field: string) => ({ selector: REPLAY_ARM_TO_FINDER_ARM[field],
                    decisionTime: 1_700_000_000, entryTime: 1_700_000_060, exitTime: 1_700_000_360, horizonBars: 5, direction: 'long', asset: field,
                    selectedReturn: 0.01, controlReturn: 0, delta: 0.01, eligibleCandidates: 6 })) : undefined };
            if (mode === 'asset_switch') {
                summary.assetSwitch = createEmptyAssetSwitchSummary({ enableCausalArms: true, evaluationCutoffSec: 1_700_001_000 });
                summary.assetSwitch.trades = CAUSAL_ARM_FIELDS.map((field: string) => ({ arm: field, asset: field, decisionTimeSec: 1_700_000_000,
                    entryTimeSec: 1_700_000_060, entryPrice: 100, exitTimeSec: 1_700_000_360, exitPrice: 101, holdingDurationSec: 300,
                    netPnl: 10, entryCost: 0, exitCost: 0, status: 'closed' }));
                summary.assetSwitch.tradeCount = 5;
                for (const [field, value] of [['topRaw', 10], ['topMean', 2], ['topZ', 100]] as const) {
                    Object.assign(summary.assetSwitch.arms[field], { status: 'complete', totalNetPnl: value,
                        realizedNetPnl: value, openPositionNetPnl: value, completedTrades: value, enteredCount: value, totalCosts: value });
                }
                summary.assetSwitch.arms.topRaw.totalNetPnl = -10;
                summary.assetSwitch.arms.topRawProfit.totalNetPnl = 10_000;
            }
            summary.annualReports = mode === 'horizon' ? [{ year: 2023, sampleFromSec: 1_700_000_000, sampleToSec: 1_700_001_000,
                horizons: [], warnings: [], reportLines: ['annual report retained during display changes'] }]
                : [{ year: 2023, sampleFromSec: 1_700_000_000, sampleToSec: 1_700_001_000,
                    assetSwitch: { ...summary.assetSwitch, windowStartSec: 1_700_000_000, windowEndSec: 1_700_001_000 },
                    horizons: [], warnings: [], reportLines: [] }];
            service.latestTopMeanResult = summary;
            service.renderTopMeanResults(service.dom, summary);
            service.topMean.syncTopMeanOpenScoreDetailsControl(service.dom, summary);
            (document.getElementById('batchBacktestSp500TopMeanDetailsBtn') as HTMLButtonElement).click();
            for (const field of CAUSAL_ARM_FIELDS) {
                const arm = REPLAY_ARM_TO_FINDER_ARM[field];
                const detailSelector = document.getElementById('batchBacktestSp500TopMeanDetailsSelector') as HTMLSelectElement;
                if (!Array.from(detailSelector.options).some((option) => option.value === arm)) throw new Error('Missing Batch details arm ' + arm);
                if (document.getElementById('batchBacktestSp500TopMeanDetails')!.hidden) (document.getElementById('batchBacktestSp500TopMeanDetailsBtn') as HTMLButtonElement).click();
                detailSelector.value = arm; detailSelector.dispatchEvent(new Event('change', { bubbles: true }));
                const details = document.getElementById('batchBacktestSp500TopMeanDetails')!;
                if (details.hidden || !details.textContent!.includes(field) || details.textContent!.includes('Rerun required')) throw new Error('Missing Batch details for ' + mode + '/' + arm);
                if (mode === 'horizon') {
                    const selector = document.getElementById('batchBacktestSp500TopMeanLatestArmSelector') as HTMLSelectElement;
                    const annual = document.querySelector<HTMLDetailsElement>('#batchBacktestSp500TopMeanResults .batch-report-details')!;
                    annual.open = true;
                    const detailsBefore = details.innerHTML;
                    selector.focus();
                    selector.value = arm; selector.dispatchEvent(new Event('change', { bubbles: true }));
                    if (document.getElementById('batchBacktestSp500TopMeanLatestArmSelector') !== selector || document.activeElement !== selector) throw new Error('Batch arm update replaced or blurred the picker');
                    if (!annual.isConnected || !annual.open) throw new Error('Batch arm update reset the annual disclosure');
                    if (details.hidden || details.innerHTML !== detailsBefore) throw new Error('Batch arm update reset the details panel');
                    const text = document.getElementById('batchBacktestSp500TopMeanResults')!.textContent!;
                    if (!text.includes(field) || !text.includes('Arm score: -0.25') || text.includes('Rerun required')) throw new Error('Missing calculated Batch latest pick ' + arm);
                }
            }
            if (mode === 'asset_switch') {
                const results = document.getElementById('batchBacktestSp500TopMeanResults')!;
                const report = results.querySelector<HTMLElement>('[data-batch-replay-report]')!;
                const annual = results.querySelector<HTMLDetailsElement>('.batch-report-details')!;
                annual.open = true;
                const details = document.getElementById('batchBacktestSp500TopMeanDetails')!;
                const detailsBefore = details.innerHTML;
                const tableButton = report.querySelector<HTMLButtonElement>('[data-batch-replay-view="table"]')!;
                tableButton.focus(); tableButton.click();
                if (document.activeElement !== tableButton || tableButton.getAttribute('aria-pressed') !== 'true') throw new Error('Replay view lost focus or active state');
                if (!report.querySelector<HTMLElement>('[data-batch-replay-panel="cards"]')!.hidden || report.querySelector<HTMLElement>('[data-batch-replay-panel="table"]')!.hidden) throw new Error('Replay view did not switch');
                const table = report.querySelector<HTMLTableElement>('.batch-replay-table')!;
                if ([...table.tBodies[0].rows].some(row => row.textContent!.includes('LOOK-AHEAD RESEARCH'))) throw new Error('Look-ahead arms mixed into selector table');
                for (const key of ['totalNetPnl', 'realizedNetPnl', 'openPositionNetPnl', 'completedTrades', 'enteredCount', 'totalCosts']) {
                    const sortButton = table.querySelector<HTMLButtonElement>(`[data-batch-replay-sort="${key}"]`)!;
                    sortButton.focus(); sortButton.click();
                    if (!table.tBodies[0].rows[0].textContent!.includes('topZ')) throw new Error('Replay table did not sort numerically: ' + key);
                    if (document.activeElement !== sortButton || sortButton.closest('th')!.getAttribute('aria-sort') !== 'descending') throw new Error('Replay sort lost focus or accessible direction');
                    sortButton.click();
                    if (sortButton.closest('th')!.getAttribute('aria-sort') !== 'ascending') throw new Error('Replay sort did not reverse');
                    if (key === 'totalNetPnl' && !table.tBodies[0].rows[0].textContent!.includes('topRaw')) throw new Error('Replay loss sorted incorrectly');
                    if (key.includes('Pnl')) {
                        const last = table.tBodies[0].rows[table.tBodies[0].rows.length - 1];
                        if (last.querySelector<HTMLElement>(`[data-batch-replay-metric="${key}"]`)!.dataset.value !== '') throw new Error('Unavailable replay values must stay last');
                    }
                }
                const annualReport = annual.querySelector<HTMLElement>('[data-batch-replay-report]')!;
                if (annualReport.querySelector<HTMLElement>('[data-batch-replay-panel="cards"]')!.hidden) throw new Error('Full-window view changed annual view');
                annualReport.querySelector<HTMLButtonElement>('[data-batch-replay-view="table"]')!.click();
                annualReport.querySelector<HTMLButtonElement>('[data-batch-replay-sort="totalNetPnl"]')!.click();
                if (!annual.isConnected || !annual.open || details.hidden || details.innerHTML !== detailsBefore) throw new Error('Replay controls reset annual disclosure or details');
                report.querySelector<HTMLButtonElement>('[data-batch-replay-view="cards"]')!.click();
                if (report.querySelector<HTMLElement>('[data-batch-replay-panel="cards"]')!.hidden || !report.querySelector<HTMLElement>('[data-batch-replay-panel="table"]')!.hidden) throw new Error('Replay cards did not restore');
            }
            persistLatestTopMeanResult(summary);
            const recovered = readLatestTopMeanResult();
            if (!recovered || recovered.causalArmDefinitions.version !== 'finder-causal-arms-v1') throw new Error('Batch causal definitions lost on reload');
            for (const field of CAUSAL_ARM_FIELDS) {
                if (mode === 'horizon' ? !recovered.horizons[0].armComparisons[REPLAY_ARM_TO_FINDER_ARM[field]] : !recovered.assetSwitch.arms[field]) throw new Error('Batch causal summary lost on reload');
            }
        }
    });
    console.log('Batch causal arm selectors, details and saved results passed.');
    await page.evaluate(async () => {
        const servicePath = '/lib/batch-backtest/batch-backtest-service.ts';
        const { batchBacktestService: service, createBatchBacktestService } = await import(servicePath);
        const dom = service.dom;
        const result = { runId: 'batch-ui-interactions', completed: true, counts: {}, horizons: [], warnings: [], reportLines: [],
            latestSelections: { decisionTime: 1_700_000_000, selections: [{ selector: 'TOP_MEAN', direction: 'long', asset: null,
                tiedAssets: ['BBB', 'AAA'], reason: 'tied', score: null, mean: null, activePairs: null, eligibleCandidates: 2 }] },
            openScoreEventDetails: [
                { selector: 'TOP_MEAN', asset: 'OLD_ASSET', year: 2022 },
                { selector: 'TOP_RAW', asset: 'NEW_ASSET', year: 2023 },
            ].map(({ selector, asset, year }) => ({ selector, asset, direction: 'long',
                decisionTime: Date.UTC(year, 0, 1) / 1000, entryTime: Date.UTC(year, 0, 2) / 1000,
                exitTime: Date.UTC(year, 0, 3) / 1000, horizonBars: 12, selectedReturn: 0.1, controlReturn: 0, delta: 0.1, eligibleCandidates: 2 })) };
        dom.batchBacktestSp500TopMeanTieBreak.value = 'off';
        service.topMean.setLatestArm('TOP_MEAN');
        service.latestTopMeanResult = result;
        service.renderTopMeanResults(dom, result);
        if (!dom.batchBacktestSp500TopMeanResults.textContent.includes('TIE / SKIP')) throw new Error('Missing tie precondition');
        dom.batchBacktestSp500TopMeanTieBreak.value = 'alpha';
        dom.batchBacktestSp500TopMeanTieBreak.dispatchEvent(new Event('change', { bubbles: true }));
        const pick = dom.batchBacktestSp500TopMeanResults.querySelector('[data-batch-latest-selection-content]');
        if (!pick.textContent.includes('AAA') || pick.textContent.includes('TIE / SKIP')) throw new Error('Tie Break did not update displayed selection');
        if (!service.topMean.formatLatestOpenScoreSelectionLines(result.latestSelections).join('\n').includes('asset=AAA')) throw new Error('Tie Break copy/display mismatch');
        dom.batchBacktestSp500TopMeanDetailsSelector.value = 'TOP_MEAN';
        dom.batchBacktestSp500TopMeanDetailsBtn.click();
        if (!dom.batchBacktestSp500TopMeanDetails.textContent.includes('OLD_ASSET')) throw new Error('Missing details precondition');
        dom.batchBacktestSp500TopMeanDetailsBtn.click();
        dom.batchBacktestSp500TopMeanDetailsSelector.value = 'TOP_RAW';
        dom.batchBacktestSp500TopMeanDetailsSelector.dispatchEvent(new Event('change', { bubbles: true }));
        dom.batchBacktestSp500TopMeanDetailsYear.value = '2023';
        dom.batchBacktestSp500TopMeanDetailsYear.dispatchEvent(new Event('change', { bubbles: true }));
        dom.batchBacktestSp500TopMeanDetailsBtn.click();
        if (!dom.batchBacktestSp500TopMeanDetails.textContent.includes('NEW_ASSET') || dom.batchBacktestSp500TopMeanDetails.textContent.includes('OLD_ASSET')) throw new Error('Hidden details filters reused stale content');
        dom.batchBacktestSymbols.value = 'ORIGINAL';
        service.activeServerRunId = 'owned-ui-run';
        service.topMean.setActiveTopMeanRunId('top-mean-ui-run');
        if (!dom.batchBacktestSymbols.readOnly || !dom.batchBacktestClear.disabled || !dom.batchBacktestBalancedGenerateBtn.disabled) throw new Error('TOP_MEAN did not lock pair-list controls');
        dom.batchBacktestSymbols.value = 'UNSUBMITTED';
        dom.batchBacktestSymbols.dispatchEvent(new Event('input', { bubbles: true }));
        if (dom.batchBacktestSymbols.value !== 'ORIGINAL' || service.activeServerRunId !== 'owned-ui-run') throw new Error('Busy pair-list edit lost submitted state');
        service.topMean.setActiveTopMeanRunId(null);
        if (dom.batchBacktestSymbols.readOnly || dom.batchBacktestClear.disabled) throw new Error('Pair-list controls did not unlock');
        service.dispose();
        const replacement = createBatchBacktestService();
        replacement.dom = dom;
        replacement.bindEvents(dom);
        dom.batchBacktestSymbols.value = 'REMOUNTED';
        dom.batchBacktestSymbols.dispatchEvent(new Event('input', { bubbles: true }));
        if (dom.batchBacktestSummary.textContent !== '1 pair' || service.activeServerRunId !== 'owned-ui-run') throw new Error('Disposed Batch listeners still handle remounted input');
        replacement.dispose();
    });
    console.log('Batch display consistency, hidden filters, editing locks and remount passed.');

};

async function runTest() {
    try {
        console.log('Starting Vite server for E2E test...');

        // Start vite on a specific port, but allow fallback if busy
        // Port 0 picks a random available port
        // Resolve the installed CLI directly so npm workspace discovery cannot
        // make the smoke test depend on the surrounding checkout layout.
        const viteProcess = spawn(process.execPath, [viteCliPath, '--port', '0'], {
            cwd: process.cwd(),
            stdio: 'pipe',
            env: { ...process.env, FORCE_COLOR: '0' }
        });

        // Flag to track intentional shutdown
        let isShuttingDown = false;

        viteProcess.on('exit', (code, signal) => {
            // Only log error if this wasn't an intentional shutdown
            if (code !== 0 && code !== null && !isShuttingDown) {
                console.error(`Vite process exited prematurely with code ${code} and signal ${signal}`);
            }
        });

        let serverReady = false;
        let baseUrl = '';
        let outputBuffer = '';

        viteProcess.stdout.on('data', (data) => {
            const chunk = data.toString();
            outputBuffer += chunk;
            // console.log(`[Vite stdout chunk]: ${chunk}`); 

            // Strip ANSI codes for easier matching
            const cleanBuffer = outputBuffer.replace(/\x1b\[[0-9;]*m/g, '');

            // Match either loopback hostname Vite may advertise.
            const match = cleanBuffer.match(/http:\/\/(localhost|127\.0\.0\.1):(\d+)/);

            if (match && !serverReady) {
                const host = match[1];
                const port = match[2];
                baseUrl = `http://${host}:${port}`;
                serverReady = true;
                console.log(`Vite server detected at ${baseUrl}`);
            }
        });

        viteProcess.stderr.on('data', (data) => {
            console.error(`[Vite stderr]: ${data.toString()}`);
        });

        process.on('unhandledRejection', (reason, p) => {
            console.error('Unhandled Rejection at:', p, 'reason:', reason);
            process.exit(1);
        });

        // Wait for server to be ready (timeout 30s)
        const startTime = Date.now();
        while (!serverReady) {
            if (Date.now() - startTime > 30000) {
                console.error('Timeout waiting for Vite server to start.');
                console.error('Full Buffer:', outputBuffer);
                stopProcessTree(viteProcess);
                throw new Error('Timeout waiting for Vite');
            }
            if (viteProcess.exitCode !== null) {
                throw new Error(`Vite exited with code ${viteProcess.exitCode}`);
            }
            await wait(500);
        }

        console.log('Launching Puppeteer...');
        let browser;

        try {
            browser = await puppeteer.launch({
                headless: true, // Run headless
                args: ['--no-sandbox', '--disable-setuid-sandbox'],
            });

            const page = await browser.newPage();
            await page.setViewport({ width: 1440, height: 1000 });

            // Use the app's generated data so the smoke test can run without
            // exchange connectivity, credentials, or a local price-data cache.
            await page.evaluateOnNewDocument(() => {
                localStorage.setItem('playground_app_settings', JSON.stringify({
                    schema: 'settings.app',
                    version: 1,
                    data: { currentSymbol: 'MOCK_STOCK', currentInterval: '1d' },
                }));
            });

            const errors: string[] = [];

            // Monitor request failures
            page.on('requestfailed', request => {
                const url = request.url();
                const failure = request.failure();
                console.error(`[Request Failed]: ${url} - ${failure?.errorText || 'Unknown error'}`);
                if (!url.includes('favicon.ico')) {
                    errors.push(`Request Failed: ${url} - ${failure?.errorText || 'Unknown error'}`);
                }
            });

            // Monitor network requests to identify 404s
            page.on('response', response => {
                if (response.status() === 404) {
                    const url = response.url();
                    if (url.includes('favicon.ico')) {
                        // console.log(`Ignoring expected 404 for favicon: ${url}`);
                        return;
                    }
                    console.error(`[Network 404]: ${url}`);
                    errors.push(`Network 404: ${url}`);
                }
            });

            page.on('console', async msg => {
                const type = msg.type();
                if (type === 'error') {
                    const text = msg.text();

                    // Get location if available
                    const location = msg.location();
                    const locationUrl = location?.url || '';

                    // Ignore favicon errors (check both text and location URL)
                    if (text.includes('favicon.ico') || locationUrl.includes('favicon.ico')) {
                        return;
                    }

                    // Try to get more details from message args
                    const args = msg.args();
                    let detailedText = text;
                    for (const arg of args) {
                        try {
                            const val = await arg.jsonValue();
                            if (val && typeof val === 'string' && val !== text) {
                                detailedText += ` | ${val}`;
                            }
                        } catch (e) {
                            // ignore
                        }
                    }

                    if (locationUrl) {
                        detailedText += ` @ ${locationUrl}`;
                    }

                    errors.push(`Console Error: ${detailedText}`);
                    console.error(`[Browser Console Error]: ${detailedText}`);
                }
            });

            page.on('pageerror', err => {
                errors.push(`Page Error: ${err.toString()}`);
                console.error(`[Browser PageError]: ${err.toString()}`);
            });

            console.log(`Navigating to ${baseUrl}...`);
            await page.goto(baseUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });

            console.log('Checking for #main-chart element...');
            try {
                await page.waitForSelector('#main-chart', { timeout: 10000 });
                console.log('#main-chart element found.');
            } catch (e) {
                throw new Error('Element #main-chart not found within 10 seconds');
            }

            console.log('Waiting for initial data load...');
            await waitForCondition(
                page,
                () => {
                    const state = (window as any).__state;
                    return state && Array.isArray(state.ohlcvData) && state.ohlcvData.length > 100;
                },
                15000,
                'initial OHLCV data'
            );

            console.log('Switching symbol to MOCK_CRYPTO...');
            await page.click('#symbolSelector');
            await page.waitForSelector('#symbolDropdown.active', { timeout: 5000 });
            await page.waitForSelector('#symbolDropdown [data-symbol="MOCK_CRYPTO"]', { visible: true, timeout: 5000 });
            await page.click('#symbolDropdown [data-symbol="MOCK_CRYPTO"]');

            await waitForCondition(
                page,
                () => {
                    const state = (window as any).__state;
                    return state && state.currentSymbol === 'MOCK_CRYPTO';
                },
                15000,
                'symbol switch to MOCK_CRYPTO'
            );

            await waitForCondition(
                page,
                () => {
                    const debug = (window as any).__debug;
                    if (!debug || typeof debug.getEntries !== 'function') return false;
                    return debug.getEntries().some((entry: any) =>
                        entry.message === 'data.apply' &&
                        entry.data &&
                        entry.data.symbol === 'MOCK_CRYPTO'
                    );
                },
                15000,
                'MOCK_CRYPTO data load'
            );

            console.log('Switching interval to 4h...');
            await page.click('.timeframe-tab[data-interval="4h"]');

            await waitForCondition(
                page,
                () => {
                    const state = (window as any).__state;
                    return state && state.currentInterval === '4h';
                },
                15000,
                'interval switch to 4h'
            );

            await waitForCondition(
                page,
                () => {
                    const debug = (window as any).__debug;
                    if (!debug || typeof debug.getEntries !== 'function') return false;
                    return debug.getEntries().some((entry: any) =>
                        entry.message === 'data.apply' &&
                        entry.data &&
                        entry.data.symbol === 'MOCK_CRYPTO' &&
                        entry.data.interval === '4h'
                    );
                },
                15000,
                '4h data load'
            );

            console.log('Testing Save Configuration...');
            await page.waitForSelector('#configNameInput', { visible: true });
            await page.type('#configNameInput', 'TestConfig');
            await page.click('#saveConfigBtn');

            await waitForCondition(
                page,
                () => {
                    const debug = (window as any).__debug;
                    if (!debug || typeof debug.getEntries !== 'function') return false;
                    return debug.getEntries().some((entry: any) =>
                        entry.message === 'settings.config.saved' &&
                        entry.data &&
                        entry.data.name === 'TestConfig'
                    );
                },
                5000,
                'configuration save'
            );
            console.log('Configuration saved successfully.');

            await verifySettingsWorkspace(page);
            await verifyRankingCards(page);
            await verifyFinderWorkspace(page);
            await verifyBatchCausalArms(page);

            console.log('Performing layout verification...');
            const layoutIssues = await verifyLayout(page);
            if (layoutIssues.length > 0) {
                errors.push(...layoutIssues.map(issue => `Layout Error: ${issue}`));
                layoutIssues.forEach(issue => console.error(`[Layout Malfunction]: ${issue}`));
            } else {
                console.log('Layout verification passed.');
            }

            await assertNoDebugErrors(page, errors);

            // Verify no critical errors occurred
            if (errors.length > 0) {
                console.warn('Warning: There were console errors during the test.');
                await logDebugSnapshot(page, 'e2e.error');
                throw new Error(`Test failed due to ${errors.length} console errors.`);
            }

            // Take a screenshot
            await page.screenshot({ path: 'e2e-success.png' });
            console.log('Screenshot saved to e2e-success.png');
            console.log('E2E Test Passed Successfully!');

        } catch (error) {
            throw error;
        } finally {
            isShuttingDown = true;
            if (browser) {
                await browser.close();
            }
            console.log('Stopping Vite server...');
            stopProcessTree(viteProcess);
        }

        // Explicitly exit with success code
        process.exit(0);
    } catch (err) {
        console.error('Top Level Error:', err);
        process.exit(1);
    }
}

runTest();
