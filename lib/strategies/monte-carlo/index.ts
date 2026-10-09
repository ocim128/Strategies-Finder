/**
 * Monte Carlo Simulation Module
 * 
 * Provides statistical validation of backtest results through:
 * - Trade sequence randomization
 * - Bootstrap resampling
 * - Path dependency / ruin probability analysis
 */

export { runMonteCarloSimulation } from "./monte-carlo-engine";
export type { MonteCarloProgress, RunMonteCarloOptions } from "./monte-carlo-engine";
export * from "./types";
