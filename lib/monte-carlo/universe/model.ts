import type { BacktestSettings, StrategyParams, Trade } from '../../types/strategies';
import type { CapitalSettings } from '../../types/backtest';
import type { DataProvider } from '../../types/data-providers';
import type { BinanceMarketType } from '../../binance-market';
import type { MonteCarloBacktestInput, MonteCarloResult, MonteCarloSettings, MonteCarloSizingConfig } from '../../strategies/monte-carlo/monte-carlo-engine';
import { normalizeSyntheticPairProviderMarkers, parseSyntheticPairToken } from '../../synthetic-pair-token';
import { splitSyntheticPairMode, syntheticPairModeSuffix } from '../../synthetic-pair-mode';
import { canonicalizeLegIdentity } from '../../synthetic-leg-identity';
import { isIbkrSymbol, markIbkrSymbol } from '../../local-daily-datasets';
import { validateBatchSymbolToken } from '../../batch-backtest/batch-run-contract';
import { parseIntervalSeconds } from '../../interval-utils';
import { median } from '../../statistics-utils';
import { parseTimeToUnixSeconds } from '../../time-normalization';
import { EFFECTIVE_BACKTEST_DEFAULTS } from '../../backtest-settings-resolver';
import { ADVANCED_SIZING_DEFAULTS } from '../../advanced-sizing-settings';

export const UNIVERSE_ALGORITHM = 'bootstrap-allocation-v1-fnv1a32';
export const UNIVERSE_LIMITS = Object.freeze({ symbols: 1000, rawTokens: 2000, bodyBytes: 1048576,
    statusBytes: 2 * 1048576, manifestBytes: 1048576, journalBytes: 256 * 1048576,
    recordBytes: 16 * 1048576, minPaths: 250, maxPaths: 10000, workSteps: 8000000, pageSize: 100 });
export const UNIVERSE_DEFAULTS = Object.freeze({ simulations: 1000, seed: 1337, initialCapital: 10000,
    ruinThresholdPercent: 50, minimumTradeRecords: 30, minimumProfitablePathPercent: 90, maximumP95DrawdownPercent: 20 });

