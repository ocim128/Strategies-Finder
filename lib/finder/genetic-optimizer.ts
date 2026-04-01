import {
    applySignalPolarity,
    precomputeIndicators,
    runBacktestCompact,
    type BacktestResult,
    type BacktestSettings,
    type OHLCVData,
    type Strategy,
    type StrategyParams,
} from "../strategies/index";
import type { AdvancedSizingSettings, TradeSizingMode } from "../types/backtest";
import {
    computeParamRange,
    createSeededRandom,
    isToggleParam,
    normalizeParamValue,
    serializeParams,
    validateParams,
} from "./finder-param-math";

interface ParamSpec {
    key: string;
    baseValue: number;
    min: number;
    max: number;
    isToggle: boolean;
}

export interface Genome {
    id: number;
    generation: number;
    params: StrategyParams;
}

export interface FitnessScore {
    score: number;
    netProfitPercent: number;
    sharpeRatio: number;
    stability: number;
    maxDrawdownPercent: number;
    totalTrades: number;
}

export interface EvaluatedGenome extends Genome {
    fitness: FitnessScore;
    result: BacktestResult;
}

export interface GeneticBacktestConfig {
    initialCapital: number;
    positionSize: number;
    commission: number;
    sizingMode: TradeSizingMode;
    fixedTradeAmount: number;
    advancedSizing?: AdvancedSizingSettings;
    minTrades: number;
}

export interface AdaptiveMutationConfig {
    enabled: boolean;
    stagnationGenerations: number;
    increaseFactor: number;
    decayFactor: number;
    minRate: number;
    maxRate: number;
}

export interface GeneticOptimizerConfig {
    populationSize: number;
    generations: number;
    eliteCount: number;
    mutationRate: number;
    mutationSigma: number;
    rangePercent: number;
    seed: number;
    tournamentSize: number;
    adaptiveMutation?: AdaptiveMutationConfig;
    backtest: GeneticBacktestConfig;
}

export interface GeneticGenerationStats {
    generation: number;
    bestScore: number;
    medianScore: number;
    bestNetProfitPercent: number;
    bestSharpeRatio: number;
    bestDrawdownPercent: number;
    mutationRate: number;
    stagnationCount: number;
}

export interface GeneticOptimizationResult {
    strategyKey: string;
    config: GeneticOptimizerConfig;
    bestGenome: EvaluatedGenome;
    generations: GeneticGenerationStats[];
    elapsedMs: number;
}

export interface GeneticOptimizerInput {
    strategyKey: string;
    strategy: Strategy;
    data: OHLCVData[];
    backtestSettings: BacktestSettings;
    config: GeneticOptimizerConfig;
    onGeneration?: (stats: GeneticGenerationStats) => void;
}

function gaussian(rand: () => number): number {
    let u = 0;
    let v = 0;
    while (u === 0) u = rand();
    while (v === 0) v = rand();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}

function buildParamSpecs(defaultParams: StrategyParams, rangePercent: number): ParamSpec[] {
    return Object.keys(defaultParams).map((key) => {
        const baseValue = defaultParams[key];
        const toggle = isToggleParam(key, baseValue);
        if (toggle) {
            return {
                key,
                baseValue,
                min: 0,
                max: 1,
                isToggle: true,
            };
        }

        const { min, max } = computeParamRange(key, baseValue, rangePercent);

        return {
            key,
            baseValue,
            min,
            max,
            isToggle: false,
        };
    });
}

function normalizeSpecParamValue(spec: ParamSpec, value: number): number {
    if (spec.isToggle) {
        return value >= 0.5 ? 1 : 0;
    }
    return normalizeParamValue(spec.key, value, spec.baseValue, { min: spec.min, max: spec.max });
}

function randomParams(specs: ParamSpec[], rand: () => number): StrategyParams {
    const params: StrategyParams = {};
    for (const spec of specs) {
        if (spec.isToggle) {
            params[spec.key] = rand() < 0.5 ? 0 : 1;
            continue;
        }
        const value = spec.min + rand() * (spec.max - spec.min);
        params[spec.key] = normalizeSpecParamValue(spec, value);
    }
    return params;
}

