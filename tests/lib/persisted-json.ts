type PersistedJsonEnvelope = {
    schema: string;
    version: number;
    data: unknown;
};

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
        localStorage.setItem(key, JSON.stringify(payload));
        return true;
    } catch (error) {
        onError?.(error);
        return false;
    }
}
