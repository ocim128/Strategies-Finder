/**
 * Scanner Manager
 * UI controller and state manager for the scanner feature
 */

import { scannerEngine } from './scanner-engine';
import type {
    ScannerConfig,
    ScannerState,
    ScanResult,
    ScannerEvent,
    ScannerEventListener,
} from './scanner-types';
import { INITIAL_SCANNER_STATE } from './scanner-types';

// ============================================================================
// Scanner Manager Class
// ============================================================================

export class ScannerManager {
    private state: ScannerState = { ...INITIAL_SCANNER_STATE };
    private listeners: Set<ScannerEventListener> = new Set();
    private config: ScannerConfig;
    private autoRefreshTimer: ReturnType<typeof setInterval> | null = null;

    constructor(config?: Partial<ScannerConfig>) {
        this.config = {
            strategyConfigs: [],
            interval: '1h',
            maxPairs: 120,
            signalFreshnessBars: 3,
            ...config,
        };
    }

    // ========================================================================
    // Public API
    // ========================================================================

    /**
     * Start a new scan
     */
    async startScan(): Promise<void> {
        if (this.state.isScanning) {
            console.warn('Scan already in progress');
            return;
        }

        this.updateState({
            isScanning: true,
            progress: null,
            error: null,
        });
        this.emit({ type: 'scan-started' });

        try {
            let finalResults: ScanResult[] = [];

            const generator = scannerEngine.scan(this.config, (progress) => {
                this.updateState({ progress });
                this.emit({ type: 'scan-progress', progress });
            });

            // Consume the generator
            let result = await generator.next();
            while (!result.done) {
                result = await generator.next();
            }
            finalResults = result.value;

            this.updateState({
                isScanning: false,
                results: finalResults,
                lastScanTime: new Date(),
                progress: null,
            });
            this.emit({ type: 'scan-completed', results: finalResults });
        } catch (err) {
            const error = err instanceof Error ? err.message : 'Unknown error';
            this.updateState({
                isScanning: false,
                error,
                progress: null,
            });
            this.emit({ type: 'scan-error', error });
        }
    }

    /**
     * Cancel the current scan
     */
    cancelScan(): void {
        if (!this.state.isScanning) return;

        scannerEngine.cancel();
        this.updateState({
            isScanning: false,
            progress: null,
        });
        this.emit({ type: 'scan-cancelled' });
    }

    /**
     * Update scanner configuration
     */
    updateConfig(updates: Partial<ScannerConfig>): void {
        this.config = { ...this.config, ...updates };

        // Restart auto-refresh if interval changed
        if (updates.autoRefreshMs !== undefined) {
            this.setupAutoRefresh();
        }
    }

    /**
     * Get current configuration
     */
    getConfig(): ScannerConfig {
        return { ...this.config };
    }

    /**
     * Get current state
     */
    getState(): ScannerState {
        return { ...this.state };
    }

    /**
     * Get scan results
     */
    getResults(): ScanResult[] {
        return [...this.state.results];
    }

    /**
     * Enable/disable auto-refresh
     */
    setAutoRefresh(enabled: boolean, intervalMs?: number): void {
        if (enabled && intervalMs) {
            this.config.autoRefreshMs = intervalMs;
        } else {
            this.config.autoRefreshMs = undefined;
        }
        this.setupAutoRefresh();
    }

    /**
     * Subscribe to scanner events
     */
    subscribe(listener: ScannerEventListener): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /**
     * Cleanup resources
     */
    destroy(): void {
        this.cancelScan();
        this.clearAutoRefresh();
        this.listeners.clear();
    }

    // ========================================================================
    // Private Methods
    // ========================================================================

    private updateState(updates: Partial<ScannerState>): void {
        this.state = { ...this.state, ...updates };
    }

    private emit(event: ScannerEvent): void {
        this.listeners.forEach((listener) => {
            try {
                listener(event);
            } catch (err) {
                console.error('Scanner event listener error:', err);
            }
        });
    }

    private setupAutoRefresh(): void {
        this.clearAutoRefresh();

        if (this.config.autoRefreshMs && this.config.autoRefreshMs > 0) {
            this.autoRefreshTimer = setInterval(() => {
                if (!this.state.isScanning) {
                    this.startScan();
                }
            }, this.config.autoRefreshMs);
        }
    }

    private clearAutoRefresh(): void {
        if (this.autoRefreshTimer) {
            clearInterval(this.autoRefreshTimer);
            this.autoRefreshTimer = null;
        }
    }
}

// Export singleton instance
export const scannerManager = new ScannerManager();
