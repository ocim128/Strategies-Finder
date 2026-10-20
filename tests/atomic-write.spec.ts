/**
 * Direct coverage for the shared `lib/atomic-write.ts` core.
 *
 * Five per-module copies of "stage a sibling temp file, then rename" had drifted
 * apart (one used a FIXED `<file>.tmp`, one retried 20 times, one 4, one not at
 * all). These tests pin the single policy new writers inherit:
 *  - unique temp name per write (worker threads share a pid),
 *  - Windows-only retry of EPERM/EACCES/EBUSY with bounded backoff,
 *  - immediate failure for anything else, on any other platform,
 *  - the failed write always removes its own temp file and rethrows the original
 *    error.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import {
    atomicTempPath,
    atomicWriteJson,
    atomicWriteJsonSync,
    atomicWriteTextSync,
    isRetryableReplaceError,
    replaceFileWithRetrySync,
    resolveReplaceAttempts,
} from "../lib/atomic-write";

const scratchDirs: string[] = [];

function makeScratchDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "atomic-write-spec-"));
    scratchDirs.push(dir);
    return dir;
}

function listTempFiles(dir: string): string[] {
    return readdirSync(dir).filter((name) => name.endsWith(".tmp"));
}

after(() => {
    for (const dir of scratchDirs) {
        try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
    }
});

describe("atomic-write temp names", () => {
    it("is unique per write, not per process", () => {
        let nonce = 0;
        const random = () => {
            nonce += 1;
            return nonce / 1000;
        };
        const first = atomicTempPath("C:/data/out.json", { now: () => 1, random });
        const second = atomicTempPath("C:/data/out.json", { now: () => 1, random });

        assert.notEqual(first, second, "concurrent writers must never share a staged file");
        assert.match(first, new RegExp(`out\\.json\\.${process.pid}\\.`));
        assert.ok(first.endsWith(".tmp"));
    });

    it("stages in the destination directory so rename stays a same-volume replace", () => {
        const path = atomicTempPath("/data/nested/out.json");
        assert.equal(path.startsWith("/data/nested/out.json."), true);
    });
});

describe("replaceFileWithRetrySync policy", () => {
    it("retries only transient Windows lock errors and reports each backoff", () => {
        const waits: number[] = [];
        let calls = 0;
        replaceFileWithRetrySync("a.tmp", "a", {
            platform: "win32",
            renameSync: () => {
                calls += 1;
                if (calls < 3) throw Object.assign(new Error("locked"), { code: calls === 1 ? "EPERM" : "EBUSY" });
            },
            wait: (delayMs) => waits.push(delayMs),
        });

        assert.equal(calls, 3);
        assert.deepEqual(waits, [25, 50]);
    });

    it("gives up after the configured attempts and surfaces the last error", () => {
        let calls = 0;
        assert.throws(
            () => replaceFileWithRetrySync("a.tmp", "a", {
                platform: "win32",
                attempts: 3,
                renameSync: () => {
                    calls += 1;
                    throw Object.assign(new Error("persistently locked"), { code: "EPERM" });
                },
                wait: () => undefined,
            }),
            /persistently locked/,
        );
        assert.equal(calls, 3);
    });

    it("does not retry on non-Windows platforms", () => {
        let calls = 0;
        assert.throws(
            () => replaceFileWithRetrySync("a.tmp", "a", {
                platform: "linux",
                attempts: 10,
                renameSync: () => {
                    calls += 1;
                    throw Object.assign(new Error("no such file"), { code: "ENOENT" });
                },
                wait: () => undefined,
            }),
            /no such file/,
        );
        assert.equal(calls, 1, "POSIX rename failures are real failures, not lock contention");
    });

    it("does not retry a non-transient Windows error", () => {
        let calls = 0;
        assert.throws(
            () => replaceFileWithRetrySync("a.tmp", "a", {
                platform: "win32",
                renameSync: () => {
                    calls += 1;
                    throw Object.assign(new Error("cross-device"), { code: "EXDEV" });
                },
                wait: () => undefined,
            }),
            /cross-device/,
        );
        assert.equal(calls, 1);
    });

    it("treats a successful fallback as success", () => {
        let fallbackError: unknown = null;
        replaceFileWithRetrySync("a.tmp", "a", {
            platform: "win32",
            attempts: 1,
            renameSync: () => { throw Object.assign(new Error("locked"), { code: "EACCES" }); },
            fallback: (_source, _target, error) => {
                fallbackError = error;
                return true;
            },
        });
        assert.equal((fallbackError as NodeJS.ErrnoException).code, "EACCES");
    });

    it("classifies retryable codes and resolves attempts per platform", () => {
        for (const code of ["EPERM", "EACCES", "EBUSY"]) {
            assert.equal(isRetryableReplaceError({ code }), true, code);
        }
        for (const code of ["ENOENT", "EXDEV", "EISDIR"]) {
            assert.equal(isRetryableReplaceError({ code }), false, code);
        }
        assert.equal(resolveReplaceAttempts("win32", undefined), 10);
        assert.equal(resolveReplaceAttempts("win32", 20), 20);
        assert.equal(resolveReplaceAttempts("win32", 0), 10, "invalid overrides fall back to the default");
        assert.equal(resolveReplaceAttempts("linux", 20), 1);
    });
});

describe("atomic writes", () => {
    it("replaces the target and leaves no staged temp file behind", () => {
        const dir = makeScratchDir();
        const target = join(dir, "nested", "payload.json");

        atomicWriteJsonSync(target, { ok: true, value: 1 });
        atomicWriteJsonSync(target, { ok: true, value: 2 });

        assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { ok: true, value: 2 });
        assert.deepEqual(listTempFiles(join(dir, "nested")), []);
    });

    it("creates missing parent directories", () => {
        const dir = makeScratchDir();
        const target = join(dir, "a", "b", "c", "data.txt");
        atomicWriteTextSync(target, "hello\n");
        assert.equal(readFileSync(target, "utf8"), "hello\n");
    });

    it("removes its own temp file and rethrows the original error when the rename never succeeds", () => {
        const dir = makeScratchDir();
        const target = join(dir, "locked.json");
        writeFileSync(target, "previous", "utf8");

        assert.throws(
            () => atomicWriteJsonSync(target, { ok: false }, {
                platform: "win32",
                attempts: 2,
                renameSync: () => { throw Object.assign(new Error("destination locked"), { code: "EPERM" }); },
                wait: () => undefined,
            }),
            /destination locked/,
        );

        assert.equal(readFileSync(target, "utf8"), "previous", "a failed write must not touch the target");
        assert.deepEqual(listTempFiles(dir), [], "the staged temp file must not survive a failed write");
    });

    it("writes the same payload through the async twin", async () => {
        const dir = makeScratchDir();
        const target = join(dir, "async.json");
        await atomicWriteJson(target, { mode: "async" });
        assert.deepEqual(JSON.parse(readFileSync(target, "utf8")), { mode: "async" });
        assert.deepEqual(listTempFiles(dir), []);
    });
});
