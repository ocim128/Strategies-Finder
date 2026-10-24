import { resolve } from 'node:path';
import type { Plugin } from 'vite';
import { registerLocalJsonRoute, sendJson, HttpStatusError, type LocalRouteMiddlewareStack } from '../../vite-http-utils';
import type { BatchOwnerLocks, BatchOwnerToken } from '../../batch-backtest/sp500-top-mean-vite-routes';
import { resolveWorkerEntryPath, type WorkerBundleMemoRecord } from '../../server-worker-entry';
import { createFinderTaskWorker } from '../../finder/server/finder-task-worker';
import { isBuiltInKey } from '../../strategies/built-in-catalog';
import { loadBuiltInStrategyByKey } from '../../../strategyRegistry';
import { UniverseStore, universeDigest, type StoredUniverseRun } from './store';
import { UNIVERSE_ALGORITHM, UNIVERSE_LIMITS, isUniverseTerminal, shortUniverseError, universeSnapshot,
    validateUniverseRequest, validateUniverseRunId, type UniverseManifest, type UniverseRunState } from './model';
import type { UniverseWorkerTask, UniverseWorkerMessage } from './worker';

type TaskWorker = ReturnType<typeof createFinderTaskWorker<UniverseWorkerTask, UniverseWorkerMessage>>;
interface ActiveUniverse {
    id: string; digest: string; token: BatchOwnerToken; stopped: boolean; run: StoredUniverseRun | null;
    worker: TaskWorker | null; stage: string; index: number | null; fatal: string | null;
    launch: Promise<void> | null; finalizing: Promise<void> | null;
    admission: Promise<StoredUniverseRun> | null;
}

