import assert from 'node:assert/strict';
import { it } from 'node:test';
import * as fs from 'node:fs/promises';
import fsPromises from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { UniverseServer, registerUniverseRoutes } from '../lib/monte-carlo/universe/server';
import { UniverseStore, universeDigest } from '../lib/monte-carlo/universe/store';
import { emptyUniverseRow, universeReplay, universeSnapshot, UNIVERSE_LIMITS } from '../lib/monte-carlo/universe/model';
import { createBatchOwnerLocksAdapter, __testInternals as batch } from '../lib/batch-backtest/batch-backtest-vite-plugin';
import { resolveWorkerEntryPath } from '../lib/server-worker-entry';
import { universeManifest, universeRequest, universeCandles } from './helpers/monte-carlo-universe-fixture';
import { ServerRunPollLoop } from '../lib/server-run-poll-loop';
import { withTimeout } from './helpers/with-timeout';
import { waitFor } from './helpers/wait-for';

async function temporary() { return fs.mkdtemp(join(tmpdir(), 'mc-universe-')); }
function resetLocks() { batch.setRunOwnerForTests(0); batch.setAnalysisOwnerForTests(0); createBatchOwnerLocksAdapter().setFinderBusyCheck!(() => false); }
const terminal = async (server: UniverseServer, id: string) => {
    const loop = new ServerRunPollLoop({ isOwned: () => true, fetchStatus: async () => ({ kind: 'snapshot', snapshot: await server.status(id) }),
        isTerminal: snapshot => !['accepted', 'running'].includes(snapshot.state), nextRequestDelayMs: () => 5 });
    try {
        const outcome = await withTimeout(loop.run(), 15000, 'universe terminal');
        if (outcome.kind !== 'terminal') throw new Error(outcome.kind);
        return outcome.snapshot;
    } finally { loop.abort(); }
};

