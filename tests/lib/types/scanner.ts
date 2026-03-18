import type { BacktestSettings, Signal, OHLCVData } from "./strategies";

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
    /** Candles loaded per pair for scan speed (default: 1000) */
    scanLookbackBars: number;
    /** Optional auto-refresh interval in milliseconds */
    autoRefreshMs?: number;
}

export const DEFAULT_SCANNER_CONFIG: ScannerConfig = {
    strategyConfigs: [],
    interval: '2h',
    maxPairs: 120,
    signalFreshnessBars: 3,
    scanLookbackBars: 1000,
    autoRefreshMs: undefined,
};

export interface ScanResult {
    /** Trading pair symbol, e.g., "ETHUSDT" */
    symbol: string;
    /** Display name, e.g., "ETH/USDT" */
    displayName: string;
    /** Strategy that generated the signal */
    strategy: string;
    /** Strategy key used for execution/subscription */
    strategyKey: string;
    /** The signal details */
    signal: Signal;
    /** Current price at time of scan */
    currentPrice: number;
    /** Number of bars since signal was generated */
    signalAge: number;
    /** Trade direction derived from signal type */
    direction: 'long' | 'short';
    /** Take profit target price (if configured in strategy) */
    targetPrice: number | null;
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

export interface PairScanData {
    symbol: string;
    displayName: string;
    data: OHLCVData[];
}
