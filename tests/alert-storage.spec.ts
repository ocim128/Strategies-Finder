import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { readAlertWorkerToken, writeAlertWorkerToken } from "../lib/alert-storage";

class MemoryStorage {
    private readonly values = new Map<string, string>();

    get length(): number {
        return this.values.size;
    }

    clear(): void {
        this.values.clear();
    }

    getItem(key: string): string | null {
        return this.values.get(key) ?? null;
    }

    key(index: number): string | null {
        return Array.from(this.values.keys())[index] ?? null;
    }

    removeItem(key: string): void {
        this.values.delete(key);
    }

    setItem(key: string, value: string): void {
        this.values.set(key, value);
    }
}

class ThrowingRemoveStorage extends MemoryStorage {
    removeItem(): void {
        throw new Error("remove failed");
    }
}

class ThrowingGetStorage extends MemoryStorage {
    getItem(): string | null {
        throw new Error("get failed");
    }
}

const TOKEN_KEY = "alert_worker_token";
const originalLocalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
const originalSessionStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");

function installStorage(name: "localStorage" | "sessionStorage", storage: MemoryStorage): void {
    Object.defineProperty(globalThis, name, {
        value: storage,
        configurable: true,
    });
}

afterEach(() => {
    if (originalLocalStorage) {
        Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
    } else {
        delete (globalThis as { localStorage?: unknown }).localStorage;
    }
    if (originalSessionStorage) {
        Object.defineProperty(globalThis, "sessionStorage", originalSessionStorage);
    } else {
        delete (globalThis as { sessionStorage?: unknown }).sessionStorage;
    }
});

describe("alert worker token storage", () => {
    it("stores tokens in session storage and removes durable copies", () => {
        const local = new MemoryStorage();
        const session = new MemoryStorage();
        local.setItem(TOKEN_KEY, "old-token");
        installStorage("localStorage", local);
        installStorage("sessionStorage", session);

        assert.equal(writeAlertWorkerToken("  new-token  "), "new-token");
        assert.equal(session.getItem(TOKEN_KEY), "new-token");
        assert.equal(local.getItem(TOKEN_KEY), null);
    });

    it("migrates a legacy localStorage token into session storage on read", () => {
        const local = new MemoryStorage();
        const session = new MemoryStorage();
        local.setItem(TOKEN_KEY, "legacy-token");
        installStorage("localStorage", local);
        installStorage("sessionStorage", session);

        assert.equal(readAlertWorkerToken(), "legacy-token");
        assert.equal(session.getItem(TOKEN_KEY), "legacy-token");
        assert.equal(local.getItem(TOKEN_KEY), null);
    });

    it("still removes a legacy durable token when session storage read fails", () => {
        const local = new MemoryStorage();
        const session = new ThrowingGetStorage();
        local.setItem(TOKEN_KEY, "legacy-token");
        installStorage("localStorage", local);
        installStorage("sessionStorage", session);

        assert.equal(readAlertWorkerToken(), "legacy-token");
        assert.equal(local.getItem(TOKEN_KEY), null);
    });

    it("clears token values from both storage scopes", () => {
        const local = new MemoryStorage();
        const session = new MemoryStorage();
        local.setItem(TOKEN_KEY, "old-token");
        session.setItem(TOKEN_KEY, "new-token");
        installStorage("localStorage", local);
        installStorage("sessionStorage", session);

        assert.equal(writeAlertWorkerToken(""), "");
        assert.equal(session.getItem(TOKEN_KEY), null);
        assert.equal(local.getItem(TOKEN_KEY), null);
    });

    it("does not let legacy localStorage cleanup failure block session writes", () => {
        const local = new ThrowingRemoveStorage();
        const session = new MemoryStorage();
        installStorage("localStorage", local);
        installStorage("sessionStorage", session);

        assert.equal(writeAlertWorkerToken("new-token"), "new-token");
        assert.equal(session.getItem(TOKEN_KEY), "new-token");
    });
});
