import type { MonteCarloDomElements } from '../../monte-carlo-dom';
import type { MonteCarloResult } from '../../strategies/monte-carlo/types';
import { state } from '../../state';
import { backtestService } from '../../backtest-service';
import { uiManager } from '../../ui-manager';
import { dataManager } from '../../data-manager';
import { paramManager } from '../../param-manager';
import { loadBuiltInStrategyByKey } from '../../../strategyRegistry';
import { readPersistedJson, writePersistedJson } from '../../persisted-json';
import { readFinderUiState } from '../../finder/browser/finder-persistence';
import { ServerRunPollLoop } from '../../server-run-poll-loop';
import { renderUniverseInventory } from '../../monte-carlo-renderer';
import { UNIVERSE_DEFAULTS, isUniverseTerminal, sortUniverseRows, validateUniverseRequest, validateUniverseRunId, validateUniverseScreenSettings,
    type UniverseRunRequestV1, type UniverseSnapshot, type UniverseSortKey } from './model';

type Preferences = { schemaVersion: 1; scope: 'chart' | 'universe'; symbols: string } & typeof UNIVERSE_DEFAULTS;
const preferencesKey = 'monteCarloUniverse.settings', markerKey = 'monteCarloUniverse.lastRun';
const defaultPreferences = { ...UNIVERSE_DEFAULTS, schemaVersion: 1 as const, scope: 'chart' as const, symbols: '' };

export function universeCsv(snapshot: UniverseSnapshot, sortKey?: UniverseSortKey, ascending = true): string {
    if (!isUniverseTerminal(snapshot.state)) throw new Error('Export requires a terminal snapshot.');
    const fields = ['token', 'mode', 'status', 'verdict', 'reason', 'barCount', 'tradeRecords', 'firstTime', 'lastTime', 'observedReturnPercent', 'observedDrawdownPercent',
        'profitablePaths', 'profitablePathPercent', 'medianReturnPercent', 'p95DrawdownPercent', 'effectivePaths', 'rowSeed', 'inputDigest'] as const;
    const cell = (value: unknown) => {
        let text = value === null || value === undefined ? '' : String(value);
        if (typeof value === 'string' && /^[\s]*[=+\-@\t\r]/.test(text)) text = "'" + text;
        return `"${text.replace(/"/g, '""')}"`;
    };
    return [fields.join(','), ...sortUniverseRows(snapshot.rows, sortKey, ascending).map(row => fields.map(field => cell(row[field])).join(','))].join('\r\n');
}