it('opaque run IDs use server-owned names without Windows reserved-name or case collisions', async () => {
    const root = await temporary();
    try {
        const store = new UniverseStore(root); await store.initialize();
        const upper = await store.create(universeManifest(universeRequest('CON')));
        const lower = await store.create(universeManifest(universeRequest('con')));
        assert.notEqual(store.directory('CON').toLowerCase(), store.directory('con').toLowerCase());
        assert.equal(JSON.parse(await fs.readFile(join(store.directory('CON'), 'manifest.json'), 'utf8')).request.runId, 'CON');
        upper.manifest.state = 'cancelled'; await store.finish(upper); lower.manifest.state = 'completed'; await store.finish(lower);
        const restored = new UniverseStore(root); await restored.initialize();
        assert.equal(restored.get('con')!.manifest.state, 'completed'); assert.equal(restored.get('CON'), undefined);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('journal restart rebuilds committed rows/offsets, ignores a partial tail and reconciles interruption', async () => {
    const root = await temporary();
    try {
        const store = new UniverseStore(root); await store.initialize();
        const run = await store.create(universeManifest());
        await store.append(run, { row: emptyUniverseRow(run.manifest.inventory[0], 1337, 'insufficient_trades'), replay: null });
        await fs.appendFile(join(store.directory(run.manifest.request.runId), 'replay-inputs.jsonl'), '{"row":');
        const recovered = new UniverseStore(root); await recovered.initialize();
        const restored = recovered.get(run.manifest.request.runId)!;
        assert.equal(restored.manifest.state, 'interrupted'); assert.equal(restored.rows.length, 1);
        assert.deepEqual((await recovered.readRecord(restored, 0)).row, run.rows[0]);
        const snapshot = universeSnapshot(restored.manifest, restored.rows);
        assert.equal(snapshot.counts.notProcessed, 2); assert.equal(snapshot.counts.insufficient, 1);
        assert.equal((await fs.stat(join(store.directory(run.manifest.request.runId), 'replay-inputs.jsonl'))).size, restored.bytes);
        const newer = await recovered.create(universeManifest(universeRequest('replacement'))); newer.manifest.state = 'cancelled'; await recovered.finish(newer);
        assert.equal(recovered.get(run.manifest.request.runId), undefined);
        assert.deepEqual(await fs.readdir(store.root), [recovered.directory('replacement').split(/[\\/]/).at(-1)]);
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});
it('internal corruption, file limits and a rejected terminal replacement never claim durable success', async () => {
    const root = await temporary();
    try {
        const store = new UniverseStore(root); await store.initialize(); const run = await store.create(universeManifest());
        await store.append(run, { row: emptyUniverseRow(run.manifest.inventory[0], 1337, 'insufficient_trades'), replay: null });
        const path = store.directory(run.manifest.request.runId);
        await fs.appendFile(join(path, 'replay-inputs.jsonl'), 'invalid\n');
        const recovered = new UniverseStore(root); await recovered.initialize();
        assert.equal(recovered.get(run.manifest.request.runId)!.manifest.state, 'failed');
        assert.match(recovered.get(run.manifest.request.runId)!.manifest.error!, /Recovery error/);
        await fs.truncate(join(path, 'replay-inputs.jsonl'), UNIVERSE_LIMITS.journalBytes + 1);
        const capped = new UniverseStore(root); await capped.initialize();
        assert.match(capped.get(run.manifest.request.runId)!.manifest.error!, /journal_limit/);
        await fs.truncate(join(path, 'replay-inputs.jsonl'), run.bytes);
        await fs.mkdir(join(path, 'manifest.tmp')); run.manifest.state = 'completed'; await store.finish(run);
        assert.equal(run.manifest.state, 'failed'); assert.match(run.manifest.error!, /Terminal write failed/);
        const saved = JSON.parse(await fs.readFile(join(path, 'manifest.json'), 'utf8'));
        assert.equal(saved.state, 'accepted', 'failed write did not update durable state');
        await fs.rmdir(join(path, 'manifest.tmp'));
        const restarted = new UniverseStore(root); await restarted.initialize();
        assert.equal(restarted.get(run.manifest.request.runId)!.manifest.state, 'interrupted');
    } finally { await fs.rm(root, { recursive: true, force: true }); }
});

it('a rejected journal flush rolls back the unacknowledged line before restart recovery', async () => {
    const root = await temporary();
    const originalOpen = fsPromises.open;
    try {
        const store = new UniverseStore(root); await store.initialize(); const run = await store.create(universeManifest());
        fsPromises.open = (async (...args: Parameters<typeof originalOpen>) => {
            const handle = await originalOpen(...args);
            if (args[1] !== 'a') return handle;
            handle.sync = async () => { throw new Error('flush failed'); };
            return handle;
        }) as typeof originalOpen;
        await assert.rejects(store.append(run, { row: emptyUniverseRow(run.manifest.inventory[0], 1337, 'insufficient_trades'), replay: null }), /flush failed/);
        assert.equal(run.rows.length, 0);
        assert.equal((await fs.stat(join(store.directory(run.manifest.request.runId), 'replay-inputs.jsonl'))).size, 0);
        fsPromises.open = originalOpen;
        const recovered = new UniverseStore(root); await recovered.initialize();
        assert.equal(recovered.get(run.manifest.request.runId)!.rows.length, 0);
        assert.equal(recovered.get(run.manifest.request.runId)!.manifest.state, 'interrupted');
    } finally { fsPromises.open = originalOpen; await fs.rm(root, { recursive: true, force: true }); }
});
it('checked shared reservation cannot be stolen by competing Batch/Finder/TOP_MEAN admission or legacy Stop', async () => {
    resetLocks(); const locks = createBatchOwnerLocksAdapter();
    try {
        const token = locks.acquireExclusive!('mc-owner', 'monte_carlo_universe');
        assert.equal(locks.isBusy(), true); assert.throws(() => locks.acquireExclusive!('other', 'monte_carlo_universe'), /already running/);
        assert.throws(() => locks.acquireFinderSweep!('finder', () => true), /already running/);
        assert.equal((await batch.handleStopRequest('mc-owner')).stopped, false); assert.equal(locks.isBusy(), true);
        locks.releaseIfStillOwner({ runOwner: token.runOwner - 1, analysisOwner: token.analysisOwner - 1 }); assert.equal(locks.isBusy(), true);
        locks.releaseIfStillOwner(token); assert.equal(locks.isBusy(), false);
        locks.setFinderBusyCheck!(() => true); assert.throws(() => locks.acquireExclusive!('busy-finder', 'monte_carlo_universe'), /already running/);
        locks.setFinderBusyCheck!(() => false); batch.setAnalysisOwnerForTests(42); assert.throws(() => locks.acquireExclusive!('busy-analysis', 'monte_carlo_universe'), /already running/);
    } finally { resetLocks(); }
});
it('all four routes authorize reads and writes before work and enforce opaque IDs/body limits', async () => {
    resetLocks(); const root = await temporary(); const server = new UniverseServer(root, createBatchOwnerLocksAdapter());
    try {
        const routes = new Map<string, (req: any, res: any) => void | Promise<void>>();
        registerUniverseRoutes({ use: (path, handler) => routes.set(path, handler) }, server);
        for (const [path, handler] of routes) {
            let body = ''; const res = { statusCode: 0, setHeader() {}, end(text: string) { body = text; } };
            await handler({ method: path.endsWith('/status') ? 'GET' : 'POST', headers: { host: 'localhost' }, socket: { remoteAddress: '203.0.113.1' } }, res);
            assert.equal(res.statusCode, 401); assert.match(body, /Unauthorized/);
        }
        await assert.rejects(server.status('../escape'), /invalid_run_id/);
        const run = routes.get('/api/monte-carlo/universe/run')!;
        const req = Readable.from([Buffer.alloc(UNIVERSE_LIMITS.bodyBytes + 1, ' ')]) as any;
        Object.assign(req, { method: 'POST', headers: { host: 'localhost' }, socket: { remoteAddress: '127.0.0.1' } });
        let body = ''; const res = { statusCode: 0, setHeader() {}, end(text: string) { body = text; } };
        await run(req, res); assert.equal(res.statusCode, 413, body);
    } finally { await server.dispose(); await fs.rm(root, { recursive: true, force: true }); resetLocks(); }
});
it('idempotent admission, pending Stop, bundle failure and clean worker exit all settle and release ownership', async () => {
    resetLocks(); const root = await temporary(), locks = createBatchOwnerLocksAdapter();
    let release!: (entry: string) => void;
    const entry = new Promise<string>(resolveEntry => { release = resolveEntry; });
    const server = new UniverseServer(root, locks, () => entry);
    try {
        const request = universeRequest('admission');
        await server.run(request); assert.equal(locks.isBusy(), true);
        assert.deepEqual(await server.run(JSON.parse(JSON.stringify(request))), { runId: 'admission' });
        const edited = structuredClone(request); edited.simulation.seed++;
        await assert.rejects(server.run(edited), /run_id_conflict/);
        await server.stop('admission'); release('invalid.ts');
        const result = await terminal(server, 'admission');
        assert.ok(['cancelled', 'failed'].includes(result.state)); assert.equal(result.counts.notProcessed, 3); assert.equal(locks.isBusy(), false);
    } finally { release('invalid.ts'); await server.dispose(); }
    const stopped = new UniverseServer(root, locks, async () => { throw new Error('should not start'); });
    try {
        await stopped.stop('pending'); await stopped.run(universeRequest('pending'));
        assert.equal((await terminal(stopped, 'pending')).state, 'cancelled');
    } finally { await stopped.dispose(); }
    const raw = new UniverseServer(root, locks, async () => 'unrunnable.ts');
    try { await raw.run(universeRequest('raw')); assert.match((await terminal(raw, 'raw')).error!, /bundling failed/); } finally { await raw.dispose(); }
    const exitFile = join(root, 'exit.cjs'); await fs.writeFile(exitFile, 'process.exit(0)');
    const exited = new UniverseServer(root, locks, async () => exitFile);
    try { await exited.run(universeRequest('exit')); assert.match((await terminal(exited, 'exit')).error!, /unexpectedly mid-task/); }
    finally { await exited.dispose(); await fs.rm(root, { recursive: true, force: true }); resetLocks(); }
});
it('real bundled JS worker runs mixed local datasets, saved detail survives restart and Stop interrupts CPU work', async () => {
    resetLocks(); const root = await temporary(), locks = createBatchOwnerLocksAdapter();
    const names = ['MCLOCALBASE', 'MCLOCALQUOTE'];
    const csvDir = resolve('price-data/ibkr/csv/1d'); await fs.mkdir(csvDir, { recursive: true });
    const files: string[] = [];
    const worker = await resolveWorkerEntryPath({ repositorySourcePath: resolve('lib/monte-carlo/universe/worker.ts'), moduleSourcePath: '',
        temporaryNamespace: 'mc-universe-tests', outputFileName: 'worker.cjs' });
    assert.match(worker, /\.cjs$/);
    const server = new UniverseServer(root, locks, async () => worker);
    try {
        for (const [index, name] of names.entries()) {
            const file = join(csvDir, name + '.csv'); files.push(file);
            await fs.writeFile(file, 'time,open,high,low,close,volume\n' + universeCandles(index === 1).map(b => [b.time, b.open, b.high, b.low, b.close, b.volume].join(',')).join('\n'));
        }
        const request = universeRequest('real'); request.symbols = ['MCLOCALBASE\u2022', 'MCLOCALBASE\u2022+MCLOCALQUOTE\u2022', 'MCLOCALBASE\u2022+MCLOCALQUOTE\u2022@']; request.simulation.simulations = 250;
        await server.run(request); const result = await terminal(server, request.runId);
        assert.equal(result.state, 'completed', result.error ?? '');
        assert.deepEqual(result.rows.map(r => r.status), ['evaluated', 'evaluated', 'evaluated'], JSON.stringify(result.rows));
        assert.equal(result.counts.evaluated, 3); assert.equal(locks.isBusy(), false);
        const detail = await server.detail(request.runId, 2); assert.equal(detail.result.inputSource, 'universe'); assert.equal(detail.digest, result.rows[2].inputDigest);
        await server.dispose();
        const recovered = new UniverseServer(root, locks, async () => worker);
        try {
            const after = await recovered.detail(request.runId, 2); assert.deepEqual(after.result.metricSamples, detail.result.metricSamples);
            const stopRequest = universeRequest('cpu-stop'); stopRequest.symbols = Array.from({ length: 100 }, (_, i) => `${i % 2 ? 'MCLOCALBASE\u2022+MCLOCALQUOTE\u2022' : 'MCLOCALBASE\u2022'}${i % 2 ? '@' : ''}`);
            // Two canonical instruments still provide enough compute to exercise synchronous termination.
            stopRequest.simulation.simulations = 10000; await recovered.run(stopRequest);
            await recovered.stop(stopRequest.runId);
            assert.equal((await terminal(recovered, stopRequest.runId)).state, 'cancelled'); assert.equal(locks.isBusy(), false);
        } finally { await recovered.dispose(); }
    } finally { await withTimeout(server.dispose(), 10000, 'server disposal'); for (const file of files) await fs.unlink(file); await fs.rm(root, { recursive: true, force: true }); resetLocks(); }
});

it('100-instrument shared-leg fixture bounds scalar retention and records run/status/Stop/disk measurements', async () => {
    resetLocks(); const root = await temporary(), locks = createBatchOwnerLocksAdapter();
    const csvDir = resolve('price-data/ibkr/csv/1d'); await fs.mkdir(csvDir, { recursive: true });
    const files: string[] = [];
    const worker = await resolveWorkerEntryPath({ repositorySourcePath: resolve('lib/monte-carlo/universe/worker.ts'), moduleSourcePath: '', temporaryNamespace: 'mc-universe-tests', outputFileName: 'worker.cjs' });
    const server = new UniverseServer(root, locks, async () => worker);
    try {
        const names = Array.from({ length: 10 }, (_, i) => `MCSCALE${i}`);
        for (const [index, name] of names.entries()) {
            const file = join(csvDir, name + '.csv'); files.push(file);
            const candles = universeCandles().map(b => ({ ...b, open: b.open + index * 5, high: b.high + index * 5, low: b.low + index * 5, close: b.close + index * 5 }));
            await fs.writeFile(file, 'time,open,high,low,close,volume\n' + candles.map(b => [b.time, b.open, b.high, b.low, b.close, b.volume].join(',')).join('\n'));
        }
        const request = universeRequest('scale'); request.symbols = names.map(n => n + '\u2022');
        for (let i = 0; i < names.length; i++) for (let j = i + 1; j < names.length; j++) request.symbols.push(`${names[i]}\u2022+${names[j]}\u2022`, `${names[i]}\u2022+${names[j]}\u2022@`);
        const started = performance.now(), initialMemory = process.memoryUsage();
        let peakRss = initialMemory.rss, peakParentHeap = initialMemory.heapUsed, maxStatusMs = 0, maxStatusBytes = 0, sampled = 0;
        await server.run(request);
        const poll = new ServerRunPollLoop({ isOwned: () => true, fetchStatus: async () => {
            const now = performance.now(), snapshot = await server.status(request.runId);
            maxStatusMs = Math.max(maxStatusMs, performance.now() - now); maxStatusBytes = Math.max(maxStatusBytes, Buffer.byteLength(JSON.stringify(snapshot)));
            const memory = process.memoryUsage(); peakRss = Math.max(peakRss, memory.rss); peakParentHeap = Math.max(peakParentHeap, memory.heapUsed); sampled++;
            return { kind: 'snapshot', snapshot };
        }, isTerminal: snapshot => !['accepted', 'running'].includes(snapshot.state), nextRequestDelayMs: () => 10 });
        const outcome = await withTimeout(poll.run(), 30000, '100-instrument fixture'); poll.abort();
        if (outcome.kind !== 'terminal') throw new Error(outcome.kind);
        const snapshot = outcome.snapshot, wallMs = performance.now() - started;
        assert.equal(snapshot.state, 'completed', snapshot.error ?? ''); assert.equal(snapshot.rows.length, 100);
        assert.equal(snapshot.counts.evaluated, 100, JSON.stringify(snapshot.counts));
        assert.ok(snapshot.rows.every(r => r.effectivePaths === 1000));
        const stored = server.store.get(request.runId)!;
        assert.equal(stored.rows.length, 100); assert.ok(stored.rows.every(r => !('trades' in r) && !('metricSamples' in r)));
        const runDir = server.store.directory(request.runId), fileNames = await fs.readdir(runDir);
        assert.deepEqual(fileNames.sort(), ['manifest.json', 'replay-inputs.jsonl']);
        const fileBytes = Object.fromEntries(await Promise.all(fileNames.map(async name => [name, (await fs.stat(join(runDir, name))).size])));
        const next = { ...request, runId: 'scale-stop', simulation: { ...request.simulation, simulations: 10000 } };
        await server.run(next);
        const stopStarted = performance.now(); await server.stop(next.runId); const stopped = await terminal(server, next.runId); const stopMs = performance.now() - stopStarted;
        assert.equal(stopped.state, 'cancelled'); assert.equal(locks.isBusy(), false);
        const measurements = { node: process.version, instruments: 100, workerTasksAtOnce: 1, paths: 1000, evaluated: snapshot.counts.evaluated,
            tradeRecords: snapshot.rows.map(r => r.tradeRecords), wallMs, maxStatusMs, maxStatusBytes, statusSamples: sampled, stopMs,
            initialRss: initialMemory.rss, peakRss, initialParentHeap: initialMemory.heapUsed, peakParentHeap, fileBytes };
        await fs.mkdir(resolve('artifacts/agent-handoffs'), { recursive: true });
        await fs.writeFile(resolve('artifacts/agent-handoffs/monte-carlo-universe-measurements.json'), JSON.stringify(measurements, null, 2));
        console.log('Universe 100-instrument measurement', JSON.stringify(measurements));
    } finally { await server.dispose(); for (const file of files) await fs.unlink(file); await fs.rm(root, { recursive: true, force: true }); resetLocks(); }
});

it('parent append failure wins over worker completion and retains a failed, complete inventory', async () => {
    resetLocks(); const root = await temporary(), locks = createBatchOwnerLocksAdapter();
    let release!: (path: string) => void;
    const gate = new Promise<string>(resolveEntry => { release = resolveEntry; });
    const server = new UniverseServer(root, locks, () => gate);
    try {
        const request = universeRequest('disk-failure'); await server.run(request);
        const stored = server.store.get(request.runId)!;
        const record = { row: emptyUniverseRow(stored.manifest.inventory[0], 1337, 'insufficient_trades'), replay: null };
        const workerFile = join(root, 'commit.cjs');
        await fs.writeFile(workerFile, `const p = require('node:worker_threads').parentPort; p.on('message', m => { if(m.type === 'run_task') p.postMessage({type:'commit',record:${JSON.stringify(record)}}); if(m.type === 'commit_ack') p.postMessage({type:'done'}); });`);
        const journal = join(server.store.directory(request.runId), 'replay-inputs.jsonl'); await fs.unlink(journal); await fs.mkdir(journal);
        release(workerFile); const snapshot = await terminal(server, request.runId);
        assert.equal(snapshot.state, 'failed'); assert.equal(snapshot.counts.processed, 0); assert.equal(snapshot.counts.notProcessed, 3);
        assert.ok(snapshot.error); assert.equal(locks.isBusy(), false);
        assert.equal(JSON.parse(await fs.readFile(join(server.store.directory(request.runId), 'manifest.json'), 'utf8')).state, 'failed');
    } finally { release('invalid.ts'); await server.dispose(); await fs.rm(root, { recursive: true, force: true }); resetLocks(); }
});
it('disconnect cancels transient detail compute, releases admission and leaves the stored terminal result intact', async () => {
    resetLocks(); const root = await temporary(), locks = createBatchOwnerLocksAdapter();
    const readyFile = join(root, 'detail-ready'), workerFile = join(root, 'detail-hang.cjs');
    await fs.writeFile(workerFile, `const p = require('node:worker_threads').parentPort; p.on('message', () => require('node:fs').writeFileSync(${JSON.stringify(readyFile)}, 'ready'));`);
    const server = new UniverseServer(root, locks, async () => workerFile);
    try {
        await assert.rejects(server.status('initialization'), /run_unavailable/);
        const request = universeRequest('detail-disconnect'), stored = await server.store.create(universeManifest(request));
        const row = emptyUniverseRow(stored.manifest.inventory[0], 1337, 'evaluated'); row.verdict = 'Pass'; row.detailAvailable = true;
        const trades = Array.from({ length: 5 }, (_, id) => ({ id, type: 'long' as const, entryTime: 1700000000 as any, exitTime: 1700086400 as any,
            entryPrice: 100, exitPrice: 101, size: 1, pnl: 1, pnlPercent: 1 }));
        const replay = universeReplay({ trades, netProfit: 5, maxDrawdownPercent: 0, sharpeRatio: 0, winRate: 100 }, request, row, 250);
        row.inputDigest = universeDigest(replay); await server.store.append(stored, { row, replay }); stored.manifest.state = 'completed'; await server.store.finish(stored);
        const abort = new AbortController(); const rejected = assert.rejects(server.detail(request.runId, 0, abort.signal), /exited|stopped|abort/i);
        await waitFor(() => existsSync(readyFile), 5000, 'detail worker to start');
        await assert.rejects(server.run(universeRequest('competing-run')), /already running/);
        abort.abort(); await rejected;
        assert.equal(locks.isBusy(), false); assert.equal((await server.status(request.runId)).state, 'completed');
        assert.equal((await server.store.readRecord(stored, 0)).row.inputDigest, row.inputDigest);
    } finally { await server.dispose(); await fs.rm(root, { recursive: true, force: true }); resetLocks(); }
});