/** One owner generation spans admission, worker termination, and the serialized writer. */
export class UniverseServer {
    readonly store: UniverseStore;
    private readonly ready: Promise<void>;
    private active: ActiveUniverse | null = null;
    private pendingStop: string | null = null;
    private disposed = false;
    private detailWorker: TaskWorker | null = null;
    private detailDone: Promise<unknown> | null = null;
    private readonly memo: { record: WorkerBundleMemoRecord | null } = { record: null };
    constructor(private readonly root: string, private readonly locks: BatchOwnerLocks,
        private readonly workerEntry?: () => Promise<string>) {
        this.store = new UniverseStore(root); this.ready = this.store.initialize();
        // A recovery I/O failure is reported by routes, never an unhandled boot rejection.
        this.ready.catch(() => undefined);
    }
    private async entry(): Promise<string> {
        const path = await (this.workerEntry?.() ?? resolveWorkerEntryPath({
            repositorySourcePath: resolve(this.root, 'lib/monte-carlo/universe/worker.ts'),
            moduleSourcePath: resolve(this.root, 'lib/monte-carlo/universe/worker.ts'),
            temporaryNamespace: 'monte-carlo-universe-workers', outputFileName: 'worker.cjs', memo: this.memo,
        }));
        if (!/\.(c?js|mjs)$/.test(path)) throw new Error('Worker bundling failed; runnable JavaScript is required.');
        return path;
    }
    async run(value: unknown): Promise<{ runId: string }> {
        let parsed: ReturnType<typeof validateUniverseRequest>;
        try { parsed = validateUniverseRequest(value); }
        catch (error) { throw new HttpStatusError(400, shortUniverseError(error)); }
        const { request, inventory, rawCount, duplicateCount } = parsed;
        if (!isBuiltInKey(request.strategyKey)) throw new HttpStatusError(400, 'Unknown built-in strategy.');
        const validateParams = async (key: string, params: Record<string, number>) => {
            if (!isBuiltInKey(key)) throw new HttpStatusError(400, `Unknown built-in strategy: ${key}`);
            const strategy = await loadBuiltInStrategyByKey(key);
            if (!strategy || Object.keys(params).some(name => !Object.prototype.hasOwnProperty.call(strategy.defaultParams, name))) {
                throw new HttpStatusError(400, `Unsupported strategy parameters: ${key}`);
            }
        };
        await validateParams(request.strategyKey, request.strategyParams);
        for (const key of request.backtestSettings.confirmationStrategies ?? []) await validateParams(key, request.backtestSettings.confirmationStrategyParams?.[key] ?? {});
        for (const [key, params] of Object.entries(request.backtestSettings.confirmationStrategyParams ?? {})) await validateParams(key, params);
        if (request.backtestSettings.exitStrategyOverrideEnabled) await validateParams(request.backtestSettings.exitStrategyKey ?? '', request.backtestSettings.exitStrategyParams ?? {});
        await this.ready;
        if (this.disposed) throw new HttpStatusError(503, 'Server is shutting down.');
        const digest = universeDigest(request);
        const previous = this.store.get(request.runId);
        const previousDigest = previous?.manifest.requestDigest ?? (this.active?.id === request.runId ? this.active.digest : null);
        if (previousDigest) {
            if (previousDigest !== digest) throw new HttpStatusError(409, 'run_id_conflict');
            if (this.active?.id === request.runId) await this.active.admission;
            return { runId: request.runId };
        }
        if (!this.locks.acquireExclusive) throw new HttpStatusError(503, 'Checked owner adapter unavailable.');
        const token = this.locks.acquireExclusive(request.runId, 'monte_carlo_universe');
        const active: ActiveUniverse = { id: request.runId, digest, token, stopped: this.pendingStop === request.runId,
            run: null, worker: null, stage: 'Accepted', index: null, fatal: null, launch: null, finalizing: null, admission: null };
        if (active.stopped) this.pendingStop = null;
        this.active = active;
        const manifest: UniverseManifest = { schemaVersion: 1, algorithmVersion: UNIVERSE_ALGORITHM,
            request: structuredClone(request), inventory, rawCount, duplicateCount, requestDigest: digest,
            state: 'accepted', asOfTimeSec: Math.floor(Date.now() / 1000), startedAt: Date.now(), finishedAt: null, error: null };
        active.admission = this.store.create(manifest);
        try { active.run = await active.admission; }
        catch (error) { this.active = null; this.locks.releaseIfStillOwner(token); throw error; }
        active.launch = this.launch(active);
        return { runId: request.runId };
    }
    private async launch(active: ActiveUniverse): Promise<void> {
        try {
            if (active.stopped || this.disposed) { await this.finalize(active, 'cancelled'); return; }
            const entry = await this.entry();
            if (active.stopped || this.disposed) { await this.finalize(active, 'cancelled'); return; }
            const run = active.run!;
            run.manifest.state = 'running'; await this.store.writeManifest(run);
            if (active.stopped || this.disposed) { await this.finalize(active, 'cancelled'); return; }
            active.worker = createFinderTaskWorker<UniverseWorkerTask, UniverseWorkerMessage>(entry, 'Universe worker', (message, task, takeTask) => {
                if (!task || this.active !== active || active.finalizing) return;
                if (message.type === 'progress') { active.stage = message.stage; active.index = message.index; }
                if (message.type === 'commit') {
                    // Backpressure: publish only after append + fsync; one pending row at most.
                    void this.store.append(run, message.record).then(() => {
                        if (this.active === active && !active.finalizing) active.worker?.postMessage({ type: 'commit_ack' });
                    }, error => {
                        active.fatal = shortUniverseError(error);
                        void this.finalize(active, 'failed', active.fatal);
                    });
                }
                if (message.type === 'done' || message.type === 'fatal') {
                    takeTask();
                    void this.finalize(active, message.type === 'fatal' ? 'failed' : active.stopped ? 'cancelled' : 'completed', message.type === 'fatal' ? message.error : undefined);
                }
            }, (_task, error) => { void this.finalize(active, active.stopped ? 'cancelled' : 'failed', active.stopped ? undefined : error); });
            active.worker.runTask({ kind: 'run', request: run.manifest.request, inventory: run.manifest.inventory, asOfTimeSec: run.manifest.asOfTimeSec });
        } catch (error) { await this.finalize(active, 'failed', shortUniverseError(error)); }
    }
    private finalize(active: ActiveUniverse, state: UniverseRunState, error?: string): Promise<void> {
        if (active.finalizing) return active.finalizing;
        // Defer the body until the promise has been installed (dispose may emit exit).
        active.finalizing = Promise.resolve().then(async () => {
            await active.worker?.dispose().catch(error => { active.fatal = shortUniverseError(error); });
            const run = active.run;
            if (run) {
                await run.writer.catch(failure => { active.fatal = shortUniverseError(failure); });
                run.manifest.state = active.fatal ? 'failed' : state;
                run.manifest.error = active.fatal ?? (error ? shortUniverseError(error) : null);
                run.manifest.finishedAt = Date.now(); active.stage = run.manifest.state; active.index = null;
                await this.store.finish(run);
            }
        }).catch(failure => {
            if (active.run) { active.run.manifest.state = 'failed'; active.run.manifest.error = shortUniverseError(failure); }
        }).finally(() => {
            this.locks.releaseIfStillOwner(active.token);
            if (this.active === active) this.active = null;
        });
        return active.finalizing;
    }
    async status(id: unknown) {
        try { validateUniverseRunId(id); } catch { throw new HttpStatusError(400, 'invalid_run_id'); }
        await this.ready;
        const run = this.store.get(id);
        if (!run) throw new HttpStatusError(404, 'run_unavailable');
        const active = this.active?.id === id ? this.active : null;
        const manifest = active?.finalizing ? { ...run.manifest, state: 'running' as const, finishedAt: null } : run.manifest;
        const snapshot = universeSnapshot(manifest, run.rows, active?.stage ?? run.manifest.state, active?.index ?? null);
        if (Buffer.byteLength(JSON.stringify(snapshot)) > UNIVERSE_LIMITS.statusBytes) throw new HttpStatusError(500, 'status_resource_limit');
        return snapshot;
    }
    async stop(id: unknown) {
        try { validateUniverseRunId(id); } catch { throw new HttpStatusError(400, 'invalid_run_id'); }
        const active = this.active;
        if (active?.id === id) {
            active.stopped = true;
            if (active.worker) await this.finalize(active, 'cancelled');
            return { stopped: true };
        }
        // One pending slot closes the Stop-before-admission race without a growing set.
        if (!this.store.get(id)) this.pendingStop = id;
        return { stopped: false };
    }
    async detail(id: unknown, index: unknown, signal?: AbortSignal) {
        try { validateUniverseRunId(id); } catch { throw new HttpStatusError(400, 'invalid_run_id'); }
        if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index >= UNIVERSE_LIMITS.symbols) throw new HttpStatusError(400, 'invalid_row_index');
        await this.ready;
        const run = this.store.get(id);
        if (!run) throw new HttpStatusError(404, 'run_unavailable');
        if (!isUniverseTerminal(run.manifest.state)) throw new HttpStatusError(409, 'Detail requires a terminal run.');
        if (!run.rows[index]?.detailAvailable) throw new HttpStatusError(404, 'detail_unavailable');
        if (this.disposed || !this.locks.acquireExclusive) throw new HttpStatusError(503, 'Server unavailable.');
        const token = this.locks.acquireExclusive(id, 'monte_carlo_universe');
        run.readers++;
        const result = (async () => {
            let worker: TaskWorker | null = null;
            const abort = () => worker?.stop();
            signal?.addEventListener('abort', abort, { once: true });
            try {
                const record = await this.store.readRecord(run, index);
                signal?.throwIfAborted();
                const entry = await this.entry();
                signal?.throwIfAborted();
                if (this.disposed) throw new Error('Server shutting down.');
                return await new Promise<Extract<UniverseWorkerMessage, { type: 'detail' }>['result']>((resolveResult, reject) => {
                    worker = createFinderTaskWorker<UniverseWorkerTask, UniverseWorkerMessage>(entry, 'Universe detail worker', (message, task, takeTask) => {
                        if (!task) return;
                        if (message.type === 'detail') { takeTask(); resolveResult(message.result); }
                        if (message.type === 'fatal') { takeTask(); reject(new Error(message.error)); }
                    }, (_task, error) => reject(new Error(error)));
                    this.detailWorker = worker;
                    worker.runTask({ kind: 'detail', record });
                });
            } finally { signal?.removeEventListener('abort', abort); await (worker as TaskWorker | null)?.dispose(); this.detailWorker = null; run.readers--; this.locks.releaseIfStillOwner(token); }
        })();
        this.detailDone = result;
        try { return await result; } finally { if (this.detailDone === result) this.detailDone = null; }
    }
    async dispose(): Promise<void> {
        this.disposed = true; this.memo.record = null;
        if (this.active) {
            const active = this.active; active.stopped = true;
            await active.admission?.catch(() => undefined);
            await active.launch;
            if (active.run) await this.finalize(active, 'cancelled');
        }
        await this.detailWorker?.dispose();
        await this.detailDone?.catch(() => undefined);
    }
}