export class UniverseController {
    private snapshot: UniverseSnapshot | null = null;
    private runId: string | null = null;
    private busy = false;
    private disposed = false;
    private poll: ServerRunPollLoop<UniverseSnapshot> | null = null;
    private page = 0;
    private sortKey: UniverseSortKey | undefined;
    private ascending = true;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private readonly cleanup: Array<() => void> = [];
    private readonly lifetime = new AbortController();
    private detailGeneration = 0;
    private detailPromise: Promise<void> | null = null;
    private selectedDetail: number | null = null;
    private detail: MonteCarloResult | null = null;
    private statusText = 'Symbol Universe requires the local research server.';
    constructor(private readonly dom: MonteCarloDomElements,
        private readonly onScope: (universe: boolean, detail: MonteCarloResult | null) => void) {
        const preferences = readPersistedJson<Preferences>({ key: preferencesKey, schema: preferencesKey, version: 1,
            fallback: defaultPreferences, migrate: ({ version, data }) => {
                const p = data as Preferences;
                if (version !== 1 || !p || p.schemaVersion !== 1 || !['chart', 'universe'].includes(p.scope) || typeof p.symbols !== 'string') return null;
                for (const key of Object.keys(UNIVERSE_DEFAULTS) as Array<keyof typeof UNIVERSE_DEFAULTS>) if (typeof p[key] !== 'number' || !Number.isFinite(p[key])) return null;
                try { validateUniverseScreenSettings(p, p); } catch { return null; }
                return p;
            } });
        dom.scopeSelect.value = preferences.scope;
        dom.universeSymbols.value = preferences.symbols;
        for (const [input, key] of this.fields()) input.value = String(preferences[key]);
        this.listen(dom.scopeSelect, 'change', () => { this.scopeChanged(); this.scheduleSave(); });
        for (const [input] of this.fields()) this.listen(input, 'input', () => this.scheduleSave());
        this.listen(dom.universeSymbols, 'input', () => this.scheduleSave());
        this.listen(dom.universeCopyFinder, 'click', () => {
            dom.universeSymbols.value = (document.getElementById('finderUniverseSymbols') as HTMLTextAreaElement | null)?.value ?? readFinderUiState().universeSymbolsText;
            this.scheduleSave();
        });
        this.listen(dom.runBtn, 'click', () => { if (this.isUniverse()) void this.run(); });
        this.listen(dom.cancelBtn, 'click', () => { if (this.isUniverse()) void this.stop(); });
        this.listen(dom.universePrevious, 'click', () => { this.page = Math.max(0, this.page - 1); this.render(); });
        this.listen(dom.universeNext, 'click', () => { this.page++; this.render(); });
        this.listen(dom.universeTable, 'click', event => {
            const target = (event.target as Element).closest<HTMLButtonElement>('button');
            if (target?.disabled) return;
            if (target?.dataset.sort) {
                const key = target.dataset.sort as UniverseSortKey;
                this.ascending = key === this.sortKey ? !this.ascending : true; this.sortKey = key; this.page = 0; this.render();
            }
            if (target?.dataset.detail !== undefined) this.selectDetail(Number(target.dataset.detail));
        });
        this.listen(dom.universeCsv, 'click', () => {
            if (this.snapshot && isUniverseTerminal(this.snapshot.state)) void navigator.clipboard.writeText(universeCsv(this.snapshot, this.sortKey, this.ascending)).catch(error => this.message(String(error)));
        });
        this.listen(dom.universeJson, 'click', () => this.download());
        const flush = () => this.savePreferences();
        window.addEventListener('pagehide', flush); this.cleanup.push(() => window.removeEventListener('pagehide', flush));
        for (const key of ['currentStrategyKey', 'currentInterval', 'currentSymbol', 'binanceMarketType', 'blockRange', 'strategyTimeframeEnabled', 'strategyTimeframeMinutes'] as const) {
            this.cleanup.push(state.subscribe(key, () => { if (this.isUniverse()) void this.preview(); }));
        }
        this.scopeChanged();
        const marker = readPersistedJson<{ schemaVersion: 1; lastRunId: string | null }>({ key: markerKey, schema: markerKey, version: 1,
            fallback: { schemaVersion: 1, lastRunId: null }, migrate: ({ version, data }) => {
                const m = data as { schemaVersion: number; lastRunId: unknown };
                if (version !== 1 || m?.schemaVersion !== 1) return null;
                try { if (m.lastRunId !== null) validateUniverseRunId(m.lastRunId); } catch { return null; }
                return m as { schemaVersion: 1; lastRunId: string | null };
            } });
        if (marker.lastRunId) { this.runId = marker.lastRunId; this.setBusy(true); void this.attach(marker.lastRunId); }
    }
    private fields(): Array<[HTMLInputElement, keyof typeof UNIVERSE_DEFAULTS]> {
        const d = this.dom;
        return [[d.universePaths, 'simulations'], [d.universeCapital, 'initialCapital'], [d.universeMinimum, 'minimumTradeRecords'],
            [d.universeProfitable, 'minimumProfitablePathPercent'], [d.universeDrawdown, 'maximumP95DrawdownPercent'], [d.universeSeed, 'seed'], [d.universeRuin, 'ruinThresholdPercent']];
    }
    private listen(element: HTMLElement, event: string, listener: (event: Event) => void): void {
        element.addEventListener(event, listener); this.cleanup.push(() => element.removeEventListener(event, listener));
    }
    isUniverse(): boolean { return this.dom.scopeSelect.value === 'universe'; }
    private scopeChanged(): void {
        const universe = this.isUniverse();
        this.dom.chartScope.hidden = universe; this.dom.universeScope.hidden = !universe;
        this.onScope(universe, this.detail);
        this.dom.runBtn.textContent = universe ? 'Run Universe' : 'Run Monte Carlo';
        this.dom.cancelBtn.textContent = universe ? 'Stop' : 'Cancel';
        if (universe) { this.setBusy(this.busy); this.message(this.statusText); void this.preview(); }
    }
    private scheduleSave(): void {
        if (this.saveTimer) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => { this.saveTimer = null; this.savePreferences(); }, 250);
    }
    private savePreferences(): void {
        if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
        const numeric = Object.fromEntries(this.fields().map(([input, key]) => [key, Number(input.value)]));
        writePersistedJson({ key: preferencesKey, schema: preferencesKey, version: 1,
            data: { ...numeric, schemaVersion: 1, scope: this.isUniverse() ? 'universe' : 'chart', symbols: this.dom.universeSymbols.value } });
    }
    private saveMarker(id: string | null): void { writePersistedJson({ key: markerKey, schema: markerKey, version: 1, data: { schemaVersion: 1, lastRunId: id } }); }
    private async capture(id: string): Promise<UniverseRunRequestV1> {
        await uiManager.waitForStrategySelection();
        let key = state.currentStrategyKey;
        let strategy = await loadBuiltInStrategyByKey(key);
        await uiManager.waitForStrategySelection();
        while (key !== state.currentStrategyKey) {
            key = state.currentStrategyKey; strategy = await loadBuiltInStrategyByKey(key);
            await uiManager.waitForStrategySelection();
        }
        if (!strategy) throw new Error('Select a built-in strategy for the local server.');
        if (this.disposed) throw new Error('Controller disposed');
        const { initialCapital: _initial, ...capitalSettings } = backtestService.getCapitalSettings();
        const request: UniverseRunRequestV1 = { schemaVersion: 1, runId: id, strategyKey: key, strategyParams: paramManager.getValues(strategy),
            backtestSettings: { ...backtestService.getBacktestSettings(), strategyTimeframeEnabled: state.strategyTimeframeEnabled, strategyTimeframeMinutes: state.strategyTimeframeMinutes }, capitalSettings, interval: state.currentInterval,
            sourceContext: { provider: dataManager.getProvider(state.currentSymbol), binanceMarketType: state.binanceMarketType },
            blockRange: state.blockRange ? { ...state.blockRange } : null, symbols: this.dom.universeSymbols.value.split(/[\s,]+/).filter(Boolean),
            simulation: { simulations: Number(this.dom.universePaths.value), seed: Number(this.dom.universeSeed.value), initialCapital: Number(this.dom.universeCapital.value), ruinThresholdPercent: Number(this.dom.universeRuin.value) },
            criteria: { minimumTradeRecords: Number(this.dom.universeMinimum.value), minimumProfitablePathPercent: Number(this.dom.universeProfitable.value), maximumP95DrawdownPercent: Number(this.dom.universeDrawdown.value) } };
        return structuredClone(request);
    }
    private async preview(): Promise<void> {
        try {
            const r = await this.capture('preview');
            if (!this.disposed) this.dom.universePreview.textContent = `Next run: ${r.strategyKey} · ${r.interval} · ${r.sourceContext.provider}\n${JSON.stringify(r.strategyParams)}\n${r.capitalSettings.sizingMode} sizing · commission ${r.capitalSettings.commission}% · ${r.backtestSettings.executionModel ?? 'signal_close'} · ${r.backtestSettings.tradeDirection ?? 'long'}\n${r.blockRange ? `${new Date(r.blockRange.from * 1000).toISOString()} through ${new Date(r.blockRange.to * 1000).toISOString()} (inclusive)` : 'All loaded history'}\nConfirmation: ${r.backtestSettings.confirmationStrategies?.join(', ') || 'none'} · Exit override: ${r.backtestSettings.exitStrategyOverrideEnabled ? r.backtestSettings.exitStrategyKey : 'none'}. Edits apply to the next run.`;
        } catch (error) { if (!this.disposed) this.dom.universePreview.textContent = String(error); }
    }
    private setBusy(busy: boolean): void {
        this.busy = busy;
        if (this.isUniverse()) { this.dom.runBtn.disabled = busy; this.dom.cancelBtn.disabled = !busy; this.dom.cancelBtn.style.display = busy ? 'inline-block' : 'none'; this.dom.spinner.style.display = busy ? 'inline-block' : 'none'; }
    }
    private message(text: string): void { this.statusText = text; if (!this.disposed && this.isUniverse()) this.dom.statusSpan.textContent = text; }
    private async json(path: string, body?: unknown, signal = this.lifetime.signal): Promise<unknown> {
        const response = await fetch(`/api/monte-carlo/universe/${path}`, { method: body === undefined ? 'GET' : 'POST', signal,
            ...(body === undefined ? {} : { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) });
        if (!response.headers.get('content-type')?.includes('application/json')) throw new Error('Symbol Universe requires the local research server.');
        const value = await response.json();
        if (!response.ok) throw Object.assign(new Error(value.error ?? 'Server request failed'), { status: response.status });
        return value;
    }
    private async run(): Promise<void> {
        if (this.busy || this.disposed) return;
        const previousId = this.runId;
        let submitted = false;
        this.setBusy(true); const id = crypto.randomUUID(); this.runId = id; this.saveMarker(id); this.savePreferences();
        try {
            this.message('Capturing strategy configuration…');
            const request = await this.capture(id); validateUniverseRequest(request);
            this.detailGeneration++; this.detail = null; this.selectedDetail = null;
            if (this.isUniverse()) this.onScope(true, null);
            this.message('Starting local server run…');
            submitted = true;
            await this.json('run', request);
            if (this.disposed || this.runId !== id) return;
            this.snapshot = null; this.page = 0; await this.attach(id);
        } catch (error) {
            if (this.disposed || this.runId !== id) return;
            this.message(error instanceof Error ? error.message : String(error)); this.setBusy(false);
            // A network failure can hide an accepted response; recover by status without resubmitting.
            if (submitted && !(error as { status?: number }).status && error instanceof TypeError) { this.setBusy(true); void this.attach(id); }
            else { this.runId = previousId; this.saveMarker(previousId); }
        }
    }
    private async attach(id: string): Promise<void> {
        this.poll?.abort();
        const adopt = (snapshot: UniverseSnapshot) => {
            this.snapshot = snapshot; this.render();
            this.message(`${snapshot.stage} · ${snapshot.counts.processed}/${snapshot.counts.requested}${snapshot.currentIndex === null ? '' : ` · instrument ${snapshot.currentIndex + 1}`}${snapshot.error ? ` · ${snapshot.error}` : ''}`);
            if (isUniverseTerminal(snapshot.state)) this.setBusy(false);
        };
        const poll = new ServerRunPollLoop<UniverseSnapshot>({ signal: this.lifetime.signal, isOwned: () => !this.disposed && this.runId === id,
            fetchStatus: async signal => {
                try {
                    const snapshot = await this.json(`status?runId=${encodeURIComponent(id)}`, undefined, signal) as UniverseSnapshot;
                    return snapshot.runId === id ? { kind: 'snapshot', snapshot } : { kind: 'rejected' };
                } catch (error) { if ((error as { status?: number }).status === 404) return { kind: 'not_found' }; throw error; }
            }, isTerminal: snapshot => isUniverseTerminal(snapshot.state), nextRequestDelayMs: () => 1000, requestTimeoutMs: 15000,
            onProgress: adopt, onTransientFailure: () => this.message('Connection interrupted; retrying status. The server run continues.') });
        this.poll = poll;
        const outcome = await poll.run();
        if (this.disposed || this.runId !== id || this.poll !== poll) return;
        if (outcome.kind === 'terminal') adopt(outcome.snapshot);
        if (outcome.kind !== 'cancelled') this.setBusy(false);
        if (outcome.kind === 'not_found' || outcome.kind === 'rejected') { this.message('Run unavailable or replaced. Start a new run.'); this.saveMarker(null); }
        if (outcome.kind === 'connection_lost') this.message('Local research server unavailable. Reload to reattach. Current Chart remains available.');
    }
    private async stop(): Promise<void> {
        if (!this.runId) return;
        try { await this.json('stop', { runId: this.runId }); this.message('Stopping; waiting for committed rows…'); }
        catch (error) { this.message(String(error)); }
    }
    private render(): void { if (this.snapshot) renderUniverseInventory(this.snapshot, this.dom, this.page, this.sortKey, this.ascending); }
    private selectDetail(index: number): void {
        this.selectedDetail = index; this.detailGeneration++; this.detail = null;
        if (this.isUniverse()) this.onScope(true, null);
        if (!this.detailPromise) this.queueDetail();
    }
    private queueDetail(): void {
        const generation = this.detailGeneration, index = this.selectedDetail, id = this.runId;
        if (index === null || !id) return;
        this.dom.universeDetailStatus.textContent = 'Replaying saved trades…';
        this.detailPromise = (async () => {
            try {
                const response = await this.json('detail', { runId: id, rowIndex: index }) as { result: MonteCarloResult; digest: string };
                if (this.disposed || generation !== this.detailGeneration || id !== this.runId) return;
                this.detail = response.result;
                this.dom.universeDetailStatus.textContent = `${this.snapshot?.rows[index]?.token ?? ''} · saved configuration · ${response.digest}`;
                if (this.isUniverse()) this.onScope(true, this.detail);
            } catch (error) { if (!this.disposed && generation === this.detailGeneration) this.dom.universeDetailStatus.textContent = String(error); }
        })().finally(() => {
            this.detailPromise = null;
            if (!this.disposed && id === this.runId && generation !== this.detailGeneration && this.selectedDetail !== null) this.queueDetail();
        });
    }
    private download(): void {
        if (!this.snapshot || !isUniverseTerminal(this.snapshot.state)) return;
        const url = URL.createObjectURL(new Blob([JSON.stringify({ ...this.snapshot, rows: sortUniverseRows(this.snapshot.rows, this.sortKey, this.ascending) }, null, 2)], { type: 'application/json' }));
        const link = document.createElement('a'); link.href = url; link.download = `monte-carlo-universe-${this.snapshot.runId}.json`; link.click(); URL.revokeObjectURL(url);
    }
    dispose(): void {
        if (this.disposed) return;
        this.savePreferences(); this.disposed = true; this.detailGeneration++; this.detail = null;
        this.poll?.abort(); this.lifetime.abort(); this.cleanup.splice(0).forEach(cleanup => cleanup());
    }
}
