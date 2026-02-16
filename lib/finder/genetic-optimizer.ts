import {
    precomputeIndicators,
    runBacktestCompact,
    type BacktestResult,
    type BacktestSettings,
    type OHLCVData,
    type Strategy,
    type StrategyParams,
} from "../strategies/index";

interface ParamSpec {
    key: string;
    baseValue: number;
    min: number;
    max: number;
    isInteger: boolean;
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
    sizingMode: "percent" | "fixed";
    fixedTradeAmount: number;
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

function createSeededRandom(seed: number): () => number {
    let state = (Math.floor(seed) >>> 0) || 1;
    return () => {
        state += 0x6d2b79f5;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
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

function isToggleParam(key: string, value: number): boolean {
    return /^use[A-Z]/.test(key) && (value === 0 || value === 1);
}

function buildParamSpecs(defaultParams: StrategyParams, rangePercent: number): ParamSpec[] {
    const rangeRatio = Math.max(0, rangePercent) / 100;
    return Object.keys(defaultParams).map((key) => {
        const baseValue = defaultParams[key];
        const toggle = isToggleParam(key, baseValue);
        if (toggle) {
            return {
                key,
                baseValue,
                min: 0,
                max: 1,
                isInteger: true,
                isToggle: true,
            };
        }

        const rawRange = Math.abs(baseValue) * rangeRatio;
        const span = rawRange > 0 ? rawRange : rangeRatio > 0 ? 1 : 0;
        let min = baseValue - span;
        let max = baseValue + span;

        if (key === "clusterChoice") {
            min = 0;
            max = 2;
        } else if (/(iteration|iterations|interval|alpha)/i.test(key)) {
            min = Math.max(1, min);
        } else if (key === "warmupBars") {
            min = Math.max(0, min);
        }

        if (key === "stopLossPercent") {
            min = Math.max(0, min);
            max = Math.min(15, max);
        } else if (key === "targetPct") {
            min = 0;
            max = 2;
        } else if (key === "takeProfitPercent") {
            min = Math.max(0, min);
            max = Math.min(100, max);
        }

        return {
            key,
            baseValue,
            min,
            max,
            isInteger: Number.isInteger(baseValue),
            isToggle: false,
        };
    });
}

function normalizeParamValue(spec: ParamSpec, value: number): number {
    const { key, baseValue, min, max, isInteger, isToggle } = spec;

    if (isToggle) {
        return value >= 0.5 ? 1 : 0;
    }

    let next = clamp(value, min, max);
    const isRsiThreshold = /(rsi(bullish|bearish|overbought|oversold)|overbought|oversold)/i.test(key);
    const isRsiPeriod = /rsi/i.test(key) && !isRsiThreshold;
    const periodLike = /(period|lookback|bars|bins|length|iteration|iterations|interval|alpha)/i.test(key) || isRsiPeriod;
    const percentLike = /(percent|pct)/i.test(key) || isRsiThreshold;
    const nonNegative = /(std|dev|factor|multiplier|atr|adx)/i.test(key);

    if (key === "warmupBars") {
        next = Math.max(0, Math.round(next));
    } else if (key === "clusterChoice") {
        next = Math.min(2, Math.max(0, Math.round(next)));
    } else if (periodLike) {
        next = Math.max(1, Math.round(next));
    } else if (key === "targetPct") {
        next = Math.min(2, Math.max(0, Number(next.toFixed(2))));
    } else if (key === "stopLossPercent") {
        next = Math.min(15, Math.max(0, Number(next.toFixed(2))));
    } else if (key === "takeProfitPercent") {
        next = Math.min(100, Math.max(0, Number(next.toFixed(2))));
    } else if (percentLike) {
        next = Math.min(100, Math.max(0, next));
    } else if (nonNegative) {
        next = Math.max(0, next);
    }

    if (/(multiplier|factor)/i.test(key) && baseValue > 0) {
        next = Math.max(0.1, next);
    }
    if (/z(entry|exit)/i.test(key) || key === "bufferAtr") {
        next = Math.max(0, next);
    }

    if (!periodLike && isInteger && !percentLike && key !== "stopLossPercent" && key !== "takeProfitPercent" && key !== "targetPct") {
        next = Math.round(next);
    } else if (key === "stopLossPercent" || key === "takeProfitPercent" || key === "targetPct") {
        next = Number(next.toFixed(2));
    } else if (!Number.isInteger(baseValue)) {
        next = Number(next.toFixed(4));
    }

    return clamp(next, min, max);
}

function validateParams(params: StrategyParams): boolean {
    const fast = params.fastPeriod;
    const slow = params.slowPeriod;
    const medium = params.mediumPeriod;
    if (fast !== undefined && slow !== undefined && fast >= slow) return false;
    if (fast !== undefined && medium !== undefined && fast >= medium) return false;
    if (medium !== undefined && slow !== undefined && medium >= slow) return false;

    const oversold = params.oversold;
    const overbought = params.overbought;
    if (oversold !== undefined && overbought !== undefined && oversold >= overbought) return false;

    const rsiOversold = params.rsiOversold;
    const rsiOverbought = params.rsiOverbought;
    if (rsiOversold !== undefined && rsiOverbought !== undefined && rsiOversold >= rsiOverbought) return false;

    const kPeriod = params.kPeriod;
    const dPeriod = params.dPeriod;
    if (kPeriod !== undefined && dPeriod !== undefined && kPeriod < dPeriod) return false;

    const macdFast = params.macdFast;
    const macdSlow = params.macdSlow;
    if (macdFast !== undefined && macdSlow !== undefined && macdFast >= macdSlow) return false;

    const minFactor = params.minFactor;
    const maxFactor = params.maxFactor;
    if (minFactor !== undefined && maxFactor !== undefined && minFactor > maxFactor) return false;
    if (params.factorStep !== undefined && params.factorStep <= 0) return false;

    if (params.kMeansIterations !== undefined && params.kMeansIterations <= 0) return false;
    if (params.kMeansInterval !== undefined && params.kMeansInterval <= 0) return false;
    if (params.perfAlpha !== undefined && params.perfAlpha <= 0) return false;
    if (params.clusterChoice !== undefined && (params.clusterChoice < 0 || params.clusterChoice > 2)) return false;

    const zEntry = params.zEntry;
    const zExit = params.zExit;
    if (zEntry !== undefined && zExit !== undefined && zExit >= zEntry) return false;

    const entryExposurePct = params.entryExposurePct;
    const exitExposurePct = params.exitExposurePct;
    if (entryExposurePct !== undefined && exitExposurePct !== undefined && exitExposurePct >= entryExposurePct) return false;

    return true;
}

function serializeParams(params: StrategyParams): string {
    return Object.keys(params)
        .sort()
        .map((key) => `${key}:${params[key]}`)
        .join("|");
}

function randomParams(specs: ParamSpec[], rand: () => number): StrategyParams {
    const params: StrategyParams = {};
    for (const spec of specs) {
        if (spec.isToggle) {
            params[spec.key] = rand() < 0.5 ? 0 : 1;
            continue;
        }
        const value = spec.min + rand() * (spec.max - spec.min);
        params[spec.key] = normalizeParamValue(spec, value);
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
                value = normalizeParamValue(spec, value + delta);
            }
        } else {
            value = normalizeParamValue(spec, value);
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
    const fitnessCache = new Map<string, { fitness: FitnessScore; result: BacktestResult }>();
    let nextGenomeId = 1;

    const evaluateParams = (params: StrategyParams): { fitness: FitnessScore; result: BacktestResult } => {
        const key = serializeParams(params);
        const cached = fitnessCache.get(key);
        if (cached) return cached;

        const signals = strategy.execute(data, params);
        const result = runBacktestCompact(
            data,
            signals,
            cfg.backtest.initialCapital,
            cfg.backtest.positionSize,
            cfg.backtest.commission,
            backtestSettings,
            { mode: cfg.backtest.sizingMode, fixedTradeAmount: cfg.backtest.fixedTradeAmount },
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
        defaultNormalized[spec.key] = normalizeParamValue(spec, defaultParams[spec.key]);
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
