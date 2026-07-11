import { debugLogger } from "./debug-logger";

type PersistedJsonEnvelope = {
    schema: string;
    version: number;
    data: unknown;
};

/**
 * Thresholds for flagging expensive synchronous persistence. A write that
 * crosses either of these is logged at `warn` (always mirrored to console) so
 * it surfaces in production; routine writes are recorded as `event` level
 * (dev-console only) for the timing record without flooding prod logs.
 */
const PERSISTENCE_WARN_BYTES = 500 * 1024;
const PERSISTENCE_WARN_MS = 16;

type PersistedJsonDecodedValue = {
    schema: string | null;
    version: number | null;
    data: unknown;
};

export type PersistedJsonMigrationContext = PersistedJsonDecodedValue;

export interface ReadPersistedJsonOptions<T> {
    key: string;
    schema: string;
    version: number;
    fallback: T;
    migrate: (context: PersistedJsonMigrationContext) => T | null;
    onError?: (error: unknown) => void;
}

export interface WritePersistedJsonOptions<T> {
    key: string;
    schema: string;
    version: number;
    data: T;
    onError?: (error: unknown) => void;
}

function decodePersistedJsonEnvelope(value: unknown): PersistedJsonDecodedValue {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const candidate = value as Partial<PersistedJsonEnvelope>;
        if (
            typeof candidate.schema === "string"
            && typeof candidate.version === "number"
            && Object.prototype.hasOwnProperty.call(candidate, "data")
        ) {
            return {
                schema: candidate.schema,
                version: candidate.version,
                data: candidate.data,
            };
        }
    }

    return {
        schema: null,
        version: null,
        data: value,
    };
}

export function readPersistedJson<T>(options: ReadPersistedJsonOptions<T>): T {
    const {
        key,
        schema,
        fallback,
        migrate,
        onError,
    } = options;

    if (typeof localStorage === "undefined") {
        return fallback;
    }

    try {
        const raw = localStorage.getItem(key);
        if (raw === null) {
            return fallback;
        }

        const decoded = decodePersistedJsonEnvelope(JSON.parse(raw));
        if (decoded.schema !== null && decoded.schema !== schema) {
            return fallback;
        }

        return migrate(decoded) ?? fallback;
    } catch (error) {
        onError?.(error);
        return fallback;
    }
}

export function writePersistedJson<T>(options: WritePersistedJsonOptions<T>): boolean {
    const {
        key,
        schema,
        version,
        data,
        onError,
    } = options;

    if (typeof localStorage === "undefined") {
        return false;
    }

    try {
        const payload: PersistedJsonEnvelope = {
            schema,
            version,
            data,
        };
        // Instrument the two synchronous costs (JSON.stringify + localStorage
        // setItem) so slow writes are identifiable by key without speculative
        // redesign. Never logs the persisted contents — only size + timings.
        const startedAt = performance.now();
        const serialized = JSON.stringify(payload);
        const serializedAt = performance.now();
        localStorage.setItem(key, serialized);
        const writeMs = performance.now() - serializedAt;
        const stringifyMs = serializedAt - startedAt;
        const bytes = serialized.length * 2;
        if (bytes > PERSISTENCE_WARN_BYTES || stringifyMs + writeMs > PERSISTENCE_WARN_MS) {
            debugLogger.warn("persistence.write.slow", {
                key,
                bytes,
                stringifyMs: Math.round(stringifyMs * 1000) / 1000,
                writeMs: Math.round(writeMs * 1000) / 1000,
            });
        } else {
            debugLogger.event("persistence.write", {
                key,
                bytes,
                stringifyMs: Math.round(stringifyMs * 1000) / 1000,
                writeMs: Math.round(writeMs * 1000) / 1000,
            });
        }
        return true;
    } catch (error) {
        onError?.(error);
        return false;
    }
}