export interface CapturedDataSource { provider: DataProvider; binanceMarketType: BinanceMarketType }
export interface UniverseRunRequestV1 {
    schemaVersion: 1; runId: string; strategyKey: string; strategyParams: StrategyParams;
    backtestSettings: BacktestSettings; capitalSettings: Omit<CapitalSettings, 'initialCapital'>;
    interval: string; sourceContext: CapturedDataSource; blockRange: { from: number; to: number } | null;
    symbols: string[];
    simulation: Pick<MonteCarloSettings, 'simulations' | 'seed' | 'initialCapital' | 'ruinThresholdPercent'>;
    criteria: { minimumTradeRecords: number; minimumProfitablePathPercent: number; maximumP95DrawdownPercent: number };
}
export interface UniverseInstrument { index: number; key: string; token: string; mode: 'ordinary' | 'ratio' | 'equal_weight' }
export type UniverseRowStatus = 'evaluated' | 'insufficient_trades' | 'load_failed' | 'backtest_failed' | 'simulation_failed' | 'resource_limit' | 'not_processed';
export interface UniverseRow extends UniverseInstrument {
    status: UniverseRowStatus; verdict: 'Pass' | 'Fail' | null; reason: string | null;
    barCount: number; tradeRecords: number; firstTime: number | null; lastTime: number | null;
    observedReturnPercent: number | null; observedDrawdownPercent: number | null;
    profitablePaths: number | null; profitablePathPercent: number | null; medianReturnPercent: number | null;
    p95DrawdownPercent: number | null; effectivePaths: number | null; rowSeed: number;
    inputDigest: string | null; detailAvailable: boolean;
}
export type UniverseRunState = 'accepted' | 'running' | 'completed' | 'cancelled' | 'failed' | 'interrupted';
export interface UniverseReplay {
    schemaVersion: 1; algorithmVersion: typeof UNIVERSE_ALGORITHM;
    input: MonteCarloBacktestInput; settings: MonteCarloSettings; sizing: MonteCarloSizingConfig;
}
export interface UniverseJournalRecord { row: UniverseRow; replay: UniverseReplay | null }
export interface UniverseManifest {
    schemaVersion: 1; algorithmVersion: typeof UNIVERSE_ALGORITHM; request: UniverseRunRequestV1;
    inventory: UniverseInstrument[]; rawCount: number; duplicateCount: number; requestDigest: string;
    state: UniverseRunState; asOfTimeSec: number; startedAt: number; finishedAt: number | null; error: string | null;
    counts?: ReturnType<typeof universeCoverage>;
}
export interface UniverseSnapshot {
    schemaVersion: 1; algorithmVersion: typeof UNIVERSE_ALGORITHM; runId: string; state: UniverseRunState;
    configuration: Omit<UniverseRunRequestV1, 'symbols'>;
    rawCount: number; duplicateCount: number; asOfTimeSec: number; startedAt: number; finishedAt: number | null;
    error: string | null; stage: string; currentIndex: number | null; rows: UniverseRow[];
    counts: ReturnType<typeof universeCoverage>;
}
export function isUniverseTerminal(state: UniverseRunState): boolean { return state !== 'accepted' && state !== 'running'; }
export function shortUniverseError(error: unknown): string { return (error instanceof Error ? error.message : String(error)).slice(0, 256); }
export function validateUniverseRunId(value: unknown): asserts value is string {
    if (typeof value !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value)) throw new Error('invalid_run_id');
}
function object(value: unknown): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid_request');
}
function knownKeys(value: object, keys: readonly string[]): void {
    if (Object.keys(value).some(key => !keys.includes(key))) throw new Error('unsupported_request_field');
}
function number(value: unknown, min: number, max = Number.MAX_VALUE, integer = false): void {
    if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw new Error('invalid_numeric_setting');
}
export function assertUniverseFinite(value: unknown): void {
    if (typeof value === 'number' && !Number.isFinite(value)) throw new Error('non_finite_simulation');
    if (value && typeof value === 'object') for (const item of Object.values(value)) assertUniverseFinite(item);
}
export function canonicalUniverseInventory(symbols: string[], source: CapturedDataSource, interval: string): UniverseInstrument[] {
    if (!Array.isArray(symbols) || symbols.length < 1 || symbols.length > UNIVERSE_LIMITS.rawTokens) throw new Error('invalid_symbol_count');
    const unique = new Map<string, UniverseInstrument>();
    for (const raw of symbols) {
        if (typeof raw !== 'string' || raw.length > 128) throw new Error('invalid_symbol');
        const mode = splitSyntheticPairMode(raw);
        if (!mode) throw new Error('invalid_pair_suffix');
        // The established token guard rejects slash paths; validate the parsed body,
        // after recognizing the sole supported slash-bearing allocation suffix.
        if (validateBatchSymbolToken(mode.pair) || !/^[A-Z0-9._+\u2022-]+$/.test(mode.pair)) throw new Error('invalid_symbol');
        let token = mode.pair;
        let execution: UniverseInstrument['mode'] = 'ordinary';
        if (token.includes('+')) {
            if (source.provider === 'ibkr-local' && !token.includes('\u2022')) token = token.split('+').map(markIbkrSymbol).join('+');
            const pair = parseSyntheticPairToken(normalizeSyntheticPairProviderMarkers(token + syntheticPairModeSuffix(mode.executionMode)));
            if (!pair || pair.baseSymbol === pair.quoteSymbol) throw new Error('invalid_pair');
            if (isIbkrSymbol(pair.baseSymbol) !== isIbkrSymbol(pair.quoteSymbol)) throw new Error('conflicting_providers');
            token = `${pair.baseSymbol}+${pair.quoteSymbol}${syntheticPairModeSuffix(mode.executionMode)}`;
            execution = mode.executionMode ?? 'ratio';
        } else {
            if (mode.executionMode) throw new Error('invalid_pair_suffix');
            if (source.provider === 'ibkr-local') token = markIbkrSymbol(token);
            else if (source.provider === 'binance' || source.provider === 'binance-futures') {
                token = canonicalizeLegIdentity(token)?.loaderSymbol ?? '';
            }
            if (!token) throw new Error('invalid_symbol');
        }
        if (token.length > 128) throw new Error('invalid_symbol');
        const provider = token.includes('\u2022') ? 'ibkr-local' : source.provider;
        const key = `${provider}|${provider.startsWith('binance') ? source.binanceMarketType : ''}|${interval}|${token}`;
        if (!unique.has(key)) unique.set(key, { index: unique.size, key, token, mode: execution });
    }
    if (unique.size > UNIVERSE_LIMITS.symbols) throw new Error('invalid_symbol_count');
    return [...unique.values()];
}
export function validateUniverseRequest(value: unknown): { request: UniverseRunRequestV1; inventory: UniverseInstrument[]; rawCount: number; duplicateCount: number } {
    object(value);
    const r = value as unknown as UniverseRunRequestV1;
    knownKeys(r, ['schemaVersion', 'runId', 'strategyKey', 'strategyParams', 'backtestSettings', 'capitalSettings', 'interval', 'sourceContext', 'blockRange', 'symbols', 'simulation', 'criteria']);
    validateUniverseRunId(r.runId);
    if (r.schemaVersion !== 1 || typeof r.strategyKey !== 'string' || !/^[\w-]{1,128}$/.test(r.strategyKey)) throw new Error('invalid_strategy_or_schema');
    if (typeof r.interval !== 'string' || r.interval.length > 32 || !/^(\d+)(s|m|h|d|w|M)$/.test(r.interval)
        || !Number.isFinite(parseIntervalSeconds(r.interval)) || !((parseIntervalSeconds(r.interval) ?? 0) > 0)) throw new Error('invalid_interval');
    object(r.strategyParams); object(r.backtestSettings); object(r.capitalSettings); object(r.sourceContext); object(r.simulation); object(r.criteria);
    assertUniverseFinite(r);
    knownKeys(r.sourceContext, ['provider', 'binanceMarketType']);
    knownKeys(r.simulation, ['simulations', 'seed', 'initialCapital', 'ruinThresholdPercent']);
    knownKeys(r.criteria, ['minimumTradeRecords', 'minimumProfitablePathPercent', 'maximumP95DrawdownPercent']);
    if (!['binance', 'binance-futures', 'bybit-tradfi', 'ibkr-local'].includes(r.sourceContext.provider)
        || !['spot', 'futures'].includes(r.sourceContext.binanceMarketType)
        || (r.sourceContext.provider === 'binance' && r.sourceContext.binanceMarketType !== 'spot')
        || (r.sourceContext.provider === 'binance-futures' && r.sourceContext.binanceMarketType !== 'futures')) throw new Error('invalid_source');
    if ('initialCapital' in r.capitalSettings) throw new Error('duplicate_initial_capital');
    knownKeys(r.capitalSettings, ['positionSize', 'commission', 'sizingMode', 'fixedTradeAmount', 'advancedSizing']);
    if (r.capitalSettings.advancedSizing !== undefined) {
        object(r.capitalSettings.advancedSizing);
        for (const [key, val] of Object.entries(r.capitalSettings.advancedSizing)) {
            const expected = (ADVANCED_SIZING_DEFAULTS as Record<string, unknown>)[key];
            if (expected === undefined || typeof val !== typeof expected || (typeof val === 'string' && val.length > 128)) throw new Error('invalid_advanced_sizing');
        }
    }
    if (!['fixed', 'percent'].includes(r.capitalSettings.sizingMode)) throw new Error('unsupported_sizing');
    number(r.capitalSettings.positionSize, 0); number(r.capitalSettings.fixedTradeAmount, 0); number(r.capitalSettings.commission, 0);
    if ((r.capitalSettings.sizingMode === 'fixed' ? r.capitalSettings.fixedTradeAmount : r.capitalSettings.positionSize) <= 0) throw new Error('invalid_sizing');
    const params = (p: unknown) => {
        object(p);
        const entries = Object.entries(p as object);
        if (entries.length > 128 || entries.some(([key]) => !/^[\w-]{1,128}$/.test(key))) throw new Error('invalid_strategy_parameters');
        for (const [, val] of entries) number(val, -Number.MAX_VALUE);
    };
    params(r.strategyParams);
    const otherTypes: Record<string, string> = { trendEmaPeriod: 'number', trendEmaSlopeBars: 'number', atrPercentMin: 'number', atrPercentMax: 'number',
        adxPeriod: 'number', adxMin: 'number', adxMax: 'number', exitStrategyOverrideEnabled: 'boolean', exitStrategyKey: 'string',
        exitStrategyParams: 'object', confirmationStrategiesToggle: 'boolean', confirmationStrategies: 'object', confirmationStrategyParams: 'object' };
    for (const [key, setting] of Object.entries(r.backtestSettings)) {
        const expected = Object.prototype.hasOwnProperty.call(EFFECTIVE_BACKTEST_DEFAULTS, key)
            ? typeof (EFFECTIVE_BACKTEST_DEFAULTS as Record<string, unknown>)[key] : otherTypes[key];
        if (!expected || typeof setting !== expected || setting === null) throw new Error(`invalid_setting_${key}`);
    }
    const enums: Record<string, readonly string[]> = { executionModel: ['signal_close', 'next_open', 'next_close'],
        tradeDirection: ['long', 'short', 'both', 'both_no_flip', 'combined'], riskMode: ['simple', 'advanced', 'percentage'],
        takeProfitMode: ['fixed'], marketMode: ['all', 'uptrend', 'downtrend', 'sideway'], entryTimeFilter: ['day_open', 'day_close'],
        confirmationMode: ['agree', 'disagree', 'veto_opposite', 'confirm_within_window', 'veto_within_window'], riskEntryConfirmationMove: ['up', 'down', 'both'] };
    for (const [key, allowed] of Object.entries(enums)) {
        const setting = (r.backtestSettings as Record<string, unknown>)[key];
        if (setting !== undefined && (typeof setting !== 'string' || !allowed.includes(setting))) throw new Error(`invalid_setting_${key}`);
    }
    if (r.backtestSettings.exitStrategyKey !== undefined && (r.backtestSettings.exitStrategyKey.length > 128 || (r.backtestSettings.exitStrategyKey !== '' && !/^[\w-]+$/.test(r.backtestSettings.exitStrategyKey)))) throw new Error('invalid_exit_strategy');
    if (r.backtestSettings.exitStrategyParams) params(r.backtestSettings.exitStrategyParams);
    if (r.backtestSettings.confirmationStrategyParams) {
        object(r.backtestSettings.confirmationStrategyParams);
        if (Object.keys(r.backtestSettings.confirmationStrategyParams).length > 64) throw new Error('invalid_confirmation_strategies');
        for (const p of Object.values(r.backtestSettings.confirmationStrategyParams)) params(p);
    }
    if (r.backtestSettings.confirmationStrategies && (!Array.isArray(r.backtestSettings.confirmationStrategies)
        || r.backtestSettings.confirmationStrategies.length > 64 || r.backtestSettings.confirmationStrategies.some(k => typeof k !== 'string' || !/^[\w-]{1,128}$/.test(k)))) throw new Error('invalid_confirmation_strategies');
    if ((r.backtestSettings.partialTakeProfitAtR ?? 0) > 0 || (r.backtestSettings.partialTakeProfitPercent ?? 0) > 0) throw new Error('unsupported_partial_exits');
    if (r.backtestSettings.exitStrategyOverrideEnabled) {
        for (const key of ['partialTakeProfitAtR', 'partialTakeProfitPercent']) {
            if ((r.backtestSettings.exitStrategyParams?.[key] ?? 0) > 0) throw new Error('unsupported_partial_exits');
        }
    }
    if (r.blockRange !== null) { object(r.blockRange); number(r.blockRange.from, -8640000000000, 8640000000000); number(r.blockRange.to, r.blockRange.from, 8640000000000); }
    validateUniverseScreenSettings(r.simulation, r.criteria);
    const inventory = canonicalUniverseInventory(r.symbols, r.sourceContext, r.interval);
    if (new TextEncoder().encode(JSON.stringify(r)).length > UNIVERSE_LIMITS.bodyBytes) throw new Error('request_body_limit');
    return { request: r, inventory, rawCount: r.symbols.length, duplicateCount: r.symbols.length - inventory.length };
}
export function validateUniverseScreenSettings(simulation: UniverseRunRequestV1['simulation'], criteria: UniverseRunRequestV1['criteria']): void {
    number(simulation.simulations, UNIVERSE_LIMITS.minPaths, UNIVERSE_LIMITS.maxPaths, true); number(simulation.seed, 0, 4294967295, true);
    number(simulation.initialCapital, Number.MIN_VALUE); number(simulation.ruinThresholdPercent, 0, 100);
    number(criteria.minimumTradeRecords, 5, 100000, true); number(criteria.minimumProfitablePathPercent, 0, 100); number(criteria.maximumP95DrawdownPercent, 0);
}
export function universeRowSeed(baseSeed: number, key: string): number {
    let hash = 2166136261;
    for (const byte of new TextEncoder().encode(`${baseSeed}\n${key}`)) hash = Math.imul(hash ^ byte, 16777619) >>> 0;
    return hash;
}
export function universeEffectivePaths(records: number, requested: number): number {
    return Math.min(requested, UNIVERSE_LIMITS.maxPaths, Math.floor(UNIVERSE_LIMITS.workSteps / Math.max(1, records)));
}
export function emptyUniverseRow(item: UniverseInstrument, baseSeed: number, status: UniverseRowStatus, reason: string | null = null): UniverseRow {
    return { ...item, status, reason: reason?.slice(0, 256) ?? null, verdict: null, barCount: 0, tradeRecords: 0,
        firstTime: null, lastTime: null, observedReturnPercent: null, observedDrawdownPercent: null,
        profitablePaths: null, profitablePathPercent: null, medianReturnPercent: null, p95DrawdownPercent: null,
        effectivePaths: null, rowSeed: universeRowSeed(baseSeed, item.key), inputDigest: null, detailAvailable: false };
}
export function validateUniverseTrades(trades: Trade[], equalWeight: boolean): void {
    for (const t of trades) {
        if (t.exitReason === 'partial') throw new Error('unsupported_partial_records');
        assertUniverseFinite(t);
        if (![t.pnl, t.entryPrice, t.exitPrice, t.size, t.pnlPercent].every(Number.isFinite)
            || t.entryPrice <= 0 || t.exitPrice <= 0 || t.size <= 0 || !['long', 'short'].includes(t.type)
            || parseTimeToUnixSeconds(t.entryTime) === null || parseTimeToUnixSeconds(t.exitTime) === null) throw new Error('invalid_trade_records');
        if (equalWeight) {
            if (!t.legs) throw new Error('invalid_pair_records');
            for (const leg of [t.legs.base, t.legs.quote]) {
                if (!leg || ![leg.entryPrice, leg.exitPrice, leg.size, leg.fees].every(Number.isFinite)
                    || leg.entryPrice <= 0 || leg.exitPrice <= 0 || leg.size <= 0 || leg.fees < 0 || !['long', 'short'].includes(leg.side)) throw new Error('invalid_pair_records');
            }
            if (t.legs.base.side !== t.type || t.legs.base.side === t.legs.quote.side) throw new Error('invalid_pair_records');
            const e = Math.abs(t.size * t.entryPrice);
            const sum = Math.abs(t.legs.base.size * t.legs.base.entryPrice) + Math.abs(t.legs.quote.size * t.legs.quote.entryPrice);
            if (!Number.isFinite(sum) || Math.abs(e - sum) > 1e-9 * Math.max(1, e, sum)) throw new Error('invalid_pair_records');
        }
    }
}
/** Explicit allowlist: execution artifacts and analytics cannot enter the journal. */
export function universeReplay(input: MonteCarloBacktestInput, request: UniverseRunRequestV1, row: UniverseRow, paths: number): UniverseReplay {
    const trades: Trade[] = input.trades.map(t => ({ id: t.id, type: t.type, entryTime: t.entryTime, entryPrice: t.entryPrice,
        exitTime: t.exitTime, exitPrice: t.exitPrice, pnl: t.pnl, pnlPercent: t.pnlPercent, size: t.size,
        ...(t.fees !== undefined ? { fees: t.fees } : {}), ...(t.exitReason ? { exitReason: t.exitReason } : {}),
        ...(t.legs ? { legs: { base: { side: t.legs.base.side, size: t.legs.base.size, entryPrice: t.legs.base.entryPrice, exitPrice: t.legs.base.exitPrice, fees: t.legs.base.fees },
            quote: { side: t.legs.quote.side, size: t.legs.quote.size, entryPrice: t.legs.quote.entryPrice, exitPrice: t.legs.quote.exitPrice, fees: t.legs.quote.fees } } } : {}) }));
    return { schemaVersion: 1, algorithmVersion: UNIVERSE_ALGORITHM,
        input: { trades, netProfit: input.netProfit, maxDrawdownPercent: input.maxDrawdownPercent, sharpeRatio: input.sharpeRatio, winRate: input.winRate },
        settings: { ...request.simulation, seed: row.rowSeed, simulations: paths, enableBootstrap: true, enableSequenceRandomization: false },
        sizing: { mode: request.capitalSettings.sizingMode, fixedTradeAmount: request.capitalSettings.fixedTradeAmount,
            positionSizePercent: request.capitalSettings.positionSize, commissionPercent: request.capitalSettings.commission,
            ...(row.mode === 'equal_weight' ? { executionMode: 'equal_weight' as const } : {}) } };
}
export function projectUniverseMetrics(result: MonteCarloResult, criteria: UniverseRunRequestV1['criteria']) {
    if (result.status !== 'success') throw new Error(result.errorMessage ?? 'simulation_failed');
    assertUniverseFinite(result);
    const profits = result.metricSamples.netProfitValues;
    if (!profits.length || profits.length !== result.simulationsCompleted) throw new Error('invalid_simulation_count');
    const profitablePaths = profits.filter(p => p > 0).length;
    const profitablePathPercent = 100 * profitablePaths / profits.length;
    const medianReturnPercent = median(profits.map(p => 100 * (p / result.settings.initialCapital)));
    const p95DrawdownPercent = result.ruinProbabilityMetrics.maxDrawdownDistribution.percentile95;
    const verdict = profitablePathPercent >= criteria.minimumProfitablePathPercent && p95DrawdownPercent <= criteria.maximumP95DrawdownPercent ? 'Pass' as const : 'Fail' as const;
    const metrics = { profitablePaths, profitablePathPercent, medianReturnPercent, p95DrawdownPercent, verdict, effectivePaths: profits.length };
    assertUniverseFinite(metrics);
    return metrics;
}
export function universeCoverage(rows: readonly UniverseRow[], requested = rows.length) {
    const count = (s: UniverseRowStatus) => rows.filter(r => r.status === s).length;
    const evaluated = count('evaluated'), passed = rows.filter(r => r.verdict === 'Pass').length;
    const notProcessed = requested - rows.filter(r => r.status !== 'not_processed').length;
    return { requested, evaluated, passed, failed: evaluated - passed, processed: requested - notProcessed,
        insufficient: count('insufficient_trades'), loadFailed: count('load_failed'), backtestFailed: count('backtest_failed'),
        simulationFailed: count('simulation_failed'), resourceLimited: count('resource_limit'), notProcessed,
        passRatePercent: evaluated ? 100 * passed / evaluated : null };
}
export type UniverseSortKey = keyof Pick<UniverseRow, 'token' | 'firstTime' | 'barCount' | 'tradeRecords' | 'observedReturnPercent' | 'profitablePathPercent' | 'medianReturnPercent' | 'p95DrawdownPercent' | 'status'>;
export function sortUniverseRows(rows: readonly UniverseRow[], key?: UniverseSortKey, ascending = true): UniverseRow[] {
    const compare = (a: string | number | null, b: string | number | null, asc: boolean) => a === null ? (b === null ? 0 : 1) : b === null ? -1
        : (typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b))) * (asc ? 1 : -1);
    return [...rows].sort((a, b) => (key ? compare(a[key], b[key], ascending)
        : compare(a.verdict === 'Pass' ? 0 : a.verdict === 'Fail' ? 1 : 2, b.verdict === 'Pass' ? 0 : b.verdict === 'Fail' ? 1 : 2, true)
            || compare(a.profitablePathPercent, b.profitablePathPercent, false) || compare(a.p95DrawdownPercent, b.p95DrawdownPercent, true)) || a.key.localeCompare(b.key));
}
export function universeSnapshot(manifest: UniverseManifest, committed: readonly UniverseRow[], stage = '', currentIndex: number | null = null): UniverseSnapshot {
    const rows = isUniverseTerminal(manifest.state) ? manifest.inventory.map(item => committed[item.index] ?? emptyUniverseRow(item, manifest.request.simulation.seed, 'not_processed')) : [...committed];
    const { symbols: _symbols, ...configuration } = manifest.request;
    return { schemaVersion: 1, algorithmVersion: UNIVERSE_ALGORITHM, runId: manifest.request.runId, state: manifest.state,
        configuration, rawCount: manifest.rawCount, duplicateCount: manifest.duplicateCount, asOfTimeSec: manifest.asOfTimeSec,
        startedAt: manifest.startedAt, finishedAt: manifest.finishedAt, error: manifest.error, stage, currentIndex, rows, counts: universeCoverage(rows, manifest.inventory.length) };
}
