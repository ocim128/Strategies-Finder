/**
 * Scanner Types and Interfaces
 * Types for the multi-pair Binance scanner feature
 */

import type { Signal, OHLCVData, BacktestSettings } from '../strategies/types';

// ============================================================================
// Configuration Types
// ============================================================================

export interface StrategyConfigEntry {
    /** Config name from settingsManager */
    name: string;
    /** Strategy key from strategyRegistry */
    strategyKey: string;
    /** Strategy parameters */
    strategyParams: Record<string, number>;
    /** Full backtest settings for accurate signal processing */
    backtestSettings?: BacktestSettings;
}

export interface ScannerConfig {
    /** Strategy configurations to scan */
    strategyConfigs: StrategyConfigEntry[];
    /** Timeframe interval, e.g., "1h", "4h", "1d" */
    interval: string;
    /** Maximum number of pairs to scan (default: 120) */
    maxPairs: number;
    /** Only show signals within last N bars (default: 3) */
    signalFreshnessBars: number;
    /** Optional auto-refresh interval in milliseconds */
    autoRefreshMs?: number;
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
    strategyConfigs: [],
    interval: '2h',
    maxPairs: 120,
    signalFreshnessBars: 3,
    autoRefreshMs: undefined,
};

// ============================================================================
// Result Types
// ============================================================================

export interface ScanResult {
    /** Trading pair symbol, e.g., "ETHUSDT" */
    symbol: string;
    /** Display name, e.g., "ETH/USDT" */
    displayName: string;
    /** Strategy that generated the signal */
    strategy: string;
    /** The signal details */
    signal: Signal;
    /** Current price at time of scan */
    currentPrice: number;
    /** Number of bars since signal was generated */
    signalAge: number;
    /** Trade direction derived from signal type */
    direction: 'long' | 'short';
}

export interface ScanProgress {
    /** Current pair being scanned (1-indexed) */
    current: number;
    /** Total pairs to scan */
    total: number;
    /** Current symbol being scanned */
    currentSymbol: string;
    /** Estimated time remaining in milliseconds */
    estimatedRemainingMs: number;
}

// ============================================================================
// State Types
// ============================================================================

export interface ScannerState {
    /** Whether a scan is currently in progress */
    isScanning: boolean;
    /** Current progress (null if not scanning) */
    progress: ScanProgress | null;
    /** Results from the last completed scan */
    results: ScanResult[];
    /** Timestamp of last completed scan */
    lastScanTime: Date | null;
    /** Error message if scan failed */
    error: string | null;
}

export const INITIAL_SCANNER_STATE: ScannerState = {
    isScanning: false,
    progress: null,
    results: [],
    lastScanTime: null,
    error: null,
};

// ============================================================================
// Event Types
// ============================================================================

export type ScannerEventType =
    | 'scan-started'
    | 'scan-progress'
    | 'scan-completed'
    | 'scan-error'
    | 'scan-cancelled';

export interface ScannerEvent {
    type: ScannerEventType;
    progress?: ScanProgress;
    results?: ScanResult[];
    error?: string;
}

export type ScannerEventListener = (event: ScannerEvent) => void;

// ============================================================================
// Internal Types
// ============================================================================

export interface PairScanData {
    symbol: string;
    displayName: string;
    data: OHLCVData[];
}