function tournamentSelect(population: EvaluatedGenome[], rand: () => number, tournamentSize: number): EvaluatedGenome {
    const rounds = Math.max(2, tournamentSize);
    let winner = population[Math.floor(rand() * population.length)];
    for (let i = 1; i < rounds; i++) {
        const challenger = population[Math.floor(rand() * population.length)];
        if (challenger.fitness.score > winner.fitness.score) {
            winner = challenger;
        }
    }
    return winner;
}

function crossoverUniform(
    parentA: StrategyParams,
    parentB: StrategyParams,
    specs: ParamSpec[],
    rand: () => number
): StrategyParams {
    const child: StrategyParams = {};
    for (const spec of specs) {
        const fromA = rand() < 0.5;
        child[spec.key] = fromA ? parentA[spec.key] : parentB[spec.key];
    }
    return child;
}

function mutateGaussian(
    params: StrategyParams,
    specs: ParamSpec[],
    mutationRate: number,
    mutationSigma: number,
    rand: () => number
): StrategyParams {
    const mutated: StrategyParams = {};
    const chance = clamp(mutationRate, 0, 1);
    const sigma = Math.max(0.0001, mutationSigma);

    for (const spec of specs) {
        let value = params[spec.key];
        if (rand() < chance) {
            if (spec.isToggle) {
                value = value >= 0.5 ? 0 : 1;
            } else {
                const span = Math.max(0.0001, spec.max - spec.min);
                const delta = gaussian(rand) * span * sigma;
                value = normalizeSpecParamValue(spec, value + delta);
            }
        } else {
            value = normalizeSpecParamValue(spec, value);
        }
        mutated[spec.key] = value;
    }

    return mutated;
}

function computeFitness(result: BacktestResult, minTrades: number): FitnessScore {
    const tradeCount = Math.max(0, result.totalTrades);
    const tradeCoverage = minTrades > 0 ? Math.min(1, tradeCount / minTrades) : 1;
    const drawdown = Math.max(0, result.maxDrawdownPercent);
    // Survival Mode: Aggressive stability penalty.
    // If drawdown > 10%, score degrades rapidly. If > 25%, it's nuked.
    const stability = 1 / (1 + Math.pow(drawdown / 10, 2));

    const netProfitTerm = result.netProfitPercent / 100;
    const sharpeTerm = Number.isFinite(result.sharpeRatio) ? Math.max(0, result.sharpeRatio) : 0;

    let score: number;

    if (tradeCount === 0) {
        score = Number.NEGATIVE_INFINITY;
    } else if (netProfitTerm > 0) {
        // Profit Mode: Reward Shark-like efficiency (Sharpe) and Safety (Stability)
        // We square the stability to really punish drawdown.
        score = netProfitTerm * sharpeTerm * Math.pow(stability, 2) * tradeCoverage;
    } else {
        // Loss Mode: Penalize losses and drawdowns heavily
        const lossPenalty = Math.abs(netProfitTerm) * 2;
        const drawdownPenalty = drawdown / 10; // 10% DD = 1.0 penalty
        const tradePenalty = 1 - tradeCoverage;
        score = -(lossPenalty + drawdownPenalty + tradePenalty);
    }

    return {
        score: Number.isFinite(score) ? score : Number.NEGATIVE_INFINITY,
        netProfitPercent: result.netProfitPercent,
        sharpeRatio: result.sharpeRatio,
        stability,
        maxDrawdownPercent: drawdown,
        totalTrades: tradeCount,
    };
}

