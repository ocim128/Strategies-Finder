import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import worker from '../workers/entry-signal-worker';

const MIGRATIONS_DIR = path.resolve(__dirname, '../workers/migrations');
const MIGRATION_FILES = [
    '0001_entry_signals.sql',
    '0002_signal_subscriptions.sql',
    '0003_exit_alerts.sql',
    '0004_rename_candle_time_col.sql',
    '0005_actionable_entry_signal_index.sql',
    '0006_alert_state_schema.sql',
];

type D1Result<T> = { results?: T[]; success?: boolean };

/**
 * Minimal D1 statement adapter over node:sqlite covering the worker's usage:
 * prepare().bind(...).run()/.first<T>()/.all<T>() plus unbound variants.
 */
function createSignalsDb(db: DatabaseSync, options?: { failWhen?(sql: string): boolean }) {
    const normalizeArgs = (args: unknown[]): SQLInputValue[] => args.map((value) => {
        if (typeof value === 'boolean') return value ? 1 : 0;
        return value as SQLInputValue;
    });
    return {
        prepare(sql: string) {
            if (options?.failWhen?.(sql)) {
                throw new Error(`d1_statement_failed:${sql.trim().slice(0, 48)}`);
            }
            const statement = db.prepare(sql);
            return {
                bind(...args: unknown[]) {
                    const params = normalizeArgs(args);
                    return {
                        run: async () => {
                            statement.run(...params);
                            return { success: true } as D1Result<unknown>;
                        },
                        first: async <T>() => (statement.get(...params) as T | undefined) ?? null,
                        all: async <T>() => ({ results: statement.all(...params) as T[] }) as D1Result<T>,
                    };
                },
                run: async () => {
                    statement.run();
                    return { success: true } as D1Result<unknown>;
                },
                first: async <T>() => (statement.get() as T | undefined) ?? null,
                all: async <T>() => ({ results: statement.all() as T[] }) as D1Result<T>,
            };
        },
    };
}

function applyMigrations(db: DatabaseSync, count: number, from = 0): void {
    for (const file of MIGRATION_FILES.slice(from, count)) {
        db.exec(fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8'));
    }
}

function makeEnv(db: DatabaseSync, extra?: Record<string, unknown>, failWhen?: (sql: string) => boolean) {
    return {
        SIGNALS_DB: createSignalsDb(db, failWhen ? { failWhen } : undefined),
        ...extra,
    } as never;
}

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
