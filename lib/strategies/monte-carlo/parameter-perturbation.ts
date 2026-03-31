import type { StrategyParams } from "../../types/strategies";
import { createSeededRandom, gaussianRandom } from "./utils";

export interface PerturbedParams {
    original: StrategyParams;
    perturbed: StrategyParams;
    perturbationMagnitude: number;
}

/**
 * Perturbs strategy parameters using Gaussian noise
 */
export function perturbParameters(
    params: StrategyParams,
    seed: number,
    stdDevPercent: number = 5
): PerturbedParams {
    const random = createSeededRandom(seed);
    const perturbed: StrategyParams = {};
    let totalPerturbation = 0;
    let paramCount = 0;
    
    for (const [key, value] of Object.entries(params)) {
        if (typeof value !== "number" || !Number.isFinite(value)) {
            perturbed[key] = value;
            continue;
        }
        
        const noise = gaussianRandom(random) * (stdDevPercent / 100);
        const perturbedValue = value * (1 + noise);
        
        // Apply constraints (avoid zero or negative for params that should be positive)
        perturbed[key] = value > 0 ? Math.max(0.001, perturbedValue) : perturbedValue;
        
        totalPerturbation += Math.abs(noise);
        paramCount++;
    }
    
    return {
        original: params,
        perturbed,
        perturbationMagnitude: paramCount > 0 ? totalPerturbation / paramCount : 0,
    };
}

/**
 * Generate sensitivity report across multiple perturbations
 */
export interface SensitivityAnalysisResult {
    baseMetrics: {
        netProfit: number;
        sharpeRatio: number;
        maxDrawdown: number;
    };
    perturbedMetrics: Array<{
        perturbationMagnitude: number;
        netProfit: number;
        sharpeRatio: number;
        maxDrawdown: number;
    }>;
    sensitivities: {
        netProfit: number; // d(NetProfit)/d(Param)
        sharpeRatio: number;
        maxDrawdown: number;
    };
    stabilityScore: number; // 0-100
}

export function analyzeParameterSensitivity(
    params: StrategyParams,
    seed: number,
    stdDevPercent: number = 5,
    simulations: number = 30
): {
    perturbations: PerturbedParams[];
    averagePerturbationMagnitude: number;
} {
    const perturbations: PerturbedParams[] = [];
    let totalMagnitude = 0;
    
    for (let i = 0; i < simulations; i++) {
        const perturbation = perturbParameters(params, seed + i, stdDevPercent);
        perturbations.push(perturbation);
        totalMagnitude += perturbation.perturbationMagnitude;
    }
    
    return {
        perturbations,
        averagePerturbationMagnitude: totalMagnitude / simulations,
    };
}
