/**
 * Signal Committee UI preferences. Persisted to localStorage via the shared
 * persisted-json envelope (schema + version + data) so future shape changes
 * can be migrated cleanly. Member identity lives in D1, not here — these are
 * pure UI prefs (refresh interval, auto toggle state).
 */
import { readPersistedJson, writePersistedJson } from "./persisted-json";

const PREFS_KEY = "signal_committee_prefs";
const PREFS_SCHEMA = "signal_committee_prefs";
const PREFS_VERSION = 1;

/** Floor for the auto-refresh interval. The cron runs per minute, so polling
 *  faster than this only re-reads the same cached state. */
export const MIN_REFRESH_INTERVAL_SEC = 10;
export const DEFAULT_REFRESH_INTERVAL_SEC = 30;
export const MAX_REFRESH_INTERVAL_SEC = 600;

export interface SignalCommitteePrefs {
    autoRefresh: boolean;
    intervalSec: number;
}

const DEFAULT_PREFS: SignalCommitteePrefs = {
    autoRefresh: false,
    intervalSec: DEFAULT_REFRESH_INTERVAL_SEC,
};

function clampInterval(value: unknown): number {
    const n = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_REFRESH_INTERVAL_SEC;
    return Math.min(MAX_REFRESH_INTERVAL_SEC, Math.max(MIN_REFRESH_INTERVAL_SEC, Math.round(n)));
}

export function readSignalCommitteePrefs(): SignalCommitteePrefs {
    return readPersistedJson<SignalCommitteePrefs>({
        key: PREFS_KEY,
        schema: PREFS_SCHEMA,
        version: PREFS_VERSION,
        fallback: DEFAULT_PREFS,
        migrate: (ctx) => {
            if (!ctx.data || typeof ctx.data !== "object") return null;
            const data = ctx.data as Partial<SignalCommitteePrefs>;
            return {
                autoRefresh: Boolean(data.autoRefresh),
                intervalSec: clampInterval(data.intervalSec),
            };
        },
    });
}

export function writeSignalCommitteePrefs(prefs: SignalCommitteePrefs): boolean {
    return writePersistedJson({
        key: PREFS_KEY,
        schema: PREFS_SCHEMA,
        version: PREFS_VERSION,
        data: {
            autoRefresh: Boolean(prefs.autoRefresh),
            intervalSec: clampInterval(prefs.intervalSec),
        },
    });
}
