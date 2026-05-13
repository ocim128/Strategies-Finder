/**
 * Live Positions Handlers
 * 
 * Wires up the Live Positions panel UI to the live positions service.
 */

import { 
    livePositionsService, 
    LivePosition, 
    ClosedTrade,
} from '../live-positions-service';
import { alertService, ALERT_WORKER_URL_CHANGED_EVENT } from '../alert-service';
import { getOptionalElement } from '../dom-utils';
import { uiManager } from '../ui-manager';
import { setMarketSelection } from '../state-actions';
import { dataManager } from '../data-manager';
import { settingsManager } from '../settings-manager';
import { backtestService } from '../backtest-service';
import { loadBuiltInStrategyByKey, strategyRegistry } from '../../strategyRegistry';
import { createAccessibleModal, type AccessibleModalController } from '../modal-accessibility';
import { formatDisplayPrice } from '../price-format';
import { resolveAlertSignalEntryPrice } from '../alert-signal-utils';
import { toBooleanLike, toFiniteNumber as readFiniteNumber } from '../settings-parse-utils';
import { createLivePositionsDom } from '../live-positions-dom';
import {
    readLivePositionsCollapsed,
    writeLivePositionsCollapsed,
    readLivePositionsEnabled,
    writeLivePositionsEnabled,
} from '../live-positions-storage';


// DOM element references
let panel: HTMLElement | null = null;
let list: HTMLElement | null = null;
let empty: HTMLElement | null = null;
let count: HTMLElement | null = null;
let lastUpdated: HTMLElement | null = null;
let refreshBtn: HTMLElement | null = null;
let toggleBtn: HTMLElement | null = null;
let collapseBtn: HTMLElement | null = null;
let collapseIcon: HTMLElement | null = null;
let mismatchBanner: HTMLElement | null = null;
let mismatchText: HTMLElement | null = null;
let pollingStatusBtn: HTMLButtonElement | null = null;
let pollingDot: HTMLElement | null = null;
let pollingText: HTMLElement | null = null;
let detailModal: HTMLElement | null = null;
let detailTitle: HTMLElement | null = null;
let detailLoading: HTMLElement | null = null;
let detailContent: HTMLElement | null = null;
let detailCloseBtn: HTMLButtonElement | null = null;
let detailModalController: AccessibleModalController | null = null;

// State
let isCollapsed = false;
let isLiveUpdatesEnabled = false;
let unsubscribeService: (() => void) | null = null;
let workerUrlListener: ((event: Event) => void) | null = null;

// Format helpers
function toFiniteNumber(value: unknown): number {
    return readFiniteNumber(value) ?? 0;
}

function toBoolean(value: unknown): boolean | null {
    return toBooleanLike(value);
}

function inferRiskToggle(settings: Record<string, unknown>): boolean {
    const riskMode = typeof settings.riskMode === 'string' ? settings.riskMode : 'simple';
    const usesHistoricalLevels = (
        toBoolean(settings.historicalLevelTakeProfitEnabled) === true
        || toBoolean(settings.historicalLevelTakeProfitToggle) === true
        || toBoolean(settings.historicalLevelStopLossEnabled) === true
        || toBoolean(settings.historicalLevelStopLossToggle) === true
    ) && toFiniteNumber(settings.historicalLevelLookbackBars) > 0;
    if (usesHistoricalLevels) {
        return true;
    }

    if (riskMode === 'percentage') {
        return (toBoolean(settings.stopLossEnabled) === true)
            || (toBoolean(settings.takeProfitEnabled) === true)
            || toFiniteNumber(settings.stopLossPercent) > 0
            || toFiniteNumber(settings.takeProfitPercent) > 0
            || (toBoolean(settings.riskMaxHoldEnabled) === true);
    }
    return toFiniteNumber(settings.stopLossAtr) > 0
        || toFiniteNumber(settings.takeProfitAtr) > 0
        || toFiniteNumber(settings.trailingAtr) > 0
        || (toBoolean(settings.riskMaxHoldEnabled) === true && toFiniteNumber(settings.riskMaxHoldBars) > 0);
}

function inferTradeFilterToggle(settings: Record<string, unknown>): boolean {
    if (typeof settings.tradeFilterMode === 'string' && settings.tradeFilterMode !== 'none') {
        return true;
    }

    for (const [key, value] of Object.entries(settings)) {
        if (!key.startsWith('snapshot')) continue;
        if (typeof value === 'boolean' && value) return true;
        if (toFiniteNumber(value) > 0) return true;
    }

    return false;
}