export function registerUniverseRoutes(stack: LocalRouteMiddlewareStack, server: UniverseServer): void {
    const post = (path: string, action: (body: Record<string, unknown>) => Promise<unknown>, status = 200) => registerLocalJsonRoute(stack, `/api/monte-carlo/universe/${path}`, {
        methods: ['POST'], readBody: true, maxBodyBytes: UNIVERSE_LIMITS.bodyBytes,
        onAuthorized: async ({ res, body }) => sendJson(res, status, await action(body)),
    });
    post('run', body => server.run(body), 202);
    post('stop', body => server.stop(body.runId));
    registerLocalJsonRoute(stack, '/api/monte-carlo/universe/detail', { methods: ['POST'], readBody: true, maxBodyBytes: UNIVERSE_LIMITS.bodyBytes,
        onAuthorized: async ({ body, res }) => {
            const abort = new AbortController();
            const response = res as typeof res & { on?: (event: string, listener: () => void) => void; off?: (event: string, listener: () => void) => void };
            const close = () => abort.abort(); response.on?.('close', close);
            try { sendJson(res, 200, await server.detail(body.runId, body.rowIndex, abort.signal)); }
            finally { response.off?.('close', close); }
        } });
    registerLocalJsonRoute(stack, '/api/monte-carlo/universe/status', { methods: ['GET'],
        onAuthorized: async ({ res, url }) => sendJson(res, 200, await server.status(url.searchParams.get('runId'))) });
}
export function monteCarloUniverseVitePlugin(locks: BatchOwnerLocks): Plugin {
    let server: UniverseServer | null = null;
    return { name: 'monte-carlo-universe',
        configureServer(vite) {
            server = new UniverseServer(vite.config.root, locks); registerUniverseRoutes(vite.middlewares, server);
            vite.httpServer?.once('close', () => { void server?.dispose(); });
        },
        configurePreviewServer(vite) {
            server = new UniverseServer(vite.config.root, locks); registerUniverseRoutes(vite.middlewares, server);
            vite.httpServer.once('close', () => { void server?.dispose(); });
        },
        async closeBundle() { await server?.dispose(); server = null; },
        async handleHotUpdate(context) {
            if (context.file.includes('/monte-carlo/') || context.file.includes('/strategies/')) { await server?.dispose(); await context.server.restart(); }
        },
    };
}
