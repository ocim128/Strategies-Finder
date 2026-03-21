import { strategyRegistry } from "../../strategyRegistry";
import type { StrategyParams } from "../types/strategies";
import type { FinderOptions } from "../types/finder";
import {
    computeParamRange,
    createSeededRandom,
    isToggleParam,
    normalizeParamValue,
    serializeParams,
    validateParams,
} from "./finder-param-math";

const FINDER_PARAM_MATH_OPTIONS = Object.freeze({ includeFinderExtraBounds: true });

export class FinderParamSpace {
    public generateParamSets(defaultParams: StrategyParams, options: FinderOptions): StrategyParams[] {
        const keys = Object.keys(defaultParams);
        if (keys.length === 0 || options.mode === "default") {
            return [this.normalizeParams(defaultParams)];
        }

        const valuesByKey = keys.map((key) => this.buildRangeValues(key, defaultParams[key], options));
        const totalCombos = valuesByKey.reduce((product, values) => product * values.length, 1);

        if (options.mode === "grid" && totalCombos <= options.maxRuns) {
            const combos: StrategyParams[] = [];
            this.buildGridCombos(keys, valuesByKey, 0, {}, combos, options.maxRuns);
            return combos.length > 0 ? combos : [this.normalizeParams(defaultParams)];
        }

        if (options.mode === "grid") {
            return this.sampleGridCombos(keys, valuesByKey, defaultParams, options.maxRuns, this.resolveRandom(options));
        }

        if (options.mode === "robust_random_wf") {
            return this.generateRandomCombos(keys, defaultParams, options, this.resolveRandom(options));
        }

        return this.generateRandomCombos(keys, defaultParams, options, this.resolveRandom(options));
    }

    public buildRandomConfirmationParams(strategyKeys: string[], options: FinderOptions): Record<string, StrategyParams> {
        const paramsByKey: Record<string, StrategyParams> = {};
        const rand = this.resolveRandom(options);
        for (const key of strategyKeys) {
            const strategy = strategyRegistry.get(key);
            if (!strategy) continue;
            paramsByKey[key] = this.generateRandomParams(strategy.defaultParams, options, rand);
        }
        return paramsByKey;
    }

    private buildRangeValues(key: string, baseValue: number, options: FinderOptions): number[] {
        // Toggle params (use*) always get [0, 1] for grid search
        if (isToggleParam(key, baseValue)) {
            return [0, 1];
        }

        const { min, max } = computeParamRange(key, baseValue, options.rangePercent, FINDER_PARAM_MATH_OPTIONS);
        const steps = Math.max(2, options.steps);
        const stepSize = steps > 1 ? (max - min) / (steps - 1) : 0;

        const values = new Set<number>();
        for (let i = 0; i < steps; i++) {
            const rawValue = min + stepSize * i;
            values.add(normalizeParamValue(key, rawValue, baseValue, FINDER_PARAM_MATH_OPTIONS));
        }

        values.add(normalizeParamValue(key, baseValue, baseValue, FINDER_PARAM_MATH_OPTIONS));
        return Array.from(values).sort((a, b) => a - b);
    }

    private buildGridCombos(
        keys: string[],
        valuesByKey: number[][],
        index: number,
        current: StrategyParams,
        combos: StrategyParams[],
        maxRuns: number
    ): void {
        if (combos.length >= maxRuns) return;
        if (index >= keys.length) {
            if (validateParams(current)) {
                combos.push({ ...current });
            }
            return;
        }

        const key = keys[index];
        for (const value of valuesByKey[index]) {
            current[key] = value;
            this.buildGridCombos(keys, valuesByKey, index + 1, current, combos, maxRuns);
            if (combos.length >= maxRuns) break;
        }
    }

    private sampleGridCombos(
        keys: string[],
        valuesByKey: number[][],
        defaultParams: StrategyParams,
        maxRuns: number,
        rand: () => number
    ): StrategyParams[] {
        const combos: StrategyParams[] = [];
        const seen = new Set<string>();
        const normalizedDefault = this.normalizeParams(defaultParams);
        this.tryAddCombo(normalizedDefault, combos, seen, maxRuns);

        let attempts = 0;
        const maxAttempts = maxRuns * 10;
        while (combos.length < maxRuns && attempts < maxAttempts) {
            const params: StrategyParams = {};
            for (let i = 0; i < keys.length; i++) {
                const values = valuesByKey[i];
                const pick = values[Math.floor(rand() * values.length)];
                params[keys[i]] = pick;
            }
            this.tryAddCombo(params, combos, seen, maxRuns);
            attempts += 1;
        }
        return combos;
    }

