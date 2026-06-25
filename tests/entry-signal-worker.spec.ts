import { expect } from 'chai';
import { describe, it } from 'node:test';
import worker, {
    buildLatestActionableEntrySignalQuery,
    decideCommitteeAlert,
} from '../workers/entry-signal-worker';

describe('Entry signal worker queries', () => {
    it('filters pending-entry placeholders out of latest-entry lookups', () => {
        const query = buildLatestActionableEntrySignalQuery('payload_json');

        expect(query).to.equal(
            "SELECT payload_json FROM entry_signals WHERE channel_key = ? AND COALESCE(signal_reason, '') != ? ORDER BY signal_time DESC, id DESC LIMIT 1"
        );
    });

    it('keeps health public but protects private endpoints when WORKER_API_TOKEN is set', async () => {
        const env = { WORKER_API_TOKEN: 'secret' } as never;

        const health = await worker.fetch(new Request('https://worker.test/health'), env);
        expect(health.status).to.equal(200);

        const unauthorized = await worker.fetch(new Request('https://worker.test/api/subscriptions'), env);
        expect(unauthorized.status).to.equal(401);

        const authorized = await worker.fetch(new Request('https://worker.test/api/subscriptions', {
            headers: { authorization: 'Bearer secret' },
        }), env);
        expect(authorized.status).to.equal(500);
    });
});

describe('Signal Committee batched state endpoint', () => {
    it('gates POST /api/subscriptions/states behind the worker token', async () => {
        const env = { WORKER_API_TOKEN: 'secret' } as never;
        const unauthorized = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: ['s1'] }),
            }),
            env
        );
        expect(unauthorized.status).to.equal(401);
    });

    it('returns 500 when SIGNALS_DB binding is missing (no crash)', async () => {
        const res = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: ['s1'] }),
            }),
            {} as never
        );
        expect(res.status).to.equal(500);
        const body = await res.json() as { ok: boolean; error: string };
        expect(body.ok).to.equal(false);
        expect(body.error).to.contain('SIGNALS_DB');
    });

    it('rejects requests whose streamIds is not an array', async () => {
        const res = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: 'not-an-array' }),
            }),
            {} as never
        );
        expect(res.status).to.equal(400);
    });

    it('returns an empty states list for an empty streamIds array', async () => {
        const res = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/states', {
                method: 'POST',
                body: JSON.stringify({ streamIds: [] }),
            }),
            {} as never
        );
        expect(res.status).to.equal(200);
        const body = await res.json() as { ok: boolean; states: unknown[] };
        expect(body.ok).to.equal(true);
        expect(body.states).to.deep.equal([]);
    });
});