function buildUiCompatibleBacktestSettings(source: unknown): Record<string, unknown> {
    const settings = (source && typeof source === 'object')
        ? { ...(source as Record<string, unknown>) }
        : {};

    if (typeof settings.riskSettingsToggle !== 'boolean') {
        settings.riskSettingsToggle = inferRiskToggle(settings);
    }
    if (typeof settings.tradeFilterSettingsToggle !== 'boolean') {
        settings.tradeFilterSettingsToggle = inferTradeFilterToggle(settings);
    }
    if (typeof settings.entrySettingsToggle !== 'boolean') {
        settings.entrySettingsToggle = settings.tradeFilterSettingsToggle;
    }

    return settings;
}

function formatPrice(price: number | null): string {
    return formatDisplayPrice(price);
}

function formatPnl(pnl: number | null, percent: number | null): string {
    if (pnl === null || !Number.isFinite(pnl)) return '-';
    const sign = pnl >= 0 ? '+' : '';
    return `${sign}${pnl.toFixed(2)} (${sign}${percent?.toFixed(2) ?? '0.00'}%)`;
}

function formatTime(timestamp: number): string {
    const date = new Date(timestamp * 1000);
    return date.toLocaleTimeString('en-US', { 
        hour: '2-digit', 
        minute: '2-digit',
        hour12: false 
    });
}

function formatDuration(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
}

function hasWorkerUrl(url = alertService.getWorkerUrl()): boolean {
    return url.trim().length > 0;
}

function updatePollingStatusUi(url = alertService.getWorkerUrl()): void {
    if (!pollingStatusBtn || !pollingDot || !pollingText) return;

    const workerConfigured = hasWorkerUrl(url);
    const isActive = isLiveUpdatesEnabled && workerConfigured;

    pollingStatusBtn.setAttribute('aria-pressed', String(isLiveUpdatesEnabled));
    pollingDot.classList.toggle('paused', !isActive);

    if (isActive) {
        pollingText.textContent = 'On';
        pollingStatusBtn.title = 'Disable live position auto-refresh';
        return;
    }

    if (isLiveUpdatesEnabled) {
        pollingText.textContent = 'No Worker';
        pollingStatusBtn.title = 'Worker URL is required for live position auto-refresh';
        return;
    }

    pollingText.textContent = 'Off';
    pollingStatusBtn.title = 'Enable live position auto-refresh';
}

function syncPollingWithWorkerUrl(url: string): void {
    if (isLiveUpdatesEnabled && hasWorkerUrl(url)) {
        livePositionsService.startPolling();
    } else {
        livePositionsService.stopPolling();
    }
    updatePollingStatusUi(url);
}

function setLiveUpdatesEnabled(enabled: boolean): void {
    isLiveUpdatesEnabled = enabled;
    writeLivePositionsEnabled(enabled);
    syncPollingWithWorkerUrl(alertService.getWorkerUrl());
}

// UI update functions
function updateLastUpdated(timestamp: number | null): void {
    if (!lastUpdated) return;
    if (!timestamp) {
        lastUpdated.textContent = 'Never';
        return;
    }
    const diff = Date.now() - timestamp;
    if (diff < 60000) {
        lastUpdated.textContent = 'Just now';
    } else if (diff < 3600000) {
        lastUpdated.textContent = `${Math.floor(diff / 60000)}m ago`;
    } else {
        lastUpdated.textContent = new Date(timestamp).toLocaleTimeString();
    }
}

