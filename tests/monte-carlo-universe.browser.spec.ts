import assert from 'node:assert/strict';
import { it } from 'node:test';
import { UniverseController, universeCsv } from '../lib/monte-carlo/universe/controller';
import { createMonteCarloDom, MONTE_CARLO_REQUIRED_IDS } from '../lib/monte-carlo-dom';
import { renderUniverseInventory, renderMonteCarloResults } from '../lib/monte-carlo-renderer';
import { emptyUniverseRow, universeSnapshot, type UniverseSnapshot } from '../lib/monte-carlo/universe/model';
import { universeRequest, universeManifest } from './helpers/monte-carlo-universe-fixture';
import { createFakeElement } from './helpers/fake-element';
import { waitFor } from './helpers/wait-for';
import { backtestService } from '../lib/backtest-service';
import { dataManager } from '../lib/data-manager';
import { paramManager } from '../lib/param-manager';
import { uiManager } from '../lib/ui-manager';
import { state } from '../lib/state';
import { runMonteCarloSimulation } from '../lib/strategies/monte-carlo/monte-carlo-engine';

it('full-inventory sorting/export, nulls, CSV injection protection, pagination and legacy detail units', async () => {
    const elements = new Map(MONTE_CARLO_REQUIRED_IDS.map(id => [id as string, { ...createFakeElement(), getContext: () => null }]));
    const original = Object.getOwnPropertyDescriptor(globalThis, 'document');
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: (id: string) => elements.get(id) ?? null } });
    try {
        const request = universeRequest(); request.symbols = Array.from({ length: 1000 }, (_, i) => `S${i}\u2022`);
        const manifest = universeManifest(request); manifest.state = 'completed';
        const rows = manifest.inventory.map(item => emptyUniverseRow(item, 0, 'insufficient_trades'));
        rows[999].status = 'evaluated'; rows[999].verdict = 'Pass'; rows[999].profitablePathPercent = 99; rows[999].detailAvailable = true;
        rows[999].reason = '=SUM(1,2)\n"quoted"';
        const snapshot = universeSnapshot(manifest, rows), dom = createMonteCarloDom();
        renderUniverseInventory(snapshot, dom, 0);
        assert.match(dom.universeRows.innerHTML, /S999/); assert.equal((dom.universeRows.innerHTML.match(/<tr>/g) ?? []).length, 100);
        assert.match(dom.universeSummary.textContent!, /1\/1 eligible/);
        const csv = universeCsv(snapshot);
        assert.match(csv, /S999/); assert.match(csv, /S998/); assert.match(csv, /'=SUM\(1,2\)/); assert.match(csv, /""quoted""/);
        const running: UniverseSnapshot = { ...snapshot, state: 'running' };
        renderUniverseInventory(running, dom, 0); assert.equal(dom.universeCsv.disabled, true); assert.match(dom.universeSummary.textContent!, /Partial/);
        assert.throws(() => universeCsv(running), /terminal/);
        const input = { trades: Array.from({ length: 5 }, (_, i) => ({ id: i, type: 'long' as const, entryPrice: 100, exitPrice: 101, size: 1,
            entryTime: (1700000000 + i * 86400) as any, exitTime: (1700086400 + i * 86400) as any, pnl: 1, pnlPercent: 1 })), netProfit: 5, maxDrawdownPercent: 0, winRate: 100, sharpeRatio: 0 };
        const detail = await runMonteCarloSimulation(input, { simulations: 1, seed: 0, initialCapital: 100, ruinThresholdPercent: 50, enableBootstrap: true, enableSequenceRandomization: false }, undefined, undefined, { inputSource: 'universe' });
        detail.ruinProbabilityMetrics.ruinProbability = detail.ruinProbabilityMetrics.ruinRate = 0.25;
        renderMonteCarloResults(detail, dom);
        assert.equal(dom.ruinProbEl.textContent, '25.0%'); assert.match(dom.sourceBadge.textContent!, /Symbol Universe/);
    } finally { if (original) Object.defineProperty(globalThis, 'document', original); else delete (globalThis as any).document; }
});