function median(values: number[]): number {
    if (values.length === 0) return 0;
    const sorted = values.slice().sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

export async function runGeneticOptimization(input: GeneticOptimizerInput): Promise<GeneticOptimizationResult> {
    const startedAt = performance.now();
    const { strategy, strategyKey, data, backtestSettings, onGeneration } = input;
    const cfg = input.config;
    const rand = createSeededRandom(cfg.seed);
    const defaultParams = { ...strategy.defaultParams };
    const specs = buildParamSpecs(defaultParams, cfg.rangePercent);
    if (specs.length === 0) {
        throw new Error(`[Genetic] Strategy ${strategyKey} has no tunable numeric params.`);
    }

    const precomputed = precomputeIndicators(data, backtestSettings);
    const preparedFinderData = strategy.prepareFinderData?.(data, backtestSettings);
    const fitnessCache = new Map<string, { fitness: FitnessScore; result: BacktestResult }>();
    let nextGenomeId = 1;

    const evaluateParams = (params: StrategyParams): { fitness: FitnessScore; result: BacktestResult } => {
        const key = serializeParams(params);
        const cached = fitnessCache.get(key);
        if (cached) return cached;

        const rawSignals = strategy.executePrepared
            ? strategy.executePrepared(preparedFinderData, params, data)
            : strategy.execute(data, params);
        const signals = applySignalPolarity(rawSignals, backtestSettings);
        const result = runBacktestCompact(
            data,
            signals,
            cfg.backtest.initialCapital,
            cfg.backtest.positionSize,
            cfg.backtest.commission,
            backtestSettings,
            {
                mode: cfg.backtest.sizingMode,
                fixedTradeAmount: cfg.backtest.fixedTradeAmount,
                advancedSizing: cfg.backtest.advancedSizing,
            },
            precomputed
        );

        const fitness = computeFitness(result, cfg.backtest.minTrades);
        const packed = { fitness, result };
        fitnessCache.set(key, packed);
        return packed;
    };

    const makeGenome = (generation: number, params: StrategyParams): Genome => ({
        id: nextGenomeId++,
        generation,
        params,
    });

    const initialPopulation: Genome[] = [];
    const initialSeen = new Set<string>();
    const defaultNormalized: StrategyParams = {};
    for (const spec of specs) {
        defaultNormalized[spec.key] = normalizeSpecParamValue(spec, defaultParams[spec.key]);
    }
    initialPopulation.push(makeGenome(0, defaultNormalized));
    initialSeen.add(serializeParams(defaultNormalized));

    let attempts = 0;
    const maxInitialAttempts = Math.max(1000, cfg.populationSize * 40);
    while (initialPopulation.length < cfg.populationSize && attempts < maxInitialAttempts) {
        const candidate = randomParams(specs, rand);
        if (!validateParams(candidate)) {
            attempts++;
            continue;
        }
        const key = serializeParams(candidate);
        if (initialSeen.has(key)) {
            attempts++;
            continue;
        }
        initialSeen.add(key);
        initialPopulation.push(makeGenome(0, candidate));
        attempts++;
    }

    while (initialPopulation.length < cfg.populationSize) {
        const jittered = mutateGaussian(defaultNormalized, specs, 1, 0.35, rand);
        if (!validateParams(jittered)) continue;
        const key = serializeParams(jittered);
        if (initialSeen.has(key)) continue;
        initialSeen.add(key);
        initialPopulation.push(makeGenome(0, jittered));
    }

    let population = initialPopulation;
    let bestOverall: EvaluatedGenome | null = null;
    const generationStats: GeneticGenerationStats[] = [];
    const eliteCount = Math.max(1, Math.min(cfg.eliteCount, cfg.populationSize));
    const adaptiveMutation = cfg.adaptiveMutation?.enabled ? cfg.adaptiveMutation : null;
    const adaptiveMinRate = adaptiveMutation
        ? clamp(adaptiveMutation.minRate, 0, 1)
        : clamp(cfg.mutationRate, 0, 1);
    const adaptiveMaxRate = adaptiveMutation
        ? Math.max(adaptiveMinRate, clamp(adaptiveMutation.maxRate, 0, 1))
        : clamp(cfg.mutationRate, 0, 1);
    const adaptiveStagnationGenerations = adaptiveMutation
        ? Math.max(1, Math.floor(adaptiveMutation.stagnationGenerations))
        : 0;
    const adaptiveIncreaseFactor = adaptiveMutation
        ? Math.max(1.01, adaptiveMutation.increaseFactor)
        : 1;
    const adaptiveDecayFactor = adaptiveMutation
        ? clamp(adaptiveMutation.decayFactor, 0.5, 1)
        : 1;
    const baseMutationRate = clamp(cfg.mutationRate, adaptiveMinRate, adaptiveMaxRate);
    let currentMutationRate = baseMutationRate;
    let stagnationCount = 0;
    let lastImprovementScore = Number.NEGATIVE_INFINITY;

    for (let generation = 0; generation < cfg.generations; generation++) {
        const evaluated: EvaluatedGenome[] = population.map((genome) => {
            const scored = evaluateParams(genome.params);
            return {
                ...genome,
                fitness: scored.fitness,
                result: scored.result,
            };
        });

        evaluated.sort((a, b) => b.fitness.score - a.fitness.score);
        const best = evaluated[0];
        const improved = best.fitness.score > lastImprovementScore + 1e-12;
        if (improved) {
            lastImprovementScore = best.fitness.score;
            stagnationCount = 0;
            if (adaptiveMutation) {
                currentMutationRate = clamp(
                    Math.max(baseMutationRate, currentMutationRate * adaptiveDecayFactor),
                    adaptiveMinRate,
                    adaptiveMaxRate
                );
            }
        } else {
            stagnationCount += 1;
            if (adaptiveMutation && stagnationCount >= adaptiveStagnationGenerations) {
                currentMutationRate = clamp(
                    currentMutationRate * adaptiveIncreaseFactor,
                    adaptiveMinRate,
                    adaptiveMaxRate
                );
                stagnationCount = 0;
            }
        }

        if (!bestOverall || best.fitness.score > bestOverall.fitness.score) {
            bestOverall = best;
        }

        const scores = evaluated.map((item) => item.fitness.score);
        const stats: GeneticGenerationStats = {
            generation,
            bestScore: best.fitness.score,
            medianScore: median(scores),
            bestNetProfitPercent: best.fitness.netProfitPercent,
            bestSharpeRatio: best.fitness.sharpeRatio,
            bestDrawdownPercent: best.fitness.maxDrawdownPercent,
            mutationRate: currentMutationRate,
            stagnationCount,
        };
        generationStats.push(stats);
        onGeneration?.(stats);

        if (generation === cfg.generations - 1) {
            break;
        }

        const nextPopulation: Genome[] = [];
        const nextSeen = new Set<string>();

        for (let i = 0; i < eliteCount; i++) {
            const elite = evaluated[i];
            const clonedParams = { ...elite.params };
            nextPopulation.push(makeGenome(generation + 1, clonedParams));
            nextSeen.add(serializeParams(clonedParams));
        }

        let childAttempts = 0;
        const maxChildAttempts = Math.max(5000, cfg.populationSize * 80);
        while (nextPopulation.length < cfg.populationSize && childAttempts < maxChildAttempts) {
            const parentA = tournamentSelect(evaluated, rand, cfg.tournamentSize);
            const parentB = tournamentSelect(evaluated, rand, cfg.tournamentSize);
            let childParams = crossoverUniform(parentA.params, parentB.params, specs, rand);
            childParams = mutateGaussian(childParams, specs, currentMutationRate, cfg.mutationSigma, rand);
            if (!validateParams(childParams)) {
                childAttempts++;
                continue;
            }
            const key = serializeParams(childParams);
            if (nextSeen.has(key)) {
                childAttempts++;
                continue;
            }
            nextSeen.add(key);
            nextPopulation.push(makeGenome(generation + 1, childParams));
            childAttempts++;
        }

        while (nextPopulation.length < cfg.populationSize) {
            const fallback = randomParams(specs, rand);
            if (!validateParams(fallback)) continue;
            const key = serializeParams(fallback);
            if (nextSeen.has(key)) continue;
            nextSeen.add(key);
            nextPopulation.push(makeGenome(generation + 1, fallback));
        }

        population = nextPopulation;
    }

    if (!bestOverall) {
        throw new Error("[Genetic] Optimization produced no evaluated genomes.");
    }

    return {
        strategyKey,
        config: cfg,
        bestGenome: bestOverall,
        generations: generationStats,
        elapsedMs: performance.now() - startedAt,
    };
}
