import { parentPort } from 'node:worker_threads';
import { runBatchBacktest, type BatchBacktestRunInput } from '../../batch-backtest/batch-backtest-runner';
import { createCapturedServerBatchDatasetLoader } from '../../batch-backtest/server-batch-data-loader';
import { loadBuiltInStrategyByKey } from '../../../strategyRegistry';
import { runMonteCarloSimulation } from '../../strategies/monte-carlo/monte-carlo-engine';
import { parseTimeToUnixSeconds } from '../../time-normalization';
import { universeDigest } from './store';
import { UNIVERSE_ALGORITHM, UNIVERSE_LIMITS, emptyUniverseRow, projectUniverseMetrics, shortUniverseError,
    universeEffectivePaths, universeReplay, validateUniverseTrades, assertUniverseFinite,
    type UniverseRunRequestV1, type UniverseInstrument, type UniverseJournalRecord } from './model';

export type UniverseWorkerTask = { kind: 'run'; request: UniverseRunRequestV1; inventory: UniverseInstrument[]; asOfTimeSec: number }
    | { kind: 'detail'; record: UniverseJournalRecord };
export type UniverseWorkerMessage = { type: 'commit'; record: UniverseJournalRecord } | { type: 'progress'; index: number; stage: string }
    | { type: 'done' } | { type: 'detail'; result: Awaited<ReturnType<typeof replayUniverseDetail>> } | { type: 'fatal'; error: string };

export async function replayUniverseDetail(record: UniverseJournalRecord) {
    const replay = record.replay;
    if (!replay || replay.schemaVersion !== 1 || replay.algorithmVersion !== UNIVERSE_ALGORITHM
        || universeDigest(replay) !== record.row.inputDigest) throw new Error('Replay incompatible or digest mismatch; rerun the universe.');
    validateUniverseTrades(replay.input.trades, replay.sizing.executionMode === 'equal_weight');
    const result = await runMonteCarloSimulation(replay.input, replay.settings, undefined, undefined, { sizing: replay.sizing, inputSource: 'universe' });
    if (result.status !== 'success') throw new Error(result.errorMessage ?? 'detail_failed');
    assertUniverseFinite(result);
    return { result, digest: record.row.inputDigest };
}

