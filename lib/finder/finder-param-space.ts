import { strategyRegistry } from "../../strategyRegistry";
import type { StrategyParams } from "../types/strategies";
import type { FinderOptions } from "../types/finder";

/**
 * Detects if a parameter is a toggle (on/off) parameter.
 * Toggle params: start with 'use' prefix and have value 0 or 1.
 */
export function isToggleParam(key: string, value: number): boolean {
    return /^use[A-Z]/.test(key) && (value === 0 || value === 1);
}

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

        const rangeRatio = Math.max(0, options.rangePercent) / 100;
        const rawRange = Math.abs(baseValue) * rangeRatio;
        const range = rawRange > 0 ? rawRange : rangeRatio > 0 ? 1 : 0;
        let min = baseValue - range;
        let max = baseValue + range;

        if (key === "clusterChoice") {
            min = 0;
            max = 2;
        } else if (/(iteration|iterations|interval|alpha)/i.test(key)) {
            min = Math.max(1, min);
        } else if (key === "warmupBars") {
            min = Math.max(0, min);
        }

        // Special clamping for percent params
        if (key === "stopLossPercent") {
            // Clamp to valid range: 0-15%
            min = Math.max(0, min);
            max = Math.min(15, max);
        } else if (key === "targetPct") {
            min = 0;
            max = 2;
        } else if (key === "takeProfitPercent") {
            // Clamp to valid range: 0-100%
            min = Math.max(0, min);
            max = Math.min(100, max);
        }

        const steps = Math.max(2, options.steps);
        const stepSize = steps > 1 ? (max - min) / (steps - 1) : 0;

        const values = new Set<number>();
        for (let i = 0; i < steps; i++) {
            const rawValue = min + stepSize * i;
            values.add(this.normalizeParamValue(key, rawValue, baseValue));
        }

        values.add(this.normalizeParamValue(key, baseValue, baseValue));
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
            if (this.validateParams(current)) {
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
        this.tryAddCombo(normalizedDefault, combos, seen, options.maxRuns);

        // Separate toggle params from numeric params
        const toggleKeys: string[] = [];
        const numericRanges: { key: string; baseValue: number; min: number; max: number }[] = [];

        for (const key of keys) {
            const baseValue = defaultParams[key];
            if (isToggleParam(key, baseValue)) {
                toggleKeys.push(key);
            } else {
                const rangeRatio = Math.max(0, options.rangePercent) / 100;
                const rawRange = Math.abs(baseValue) * rangeRatio;
                const range = rawRange > 0 ? rawRange : rangeRatio > 0 ? 1 : 0;
                let min = baseValue - range;
                let max = baseValue + range;

                // Special clamping for percent params
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

                numericRanges.push({ key, baseValue, min, max });
            }
        }

        let attempts = 0;
        const maxAttempts = options.maxRuns * 10;
        while (combos.length < options.maxRuns && attempts < maxAttempts) {
            const params: StrategyParams = {};

            // Randomize toggle params (50% chance on/off)
            for (const key of toggleKeys) {
                params[key] = rand() < 0.5 ? 0 : 1;
            }

            // Randomize numeric params within range
            for (const range of numericRanges) {
                const raw = range.min + rand() * (range.max - range.min);
                params[range.key] = this.normalizeParamValue(range.key, raw, range.baseValue);
            }

            this.tryAddCombo(params, combos, seen, options.maxRuns);
            attempts += 1;
        }
        return combos;
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

            const rangeRatio = Math.max(0, options.rangePercent) / 100;
            const rawRange = Math.abs(baseValue) * rangeRatio;
            const range = rawRange > 0 ? rawRange : rangeRatio > 0 ? 1 : 0;
            let min = baseValue - range;
            let max = baseValue + range;

            // Special clamping for percent params
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
                params[range.key] = this.normalizeParamValue(range.key, raw, range.baseValue);
            }

            if (this.validateParams(params)) {
                return params;
            }
        }

        return this.normalizeParams(defaultParams);
    }

    private resolveRandom(options: FinderOptions): () => number {
        if (options.mode !== "robust_random_wf") {
            return Math.random;
        }
        const seedValue = Number.isFinite(options.robustSeed) ? Number(options.robustSeed) : 1337;
        return this.createSeededRandom(seedValue);
    }

    private createSeededRandom(seed: number): () => number {
        let state = (Math.floor(seed) >>> 0) || 1;
        return () => {
            state += 0x6D2B79F5;
            let t = state;
            t = Math.imul(t ^ (t >>> 15), t | 1);
            t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    }

    private tryAddCombo(params: StrategyParams, combos: StrategyParams[], seen: Set<string>, maxRuns: number): void {
        if (combos.length >= maxRuns) return;
        if (!this.validateParams(params)) return;
        const key = this.serializeParams(params);
        if (seen.has(key)) return;
        seen.add(key);
        combos.push({ ...params });
    }

    private normalizeParams(params: StrategyParams): StrategyParams {
        const normalized: StrategyParams = {};
        Object.entries(params).forEach(([key, value]) => {
            normalized[key] = this.normalizeParamValue(key, value, value);
        });
        return normalized;
    }

    private normalizeParamValue(key: string, value: number, defaultValue: number): number {
        const isRsiThreshold = /(rsi(bullish|bearish|overbought|oversold)|overbought|oversold)/i.test(key);
        const isRsiPeriod = /rsi/i.test(key) && !isRsiThreshold;
        const iterationLike = /(iteration|iterations|interval)/i.test(key);
        const alphaLike = /alpha/i.test(key);
        const periodLike = /(period|lookback|bars|bins|length)/i.test(key) || isRsiPeriod || iterationLike || alphaLike;
        const percentLike = /(percent|pct)/i.test(key) || isRsiThreshold;
        const nonNegative = /(std|dev|factor|multiplier|atr|adx)/i.test(key);

        let next = value;
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

        if (/(multiplier|factor)/i.test(key) && defaultValue > 0) {
            next = Math.max(0.1, next);
        }

        if (/z(entry|exit)/i.test(key)) {
            next = Math.max(0, next);
        }

        if (key === "bufferAtr") {
            next = Math.max(0, next);
        }

        if (!periodLike && Number.isInteger(defaultValue) && !percentLike && key !== "stopLossPercent" && key !== "takeProfitPercent" && key !== "targetPct") {
            next = Math.round(next);
        } else if (key === "stopLossPercent" || key === "takeProfitPercent") {
            next = Number(next.toFixed(2));
        } else if (key === "targetPct") {
            next = Number(next.toFixed(2));
        } else if (!Number.isInteger(defaultValue)) {
            next = Number(next.toFixed(4));
        }

        return next;
    }

    private validateParams(params: StrategyParams): boolean {
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

    private serializeParams(params: StrategyParams): string {
        return Object.keys(params)
            .sort()
            .map((key) => `${key}:${params[key]}`)
            .join("|");
    }
}
