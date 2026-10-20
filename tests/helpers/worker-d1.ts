/**
 * Shared harness for specs that drive `workers/entry-signal-worker.ts` against a
 * REAL SQLite schema (migrations applied) instead of a hand-rolled D1 fake.
 *
 * A hand-rolled fake only proves the worker's SQL matches the fake. Applying
 * `workers/migrations/*.sql` proves it matches the schema that actually ships —
 * which is what catches a `SELECT` naming a column a later migration added or
 * renamed (e.g. 0004 renaming `last_processed_closed_candle_time`, 0006 adding
 * `committee_tag` / `latest_state_json`).
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

export const WORKER_MIGRATION_FILES = [
    "0001_entry_signals.sql",
    "0002_signal_subscriptions.sql",
    "0003_exit_alerts.sql",
    "0004_rename_candle_time_col.sql",
    "0005_actionable_entry_signal_index.sql",
    "0006_alert_state_schema.sql",
];

export const WORKER_MIGRATIONS_DIR = path.resolve(__dirname, "../../workers/migrations");

/** Apply the first `count` migrations (optionally starting at `from`). */
export function applyWorkerMigrations(db: DatabaseSync, count: number, from = 0): void {
    for (const file of WORKER_MIGRATION_FILES.slice(from, count)) {
        db.exec(fs.readFileSync(path.join(WORKER_MIGRATIONS_DIR, file), "utf8"));
    }
}

type D1Result<T> = { results?: T[]; success?: boolean };

/**
 * Minimal D1 statement adapter over `node:sqlite` covering the worker's usage:
 * `prepare().bind(...).run()/.first<T>()/.all<T>()` plus unbound variants.
 */
export function createSignalsDb(db: DatabaseSync, options?: { failWhen?(sql: string): boolean }) {
    const normalizeArgs = (args: unknown[]): SQLInputValue[] => args.map((value) => {
        if (typeof value === "boolean") return value ? 1 : 0;
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

/** Build the minimal `Env` the worker needs for a DB-only pass. */
export function makeWorkerEnv(
    db: DatabaseSync,
    extra?: Record<string, unknown>,
    failWhen?: (sql: string) => boolean,
) {
    return {
        SIGNALS_DB: createSignalsDb(db, failWhen ? { failWhen } : undefined),
        ...extra,
    } as never;
}

/**
 * A `ScheduledController` a minute in the past: the handler's alignment target
 * (second 10 of the scheduled minute) is already behind us, so
 * `computeScheduleAlignmentDelayMs` returns 0 and the cron never sleeps.
 */
export function makeScheduledController(): never {
    return { scheduledTime: Date.now() - 60_000 } as never;
}
