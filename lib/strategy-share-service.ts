import type { StrategyConfig } from "./settings-manager";

const SHARE_QUERY_PARAM = "strategyShare";
const SHARE_VERSION = 1;

interface StrategyShareEnvelope {
    v: number;
    id: string;
    issuedAt: string;
    config: StrategyConfig;
    sig: string;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStrategyConfig(value: unknown): value is StrategyConfig {
    if (!isPlainObject(value)) return false;
    if (typeof value.name !== "string") return false;
    if (typeof value.strategyKey !== "string") return false;
    if (!isPlainObject(value.strategyParams)) return false;
    if (!isPlainObject(value.backtestSettings)) return false;
    if (typeof value.createdAt !== "string") return false;
    if (typeof value.updatedAt !== "string") return false;
    return true;
}

function toBase64Url(value: string): string {
    const bytes = new TextEncoder().encode(value);
    let binary = "";
    bytes.forEach((b) => {
        binary += String.fromCharCode(b);
    });

    return btoa(binary)
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/g, "");
}

function fromBase64Url(encoded: string): string | null {
    if (!encoded) return null;
    const normalized = encoded.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");

    try {
        const binary = atob(padded);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) {
            bytes[i] = binary.charCodeAt(i);
        }
        return new TextDecoder().decode(bytes);
    } catch {
        return null;
    }
}

function toStableJson(value: unknown): string {
    return JSON.stringify(value);
}

function computeSignature(payload: string): string {
    // FNV-1a (32-bit), used only as lightweight tamper check.
    let hash = 0x811c9dc5;
    for (let i = 0; i < payload.length; i++) {
        hash ^= payload.charCodeAt(i);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(36);
}

function randomId(length: number): string {
    const chars = "abcdefghijklmnopqrstuvwxyz0123456789";
    const buf = new Uint8Array(length);
    crypto.getRandomValues(buf);
    let out = "";
    for (let i = 0; i < buf.length; i++) {
        out += chars[buf[i] % chars.length];
    }
    return out;
}

function parseEnvelope(value: unknown): StrategyShareEnvelope | null {
    if (!isPlainObject(value)) return null;
    if (value.v !== SHARE_VERSION) return null;
    if (typeof value.id !== "string" || !value.id) return null;
    if (typeof value.issuedAt !== "string" || !value.issuedAt) return null;
    if (typeof value.sig !== "string" || !value.sig) return null;
    if (!isStrategyConfig(value.config)) return null;

    const signingPayload = toStableJson({
        v: value.v,
        id: value.id,
        issuedAt: value.issuedAt,
        config: value.config,
    });
    const expectedSig = computeSignature(signingPayload);
    if (expectedSig !== value.sig) return null;

    return {
        v: value.v,
        id: value.id,
        issuedAt: value.issuedAt,
        config: value.config,
        sig: value.sig,
    };
}

function parseToken(token: string): StrategyConfig | null {
    const json = fromBase64Url(token);
    if (!json) return null;

    try {
        const parsed = JSON.parse(json) as unknown;
        const envelope = parseEnvelope(parsed);
        return envelope?.config ?? null;
    } catch {
        return null;
    }
}

export function createStrategyShareLink(config: StrategyConfig, sourceUrl?: string): string {
    const payload = {
        v: SHARE_VERSION,
        id: randomId(12),
        issuedAt: new Date().toISOString(),
        config,
    };

    const envelope: StrategyShareEnvelope = {
        ...payload,
        sig: computeSignature(toStableJson(payload)),
    };

    const token = toBase64Url(toStableJson(envelope));
    const url = new URL(sourceUrl ?? window.location.href);
    url.searchParams.set(SHARE_QUERY_PARAM, token);
    return url.toString();
}

export function parseStrategyConfigFromSharedInput(input: string): StrategyConfig | null {
    const trimmed = input.trim();
    if (!trimmed) return null;

    try {
        const asUrl = new URL(trimmed);
        const token = asUrl.searchParams.get(SHARE_QUERY_PARAM);
        return token ? parseToken(token) : null;
    } catch {
        return parseToken(trimmed);
    }
}

export function parseStrategyConfigFromCurrentUrl(): StrategyConfig | null {
    const url = new URL(window.location.href);
    const token = url.searchParams.get(SHARE_QUERY_PARAM);
    if (!token) return null;
    return parseToken(token);
}

export function clearSharedConfigParamFromUrl(): void {
    const url = new URL(window.location.href);
    if (!url.searchParams.has(SHARE_QUERY_PARAM)) return;
    url.searchParams.delete(SHARE_QUERY_PARAM);
    window.history.replaceState({}, document.title, url.toString());
}