/** The completion callback never rejects into Batch's backtest error handler. */
export async function executeUniverseRun(task: Extract<UniverseWorkerTask, { kind: 'run' }>,
    commit: (record: UniverseJournalRecord) => Promise<void>,
    progress: (index: number, stage: string) => void,
    loadDataset?: BatchBacktestRunInput['loadDataset']): Promise<void> {
    const { request, inventory, asOfTimeSec } = task;
    const strategy = await loadBuiltInStrategyByKey(request.strategyKey);
    if (!strategy) throw new Error('Unknown built-in strategy');
    const loader = loadDataset ? null : createCapturedServerBatchDatasetLoader(request.sourceContext.provider);
    let fatal: unknown = null;
    let committed = 0;
    await runBatchBacktest({ symbols: inventory.map(i => i.token), strategyKey: request.strategyKey, strategy,
        strategyParams: request.strategyParams, backtestSettings: request.backtestSettings,
        capitalSettings: { ...request.capitalSettings, initialCapital: request.simulation.initialCapital }, interval: request.interval,
        blockRange: request.blockRange, asOfTimeSec, engineMode: 'typescript', useRustEnginePreference: false,
        pruneResultArtifacts: true, loadDataset: loadDataset ?? ((symbol, interval, signal) => loader!.load(symbol, interval, signal)),
    }, { isCancelled: () => fatal !== null, setProgress: () => {}, setStatus: () => {},
        onSymbolStart: (index) => progress(index, 'Loading / backtesting'),
        onSymbolComplete: async (index, batch) => {
            try {
                if (fatal || index < committed) return;
                if (index !== committed) throw new Error('unexpected_completion_order');
                const row = emptyUniverseRow(inventory[index], request.simulation.seed,
                    batch.status === 'load_failed' ? 'load_failed' : batch.status === 'run_failed' ? 'backtest_failed' : 'insufficient_trades', batch.error ?? null);
                row.barCount = batch.barCount;
                row.firstTime = batch.firstTime === undefined ? null : parseTimeToUnixSeconds(batch.firstTime);
                row.lastTime = batch.lastTime === undefined ? null : parseTimeToUnixSeconds(batch.lastTime);
                let replay: UniverseJournalRecord['replay'] = null;
                if (batch.result) {
                    if (batch.result.marketContext) {
                        const coverage = batch.result.marketContext;
                        row.barCount = coverage.candleCount;
                        row.firstTime = coverage.firstCandleTime === null ? null : parseTimeToUnixSeconds(coverage.firstCandleTime);
                        row.lastTime = coverage.lastCandleTime === null ? null : parseTimeToUnixSeconds(coverage.lastCandleTime);
                    }
                    row.tradeRecords = batch.result.trades.length;
                    row.observedReturnPercent = 100 * (batch.result.netProfit / request.simulation.initialCapital);
                    row.observedDrawdownPercent = batch.result.maxDrawdownPercent;
                    try {
                        validateUniverseTrades(batch.result.trades, row.mode === 'equal_weight');
                        assertUniverseFinite([row.observedReturnPercent, row.observedDrawdownPercent]);
                        if (row.tradeRecords >= request.criteria.minimumTradeRecords) {
                            const paths = universeEffectivePaths(row.tradeRecords, request.simulation.simulations);
                            if (paths < UNIVERSE_LIMITS.minPaths) { row.status = 'resource_limit'; row.reason = 'Work limit allows fewer than 250 paths.'; }
                            else {
                                replay = universeReplay(batch.result, request, row, paths);
                                if (Buffer.byteLength(JSON.stringify({ row, replay })) + 1024 > UNIVERSE_LIMITS.recordBytes) {
                                    row.status = 'resource_limit'; row.reason = 'Replay record exceeds 16 MiB.'; replay = null;
                                } else {
                                    progress(index, 'Bootstrap simulation');
                                    const result = await runMonteCarloSimulation(replay.input, replay.settings, undefined, undefined, { sizing: replay.sizing, inputSource: 'universe' });
                                    Object.assign(row, projectUniverseMetrics(result, request.criteria));
                                    row.status = 'evaluated'; row.inputDigest = universeDigest(replay); row.detailAvailable = true;
                                }
                            }
                        } else row.reason = `Requires ${request.criteria.minimumTradeRecords} complete trade records.`;
                    } catch (error) {
                        replay = null; row.status = 'simulation_failed'; row.reason = shortUniverseError(error);
                        if (!Number.isFinite(row.observedReturnPercent)) row.observedReturnPercent = null;
                        if (!Number.isFinite(row.observedDrawdownPercent)) row.observedDrawdownPercent = null;
                    }
                }
                progress(index, 'Saving replay input');
                await commit({ row, replay }); committed++;
            } catch (error) { fatal = error; }
        },
    });
    if (fatal) throw fatal;
}

if (parentPort) {
    const port = parentPort;
    let acknowledgment: { resolve: () => void; reject: (error: Error) => void } | null = null;
    port.on('message', (message: { type: string; task?: UniverseWorkerTask; error?: string }) => {
        if (message.type === 'commit_ack') {
            const pending = acknowledgment; acknowledgment = null;
            if (message.error) pending?.reject(new Error(message.error)); else pending?.resolve();
            return;
        }
        if (message.type !== 'run_task' || !message.task) return;
        const task = message.task;
        void (async () => {
            if (task.kind === 'detail') port.postMessage({ type: 'detail', result: await replayUniverseDetail(task.record) } satisfies UniverseWorkerMessage);
            else {
                await executeUniverseRun(task, record => new Promise<void>((resolve, reject) => {
                    acknowledgment = { resolve, reject };
                    port.postMessage({ type: 'commit', record } satisfies UniverseWorkerMessage);
                }), (index, stage) => port.postMessage({ type: 'progress', index, stage } satisfies UniverseWorkerMessage));
                port.postMessage({ type: 'done' } satisfies UniverseWorkerMessage);
            }
        })().catch(error => port.postMessage({ type: 'fatal', error: shortUniverseError(error) } satisfies UniverseWorkerMessage));
    });
}