    private generateRandomCombos(
        keys: string[],
        defaultParams: StrategyParams,
        options: FinderOptions,
        rand: () => number
    ): StrategyParams[] {
        const combos: StrategyParams[] = [];
        const seen = new Set<string>();
        const normalizedDefault = this.normalizeParams(defaultParams);
        const optimizeForRandom = options.mode === "random";
        const discreteSpaceSize = optimizeForRandom
            ? this.estimateDiscreteSpaceSize(keys, defaultParams, options)
            : null;
        const targetRuns = Math.max(
            1,
            discreteSpaceSize === null
                ? options.maxRuns
                : Math.min(options.maxRuns, discreteSpaceSize)
        );
        this.tryAddCombo(normalizedDefault, combos, seen, targetRuns);

        // Separate toggle params from numeric params
        const toggleKeys: string[] = [];
        const numericRanges: { key: string; baseValue: number; min: number; max: number }[] = [];

        for (const key of keys) {
            const baseValue = defaultParams[key];
            if (isToggleParam(key, baseValue)) {
                toggleKeys.push(key);
            } else {
                const { min, max } = computeParamRange(key, baseValue, options.rangePercent, FINDER_PARAM_MATH_OPTIONS);
                numericRanges.push({ key, baseValue, min, max });
            }
        }

        const maxAttempts = optimizeForRandom
            ? Math.max(targetRuns * 20, 200)
            : options.maxRuns * 10;
        const skipDedup = !optimizeForRandom && options.maxRuns >= 50;

        if (optimizeForRandom && combos.length < targetRuns) {
            this.generateLatinHypercubeCombos(toggleKeys, numericRanges, combos, seen, targetRuns, rand);
            if (combos.length < targetRuns) {
                this.generateLatinHypercubeCombos(toggleKeys, numericRanges, combos, seen, targetRuns, rand);
            }
        }

        let attempts = 0;
        while (combos.length < targetRuns && attempts < maxAttempts) {
            const params: StrategyParams = {};

            // Randomize toggle params (50% chance on/off)
            for (const key of toggleKeys) {
                params[key] = rand() < 0.5 ? 0 : 1;
            }

            // Randomize numeric params within range
            for (const range of numericRanges) {
                const raw = range.min + rand() * (range.max - range.min);
                params[range.key] = normalizeParamValue(range.key, raw, range.baseValue, FINDER_PARAM_MATH_OPTIONS);
            }

            if (skipDedup) {
                if (validateParams(params)) {
                    combos.push(params);
                }
            } else {
                this.tryAddCombo(params, combos, seen, targetRuns);
            }
            attempts += 1;
        }
        return combos;
    }

    private generateLatinHypercubeCombos(
        toggleKeys: string[],
        numericRanges: Array<{ key: string; baseValue: number; min: number; max: number }>,
        combos: StrategyParams[],
        seen: Set<string>,
        targetRuns: number,
        rand: () => number
    ): void {
        const sampleCount = Math.max(0, targetRuns - combos.length);
        if (sampleCount <= 0) return;

        const toggleStrata = toggleKeys.map(() => this.createPermutation(sampleCount, rand));
        const numericStrata = numericRanges.map(() => this.createPermutation(sampleCount, rand));

        for (let i = 0; i < sampleCount && combos.length < targetRuns; i++) {
            const params: StrategyParams = {};

            for (let t = 0; t < toggleKeys.length; t++) {
                const key = toggleKeys[t];
                const stratum = toggleStrata[t][i];
                params[key] = stratum < (sampleCount / 2) ? 0 : 1;
            }

            for (let n = 0; n < numericRanges.length; n++) {
                const range = numericRanges[n];
                const stratum = numericStrata[n][i];
                const fraction = (stratum + rand()) / sampleCount;
                const raw = range.min + fraction * (range.max - range.min);
                params[range.key] = normalizeParamValue(range.key, raw, range.baseValue, FINDER_PARAM_MATH_OPTIONS);
            }

            this.tryAddCombo(params, combos, seen, targetRuns);
        }
    }

