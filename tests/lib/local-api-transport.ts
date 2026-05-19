interface AvailabilityRecord {
    available: boolean | null;
    checkedAt: number;
    promise: Promise<boolean> | null;
}

interface CheckAvailabilityOptions {
    key: string;
    statusUrl: string;
    force?: boolean;
    cacheMs: number;
    timeoutMs: number;
}

const availabilityByKey = new Map<string, AvailabilityRecord>();

function getRecord(key: string): AvailabilityRecord {
    let record = availabilityByKey.get(key);
    if (!record) {
        record = { available: null, checkedAt: 0, promise: null };
        availabilityByKey.set(key, record);
    }
    return record;
}

function createTimeoutSignal(sourceSignal: AbortSignal | undefined, timeoutMs: number): {
    signal: AbortSignal | undefined;
    cleanup: () => void;
} {
    if (typeof AbortController === "undefined" || typeof setTimeout === "undefined") {
        return { signal: sourceSignal, cleanup: () => undefined };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    const abortFromSource = () => controller.abort();
    if (sourceSignal) {
        if (sourceSignal.aborted) {
            abortFromSource();
        } else {
            sourceSignal.addEventListener("abort", abortFromSource, { once: true });
        }
    }

    return {
        signal: controller.signal,
        cleanup: () => {
            clearTimeout(timer);
            sourceSignal?.removeEventListener("abort", abortFromSource);
        },
    };
}

export function isAbortLikeError(error: unknown): boolean {
    return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

export async function fetchLocalApi(input: string, init: RequestInit = {}, timeoutMs: number): Promise<Response> {
    const timeout = createTimeoutSignal(init.signal ?? undefined, timeoutMs);
    try {
        return await fetch(input, { ...init, signal: timeout.signal });
    } finally {
        timeout.cleanup();
    }
}

export async function checkLocalApiAvailable(options: CheckAvailabilityOptions): Promise<boolean> {
    const record = getRecord(options.key);
    const now = Date.now();
    const cacheIsFresh = record.available !== null && now - record.checkedAt < options.cacheMs;
    if (cacheIsFresh && (!options.force || record.available === true)) {
        return record.available === true;
    }

    if (record.promise) {
        return await record.promise;
    }

    const availabilityCheck = (async () => {
        try {
            const response = await fetchLocalApi(options.statusUrl, { method: "GET" }, options.timeoutMs);
            record.available = response.ok;
        } catch {
            record.available = false;
        }
        record.checkedAt = Date.now();
        return record.available === true;
    })();

    record.promise = availabilityCheck;
    try {
        return await availabilityCheck;
    } finally {
        if (record.promise === availabilityCheck) {
            record.promise = null;
        }
    }
}

export function markLocalApiUnavailable(key: string): void {
    const record = getRecord(key);
    record.available = false;
    record.checkedAt = Date.now();
}

export function resetLocalApiAvailability(key?: string): void {
    if (key) {
        availabilityByKey.delete(key);
        return;
    }
    availabilityByKey.clear();
}