it('controller waits for selection, captures once, survives chart edits, restores full snapshots and ignores stale detail selection', async () => {
    const keys = ['document', 'window', 'fetch', 'localStorage'] as const;
    const originals = keys.map(key => Object.getOwnPropertyDescriptor(globalThis, key));
    const elements = new Map(MONTE_CARLO_REQUIRED_IDS.map(id => [id as string, createFakeElement()]));
    const el = (id: string) => elements.get(id)!;
    const storage = new Map<string, string>();
    const originalKey = state.currentStrategyKey, originalCapital = backtestService.getCapitalSettings, originalSettings = backtestService.getBacktestSettings;
    const originalParams = paramManager.getValues, originalSource = dataManager.getProvider, originalWait = uiManager.waitForStrategySelection;
    let releaseSelection!: () => void;
    const selection = new Promise<void>(resolve => { releaseSelection = resolve; });
    let request: ReturnType<typeof universeRequest> | null = null;
    let polls = 0, posts = 0, detailCalls = 0;
    let rejectNextRun = false;
    let snapshot: UniverseSnapshot;
    let releaseFirstDetail!: () => void;
    const firstDetail = new Promise<void>(resolve => { releaseFirstDetail = resolve; });
    const calls: Array<unknown> = [];
    const detailPayload = { result: { inputSource: 'universe' }, digest: 'digest' };
    Object.defineProperty(globalThis, 'document', { configurable: true, value: { getElementById: (id: string) => elements.get(id) ?? null } });
    Object.defineProperty(globalThis, 'window', { configurable: true, value: { addEventListener() {}, removeEventListener() {} } });
    Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) } });
    Object.defineProperty(globalThis, 'fetch', { configurable: true, value: async (url: string, init: RequestInit) => {
        if (url.endsWith('/run')) {
            posts++;
            if (rejectNextRun) return Response.json({ error: 'busy' }, { status: 409 });
            request = JSON.parse(init.body as string); const manifest = universeManifest(request!); manifest.state = 'completed';
            snapshot = universeSnapshot(manifest, manifest.inventory.map(item => ({ ...emptyUniverseRow(item, 0, 'evaluated'), detailAvailable: true })));
            return Response.json({ runId: request!.runId });
        }
        if (url.includes('/status')) { polls++; return Response.json(snapshot); }
        if (url.endsWith('/detail')) { detailCalls++; if (detailCalls === 1) await firstDetail; return Response.json(detailPayload); }
        return Response.json({ stopped: true });
    } });
    backtestService.getCapitalSettings = () => ({ initialCapital: 999, fixedTradeAmount: 1000, sizingMode: 'fixed', positionSize: 10, commission: 0.1 });
    backtestService.getBacktestSettings = () => ({ executionModel: 'next_open' });
    paramManager.getValues = () => ({ emaPeriod: 3 }); dataManager.getProvider = () => 'ibkr-local'; uiManager.waitForStrategySelection = () => selection;
    state.currentStrategyKey = 'ema_confirmation';
    let controller: UniverseController | null = null;
    try {
        controller = new UniverseController(createMonteCarloDom(), (universe, detail) => { calls.push({ universe, detail }); });
        el('mc-universe-symbols').value = 'MCBASE\u2022 MCQUOTE\u2022';
        el('mc-scope').value = 'universe'; el('mc-scope').dispatchEvent({ type: 'change' });
        el('mc-run-btn').click(); assert.equal(posts, 0); assert.equal(el('mc-run-btn').disabled, true);
        releaseSelection(); await waitFor(() => polls > 0 && !el('mc-run-btn').disabled, 5000, 'captured run');
        assert.match(el('mc-universe-summary').textContent, /Complete \(completed\)/, 'terminal poll outcomes must replace the inventory too');
        assert.equal(posts, 1); assert.equal(request!.simulation.initialCapital, 10000); assert.equal('initialCapital' in request!.capitalSettings, false);
        el('mc-universe-capital').value = '20000'; state.set('currentInterval', '4h');
        assert.equal(request!.simulation.initialCapital, 10000); assert.equal(request!.interval, '1d');
        const click = (index: number) => el('mc-universe-table').dispatchEvent({ type: 'click', target: { closest: () => ({ disabled: false, dataset: { detail: String(index) } }) } });
        click(0); await waitFor(() => detailCalls === 1, 1000, 'first detail request'); click(1);
        releaseFirstDetail(); await waitFor(() => detailCalls === 2 && el('mc-universe-detail-status').textContent.includes('digest'), 1000, 'newest detail replay');
        assert.equal(calls.filter((call: any) => call.detail).length, 1, 'stale result was ignored');
        controller.dispose(); controller = null;
        const marker = JSON.parse(storage.get('monteCarloUniverse.lastRun')!); assert.equal(marker.data.lastRunId, request!.runId);
        assert.ok(!storage.get('monteCarloUniverse.settings')!.includes('inputDigest'));
        const before = polls; controller = new UniverseController(createMonteCarloDom(), () => {});
        await waitFor(() => polls > before && !el('mc-run-btn').disabled, 1000, 'reload reattachment');
        assert.equal(posts, 1, 'reload never resubmits');
        rejectNextRun = true; el('mc-run-btn').click();
        await waitFor(() => posts === 2 && !el('mc-run-btn').disabled, 1000, 'rejected new admission');
        assert.equal(JSON.parse(storage.get('monteCarloUniverse.lastRun')!).data.lastRunId, request!.runId, 'a rejected admission preserves the prior result identity');
    } finally {
        controller?.dispose(); releaseSelection(); releaseFirstDetail(); state.currentStrategyKey = originalKey; state.currentInterval = '1d';
        backtestService.getCapitalSettings = originalCapital; backtestService.getBacktestSettings = originalSettings; paramManager.getValues = originalParams;
        dataManager.getProvider = originalSource; uiManager.waitForStrategySelection = originalWait;
        keys.forEach((key, index) => { if (originals[index]) Object.defineProperty(globalThis, key, originals[index]!); else delete (globalThis as any)[key]; });
    }
});