function createPositionCard(position: LivePosition | ClosedTrade): HTMLElement {
    const isClosed = !position.isOpen;
    const isMismatch = position.mismatch;
    
    const card = document.createElement('div');
    card.className = `lp-position${isMismatch ? ' mismatch' : ''}${isClosed ? ' closed' : ''}`;
    card.dataset.streamId = position.streamId;
    
    const pnlClass = position.unrealizedPnl === null 
        ? '' 
        : position.unrealizedPnl >= 0 
            ? 'pnl-positive' 
            : 'pnl-negative';
    
    const displayName = position.configName 
        ? `${position.symbol} (${position.configName})`
        : position.symbol;
    
    const duration = position.isOpen
        ? formatDuration(Math.floor(Date.now() / 1000) - position.entryTime)
        : formatDuration((position as ClosedTrade).exitTime - position.entryTime);
    
    card.innerHTML = `
        <div class="lp-pos-header">
            <span class="lp-pos-symbol">${displayName}</span>
            <span class="lp-pos-direction ${position.direction}">${position.direction.toUpperCase()}</span>
        </div>
        <div class="lp-pos-details">
            <span class="lp-pos-label">Entry</span>
            <span class="lp-pos-value price">${formatPrice(position.entryPrice)}</span>
            
            <span class="lp-pos-label">Current</span>
            <span class="lp-pos-value price">${formatPrice(position.currentPrice)}</span>
            
            ${position.isOpen ? `
                <span class="lp-pos-label">P&L</span>
                <span class="lp-pos-value ${pnlClass}">${formatPnl(position.unrealizedPnl, position.unrealizedPnlPercent)}</span>
            ` : `
                <span class="lp-pos-label">Result</span>
                <span class="lp-pos-value ${(position as ClosedTrade).realizedPnl >= 0 ? 'pnl-positive' : 'pnl-negative'}">
                    ${formatPnl((position as ClosedTrade).realizedPnl, (position as ClosedTrade).realizedPnlPercent)}
                </span>
            `}
            
            <span class="lp-pos-label">Duration</span>
            <span class="lp-pos-value">${duration}</span>
        </div>
        <div class="lp-pos-footer">
            <span class="lp-pos-time">${formatTime(position.entryTime)}</span>
            ${isMismatch ? `
                <span class="lp-pos-mismatch-badge" title="${position.mismatchReason || ''}">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="10" height="10">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                    </svg>
                    Mismatch
                </span>
            ` : `<span class="lp-pos-strategy">${position.strategyKey}</span>`}
        </div>
    `;
    
    card.addEventListener('click', () => handlePositionClick(position));
    return card;
}

function renderPositions(positions: LivePosition[], closedTrades: ClosedTrade[]): void {
    if (!list || !empty || !count || !mismatchBanner || !mismatchText) return;
    
    const listEl = list; // capture non-null reference
    
    const viewMode = livePositionsService.getState().viewMode;
    const itemsToShow = viewMode === 'open' ? positions : closedTrades;
    
    // Update count
    const openCount = positions.length;
    const closedCount = closedTrades.length;
    count.textContent = viewMode === 'open' ? String(openCount) : String(closedCount);
    
    // Show/hide mismatch banner
    const mismatchCount = itemsToShow.filter(p => p.mismatch).length;
    if (mismatchCount > 0 && viewMode === 'open') {
        mismatchBanner.style.display = 'flex';
        mismatchText.textContent = `${mismatchCount} mismatch${mismatchCount > 1 ? 'es' : ''} detected`;
    } else {
        mismatchBanner.style.display = 'none';
    }
    
    // Render list
    if (itemsToShow.length === 0) {
        list.innerHTML = '';
        list.appendChild(empty);
        empty.style.display = 'flex';
        empty.innerHTML = `
            <svg viewBox="0 0 24 24" fill="currentColor" width="24" height="24">
                <path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm-7 2h2v2h-2V5zm0 4h2v2h-2V9zm0 4h2v2h-2v-2zm-4-8h2v2H8V5zm0 4h2v2H8V9zm0 4h2v2H8v-2zM5 17h14v2H5v-2zm2-12h12v10H7V5z"/>
            </svg>
            <p>No ${viewMode} positions</p>
            <span class="lp-hint">${viewMode === 'open'
                ? (isLiveUpdatesEnabled
                    ? 'Subscribe to alerts to track positions'
                    : 'Turn Live On to start polling alert subscriptions')
                : 'Closed trades appear here for verification'}
            </span>
        `;
    } else {
        listEl.innerHTML = '';
        itemsToShow.forEach(item => {
            listEl.appendChild(createPositionCard(item));
        });
    }
}

