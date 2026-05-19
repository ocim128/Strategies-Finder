import { debugLogger, DebugEntry } from "./debug-logger";
import { state } from "./state";
import { getRequiredElement } from "./dom-utils";

type LagSnapshot = {
    lastLagMs: number;
    maxLagMs: number;
};

const EVENT_LOOP_INTERVAL_MS = 250;
const LAG_LOG_THRESHOLD_MS = 200;
const LAG_LOG_THROTTLE_MS = 2000;
let debugPanelInitialized = false;
let debugPanelAbortController: AbortController | null = null;
let lagIntervalId: number | null = null;
let refreshIntervalId: number | null = null;
let unsubscribeDebugLogger: (() => void) | null = null;

function safeStringify(value: unknown): string {
    try {
        if (typeof value === 'string') return value;
        const json = JSON.stringify(value);
        return json === undefined ? String(value) : json;
    } catch {
        return String(value);
    }
}

function formatEntry(entry: DebugEntry): string {
    const time = new Date(entry.ts).toLocaleTimeString('en-US', { hour12: false });
    const data = entry.data !== undefined ? ` ${safeStringify(entry.data)}` : '';
    return `${time} [${entry.level}] ${entry.message}${data}`;
}

function buildStateSnapshot(): string {
    return [
        `symbol: ${state.currentSymbol}`,
        `interval: ${state.currentInterval}`,
        `ohlcv: ${state.ohlcvData.length}`,
        `indicators: ${state.indicators.length}`,
        `backtest: ${state.currentBacktestResult ? 'ready' : 'none'}`,
        `theme: ${state.isDarkTheme ? 'dark' : 'light'}`,
    ].join('\n');
}

export function initDebugPanel() {
    if (debugPanelInitialized) {
        return;
    }

    const panel = getRequiredElement<HTMLElement>('debugPanel');
    const toggleButton = getRequiredElement<HTMLButtonElement>('debugToggle');
    const closeButton = getRequiredElement<HTMLButtonElement>('debugClose');
    const clearButton = getRequiredElement<HTMLButtonElement>('debugClear');
    const copyButton = getRequiredElement<HTMLButtonElement>('debugCopy');
    const logList = getRequiredElement<HTMLElement>('debugLogList');
    const stateEl = getRequiredElement<HTMLElement>('debugState');
    const perfEl = getRequiredElement<HTMLElement>('debugPerf');

    let lag: LagSnapshot = { lastLagMs: 0, maxLagMs: 0 };
    let lastLagLoggedAt = 0;
    let lastTick = Date.now();
    debugPanelInitialized = true;
    debugPanelAbortController = new AbortController();
    const listenerOptions = { signal: debugPanelAbortController.signal };

    lagIntervalId = window.setInterval(() => {
        const now = Date.now();
        const drift = now - lastTick - EVENT_LOOP_INTERVAL_MS;
        if (drift > LAG_LOG_THRESHOLD_MS) {
            const lagMs = Math.round(drift);
            lag = { lastLagMs: lagMs, maxLagMs: Math.max(lag.maxLagMs, lagMs) };
            if (now - lastLagLoggedAt > LAG_LOG_THROTTLE_MS) {
                debugLogger.warn('perf.event_loop_lag', { lagMs });
                lastLagLoggedAt = now;
            }
        }
        lastTick = now;
    }, EVENT_LOOP_INTERVAL_MS);

    const renderPerf = () => {
        perfEl.textContent = [
            `lastLagMs: ${lag.lastLagMs}`,
            `maxLagMs: ${lag.maxLagMs}`,
            `logEntries: ${debugLogger.getEntries().length}`,
        ].join('\n');
    };

    const renderLogs = () => {
        const entries = debugLogger.getEntries();
        logList.replaceChildren();
        for (const entry of entries) {
            const row = document.createElement('div');
            row.className = `debug-log-entry ${entry.level}`;
            row.textContent = formatEntry(entry);
            logList.appendChild(row);
        }
        logList.scrollTop = logList.scrollHeight;
    };

    const renderState = () => {
        stateEl.textContent = buildStateSnapshot();
    };

    const renderAll = () => {
        renderState();
        renderPerf();
        renderLogs();
    };

    const setVisible = (visible: boolean) => {
        panel.classList.toggle('active', visible);
        panel.setAttribute('aria-hidden', visible ? 'false' : 'true');
        toggleButton.setAttribute('aria-pressed', visible ? 'true' : 'false');
        if (visible) {
            renderAll();
        }
    };

    const isVisible = () => panel.classList.contains('active');

    toggleButton.addEventListener('click', () => {
        setVisible(!isVisible());
    }, listenerOptions);

    closeButton.addEventListener('click', () => setVisible(false), listenerOptions);

    clearButton.addEventListener('click', () => debugLogger.clear(), listenerOptions);

    copyButton.addEventListener('click', async () => {
        const entries = debugLogger.getEntries().map(formatEntry);
        const payload = [
            `time: ${new Date().toISOString()}`,
            '',
            'state:',
            buildStateSnapshot(),
            '',
            'perf:',
            perfEl.textContent || '',
            '',
            'logs:',
            ...entries,
        ].join('\n');
        try {
            await navigator.clipboard.writeText(payload);
            debugLogger.info('debug.copy', { entries: entries.length });
        } catch (error) {
            debugLogger.error('debug.copy.failed', { error: safeStringify(error) });
        }
    }, listenerOptions);

    unsubscribeDebugLogger = debugLogger.subscribe(() => {
        if (isVisible()) {
            renderLogs();
            renderPerf();
        }
    });

    document.addEventListener('keydown', (event) => {
        if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === 'd') {
            event.preventDefault();
            setVisible(!isVisible());
        }
        if (event.key === 'Escape' && isVisible()) {
            setVisible(false);
        }
    }, listenerOptions);

    refreshIntervalId = window.setInterval(() => {
        if (isVisible()) {
            renderState();
            renderPerf();
        }
    }, 500);

    debugLogger.event('debug.ready');
}

export function disposeDebugPanel(): void {
    if (lagIntervalId !== null) {
        window.clearInterval(lagIntervalId);
        lagIntervalId = null;
    }
    if (refreshIntervalId !== null) {
        window.clearInterval(refreshIntervalId);
        refreshIntervalId = null;
    }
    debugPanelAbortController?.abort();
    debugPanelAbortController = null;
    unsubscribeDebugLogger?.();
    unsubscribeDebugLogger = null;
    debugPanelInitialized = false;
}
