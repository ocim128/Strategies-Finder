import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import worker from '../workers/entry-signal-worker';
import {
    applyWorkerMigrations as applyMigrations,
    makeWorkerEnv as makeEnv,
    WORKER_MIGRATION_FILES as MIGRATION_FILES,
} from './helpers/worker-d1';

function makeController(): never {
    // A minute-old scheduledTime keeps the handler's alignment target strictly
    // in the past, so computeScheduleAlignmentDelayMs returns 0 and the test
    // never sleeps.
    const scheduledTime = Date.now() - 60_000;
    return { scheduledTime } as never;
}

const SUBSCRIPTION_BODY = {
    streamId: 'btcusdt:5m:ema_confirmation:cfg:test-1',
    symbol: 'BTCUSDT',
    interval: '5m',
    strategyKey: 'ema_confirmation',
    strategyParams: { emaPeriod: 10 },
    backtestSettings: { tradeDirection: 'both' },
    freshnessBars: 1,
    notifyTelegram: true,
    enabled: true,
    committeeTag: 'alpha',
};

interface SubscriptionRowShape {
    stream_id: string;
    symbol: string;
    committee_tag: string | null;
    latest_state_json: string | null;
    enabled: number;
    last_processed_candle_open_time: number;
}

interface RuleRowShape {
    committee_tag: string;
    enabled: number;
    long_threshold: number;
    short_threshold: number;
    last_fired_score_sign: number;
    last_fired_at: string | null;
    updated_at: string;
}

interface RuleApiShape {
    committeeTag: string;
    enabled: boolean;
    longThreshold: number;
    shortThreshold: number;
    lastFiredScoreSign: number;
    lastFiredAt: string | null;
    updatedAt: string;
}