// Event handlers
async function handlePositionClick(position: LivePosition | ClosedTrade): Promise<void> {
    try {
        setMarketSelection({ symbol: position.symbol, interval: position.interval });

        const symbolInput = getOptionalElement<HTMLInputElement>('symbolInput');
        const intervalSelect = getOptionalElement<HTMLSelectElement>('intervalSelect');
        if (symbolInput) symbolInput.value = position.symbol;
        if (intervalSelect) intervalSelect.value = position.interval;

        const strategy = strategyRegistry.get(position.strategyKey)
            ?? await loadBuiltInStrategyByKey(position.strategyKey);
        if (strategy) {
            const backtestSettings = buildUiCompatibleBacktestSettings(position.backtestSettings);
            await settingsManager.applyStrategyConfig({
                name: '__live_positions_nav__',
                createdAt: new Date().toISOString(),
                updatedAt: new Date().toISOString(),
                strategyKey: position.strategyKey,
                strategyParams: position.strategyParams,
                backtestSettings: backtestSettings as unknown as Parameters<typeof settingsManager.applyStrategyConfig>[0]['backtestSettings'],
            });

            const strategySelect = getOptionalElement<HTMLSelectElement>('strategySelect');
            if (strategySelect) {
                strategySelect.value = position.strategyKey;
            }
        }

        uiManager.showToast(`Loading ${position.symbol} ${position.interval}...`, 'info');
        await dataManager.loadData();
        await backtestService.runCurrentBacktest();
        uiManager.showToast(`Loaded ${position.symbol}`, 'success');
    } catch (err) {
        uiManager.showToast('Failed to load chart: ' + (err instanceof Error ? err.message : String(err)), 'error');
    }
}

function handleRefresh(): void {
    if (!refreshBtn) return;
    refreshBtn.classList.add('spinning');
    livePositionsService.refresh(true).finally(() => {
        setTimeout(() => refreshBtn?.classList.remove('spinning'), 500);
    });
}

function handleToggleView(): void {
    const currentMode = livePositionsService.getState().viewMode;
    const newMode = currentMode === 'open' ? 'closed' : 'open';
    livePositionsService.setViewMode(newMode);
    
    if (toggleBtn) {
        toggleBtn.classList.toggle('active', newMode === 'closed');
        toggleBtn.title = newMode === 'open' ? 'Show closed trades' : 'Show open positions';
    }
}

function handleCollapse(): void {
    isCollapsed = !isCollapsed;
    panel?.classList.toggle('collapsed', isCollapsed);
    
    if (collapseIcon) {
        collapseIcon.style.transform = isCollapsed ? 'rotate(-90deg)' : 'rotate(0deg)';
    }
    
    writeLivePositionsCollapsed(isCollapsed);
}

function handlePollingToggle(): void {
    const nextEnabled = !isLiveUpdatesEnabled;
    setLiveUpdatesEnabled(nextEnabled);

    if (nextEnabled && !hasWorkerUrl()) {
        uiManager.showToast('Configure a Worker URL to enable live positions.', 'info');
    }
}

// Service state update handler
function onServiceStateUpdate(state: ReturnType<typeof livePositionsService.getState>): void {
    renderPositions(state.positions, state.closedTrades);
    updateLastUpdated(state.lastPollTime);
    updatePollingStatusUi();
    
    if (state.error) {
        uiManager.showToast('Live positions error: ' + state.error, 'error');
    }
}

