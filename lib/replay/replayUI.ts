/**
 * Replay UI Controller
 * 
 * Handles all UI interactions for the replay feature including
 * transport controls, progress bar, speed slider, and signal log.
 */

import type { ReplayManager } from './replayManager';
import type { ReplayEvent, ReplayStatus, SignalWithAnnotation } from './replayTypes';
import type { OpenPosition } from './liveTradeTypes';
import { state } from '../state';

// ============================================================================
// ReplayUI Class
// ============================================================================

export class ReplayUI {
    private replayManager: ReplayManager;
    private unsubscribe: (() => void) | null = null;
    private isDraggingProgress: boolean = false;
    private isInitialized: boolean = false;

    // Element references
    private elements: {
        statusDot?: HTMLElement;
        statusText?: HTMLElement;
        currentBar?: HTMLElement;
        totalBars?: HTMLElement;
        progress?: HTMLElement;
        progressFill?: HTMLElement;
        progressThumb?: HTMLElement;
        playPauseBtn?: HTMLButtonElement;
        stopBtn?: HTMLButtonElement;
        stepForwardBtn?: HTMLButtonElement;
        stepBackBtn?: HTMLButtonElement;
        speedSlider?: HTMLInputElement;
        speedValue?: HTMLElement;
        startBtn?: HTMLButtonElement;
        signalList?: HTMLElement;
        signalCount?: HTMLElement;
        // Position panel elements
        positionPanel?: HTMLElement;
        positionDirection?: HTMLElement;
        positionEntry?: HTMLElement;
        positionSize?: HTMLElement;
        positionPnL?: HTMLElement;
        positionStopLoss?: HTMLElement;
        positionTakeProfit?: HTMLElement;
        equityDisplay?: HTMLElement;
    } = {};

