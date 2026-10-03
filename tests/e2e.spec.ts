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
            manager.renderLatestResults();
            if (manager.getLatestCandidate().candidateOrdinal !== 0) throw new Error('Overall ordering sort failed');
            const sort = document.getElementById('finderArmPerformanceRankingSort') as HTMLSelectElement;
            sort.value = 'selected_asset';
            sort.dispatchEvent(new Event('change', { bubbles: true }));
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
        if (replayRequests !== 0) throw new Error('Local ranking sort launched a replay');
        console.log('Ranking card expansion and local sorting passed.');
    } finally {
        page.off('request', observe);
    }
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

            await verifyRankingCards(page);

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