describe('Worker schema migrations', () => {
    it('migration 0006 creates the full alert state schema on a fresh database', () => {
        const db = new DatabaseSync(':memory:');
        applyMigrations(db, MIGRATION_FILES.length);

        const subscriptionColumns = db.prepare('PRAGMA table_info(signal_subscriptions)').all() as Array<{ name: string; type: string }>;
        const committeeTag = subscriptionColumns.find((column) => column.name === 'committee_tag');
        const latestStateJson = subscriptionColumns.find((column) => column.name === 'latest_state_json');
        assert.equal(committeeTag?.type, 'TEXT');
        assert.equal(latestStateJson?.type, 'TEXT');

        const ruleTable = db.prepare(
            "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'committee_alert_rules'"
        ).get() as { sql: string } | undefined;
        assert.ok(ruleTable, 'committee_alert_rules must exist');
        for (const fragment of [
            'committee_tag TEXT PRIMARY KEY',
            'enabled INTEGER NOT NULL DEFAULT 0',
            'long_threshold INTEGER NOT NULL DEFAULT 1',
            'short_threshold INTEGER NOT NULL DEFAULT -1',
            'last_fired_score_sign INTEGER NOT NULL DEFAULT 0',
            'last_fired_at TEXT',
            'updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP',
        ]) {
            assert.ok(ruleTable.sql.includes(fragment), `missing: ${fragment}`);
        }
    });

    it('supports subscription upsert with committee tag on a migration-built database', async () => {
        const db = new DatabaseSync(':memory:');
        applyMigrations(db, MIGRATION_FILES.length);

        const response = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/upsert', {
                method: 'POST',
                body: JSON.stringify(SUBSCRIPTION_BODY),
            }),
            makeEnv(db),
        );
        assert.equal(response.status, 200);
        const body = await response.json() as { ok: boolean; subscription: SubscriptionRowShape };
        assert.equal(body.ok, true);
        assert.equal(body.subscription.committee_tag, 'alpha');
        assert.equal(body.subscription.latest_state_json, null);
    });

    it('upgrades an existing-data database and preserves its rows', async () => {
        const db = new DatabaseSync(':memory:');
        applyMigrations(db, 5);
        db.prepare(
            `INSERT INTO signal_subscriptions
                (stream_id, enabled, symbol, interval, strategy_key, strategy_params_json, backtest_settings_json)
             VALUES ('legacy:5m:ema_confirmation:cfg:legacy-1', 1, 'ETHUSDT', '5m', 'ema_confirmation', '{}', '{}')`
        ).run();

        applyMigrations(db, 6, 5);

        const rows = db.prepare('SELECT * FROM signal_subscriptions').all() as unknown as SubscriptionRowShape[];
        assert.equal(rows.length, 1);
        assert.equal(rows[0]!.stream_id, 'legacy:5m:ema_confirmation:cfg:legacy-1');
        assert.equal(rows[0]!.committee_tag, null);

        const response = await worker.fetch(
            new Request('https://worker.test/api/subscriptions/upsert', {
                method: 'POST',
                body: JSON.stringify({ ...SUBSCRIPTION_BODY, streamId: 'legacy:5m:ema_confirmation:cfg:legacy-1' }),
            }),
            makeEnv(db),
        );
        assert.equal(response.status, 200);
        const after = db.prepare(
            'SELECT * FROM signal_subscriptions WHERE stream_id = ?'
        ).get('legacy:5m:ema_confirmation:cfg:legacy-1') as unknown as SubscriptionRowShape | undefined;
        assert.ok(after);
        assert.equal(after!.committee_tag, 'alpha');
        assert.equal(after!.symbol, 'BTCUSDT');
    });

    it('supports committee rule upsert and list with handler defaults', async () => {
        const db = new DatabaseSync(':memory:');
        applyMigrations(db, MIGRATION_FILES.length);

        const upsert = await worker.fetch(
            new Request('https://worker.test/api/committee-alert/rules', {
                method: 'POST',
                body: JSON.stringify({ committeeTag: 'alpha', enabled: true, longThreshold: 2, shortThreshold: -2 }),
            }),
            makeEnv(db),
        );
        assert.equal(upsert.status, 200);
        const upsertBody = await upsert.json() as { ok: boolean; item: RuleApiShape | null };
        assert.equal(upsertBody.ok, true);
        assert.ok(upsertBody.item, 'upsert must return the persisted rule');
        assert.equal(upsertBody.item!.longThreshold, 2);
        assert.equal(upsertBody.item!.shortThreshold, -2);
        assert.equal(upsertBody.item!.lastFiredScoreSign, 0);
        assert.equal(upsertBody.item!.lastFiredAt, null);
        assert.ok(upsertBody.item!.updatedAt.length > 0);

        const defaults = await worker.fetch(
            new Request('https://worker.test/api/committee-alert/rules', {
                method: 'POST',
                body: JSON.stringify({ committeeTag: 'beta', enabled: false }),
            }),
            makeEnv(db),
        );
        const defaultsBody = await defaults.json() as { ok: boolean; item: RuleApiShape | null };
        assert.equal(defaultsBody.item!.enabled, false);
        assert.equal(defaultsBody.item!.longThreshold, 1);
        assert.equal(defaultsBody.item!.shortThreshold, -1);

        const list = await worker.fetch(
            new Request('https://worker.test/api/committee-alert/rules'),
            makeEnv(db),
        );
        const listBody = await list.json() as { ok: boolean; count: number; items: RuleApiShape[] };
        assert.equal(listBody.ok, true);
        assert.equal(listBody.count, 2);
        assert.deepEqual(listBody.items.map((rule) => rule.committeeTag), ['alpha', 'beta']);
    });

    it('scheduled committee evaluation fires on threshold cross, persists hysteresis, and stays quiet on repeat', async () => {
        const db = new DatabaseSync(':memory:');
        applyMigrations(db, MIGRATION_FILES.length);
        db.prepare(
            `INSERT INTO committee_alert_rules (committee_tag, enabled, long_threshold, short_threshold)
             VALUES ('alpha', 1, 1, -1)`
        ).run();
        db.prepare(
            `INSERT INTO signal_subscriptions
                (stream_id, enabled, symbol, interval, strategy_key, strategy_params_json, backtest_settings_json,
                 committee_tag, latest_state_json, last_processed_candle_open_time)
             VALUES ('solusdt:5m:ema_confirmation:cfg:mem-1', 1, 'SOLUSDT', '5m', 'ema_confirmation', '{}', '{}',
                     'alpha', ?, ?)`
        ).run(
            JSON.stringify({
                evaluatedAt: new Date().toISOString(),
                closedCandleTimeSec: null,
                latestClose: 100,
                reason: null,
                latestTrade: { isOpen: true },
                latestEntry: { direction: 'long', time: 1, price: 100 },
            }),
            Math.floor(Date.now() / 1000) + 3_600_000,
        );

        const telegramCalls: string[] = [];
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
            const url = String(input);
            if (url.startsWith('https://api.telegram.org/')) {
                const parsed = JSON.parse(String(init?.body ?? '{}')) as { text?: string };
                telegramCalls.push(parsed.text ?? '');
                return new Response(JSON.stringify({ ok: true }), { status: 200 });
            }
            return new Response('{}', { status: 404 });
        }) as typeof fetch;

        try {
            const env = makeEnv(db, {
                TELEGRAM_BOT_TOKEN: 'test-token',
                TELEGRAM_CHAT_ID: 'test-chat',
            });
            await worker.scheduled(makeController(), env);

            assert.equal(telegramCalls.length, 1);
            assert.ok(telegramCalls[0]!.includes('Committee "alpha"'), telegramCalls[0]);

            const rule = db.prepare(
                'SELECT * FROM committee_alert_rules WHERE committee_tag = ?'
            ).get('alpha') as unknown as RuleRowShape;
            assert.equal(rule.last_fired_score_sign, 1);
            assert.ok(rule.last_fired_at, 'last_fired_at must persist after a successful send');

            await worker.scheduled(makeController(), env);
            assert.equal(telegramCalls.length, 1, 'hysteresis must suppress an immediate repeat fire');
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    it('isolates committee-pass query failures from an otherwise completed cron pass', async () => {
        const db = new DatabaseSync(':memory:');
        applyMigrations(db, MIGRATION_FILES.length);
        const originalFetch = globalThis.fetch;
        globalThis.fetch = (async () => new Response('{}', { status: 404 })) as typeof fetch;
        const errors: string[] = [];
        const originalConsoleError = console.error;
        console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };

        try {
            const env = makeEnv(
                db,
                { TELEGRAM_BOT_TOKEN: 'test-token', TELEGRAM_CHAT_ID: 'test-chat' },
                (sql) => sql.includes('FROM committee_alert_rules'),
            );
            await worker.scheduled(makeController(), env);
            assert.ok(errors.some((line) => line.includes('committee_alert_pass_failed')), errors.join('\n'));
        } finally {
            globalThis.fetch = originalFetch;
            console.error = originalConsoleError;
        }
    });
});

