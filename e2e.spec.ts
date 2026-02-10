import puppeteer, { Page } from 'puppeteer';
import { spawn } from 'child_process';

// Helper to wait
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

console.log('Script starting...');

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
            { selector: '#openCodeEditor', maxHeight: 50, label: 'Create Custom Strategy button' }
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

async function runTest() {
    try {
        console.log('Starting Vite server for E2E test...');

        // Start vite on a specific port, but allow fallback if busy
        // Port 0 picks a random available port
        // Use npx with shell: true for Windows compatibility
        const viteProcess = spawn('npx', ['vite', '--port', '0'], {
            shell: true,
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

            // Regex for localhost port
            // Matches http://localhost:PORT
            const match = cleanBuffer.match(/http:\/\/localhost:(\d+)/);

            if (match && !serverReady) {
                const port = match[1];
                baseUrl = `http://localhost:${port}`;
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
                viteProcess.kill();
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
            await page.goto(baseUrl, { waitUntil: 'networkidle0' });

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

            console.log('Switching symbol to BTCUSDT...');
            await page.click('#symbolSelector');
            await page.waitForSelector('#symbolDropdown.active', { timeout: 5000 });
            await page.click('#symbolDropdown [data-symbol="BTCUSDT"]');

            await waitForCondition(
                page,
                () => {
                    const state = (window as any).__state;
                    return state && state.currentSymbol === 'BTCUSDT';
                },
                15000,
                'symbol switch to BTCUSDT'
            );

            await waitForCondition(
                page,
                () => {
                    const debug = (window as any).__debug;
                    if (!debug || typeof debug.getEntries !== 'function') return false;
                    return debug.getEntries().some((entry: any) =>
                        entry.message === 'data.apply' &&
                        entry.data &&
                        entry.data.symbol === 'BTCUSDT'
                    );
                },
                15000,
                'BTCUSDT data load'
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
                        entry.data.symbol === 'BTCUSDT' &&
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

            // Mark as shutting down before cleanup
            isShuttingDown = true;

        } catch (error) {
            throw error;
        } finally {
            if (browser) {
                await browser.close();
            }
            console.log('Stopping Vite server...');
            // On Windows, killing the spawned shell might not kill the child node process.
            // Using taskkill is often more reliable
            try {
                process.kill(viteProcess.pid!, 'SIGTERM');
            } catch (e) {
                // ignore
            }
            // Force kill if needed
            viteProcess.kill();
        }

        // Explicitly exit with success code
        process.exit(0);
    } catch (err) {
        console.error('Top Level Error:', err);
        process.exit(1);
    }
}

runTest();
