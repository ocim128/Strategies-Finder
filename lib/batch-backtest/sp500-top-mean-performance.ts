export interface TopMeanCacheCounters {
    legHits: number;
    legMisses: number;
    pairHits: number;
    pairMisses: number;
    diskHits: number;
    diskMisses: number;
    diskWrites: number;
}

export interface TopMeanWorkerTiming {
    attemptedPairs: number;
    completedPairs: number;
    failedPairs: number;
    loadMs: number;
    prepareMs: number;
    backtestMs: number;
    artifactMs: number;
    pairWallMs: number;
    shardWallMs: number;
    cache: TopMeanCacheCounters;
}

export interface TopMeanWorkerPoolPerformance extends TopMeanWorkerTiming {
    workers: number;
    spawnedWorkers: number;
    reusedWorkers: number;
    shards: number;
    pendingShards: number;
    shardSize: number;
    workerBundleMs: number;
    workerStartupMs: number;
    wallMs: number;
}

export interface TopMeanPerformanceDiagnostic {
    schema: "sp500_top_mean_performance.v1";
    startedAt: string;
    completedAt?: string;
    totalMs: number;
    pairCount: number;
    completedPairs: number;
    failedPairs: number;
    workerCount: number;
    pairsPerSecond: number;
    phases: {
        preflightMs: number;
        backtestingMs: number;
        snapshotMs: number;
        replayMs: number;
        resultWriteMs: number;
    };
    replay: {
        scanMs: number;
        eventsMs: number;
        targetsMs: number;
        outcomesMs: number;
        aggregateMs: number;
        targetLoadMs: number;
        targetDatasets: number;
    };
    worker?: TopMeanWorkerPoolPerformance;
}

function fixed(value: number): string {
    return Number.isFinite(value) ? value.toFixed(1) : "0.0";
}

function percent(part: number, whole: number): string {
    if (!Number.isFinite(part) || !Number.isFinite(whole) || whole <= 0) return "0.0%";
    return `${((part / whole) * 100).toFixed(1)}%`;
}

export function formatTopMeanPerformanceLines(performance: TopMeanPerformanceDiagnostic): string[] {
    const p = performance;
    const lines = [
        `PERFORMANCE | total=${fixed(p.totalMs)}ms | pairs=${p.completedPairs}/${p.pairCount} | failed=${p.failedPairs} | workers=${p.workerCount} | throughput=${fixed(p.pairsPerSecond)} pairs/s`,
        `PERFORMANCE PHASES | preflight=${fixed(p.phases.preflightMs)}ms | backtesting=${fixed(p.phases.backtestingMs)}ms | snapshot=${fixed(p.phases.snapshotMs)}ms | replay=${fixed(p.phases.replayMs)}ms | resultWrite=${fixed(p.phases.resultWriteMs)}ms`,
        `PERFORMANCE REPLAY | scan=${fixed(p.replay.scanMs)}ms | events=${fixed(p.replay.eventsMs)}ms | targets=${fixed(p.replay.targetsMs)}ms | outcomes=${fixed(p.replay.outcomesMs)}ms | aggregate=${fixed(p.replay.aggregateMs)}ms | targetLoad=${fixed(p.replay.targetLoadMs)}ms/${p.replay.targetDatasets}`,
    ];

    const worker = p.worker;
    if (!worker) return lines;

    const measuredWorkerMs = worker.loadMs + worker.prepareMs + worker.backtestMs + worker.artifactMs;
    lines.push(
        `PERFORMANCE WORKERS | wall=${fixed(worker.wallMs)}ms | shards=${worker.pendingShards}/${worker.shards} | shardSize=${worker.shardSize} | spawned=${worker.spawnedWorkers} | reused=${worker.reusedWorkers} | bundle=${fixed(worker.workerBundleMs)}ms | startup=${fixed(worker.workerStartupMs)}ms`,
        `PERFORMANCE WORKER COST | load=${fixed(worker.loadMs)}ms (${percent(worker.loadMs, measuredWorkerMs)}) | prepare=${fixed(worker.prepareMs)}ms (${percent(worker.prepareMs, measuredWorkerMs)}) | backtest=${fixed(worker.backtestMs)}ms (${percent(worker.backtestMs, measuredWorkerMs)}) | artifact=${fixed(worker.artifactMs)}ms (${percent(worker.artifactMs, measuredWorkerMs)}) | summedPair=${fixed(worker.pairWallMs)}ms`,
        `PERFORMANCE CACHE | leg=${worker.cache.legHits} hit/${worker.cache.legMisses} miss | pair=${worker.cache.pairHits} hit/${worker.cache.pairMisses} miss | disk=${worker.cache.diskHits} hit/${worker.cache.diskMisses} miss/${worker.cache.diskWrites} write`,
    );
    return lines;
}