// Detail modal handlers
async function openDetailModal(streamId: string): Promise<void> {
    if (!detailModal || !detailTitle || !detailLoading || !detailContent) return;
    
    detailModalController?.open();
    detailLoading.style.display = '';
    detailContent.style.display = 'none';
    
    try {
        const details = await livePositionsService.getPositionDetails(streamId);
        
        if (!details.position) {
            detailContent.innerHTML = '<p class="lp-empty">Position not found</p>';
            detailLoading.style.display = 'none';
            detailContent.style.display = '';
            return;
        }
        
        detailTitle.textContent = `${details.position.symbol} ${details.position.interval} - Position Details`;
        
        const pos = details.position;
        const isClosed = !pos.isOpen;
        const closedPos = isClosed ? pos as ClosedTrade : null;
        
        const pnlClass = isClosed 
            ? (closedPos?.realizedPnl || 0) >= 0 ? 'positive' : 'negative'
            : (pos.unrealizedPnl || 0) >= 0 ? 'positive' : 'negative';
        
        detailContent.innerHTML = `
            <div class="lp-detail-section">
                <h4>Position Info</h4>
                <div class="lp-detail-grid">
                    <div class="lp-detail-row">
                        <span class="label">Symbol</span>
                        <span class="value">${pos.symbol}</span>
                    </div>
                    <div class="lp-detail-row">
                        <span class="label">Interval</span>
                        <span class="value">${pos.interval}</span>
                    </div>
                    <div class="lp-detail-row">
                        <span class="label">Direction</span>
                        <span class="value">${pos.direction.toUpperCase()}</span>
                    </div>
                    <div class="lp-detail-row">
                        <span class="label">Strategy</span>
                        <span class="value">${pos.strategyKey}</span>
                    </div>
                </div>
            </div>
            
            <div class="lp-detail-section">
                <h4>Entry</h4>
                <div class="lp-detail-grid">
                    <div class="lp-detail-row">
                        <span class="label">Price</span>
                        <span class="value">${formatPrice(pos.entryPrice)}</span>
                    </div>
                    <div class="lp-detail-row">
                        <span class="label">Time</span>
                        <span class="value">${new Date(pos.entryTime * 1000).toLocaleString()}</span>
                    </div>
                </div>
            </div>
            
            ${isClosed ? `
                <div class="lp-detail-section">
                    <h4>Exit</h4>
                    <div class="lp-detail-grid">
                        <div class="lp-detail-row">
                            <span class="label">Price</span>
                            <span class="value">${formatPrice(closedPos?.exitPrice || null)}</span>
                        </div>
                        <div class="lp-detail-row">
                            <span class="label">Time</span>
                            <span class="value">${new Date((closedPos?.exitTime || 0) * 1000).toLocaleString()}</span>
                        </div>
                        <div class="lp-detail-row">
                            <span class="label">Reason</span>
                            <span class="value">${closedPos?.exitReason || 'unknown'}</span>
                        </div>
                    </div>
                </div>
                
                <div class="lp-detail-section">
                    <h4>Result</h4>
                    <div class="lp-detail-grid">
                        <div class="lp-detail-row">
                            <span class="label">P&L</span>
                            <span class="value ${pnlClass}">${formatPnl(closedPos?.realizedPnl || null, closedPos?.realizedPnlPercent || null)}</span>
                        </div>
                    </div>
                </div>
            ` : `
                <div class="lp-detail-section">
                    <h4>Current Status</h4>
                    <div class="lp-detail-grid">
                        <div class="lp-detail-row">
                            <span class="label">Current Price</span>
                            <span class="value">${formatPrice(pos.currentPrice)}</span>
                        </div>
                        <div class="lp-detail-row">
                            <span class="label">Unrealized P&L</span>
                            <span class="value ${pnlClass}">${formatPnl(pos.unrealizedPnl, pos.unrealizedPnlPercent)}</span>
                        </div>
                        ${pos.stopLossPrice ? `
                            <div class="lp-detail-row">
                                <span class="label">Stop Loss</span>
                                <span class="value">${formatPrice(pos.stopLossPrice)}</span>
                            </div>
                        ` : ''}
                        ${pos.takeProfitPrice ? `
                            <div class="lp-detail-row">
                                <span class="label">Take Profit</span>
                                <span class="value">${formatPrice(pos.takeProfitPrice)}</span>
                            </div>
                        ` : ''}
                    </div>
                </div>
            `}
            
            ${pos.mismatch ? `
                <div class="lp-detail-alert">
                    <svg viewBox="0 0 24 24" fill="currentColor" width="16" height="16">
                        <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"/>
                    </svg>
                    <span>${pos.mismatchReason || 'Mismatch detected between worker and local backtest'}</span>
                </div>
                
                <div class="lp-detail-section">
                    <h4>Worker vs Local Comparison</h4>
                    <div class="lp-detail-grid">
                        <div class="lp-detail-row">
                            <span class="label">Worker Signal</span>
                            <span class="value">${pos.lastSignalFromWorker ? 'Present' : 'None'}</span>
                        </div>
                        <div class="lp-detail-row">
                            <span class="label">Local Backtest</span>
                            <span class="value">${pos.localBacktestTrade ? (pos.localBacktestTrade.exitReason === 'end_of_data' ? 'Open' : 'Closed') : 'No trade'}</span>
                        </div>
                    </div>
                </div>
            ` : ''}
            
            <div class="lp-detail-section">
                <h4>Signal History (${details.workerSignals.length})</h4>
                <div class="lp-detail-grid">
                    ${details.workerSignals.slice(0, 5).map((sig, i) => {
                        const displayPrice = resolveAlertSignalEntryPrice(sig);
                        return `
                        <div class="lp-detail-row" style="grid-column: 1 / -1;">
                            <span class="label">#${i + 1} ${sig.direction.toUpperCase()}</span>
                            <span class="value">${formatPrice(displayPrice ?? sig.signal_price)} @ ${formatTime(sig.signal_time)}</span>
                        </div>
                    `;
                    }).join('') || '<span class="label">No signals found</span>'}
                </div>
            </div>
        `;
        
        detailLoading.style.display = 'none';
        detailContent.style.display = '';
    } catch (err) {
        detailContent.innerHTML = `<p class="lp-empty">Error loading details: ${err instanceof Error ? err.message : String(err)}</p>`;
        detailLoading.style.display = 'none';
        detailContent.style.display = '';
    }
}