    private estimateDiscreteSpaceSize(
        keys: string[],
        defaultParams: StrategyParams,
        options: FinderOptions
    ): number | null {
        let total = 1;
        for (const key of keys) {
            const baseValue = defaultParams[key];
            if (isToggleParam(key, baseValue)) {
                total *= 2;
            } else {
                const { min, max } = computeParamRange(key, baseValue, options.rangePercent, FINDER_PARAM_MATH_OPTIONS);
                const minNorm = normalizeParamValue(key, min, baseValue, FINDER_PARAM_MATH_OPTIONS);
                const maxNorm = normalizeParamValue(key, max, baseValue, FINDER_PARAM_MATH_OPTIONS);
                const baseNorm = normalizeParamValue(key, baseValue, baseValue, FINDER_PARAM_MATH_OPTIONS);
                if (!Number.isInteger(minNorm) || !Number.isInteger(maxNorm) || !Number.isInteger(baseNorm)) {
                    return null;
                }
                const low = Math.min(minNorm, maxNorm);
                const high = Math.max(minNorm, maxNorm);
                const count = Math.max(1, Math.floor(high) - Math.ceil(low) + 1);
                total *= count;
            }

            if (!Number.isFinite(total) || total > 1_000_000) {
                return null;
            }
        }

        return Math.max(1, Math.floor(total));
    }

    private generateRandomParams(defaultParams: StrategyParams, options: FinderOptions, rand: () => number): StrategyParams {
        const keys = Object.keys(defaultParams);
        if (keys.length === 0) return {};

        // Separate toggle params from numeric params
        const toggleKeys: string[] = [];
        const numericRanges: { key: string; baseValue: number; min: number; max: number }[] = [];

        for (const key of keys) {
            const baseValue = defaultParams[key];
            if (isToggleParam(key, baseValue)) {
                toggleKeys.push(key);
                continue;
            }

            const { min, max } = computeParamRange(key, baseValue, options.rangePercent, FINDER_PARAM_MATH_OPTIONS);
            numericRanges.push({ key, baseValue, min, max });
        }

        const maxAttempts = Math.max(10, keys.length * 5);
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            const params: StrategyParams = {};

            for (const key of toggleKeys) {
                params[key] = rand() < 0.5 ? 0 : 1;
            }

            for (const range of numericRanges) {
                const raw = range.min + rand() * (range.max - range.min);
                params[range.key] = normalizeParamValue(range.key, raw, range.baseValue, FINDER_PARAM_MATH_OPTIONS);
            }

            if (validateParams(params)) {
                return params;
            }
        }

        return this.normalizeParams(defaultParams);
    }

    private resolveRandom(options: FinderOptions): () => number {
        if (options.mode === "robust_random_wf") {
            const seedValue = Number.isFinite(options.robustSeed) ? Number(options.robustSeed) : 1337;
            return createSeededRandom(seedValue);
        }
        if (options.mode === "random" && Number.isFinite(options.randomSeed)) {
            return createSeededRandom(Number(options.randomSeed));
        }
        return Math.random;
    }

    private createPermutation(size: number, rand: () => number): number[] {
        const arr = Array.from({ length: Math.max(0, size) }, (_, i) => i);
        for (let i = arr.length - 1; i > 0; i--) {
            const j = Math.floor(rand() * (i + 1));
            const tmp = arr[i];
            arr[i] = arr[j];
            arr[j] = tmp;
        }
        return arr;
    }

    private tryAddCombo(params: StrategyParams, combos: StrategyParams[], seen: Set<string>, maxRuns: number): void {
        if (combos.length >= maxRuns) return;
        if (!validateParams(params)) return;
        const key = serializeParams(params);
        if (seen.has(key)) return;
        seen.add(key);
        combos.push({ ...params });
    }

    private normalizeParams(params: StrategyParams): StrategyParams {
        const normalized: StrategyParams = {};
        Object.entries(params).forEach(([key, value]) => {
            normalized[key] = normalizeParamValue(key, value, value, FINDER_PARAM_MATH_OPTIONS);
        });
        return normalized;
    }
}
