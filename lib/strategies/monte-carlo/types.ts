import type { AdvancedSizingSettings, TradeSizingMode } from "../../types/backtest";
import type { OHLCVData, Trade } from "../../types/strategies";
import type { PolymarketExitMode } from "../../polymarket-exit-mode";

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
    /** Enable parameter perturbation */
    enableParameterPerturbation: boolean;
    /** Parameter perturbation std dev as % of param value */
    parameterPerturbationStdDev: number;
    /** Ruin threshold as % of initial capital */
    ruinThresholdPercent: number;
    /** Initial capital for simulation */
    initialCapital: number;
    /** Fixed dollar stake per trade for Polymarket bankroll simulation */
    polymarketStakePerTrade?: number;
}

export interface MonteCarloSizingConfig {
    mode: TradeSizingMode;
    positionSizePercent: number;
    fixedTradeAmount: number;
    commissionPercent: number;
    advancedSizing?: AdvancedSizingSettings;
    ohlcvData?: OHLCVData[];
}

export interface ParameterPerturbationConfig {
    paramKey: string;
    baseValue: number;
    perturbationStdDev: number;
    minConstraint?: number;
    maxConstraint?: number;
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

export interface PolymarketMonteCarloTradeInput {
    entryPrice: number;
    sharePnl: number;
    exitTime: Trade["exitTime"];
}

export interface PolymarketMonteCarloInput {
    trades: PolymarketMonteCarloTradeInput[];
    hasTradeLevelAnnotations: boolean;
    coverageSummary: MonteCarloCoverageSummary;
    evaluationMode: PolymarketExitMode;
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

export interface ParameterSensitivityReport {
    paramKey: string;
    baseValue: number;
    perturbations: {
        perturbedValue: number;
        netProfit: number;
        sharpeRatio: number;
        maxDrawdown: number;
        sensitivity: number; // d(Metric)/d(Param)
    }[];
    overallSensitivity: number;
    stabilityScore: number; // 0-100, higher = more stable
}

export interface MonteCarloResult {
    status: "success" | "error" | "insufficient_sample";
    errorMessage?: string;
    inputSource?: "chart" | "polymarket";
    successRateLabel?: "Win Rate" | "Positive Trade Rate";
    polymarketSizingModel?: "fixed_stake";
    coverageSummary?: MonteCarloCoverageSummary;
    polymarketEvaluationMode?: PolymarketExitMode;
    
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
    
    // Parameter sensitivity (if enabled)
    parameterSensitivity?: ParameterSensitivityReport[];
    
    // Diagnostic info
    executionTimeMs: number;
    seed: number;
}

// ============================================================================
// Internal Types
// ============================================================================

export type TradeReturn = {
    pnlPercent: number;
    pnl: number;
    originalIndex: number;
};

export type EquityCurvePoint = {
    bar: number;
    equity: number;
    cumulativeReturn: number;
};