    constructor(replayManager: ReplayManager) {
        this.replayManager = replayManager;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Initialization
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Initialize the UI - call after DOM is ready
     */
    public init(): void {
        if (this.isInitialized) return;

        try {
            this.cacheElements();
            this.bindEvents();
            this.subscribeToReplayEvents();
            this.updateStartButtonState();
            this.isInitialized = true;
            console.log('[ReplayUI] Initialized');
        } catch (error) {
            console.warn('[ReplayUI] Initialization failed (tab may not be active):', error);
        }
    }

    /**
     * Re-initialize when tab becomes visible
     */
    public reinit(): void {
        this.isInitialized = false;
        this.init();
    }

    /**
     * Cache DOM element references
     */
    private cacheElements(): void {
        this.elements = {
            statusDot: document.getElementById('replayStatusDot') || undefined,
            statusText: document.getElementById('replayStatusText') || undefined,
            currentBar: document.getElementById('replayCurrentBar') || undefined,
            totalBars: document.getElementById('replayTotalBars') || undefined,
            progress: document.getElementById('replayProgress') || undefined,
            progressFill: document.getElementById('replayProgressFill') || undefined,
            progressThumb: document.getElementById('replayProgressThumb') || undefined,
            playPauseBtn: document.getElementById('replayPlayPause') as HTMLButtonElement || undefined,
            stopBtn: document.getElementById('replayStop') as HTMLButtonElement || undefined,
            stepForwardBtn: document.getElementById('replayStepForward') as HTMLButtonElement || undefined,
            stepBackBtn: document.getElementById('replayStepBack') as HTMLButtonElement || undefined,
            speedSlider: document.getElementById('replaySpeedSlider') as HTMLInputElement || undefined,
            speedValue: document.getElementById('replaySpeedValue') || undefined,
            startBtn: document.getElementById('replayStartBtn') as HTMLButtonElement || undefined,
            signalList: document.getElementById('replaySignalList') || undefined,
            signalCount: document.getElementById('replaySignalCount') || undefined,
            // Position panel elements
            positionPanel: document.getElementById('replayPositionPanel') || undefined,
            positionDirection: document.getElementById('replayPositionDirection') || undefined,
            positionEntry: document.getElementById('replayPositionEntry') || undefined,
            positionSize: document.getElementById('replayPositionSize') || undefined,
            positionPnL: document.getElementById('replayPositionPnL') || undefined,
            positionStopLoss: document.getElementById('replayPositionStopLoss') || undefined,
            positionTakeProfit: document.getElementById('replayPositionTakeProfit') || undefined,
            equityDisplay: document.getElementById('replayEquityDisplay') || undefined,
        };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Event Binding
    // ─────────────────────────────────────────────────────────────────────────

    private bindEvents(): void {
        // Transport controls
        this.elements.playPauseBtn?.addEventListener('click', this.onPlayPauseClick);
        this.elements.stopBtn?.addEventListener('click', this.onStopClick);
        this.elements.stepForwardBtn?.addEventListener('click', this.onStepForward);
        this.elements.stepBackBtn?.addEventListener('click', this.onStepBack);
        this.elements.startBtn?.addEventListener('click', this.onStartClick);

        // Speed slider
        this.elements.speedSlider?.addEventListener('input', this.onSpeedSliderChange);

        // Speed presets
        document.querySelectorAll('.speed-preset').forEach(btn => {
            btn.addEventListener('click', this.onSpeedPresetClick);
        });

        // Progress bar seeking
        this.elements.progress?.addEventListener('mousedown', this.onProgressMouseDown);
        document.addEventListener('mousemove', this.onProgressMouseMove);
        document.addEventListener('mouseup', this.onProgressMouseUp);

        // Keyboard shortcuts
        document.addEventListener('keydown', this.onKeyDown);

        // Subscribe to backtest results for enabling start button
        state.subscribe('currentBacktestResult', this.onBacktestResultChange);
    }

    private unbindEvents(): void {
        this.elements.playPauseBtn?.removeEventListener('click', this.onPlayPauseClick);
        this.elements.stopBtn?.removeEventListener('click', this.onStopClick);
        this.elements.stepForwardBtn?.removeEventListener('click', this.onStepForward);
        this.elements.stepBackBtn?.removeEventListener('click', this.onStepBack);
        this.elements.startBtn?.removeEventListener('click', this.onStartClick);
        this.elements.speedSlider?.removeEventListener('input', this.onSpeedSliderChange);

        document.querySelectorAll('.speed-preset').forEach(btn => {
            btn.removeEventListener('click', this.onSpeedPresetClick);
        });

        this.elements.progress?.removeEventListener('mousedown', this.onProgressMouseDown);
        document.removeEventListener('mousemove', this.onProgressMouseMove);
        document.removeEventListener('mouseup', this.onProgressMouseUp);
        document.removeEventListener('keydown', this.onKeyDown);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Replay Event Subscription
    // ─────────────────────────────────────────────────────────────────────────

    private subscribeToReplayEvents(): void {
        this.unsubscribe = this.replayManager.subscribe(this.handleReplayEvent);
    }

    private handleReplayEvent = (event: ReplayEvent): void => {
        switch (event.type) {
            case 'bar-advance':
            case 'seek':
                this.updateProgress(event.barIndex, event.totalBars);
                break;
            case 'signal-triggered':
                if (event.signal) {
                    this.addSignalToLog(event.signal);
                }
                break;
            case 'status-change':
                this.updateStatus(event.status);
                break;
            case 'speed-change':
                this.updateSpeedDisplay(event.speed);
                break;
            case 'replay-complete':
                this.onReplayComplete();
                break;
            case 'reset':
                this.resetUI();
                break;
            case 'position-opened':
            case 'position-closed':
            case 'pnl-update':
                this.updatePositionPanel(event.position, event.equity, event.unrealizedPnL);
                break;
        }
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Event Handlers
    // ─────────────────────────────────────────────────────────────────────────

    private onPlayPauseClick = (): void => {
        const replayState = this.replayManager.getState();

        if (replayState.status === 'playing') {
            this.replayManager.pause();
        } else if (replayState.status === 'paused') {
            this.replayManager.resume();
        } else if (replayState.status === 'idle' || replayState.status === 'stopped' || replayState.status === 'paused') {
            this.startReplay();
        }
    };

    private onStopClick = (): void => {
        this.replayManager.stop();
        state.set('replayMode', false);
    };

    private onStepForward = (): void => {
        this.replayManager.stepForward();
    };

    private onStepBack = (): void => {
        this.replayManager.stepBackward();
    };

    private onStartClick = (): void => {
        this.startReplay();
    };

    private onSpeedSliderChange = (e: Event): void => {
        const slider = e.target as HTMLInputElement;
        const speed = parseFloat(slider.value);
        this.replayManager.setSpeed(speed);
        this.updateSpeedPresetButtons(speed);
    };

    private onSpeedPresetClick = (e: Event): void => {
        const btn = e.currentTarget as HTMLButtonElement;
        const speed = parseFloat(btn.dataset.speed || '1');

        this.replayManager.setSpeed(speed);

        // Update slider
        if (this.elements.speedSlider) {
            this.elements.speedSlider.value = speed.toString();
        }

        // Update preset buttons
        this.updateSpeedPresetButtons(speed);
    };

    private onProgressMouseDown = (e: MouseEvent): void => {
        this.isDraggingProgress = true;
        this.elements.progress?.classList.add('dragging');
        this.seekToPosition(e);
    };

    private onProgressMouseMove = (e: MouseEvent): void => {
        if (!this.isDraggingProgress) return;
        this.seekToPosition(e);
    };

    private onProgressMouseUp = (): void => {
        if (this.isDraggingProgress) {
            this.isDraggingProgress = false;
            this.elements.progress?.classList.remove('dragging');
        }
    };

    private onKeyDown = (e: KeyboardEvent): void => {
        // Only handle if replay tab is active
        if (!this.isReplayTabActive()) return;

        switch (e.code) {
            case 'Space':
                e.preventDefault();
                this.onPlayPauseClick();
                break;
            case 'ArrowRight':
                e.preventDefault();
                this.onStepForward();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                this.onStepBack();
                break;
            case 'Escape':
                e.preventDefault();
                this.onStopClick();
                break;
        }
    };

    private onBacktestResultChange = (): void => {
        this.updateStartButtonState();
    };

    // ─────────────────────────────────────────────────────────────────────────
    // UI Updates
    // ─────────────────────────────────────────────────────────────────────────

    private updateProgress(current: number, total: number): void {
        if (this.elements.currentBar) {
            this.elements.currentBar.textContent = (current + 1).toString();
        }
        if (this.elements.totalBars) {
            this.elements.totalBars.textContent = total.toString();
        }

        const percent = total > 0 ? (current / (total - 1)) * 100 : 0;

        if (this.elements.progressFill) {
            this.elements.progressFill.style.width = `${percent}%`;
        }
        if (this.elements.progressThumb) {
            this.elements.progressThumb.style.left = `${percent}%`;
        }
    }

    private updateStatus(status: ReplayStatus): void {
        // Update status dot
        if (this.elements.statusDot) {
            this.elements.statusDot.className = 'replay-status-dot ' + status;
        }

        // Update status text
        if (this.elements.statusText) {
            const statusMap: Record<ReplayStatus, string> = {
                idle: 'Ready',
                playing: 'Playing',
                paused: 'Paused',
                stopped: 'Stopped',
            };
            this.elements.statusText.textContent = statusMap[status];
        }

        // Update play/pause button
        if (this.elements.playPauseBtn) {
            this.elements.playPauseBtn.classList.toggle('playing', status === 'playing');
        }

        // Update button states
        const isActive = status === 'playing' || status === 'paused';
        if (this.elements.stopBtn) {
            this.elements.stopBtn.disabled = !isActive;
        }
        if (this.elements.stepForwardBtn) {
            this.elements.stepForwardBtn.disabled = status === 'playing';
        }
        if (this.elements.stepBackBtn) {
            this.elements.stepBackBtn.disabled = status === 'playing';
        }
    }

    private updateSpeedDisplay(speed: number): void {
        if (this.elements.speedValue) {
            this.elements.speedValue.textContent = `${speed.toFixed(1)}x`;
        }
        if (this.elements.speedSlider) {
            this.elements.speedSlider.value = speed.toString();
        }
        this.updateSpeedPresetButtons(speed);
    }

    private updateSpeedPresetButtons(speed: number): void {
        document.querySelectorAll('.speed-preset').forEach(btn => {
            const btnSpeed = parseFloat((btn as HTMLButtonElement).dataset.speed || '0');
            btn.classList.toggle('active', Math.abs(btnSpeed - speed) < 0.01);
        });
    }

    private updateStartButtonState(): void {
        if (!this.elements.startBtn) return;

        const hasBacktestResult = state.currentBacktestResult !== null;
        const hasData = state.ohlcvData.length > 0;

        this.elements.startBtn.disabled = !hasBacktestResult || !hasData;
    }

    public addSignalToLog(signal: SignalWithAnnotation): void {
        if (!this.elements.signalList) return;

        // Remove empty state if present
        const emptyState = this.elements.signalList.querySelector('.replay-signals-empty');
        if (emptyState) {
            emptyState.remove();
        }

        // Create signal item
        const item = document.createElement('div');
        item.className = `replay-signal-item ${signal.type}`;

        const iconSvg = signal.type === 'buy'
            ? '<path d="M7 14l5-5 5 5H7z"/>'
            : '<path d="M7 10l5 5 5-5H7z"/>';

        item.innerHTML = `
            <div class="replay-signal-icon">
                <svg viewBox="0 0 24 24" fill="currentColor">${iconSvg}</svg>
            </div>
            <div class="replay-signal-content">
                <div class="replay-signal-header">
                    <span class="replay-signal-type">${signal.type}</span>
                    <span class="replay-signal-bar">Bar ${signal.barIndex + 1}</span>
                </div>
                <div class="replay-signal-annotation">${this.escapeHtml(signal.annotation)}</div>
                <div class="replay-signal-price">@ ${this.formatPrice(signal.price)}</div>
            </div>
        `;

        // Add to list (newest at top)
        this.elements.signalList.insertBefore(item, this.elements.signalList.firstChild);

        // Update count
        this.updateSignalCount();

        // Auto-scroll to show new signal
        item.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    public clearSignalLog(): void {
        if (!this.elements.signalList) return;

        this.elements.signalList.innerHTML = `
            <div class="replay-signals-empty">
                <svg viewBox="0 0 24 24" fill="currentColor">
                    <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-6h2v6zm0-8h-2V7h2v2z"/>
                </svg>
                <p>No signals yet</p>
                <span>Start replay to see signals</span>
            </div>
        `;
        this.updateSignalCount();
    }

    private updateSignalCount(): void {
        if (!this.elements.signalCount || !this.elements.signalList) return;

        const count = this.elements.signalList.querySelectorAll('.replay-signal-item').length;
        this.elements.signalCount.textContent = count.toString();
    }

    /**
     * Update position panel with current trade info and PnL
     */
    private updatePositionPanel(
        position: OpenPosition | null | undefined,
        equity: number | undefined,
        unrealizedPnL: number | undefined
    ): void {
        // Update equity display
        if (this.elements.equityDisplay && equity !== undefined) {
            this.elements.equityDisplay.textContent = this.formatPrice(equity);
        }

        // Show/hide position panel based on whether we have an open position
        if (!position) {
            this.clearPositionPanel();
            return;
        }

        // Show the position panel
        if (this.elements.positionPanel) {
            this.elements.positionPanel.classList.add('active');
            this.elements.positionPanel.classList.remove('long', 'short');
            this.elements.positionPanel.classList.add(position.direction);
        }

        // Update direction
        if (this.elements.positionDirection) {
            this.elements.positionDirection.textContent = position.direction.toUpperCase();
            this.elements.positionDirection.className = `position-direction ${position.direction}`;
        }

        // Update entry price
        if (this.elements.positionEntry) {
            this.elements.positionEntry.textContent = this.formatPrice(position.entryPrice);
        }

        // Update size
        if (this.elements.positionSize) {
            this.elements.positionSize.textContent = position.size.toFixed(4);
        }

        // Update unrealized PnL with color coding
        if (this.elements.positionPnL) {
            const pnl = unrealizedPnL ?? position.unrealizedPnL;
            const pnlPercent = position.unrealizedPnLPercent;
            const sign = pnl >= 0 ? '+' : '';
            this.elements.positionPnL.textContent = `${sign}${this.formatPrice(pnl)} (${sign}${pnlPercent.toFixed(2)}%)`;
            this.elements.positionPnL.className = `position-pnl ${pnl >= 0 ? 'positive' : 'negative'}`;
        }

        // Update stop loss
        if (this.elements.positionStopLoss) {
            if (position.stopLossPrice !== null) {
                this.elements.positionStopLoss.textContent = this.formatPrice(position.stopLossPrice);
                this.elements.positionStopLoss.classList.remove('disabled');
            } else {
                this.elements.positionStopLoss.textContent = '-';
                this.elements.positionStopLoss.classList.add('disabled');
            }
        }

        // Update take profit
        if (this.elements.positionTakeProfit) {
            if (position.takeProfitPrice !== null) {
                this.elements.positionTakeProfit.textContent = this.formatPrice(position.takeProfitPrice);
                this.elements.positionTakeProfit.classList.remove('disabled');
            } else {
                this.elements.positionTakeProfit.textContent = '-';
                this.elements.positionTakeProfit.classList.add('disabled');
            }
        }
    }

    /**
     * Clear the position panel (when no open position)
     */
    private clearPositionPanel(): void {
        if (this.elements.positionPanel) {
            this.elements.positionPanel.classList.remove('active', 'long', 'short');
        }
        if (this.elements.positionDirection) {
            this.elements.positionDirection.textContent = '-';
            this.elements.positionDirection.className = 'position-direction';
        }
        if (this.elements.positionEntry) {
            this.elements.positionEntry.textContent = '-';
        }
        if (this.elements.positionSize) {
            this.elements.positionSize.textContent = '-';
        }
        if (this.elements.positionPnL) {
            this.elements.positionPnL.textContent = '-';
            this.elements.positionPnL.className = 'position-pnl';
        }
        if (this.elements.positionStopLoss) {
            this.elements.positionStopLoss.textContent = '-';
            this.elements.positionStopLoss.classList.add('disabled');
        }
        if (this.elements.positionTakeProfit) {
            this.elements.positionTakeProfit.textContent = '-';
            this.elements.positionTakeProfit.classList.add('disabled');
        }
    }

    private resetUI(): void {
        this.updateStatus('idle');
        this.updateProgress(0, 0);
        this.clearSignalLog();
        this.clearPositionPanel();
        this.updateStartButtonState();
        state.set('replayMode', false);
    }

    private onReplayComplete(): void {
        this.updateStatus('stopped');
        state.set('replayMode', false);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Replay Control
    // ─────────────────────────────────────────────────────────────────────────
    private startReplay(): void {
        if (state.ohlcvData.length === 0) {
            console.warn('[ReplayUI] No data available for replay');
            return;
        }

        // Clear previous signals and trades
        this.clearSignalLog();
        state.clearTradeResults();

        // CRITICAL: Set replay mode BEFORE starting manager to block backtest updates
        state.set('replayMode', true);
        console.log('[ReplayUI] Starting replay, set replayMode=true');

        // Start replay with current strategy and data
        this.replayManager.start({
            strategyKey: state.currentStrategyKey,
            params: this.getCurrentStrategyParams(),
            data: state.ohlcvData,
            initialSpeed: parseFloat(this.elements.speedSlider?.value || '1'),
        });
    }

    private getCurrentStrategyParams(): Record<string, number> {
        // Get params from the param inputs in the settings tab
        const params: Record<string, number> = {};
        const inputs = document.querySelectorAll('#paramContainer input[type="number"]');

        inputs.forEach((input) => {
            const inputEl = input as HTMLInputElement;
            const key = inputEl.dataset.param;
            if (key) {
                params[key] = parseFloat(inputEl.value) || 0;
            }
        });

        return params;
    }

    private seekToPosition(e: MouseEvent): void {
        if (!this.elements.progress) return;

        const rect = this.elements.progress.getBoundingClientRect();
        const percent = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));

        const replayState = this.replayManager.getState();
        const targetBar = Math.round(percent * (replayState.totalBars - 1));

        this.replayManager.seekTo({ barIndex: targetBar });
    }

    private isReplayTabActive(): boolean {
        const replayTab = document.querySelector('.panel-tab[data-tab="replay"]');
        return replayTab?.classList.contains('active') ?? false;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers
    // ─────────────────────────────────────────────────────────────────────────

    private formatPrice(price: number): string {
        if (price >= 1000) return price.toFixed(2);
        if (price >= 1) return price.toFixed(4);
        return price.toFixed(6);
    }

    private escapeHtml(text: string): string {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Cleanup
    // ─────────────────────────────────────────────────────────────────────────

    public destroy(): void {
        if (this.unsubscribe) {
            this.unsubscribe();
            this.unsubscribe = null;
        }
        this.unbindEvents();
        this.elements = {};
        this.isInitialized = false;
    }
}
