export function parseIsoSec(value: unknown): number | null {
    if (typeof value !== "string") return null;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

export function parseStringArray(value: unknown): string[] {
    if (Array.isArray(value)) return value.map((item) => String(item ?? "").trim()).filter(Boolean);
    if (typeof value !== "string") return [];
    const trimmed = value.trim();
    if (!trimmed) return [];
    try {
        const parsed = JSON.parse(trimmed);
        return Array.isArray(parsed)
            ? parsed.map((item) => String(item ?? "").trim()).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

export function clamp01(value: number): number {
    return Math.max(0, Math.min(1, value));
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJsonWithRetry<T>(url: string, retries = 4): Promise<T> {
    let lastErr: unknown = null;
    for (let attempt = 0; attempt <= retries; attempt++) {
        try {
            const res = await fetch(url, { headers: { Accept: "application/json" } });
            if (!res.ok) {
                const body = await res.text().catch(() => "");
                const err = new Error(`HTTP ${res.status}: ${body.slice(0, 240)}`);
                const retryable = res.status === 429 || res.status >= 500;
                if (!retryable || attempt === retries) throw err;
                await sleep((attempt + 1) * 250);
                continue;
            }
            return await res.json() as T;
        } catch (error) {
            lastErr = error;
            if (attempt === retries) break;
            await sleep((attempt + 1) * 250);
        }
    }
    throw lastErr ?? new Error("Unknown fetch failure");
}

export function mean(values: readonly number[]): number {
    if (values.length === 0) return 0;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export function std(values: readonly number[]): number {
    if (values.length < 2) return 0;
    const average = mean(values);
    const variance = values.reduce((sum, value) => sum + (value - average) * (value - average), 0) / (values.length - 1);
    return Math.sqrt(Math.max(0, variance));
}

export function correlation(a: readonly number[], b: readonly number[]): number {
    if (a.length !== b.length || a.length < 2) return 0;
    const ma = mean(a);
    const mb = mean(b);
    let num = 0;
    let va = 0;
    let vb = 0;
    for (let i = 0; i < a.length; i++) {
        const da = a[i] - ma;
        const db = b[i] - mb;
        num += da * db;
        va += da * da;
        vb += db * db;
    }
    if (va <= 0 || vb <= 0) return 0;
    return num / Math.sqrt(va * vb);
}