describe('Entry signal worker synthetic-pair subscriptions', () => {
    it('builds enough synthetic candles from base and quote symbols instead of fetching the derived symbol', async () => {
        const originalFetch = globalThis.fetch;
        const fetchedSymbols: string[] = [];
        const fetchedIntervals: string[] = [];
        const fetchedLimits: number[] = [];
        const nowSec = Math.floor(Date.now() / 1000);
        function makeRows(symbol: string, stepSec: number, count: number): Array<[number, string, string, string, string, string]> {
            const firstOpenSec = nowSec - stepSec * (count - 1);
            const basePrice = symbol === 'ZECUSDT' ? 150 : 0.2;
            const rows: Array<[number, string, string, string, string, string]> = [];
            for (let i = 0; i < count; i++) {
                const price = basePrice + i * (symbol === 'ZECUSDT' ? 0.1 : 0.0001);
                rows.push([
                    (firstOpenSec + i * stepSec) * 1000,
                    String(price),
                    String(price * 1.01),
                    String(price * 0.99),
                    String(price * 1.001),
                    '1000',
                ]);
            }
            return rows;
        }

        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            const symbol = url.searchParams.get('symbol') ?? '';
            const interval = url.searchParams.get('interval') ?? '';
            const limit = Number(url.searchParams.get('limit') ?? '0');
            const startTime = Number(url.searchParams.get('startTime') ?? 'NaN');
            const endTime = Number(url.searchParams.get('endTime') ?? 'NaN');
            fetchedSymbols.push(symbol);
            fetchedIntervals.push(interval);
            fetchedLimits.push(limit);
            if (symbol === 'ZECAPT') {
                return new Response(JSON.stringify({ msg: 'Invalid symbol' }), { status: 400 });
            }
            const allRows = interval === '1m'
                ? makeRows(symbol, 60, 1200)
                : makeRows(symbol, 300, 240);
            const cappedLimit = limit;
            const eligibleRows = Number.isFinite(endTime)
                ? allRows.filter((row) => row[0] <= endTime)
                : Number.isFinite(startTime)
                ? allRows.filter((row) => row[0] >= startTime)
                : allRows;
            const rows = Number.isFinite(startTime)
                ? eligibleRows.slice(0, cappedLimit)
                : eligibleRows.slice(-cappedLimit);
            return new Response(JSON.stringify(rows), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const subscription = {
            id: 1,
            stream_id: 'zecapt:5m:volatility_regime_median_alignment:cfg:ZECAPT-5m',
            enabled: 1,
            symbol: 'ZECAPT',
            interval: '5m',
            strategy_key: 'volatility_regime_median_alignment',
            strategy_params_json: '{}',
            backtest_settings_json: JSON.stringify({
                syntheticPair: { baseSymbol: 'ZECUSDT', quoteSymbol: 'APTUSDT' },
            }),
            freshness_bars: 1,
            notify_telegram: 0,
            notify_exit: 0,
            candle_limit: 200,
            last_processed_candle_open_time: 0,
            last_run_at: null,
            last_status: null,
            created_at: '2026-06-20 00:00:00',
            updated_at: '2026-06-20 00:00:00',
            latest_state_json: null,
            committee_tag: 'default',
        };

        const env = {
            MIN_CLOSED_CANDLES: '120',
            MARKET_DATA_API_BASES: 'https://data-api.binance.vision',
            SIGNALS_DB: {
                prepare: () => ({
                    bind: () => ({
                        first: async () => subscription,
                    }),
                }),
            },
        } as never;

        try {
            const res = await worker.fetch(
                new Request('https://worker.test/api/subscriptions/state?streamId=zecapt%3A5m%3Avolatility_regime_median_alignment%3Acfg%3AZECAPT-5m'),
                env
            );
            expect(res.status).to.equal(200);
            const body = await res.json() as { state: { ok: boolean; symbol: string; latestClose: number | null; reason: string | null } };
            expect(body.state.ok).to.equal(true);
            expect(body.state.symbol).to.equal('ZECAPT');
            expect(body.state.latestClose).to.not.equal(null);
            expect(body.state.reason).to.not.match(/^insufficient_candles:/);
            expect(fetchedSymbols).to.include('ZECUSDT');
            expect(fetchedSymbols).to.include('APTUSDT');
            expect(fetchedSymbols).not.to.include('ZECAPT');
            expect(fetchedIntervals.every((interval) => interval === '1m')).to.equal(true);
            expect(fetchedLimits.filter((limit) => limit === 1000)).to.have.length(2);
            expect(fetchedLimits.filter((limit) => limit === 1)).to.have.length(2);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('Entry signal worker local candle proxy', () => {
    it('fetches legs from LOCAL_CANDLE_PROXY_URL first and skips Binance public endpoints entirely when the proxy has the symbol', async () => {
        const originalFetch = globalThis.fetch;
        const fetchedHosts: string[] = [];
        // Build 600 1m candles for both legs — enough to satisfy synthetic aggregation for 3m.
        // Shape matches /api/sqlite/load-ohlcv JSON response (epoch-second time, OHLCV object rows).
        const nowSec = Math.floor(Date.now() / 1000);
        function legCandles(symbol: string): Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> {
            const base = symbol === 'ZECUSDT' ? 150 : 0.2;
            const rows: Array<{ time: number; open: number; high: number; low: number; close: number; volume: number }> = [];
            for (let i = 0; i < 600; i++) {
                const p = base + i * 0.001;
                rows.push({
                    time: nowSec - (599 - i) * 60,
                    open: p, high: p * 1.01, low: p * 0.99, close: p * 1.001, volume: 1000,
                });
            }
            return rows;
        }

        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            fetchedHosts.push(url.hostname);
            if (url.hostname === 'proxy.example.test') {
                const symbol = url.searchParams.get('symbol') ?? '';
                return new Response(JSON.stringify({
                    ok: true, symbol, interval: '1m', candles: legCandles(symbol),
                }), { status: 200, headers: { 'content-type': 'application/json' } });
            }
            // Any Binance endpoint: should not be reached.
            return new Response(JSON.stringify({ msg: 'should not be called' }), { status: 400 });
        }) as typeof fetch;

        const subscription = {
            id: 1,
            stream_id: 'zecapt:3m:wick_imbalance_thrust_continuation:cfg:ZECAPT-3m',
            enabled: 1,
            symbol: 'ZECAPT',
            interval: '3m',
            strategy_key: 'wick_imbalance_thrust_continuation',
            strategy_params_json: '{}',
            backtest_settings_json: JSON.stringify({
                syntheticPair: { baseSymbol: 'ZECUSDT', quoteSymbol: 'APTUSDT' },
            }),
            freshness_bars: 1,
            notify_telegram: 0,
            notify_exit: 0,
            candle_limit: 500,
            last_processed_candle_open_time: 0,
            last_run_at: null,
            last_status: null,
            created_at: '2026-06-20 00:00:00',
            updated_at: '2026-06-20 00:00:00',
            latest_state_json: null,
            committee_tag: 'default',
        };

        const env = {
            MIN_CLOSED_CANDLES: '120',
            MARKET_DATA_API_BASES: 'https://data-api.binance.vision',
            LOCAL_CANDLE_PROXY_URL: 'https://proxy.example.test',
            LOCAL_CANDLE_PROXY_TOKEN: 'secret-token',
            SIGNALS_DB: {
                prepare: () => ({
                    bind: () => ({
                        first: async () => subscription,
                    }),
                }),
            },
        } as never;

        try {
            const res = await worker.fetch(
                new Request('https://worker.test/api/subscriptions/state?streamId=zecapt%3A3m%3Awick_imbalance_thrust_continuation%3Acfg%3AZECAPT-3m'),
                env
            );
            expect(res.status).to.equal(200);
            const body = await res.json() as { state: { ok: boolean; reason: string | null; latestClose: number | null } };
            // Proxy supplied both legs -> aggregation succeeded -> state evaluated.
            expect(body.state.ok).to.equal(true);
            expect(body.state.latestClose).to.not.equal(null);

            // Every fetch must have hit the proxy; no Binance hosts.
            expect(fetchedHosts.every((h) => h === 'proxy.example.test')).to.equal(true);
            expect(fetchedHosts.some((h) => h.includes('binance'))).to.equal(false);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('falls back to Binance public endpoints when the proxy returns no candles for the requested symbol', async () => {
        const originalFetch = globalThis.fetch;
        const fetchedHosts: string[] = [];
        const nowSec = Math.floor(Date.now() / 1000);

        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = new URL(String(input));
            fetchedHosts.push(url.hostname);
            if (url.hostname === 'proxy.example.test') {
                // Proxy has no rows for this symbol.
                return new Response(JSON.stringify({ ok: true, symbol: 'UNKNOWN', candles: [] }), {
                    status: 200, headers: { 'content-type': 'application/json' },
                });
            }
            // Binance fallback: return enough 1m rows to satisfy MIN_CLOSED_CANDLES for 3m.
            const symbol = url.searchParams.get('symbol') ?? '';
            const base = symbol === 'ZECUSDT' ? 150 : 0.2;
            const rows: Array<[number, string, string, string, string, string]> = [];
            for (let i = 0; i < 800; i++) {
                const p = base + i * 0.001;
                rows.push([
                    (nowSec - (799 - i) * 60) * 1000,
                    String(p), String(p * 1.01), String(p * 0.99), String(p * 1.001), '1000',
                ]);
            }
            return new Response(JSON.stringify(rows), {
                status: 200, headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        const subscription = {
            id: 1,
            stream_id: 'zecapt:3m:wick_imbalance_thrust_continuation:cfg:ZECAPT-3m',
            enabled: 1,
            symbol: 'ZECAPT',
            interval: '3m',
            strategy_key: 'wick_imbalance_thrust_continuation',
            strategy_params_json: '{}',
            backtest_settings_json: JSON.stringify({
                syntheticPair: { baseSymbol: 'ZECUSDT', quoteSymbol: 'APTUSDT' },
            }),
            freshness_bars: 1,
            notify_telegram: 0,
            notify_exit: 0,
            candle_limit: 500,
            last_processed_candle_open_time: 0,
            last_run_at: null,
            last_status: null,
            created_at: '2026-06-20 00:00:00',
            updated_at: '2026-06-20 00:00:00',
            latest_state_json: null,
            committee_tag: 'default',
        };

        const env = {
            MIN_CLOSED_CANDLES: '120',
            MARKET_DATA_API_BASES: 'https://data-api.binance.vision',
            LOCAL_CANDLE_PROXY_URL: 'https://proxy.example.test',
            SIGNALS_DB: {
                prepare: () => ({
                    bind: () => ({
                        first: async () => subscription,
                    }),
                }),
            },
        } as never;

        try {
            const res = await worker.fetch(
                new Request('https://worker.test/api/subscriptions/state?streamId=zecapt%3A3m%3Awick_imbalance_thrust_continuation%3Acfg%3AZECAPT-3m'),
                env
            );
            expect(res.status).to.equal(200);
            const body = await res.json() as { state: { ok: boolean } };
            expect(body.state.ok).to.equal(true);
            // Proxy was tried (and returned empty); Binance fallback supplied the data.
            expect(fetchedHosts).to.include('proxy.example.test');
            expect(fetchedHosts.some((h) => h.includes('binance'))).to.equal(true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('Entry signal worker run-now staleness', () => {
    it('overwrites latest_state_json with a not-ok snapshot for a real-symbol subscription when buildSubscriptionCandleContext fails, so the batched committee endpoint never serves a stale open trade alongside an insufficient_candles status', async () => {
        const originalFetch = globalThis.fetch;
        const staleOpenTradeState = {
            evaluatedAt: '2026-06-20T10:00:00.000Z',
            closedCandleTimeSec: 1781900000,
            latestClose: 740.41,
            reason: 'stale_signal',
            latestTrade: {
                entryTimeSec: 1781909700,
                entryPrice: 742.61,
                exitReason: 'end_of_data',
                isOpen: true,
                takeProfitPrice: null,
                stopLossPrice: null,
                takeProfitPercent: null,
                stopLossPercent: null,
            },
            latestEntry: {
                direction: 'long',
                signalTimeSec: 1781909700,
                signalPrice: 742.61,
                entryPrice: 742.61,
                signalAgeBars: 0,
                isFresh: true,
                fingerprint: 'strategy:long:1781909700:742.61',
            },
            tradeWindows: [[1781909700, null, 1]],
        };
        // Real-symbol subscription (no syntheticPair). Synthetic members keep
        // their last-good snapshot on fetch failure because their only recovery
        // path is a manual "Sync Synthetic Legs"; real-symbol members have no
        // such recovery, so wiping prevents a stale open trade from rendering
        // indefinitely. See the isSyntheticMember gate in runSubscription.
        const subscription = {
            id: 1,
            stream_id: 'btcusdt:3m:wick_imbalance_thrust_continuation:cfg:BTCUSDT-3m',
            enabled: 1,
            symbol: 'BTCUSDT',
            interval: '3m',
            strategy_key: 'wick_imbalance_thrust_continuation',
            strategy_params_json: '{}',
            backtest_settings_json: JSON.stringify({}),
            freshness_bars: 1,
            notify_telegram: 0,
            notify_exit: 0,
            // Tiny candle limit forces insufficient_candles regardless of fetch.
            candle_limit: 60,
            last_processed_candle_open_time: 0,
            last_run_at: null,
            last_status: 'new_entry',
            created_at: '2026-06-20 00:00:00',
            updated_at: '2026-06-20 00:00:00',
            latest_state_json: JSON.stringify(staleOpenTradeState),
            committee_tag: 'default',
        };

        const stateUpdates: Array<{ sql: string; params: unknown[] }> = [];
        // Stub fetch to return a few klines. Enough to resolve, but far below
        // MIN_CLOSED_CANDLES (200) so buildSubscriptionCandleContext returns
        // insufficient_candles.
        const stepSec = 180;
        const fewRows: Array<[number, string, string, string, string, string]> = [];
        const baseOpen = Math.floor(Date.now() / 1000) - stepSec * 9;
        for (let i = 0; i < 10; i++) {
            const p = 100 + i * 0.1;
            fewRows.push([
                (baseOpen + i * stepSec) * 1000,
                String(p), String(p * 1.01), String(p * 0.99), String(p * 1.001), '1000',
            ]);
        }
        globalThis.fetch = (async () => new Response(JSON.stringify(fewRows), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        })) as typeof fetch;

        const env = {
            MIN_CLOSED_CANDLES: '200',
            MARKET_DATA_API_BASES: 'https://data-api.binance.vision',
            SIGNALS_DB: {
                prepare: (sql: string) => ({
                    bind: (...params: unknown[]) => ({
                        first: async () => subscription,
                        run: async () => {
                            stateUpdates.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
                            return { meta: { changes: 1 } };
                        },
                    }),
                }),
            },
        } as never;

        try {
            const res = await worker.fetch(
                new Request('https://worker.test/api/subscriptions/run-now', {
                    method: 'POST',
                    body: JSON.stringify({
                        streamId: 'btcusdt:3m:wick_imbalance_thrust_continuation:cfg:BTCUSDT-3m',
                    }),
                }),
                env
            );
            expect(res.status).to.equal(200);
            const body = await res.json() as { ok: boolean; status: string };
            expect(body.ok).to.equal(true);
            expect(body.status).to.contain('insufficient_candles');

            // The state write must have happened and must carry a not-ok
            // snapshot (null trade, null entry, the failure reason). This is
            // what prevents the batched endpoint from echoing the stale open
            // long after the cron can no longer evaluate the stream.
            const stateWrite = stateUpdates.find((u) => u.sql.includes('latest_state_json'));
            expect(stateWrite, 'expected an UPDATE writing latest_state_json').to.not.equal(undefined);
            const persisted = JSON.parse(String(stateWrite!.params[0])) as {
                latestTrade: unknown;
                latestEntry: unknown;
                reason: string;
            };
            expect(persisted.latestTrade).to.equal(null);
            expect(persisted.latestEntry).to.equal(null);
            expect(persisted.reason).to.contain('insufficient_candles');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('keeps the last-good latest_state_json for a synthetic-pair subscription when candle fetching throws (Binance 403), so the committee stays useful until the next manual Sync Synthetic Legs; only last_status records the failure', async () => {
        const originalFetch = globalThis.fetch;
        const existingState = {
            evaluatedAt: '2026-06-20T10:00:00.000Z',
            closedCandleTimeSec: 1781900000,
            latestClose: 740.41,
            reason: null,
            latestTrade: { entryTimeSec: 1781909700, entryPrice: 742.61, exitReason: 'end_of_data', isOpen: true },
            latestEntry: { direction: 'long', signalTimeSec: 1781909700, signalPrice: 742.61, entryPrice: 742.61 },
            tradeWindows: [[1781909700, null, 1]],
        };
        const subscription = {
            id: 1,
            stream_id: 'zecapt:5m:volatility_regime_median_alignment:cfg:ZECAPT-5m',
            enabled: 1,
            symbol: 'ZECAPT',
            interval: '5m',
            strategy_key: 'volatility_regime_median_alignment',
            strategy_params_json: '{}',
            backtest_settings_json: JSON.stringify({
                syntheticPair: { baseSymbol: 'ZECUSDT', quoteSymbol: 'APTUSDT' },
            }),
            freshness_bars: 1,
            notify_telegram: 0,
            notify_exit: 0,
            candle_limit: 500,
            last_processed_candle_open_time: 0,
            last_run_at: null,
            last_status: 'new_entry',
            created_at: '2026-06-20 00:00:00',
            updated_at: '2026-06-20 00:00:00',
            latest_state_json: JSON.stringify(existingState),
            committee_tag: 'default',
        };
        const stateUpdates: Array<{ sql: string; params: unknown[] }> = [];
        globalThis.fetch = (async () => new Response('403 Forbidden', { status: 403 })) as typeof fetch;

        const env = {
            MIN_CLOSED_CANDLES: '120',
            MARKET_DATA_API_BASES: 'https://data-api.binance.vision',
            SIGNALS_DB: {
                prepare: (sql: string) => ({
                    bind: (...params: unknown[]) => ({
                        first: async () => subscription,
                        run: async () => {
                            stateUpdates.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
                            return { meta: { changes: 1 } };
                        },
                    }),
                }),
            },
        } as never;

        try {
            const res = await worker.fetch(
                new Request('https://worker.test/api/subscriptions/run-now', {
                    method: 'POST',
                    body: JSON.stringify({
                        streamId: 'zecapt:5m:volatility_regime_median_alignment:cfg:ZECAPT-5m',
                    }),
                }),
                env
            );
            expect(res.status).to.equal(200);
            const body = await res.json() as { ok: boolean; status: string };
            expect(body.ok).to.equal(true);
            // The failure is still surfaced in last_status.
            expect(body.status).to.contain('error:Binance API unavailable');

            // KEY INVARIANT: a synthetic member must NOT have its latest_state_json
            // overwritten on a fetch failure. The cron cannot self-recover (Binance
            // is blocked), so the only path back is a manual Sync Synthetic Legs.
            // Keeping the last-good snapshot lets the committee keep showing the
            // direction/tradeWindows until that manual sync; wiping it would blind
            // the committee with no recovery. The row's last_status still shows
            // WHY the snapshot is stale.
            const stateWrite = stateUpdates.find((u) => u.sql.includes('latest_state_json'));
            expect(stateWrite, 'synthetic member on fetch failure must keep its latest_state_json, not rewrite it').to.equal(undefined);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });
});

describe('Committee aggregate-score alert rule decision', () => {
    const baseRule = {
        enabled: true,
        longThreshold: 2,
        shortThreshold: -2,
        lastFiredScoreSign: 0,
    };

    it('fires long when score >= longThreshold and last sign was not positive', () => {
        const r = decideCommitteeAlert(3, baseRule);
        expect(r).to.deep.equal({ fire: true, newSign: 1 });
    });

    it('does not fire long when threshold is not met', () => {
        expect(decideCommitteeAlert(1, baseRule)).to.deep.equal({ fire: false });
    });

    it('does not fire when score is positive but below long threshold', () => {
        expect(decideCommitteeAlert(1, { ...baseRule, longThreshold: 2 })).to.deep.equal({ fire: false });
    });

    it('fires short when score <= shortThreshold and last sign was not negative', () => {
        const r = decideCommitteeAlert(-3, baseRule);
        expect(r).to.deep.equal({ fire: true, newSign: -1 });
    });

    it('hysteresis: does not refire long while score stays positive across ticks', () => {
        // First fire: last sign 0 -> score 3 -> fire, new sign +1
        const first = decideCommitteeAlert(3, baseRule);
        expect(first).to.deep.equal({ fire: true, newSign: 1 });
        // Next tick: last sign now +1, score still 3 -> no refire
        const second = decideCommitteeAlert(3, { ...baseRule, lastFiredScoreSign: 1 });
        expect(second).to.deep.equal({ fire: false });
        // Even if score climbs further while sign unchanged -> still no refire
        const third = decideCommitteeAlert(5, { ...baseRule, lastFiredScoreSign: 1 });
        expect(third).to.deep.equal({ fire: false });
    });

    it('hysteresis: refires only after sign crosses back through zero', () => {
        // Was long (+1), now score goes strongly short (-4) -> fire short
        const r = decideCommitteeAlert(-4, { ...baseRule, lastFiredScoreSign: 1 });
        expect(r).to.deep.equal({ fire: true, newSign: -1 });
    });

    it('never fires when disabled', () => {
        expect(decideCommitteeAlert(10, { ...baseRule, enabled: false })).to.deep.equal({ fire: false });
        expect(decideCommitteeAlert(-10, { ...baseRule, enabled: false })).to.deep.equal({ fire: false });
    });

    it('does not fire on zero score', () => {
        expect(decideCommitteeAlert(0, baseRule)).to.deep.equal({ fire: false });
    });
});

describe('Committee alert rules endpoints', () => {
    it('gates GET /api/committee-alert/rules behind the worker token', async () => {
        const env = { WORKER_API_TOKEN: 'secret' } as never;
        const res = await worker.fetch(new Request('https://worker.test/api/committee-alert/rules'), env);
        expect(res.status).to.equal(401);
    });

    it('returns 500 when SIGNALS_DB binding is missing (no crash)', async () => {
        const res = await worker.fetch(new Request('https://worker.test/api/committee-alert/rules'), {} as never);
        expect(res.status).to.equal(500);
    });

    it('gates POST /api/committee-alert/rules behind the worker token', async () => {
        const env = { WORKER_API_TOKEN: 'secret' } as never;
        const res = await worker.fetch(
            new Request('https://worker.test/api/committee-alert/rules', {
                method: 'POST',
                body: JSON.stringify({ committeeTag: 'default', enabled: true }),
            }),
            env
        );
        expect(res.status).to.equal(401);
    });
});
