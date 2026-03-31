/**
 * Monte Carlo Simulation Module
 * 
 * Provides statistical validation of backtest results through:
 * - Trade sequence randomization
 * - Bootstrap resampling
 * - Parameter perturbation analysis
 * - Path dependency / ruin probability analysis
 */

export { runMonteCarloSimulation } from "./monte-carlo-engine";
export * from "./types";
export { randomizeTradeSequence, generateRandomizedSequences } from "./trade-sequence-randomizer";
export { bootstrapResample, generateBootstrapSamples, blockBootstrapResample } from "./bootstrap-resampler";
export { perturbParameters, analyzeParameterSensitivity } from "./parameter-perturbation";
export {
    buildEquityCurve,
    calculateMaxDrawdown,
    checkRuin,
    computeRuinProbabilityMetrics,
} from "./path-dependency-analyzer";
export { createSeededRandom, gaussianRandom } from "./utils";