function closeDetailModal(): void {
    detailModalController?.close();
}

// Initialization
export function initLivePositionsHandlers(): void {
    detailModalController = createAccessibleModal({
        overlayId: 'lpDetailModal',
        titleId: 'lpDetailTitle',
        initialFocusSelector: '#lpDetailClose',
    });

    const dom = createLivePositionsDom();
    panel = dom.panel;
    list = dom.list;
    empty = dom.empty;
    count = dom.count;
    lastUpdated = dom.lastUpdated;
    refreshBtn = dom.refreshBtn;
    toggleBtn = dom.viewToggle;
    collapseBtn = dom.collapseBtn;
    collapseIcon = dom.collapseIcon;
    mismatchBanner = dom.mismatchBanner;
    mismatchText = dom.mismatchText;
    pollingStatusBtn = dom.pollingStatus;
    pollingDot = dom.pollingDot;
    pollingText = dom.pollingText;
    detailModal = dom.detailModal;
    detailTitle = dom.detailTitle;
    detailLoading = dom.detailLoading;
    detailContent = dom.detailContent;
    detailCloseBtn = dom.detailClose;
    
    // Restore collapse state
    isCollapsed = readLivePositionsCollapsed();
    if (isCollapsed && panel) {
        panel.classList.add('collapsed');
        if (collapseIcon) collapseIcon.style.transform = 'rotate(-90deg)';
    }

    isLiveUpdatesEnabled = readLivePositionsEnabled();
    updatePollingStatusUi();
    
    // Bind event listeners
    refreshBtn?.addEventListener('click', handleRefresh);
    toggleBtn?.addEventListener('click', handleToggleView);
    collapseBtn?.addEventListener('click', handleCollapse);
    pollingStatusBtn?.addEventListener('click', handlePollingToggle);
    
    // Detail modal close
    detailCloseBtn?.addEventListener('click', closeDetailModal);
    detailModal?.addEventListener('click', (e) => {
        if (e.target === e.currentTarget) closeDetailModal();
    });
    
    // Double-click on position opens detail modal
    list?.addEventListener('dblclick', (e) => {
        const card = (e.target as HTMLElement).closest('.lp-position') as HTMLElement | null;
        if (card?.dataset?.streamId) {
            void openDetailModal(card.dataset.streamId);
        }
    });
    
    // Subscribe to service updates
    unsubscribeService = livePositionsService.subscribe(onServiceStateUpdate);
    onServiceStateUpdate(livePositionsService.getState());
    
    // Start/stop polling from current worker URL and react to URL changes.
    syncPollingWithWorkerUrl(alertService.getWorkerUrl());
    workerUrlListener = (event: Event) => {
        const custom = event as CustomEvent<{ url?: string }>;
        const nextUrl = custom.detail?.url ?? alertService.getWorkerUrl();
        syncPollingWithWorkerUrl(nextUrl);
    };
    window.addEventListener(ALERT_WORKER_URL_CHANGED_EVENT, workerUrlListener as EventListener);
}

// Cleanup function for HMR
export function disposeLivePositionsHandlers(): void {
    if (unsubscribeService) {
        unsubscribeService();
        unsubscribeService = null;
    }
    if (workerUrlListener) {
        window.removeEventListener(ALERT_WORKER_URL_CHANGED_EVENT, workerUrlListener as EventListener);
        workerUrlListener = null;
    }
    livePositionsService.stopPolling();
}