/**
 * The cron pass is the only place the worker fetches market history on a
 * schedule, and several subscriptions routinely watch the same instrument. Those
 * used to download the same pages once per subscription (CPU minutes + public API
 * rate limit for identical bytes); one tick now fetches one history per
 * (instrument, interval, limit).
 */
describe('Scheduled subscription candle fetches', () => {
    const INTERVAL_MS = 5 * 60 * 1000;

    /** Binance-shaped klines, all closed, oldest→newest, exactly `count` rows. */
    function buildClosedKlines(count: number): unknown[] {
        const lastOpenMs = Date.now() - 10 * INTERVAL_MS;
        const firstOpenMs = lastOpenMs - (count - 1) * INTERVAL_MS;
        const rows: unknown[] = [];
        for (let i = 0; i < count; i += 1) {
            const openTimeMs = firstOpenMs + i * INTERVAL_MS;
            const base = 30_000 + i;
            rows.push([
                openTimeMs,
                String(base),
                String(base + 50),
                String(base - 50),
                String(base + 10),
                "123.4",
                openTimeMs + INTERVAL_MS - 1,
                "0",
                1,
                "0",
                "0",
                "0",
            ]);
        }
        return rows;
    }

    it('downloads one candle history per instrument per tick instead of one per subscription', async () => {
        const db = new DatabaseSync(':memory:');
        applyMigrations(db, MIGRATION_FILES.length);
        const insert = db.prepare(
            `INSERT INTO signal_subscriptions
                (stream_id, enabled, symbol, interval, strategy_key, strategy_params_json,
                 backtest_settings_json, notify_telegram, notify_exit, candle_limit)
             VALUES (?, 1, ?, '5m', 'ema_confirmation', '{}', '{}', 0, 0, 350)`
        );
        // Two configs on the same instrument (the duplicate-download case) plus a
        // third subscription on a DIFFERENT instrument that must still fetch.
        insert.run('btcusdt:5m:ema_confirmation:cfg:dup-a', 'BTCUSDT');
        insert.run('btcusdt:5m:ema_confirmation:cfg:dup-b', 'BTCUSDT');
        insert.run('ethusdt:5m:ema_confirmation:cfg:dup-c', 'ETHUSDT');

        const klineCalls: string[] = [];
        const originalFetch = globalThis.fetch;
        const originalConsoleInfo = console.info;
        // The cron pass logs a JSON summary every minute; keep the test output clean.
        console.info = () => undefined;
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (!url.includes('/api/v3/klines')) {
                return new Response('{}', { status: 404 });
            }
            klineCalls.push(url);
            // Exactly `limit` rows keeps `fetchBinanceCandles` to a single page.
            return new Response(JSON.stringify(buildClosedKlines(351)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;

        try {
            await worker.scheduled(makeController(), makeEnv(db));
        } finally {
            globalThis.fetch = originalFetch;
            console.info = originalConsoleInfo;
        }

        const btcCalls = klineCalls.filter((url) => url.includes('symbol=BTCUSDT'));
        const ethCalls = klineCalls.filter((url) => url.includes('symbol=ETHUSDT'));
        assert.equal(
            btcCalls.length,
            1,
            `two subscriptions on one instrument must share a single download (saw ${btcCalls.length})`,
        );
        assert.equal(ethCalls.length, 1, 'a different instrument must not be served from another symbol\'s cache');
        assert.equal(klineCalls.length, 2, `expected one download per distinct instrument, saw ${klineCalls.length}`);

        // A second tick must re-read the market: the cache is scoped to one pass,
        // so a stale-shape `Map` hoisted to module scope would fail here.
        const secondTickCalls: string[] = [];
        globalThis.fetch = (async (input: RequestInfo | URL) => {
            const url = String(input);
            if (!url.includes('/api/v3/klines')) return new Response('{}', { status: 404 });
            secondTickCalls.push(url);
            return new Response(JSON.stringify(buildClosedKlines(351)), {
                status: 200,
                headers: { 'content-type': 'application/json' },
            });
        }) as typeof fetch;
        console.info = () => undefined;
        try {
            // Reset the per-subscription candle cursor so the next pass is due again.
            db.prepare('UPDATE signal_subscriptions SET last_processed_candle_open_time = 0').run();
            await worker.scheduled(makeController(), makeEnv(db));
        } finally {
            globalThis.fetch = originalFetch;
            console.info = originalConsoleInfo;
        }
        assert.equal(
            secondTickCalls.filter((url) => url.includes('symbol=BTCUSDT')).length,
            1,
            'the next tick must fetch fresh candles rather than reuse the previous tick cache',
        );
    });
});
