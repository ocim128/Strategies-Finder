import type { AdvancedSizingSettings, TradeSizingMode } from "../../types/backtest";
import type { OHLCVData } from "../../types/strategies";

// ============================================================================
// Configuration Types
// ============================================================================

export interface MonteCarloSettings {
    /** Number of simulation iterations */
    simulations: number;
    /** Random seed for reproducibility */
    seed: number;
    /** Enable trade sequence randomization */
    enableSequenceRandomization: boolean;
    /** Enable bootstrap resampling */
    enableBootstrap: boolean;
    /** Ruin threshold as % of initial capital */
    ruinThresholdPercent: number;
    /** Initial capital for simulation */
    initialCapital: number;
}

export interface MonteCarloSizingConfig {
    mode: TradeSizingMode;
    positionSizePercent: number;
    fixedTradeAmount: number;
    commissionPercent: number;
    advancedSizing?: AdvancedSizingSettings;
    ohlcvData?: OHLCVData[];
}

// ============================================================================
// Result Types
// ============================================================================

export interface MonteCarloSimulation {
    simulationId: number;
    netProfit: number;
    netProfitPercent: number;
    maxDrawdown: number;
    maxDrawdownPercent: number;
    sharpeRatio: number;
    winRate: number;
    finalEquity: number;
    equityCurve: number[];
    ruinOccurred: boolean;
    timeToRuin?: number;
}

export interface MonteCarloMetricSamples {
    netProfitValues: number[];
    maxDrawdownPercentValues: number[];
    sharpeRatioValues: number[];
    winRateValues: number[];
}

export interface MonteCarloCoverageSummary {
    usableTrades: number;
    totalTrades: number;
    overallCoverage: number;
    dataCoverage: number;
    missingPriceTrades: number;
    missingOutcomeTrades: number;
    duplicateTradesIgnored: number;
    filteredTradesIgnored: number;
}

export interface RuinProbabilityMetrics {
    /** Probability of equity falling below threshold */
    ruinProbability: number;
    /** Expected number of trades until ruin */
    expectedTradesToRuin: number | null;
    /** Median trades to ruin (for ruined simulations) */
    medianTradesToRuin: number | null;
    /** Percentage of simulations that hit ruin */
    ruinRate: number;
    /** Distribution of maximum drawdowns */
    maxDrawdownDistribution: {
        mean: number;
        median: number;
        stdDev: number;
        percentile5: number;
        percentile25: number;
        percentile75: number;
        percentile95: number;
    };
}

export interface ConfidenceIntervals {
    netProfit: {
        observed: number;
        ci50Lower: number;
        ci50Upper: number;
        ci90Lower: number;
        ci90Upper: number;
        ci95Lower: number;
        ci95Upper: number;
    };
    maxDrawdown: {
        observed: number;
        ci50Lower: number;
        ci50Upper: number;
        ci90Lower: number;
        ci90Upper: number;
        ci95Lower: number;
        ci95Upper: number;
    };
    sharpeRatio: {
        observed: number;
        ci50Lower: number;
        ci50Upper: number;
        ci90Lower: number;
        ci90Upper: number;
        ci95Lower: number;
        ci95Upper: number;
    };
    winRate: {
        observed: number;
        ci50Lower: number;
        ci50Upper: number;
        ci90Lower: number;
        ci90Upper: number;
        ci95Lower: number;
        ci95Upper: number;
    };
}

export interface MonteCarloResult {
    status: "success" | "error" | "insufficient_sample";
    errorMessage?: string;
inputSource?: "chart";
    successRateLabel?: "Win Rate" | "Positive Trade Rate";
    coverageSummary?: MonteCarloCoverageSummary;
    
    // Configuration used
    settings: MonteCarloSettings;
    simulationsCompleted: number;
    
    // Input summary
    inputTradeCount: number;
    inputNetProfit: number;
    inputSharpeRatio: number;
    
    // Bounded simulation samples kept for fan-chart rendering only
    simulations: MonteCarloSimulation[];
    metricSamples: MonteCarloMetricSamples;
    
    // Aggregated metrics
    ruinProbabilityMetrics: RuinProbabilityMetrics;
    confidenceIntervals: ConfidenceIntervals;
    
    // Distribution statistics
    netProfitDistribution: {
        mean: number;
        median: number;
        stdDev: number;
        skewness: number;
        kurtosis: number;
        min: number;
        max: number;
    };
    
    // Diagnostic info
    executionTimeMs: number;
    seed: number;
}
