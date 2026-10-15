import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import type { IncomingMessage } from "node:http";
import { registerTopRawScanRoutes, readScanStatus } from "../lib/batch-backtest/top-raw-scan-vite-routes";
import { ScanStore, type ScanManifest } from "../lib/batch-backtest/top-raw-scan-store";
import type { ViteHttpResponse } from "../lib/vite-http-utils";
import { makeBacktestSettings, makeCapitalSettings } from "./helpers/backtest-settings-fixtures";
import { TopRawScanEngine } from "../lib/batch-backtest/top-raw-scan-engine";
import type { ScanStatus } from "../lib/batch-backtest/top-raw-scan-contract";
import { withTimeout } from "./helpers/with-timeout";

describe("TOP_RAW HTTP authorization and reservation", () => {
    it("releases the correct generation before streamed or polled completion permits an immediate next scan", async () => {
        const handlers = new Map<string, (req: IncomingMessage, res: ViteHttpResponse) => void | Promise<void>>();
        let owner = 0, generation = 0, releases = 0;
        registerTopRawScanRoutes({ use: (path, handler) => handlers.set(path, handler) }, {
            maxBodyBytes: 4096, rememberLocalApiOriginFromRequest: () => {},
            ownerLocks: {
                isBusy: () => owner !== 0,
                acquire: () => { assert.equal(owner, 0); owner = ++generation; return { runOwner: owner, analysisOwner: owner }; },
                releaseIfStillOwner: token => { releases++; if (owner === token.runOwner) owner = 0; },
            },
        });
        const original = TopRawScanEngine.prototype.run;
        let finish!: () => void, started!: () => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const pending = new Promise<void>(resolve => { finish = resolve; });
        let next: Promise<{ code: number; text: string }> | undefined, running: Promise<{ code: number; text: string }> | undefined;
        let closing = false;
        const call = async (route: string, runId: string, body?: unknown) => {
            const path = "/api/batch-backtest/top-raw-scan/" + route;
            const req = Readable.from(body ? [JSON.stringify(body)] : []) as unknown as IncomingMessage;
            Object.assign(req, { method: body ? "POST" : "GET", url: `${path}?runId=${runId}`, headers: { host: "localhost:5173" }, socket: { remoteAddress: "127.0.0.1" } });
            let text = "";
            const res = Object.assign(new EventEmitter(), { statusCode: 0, setHeader() {},
                write(value: string) {
                    const event = JSON.parse(value);
                    if (event.phase === "completed") {
                        assert.equal(owner, 0, "terminal stream must follow owner release");
                        if (!closing && runId === "boundary_first" && !next) next = call("run", "boundary_next", request("boundary_next"));
                    }
                    return true;
                }, end(value?: string | Buffer) { text += value ?? ""; },
            });
            await handlers.get(path)!(req, res); return { code: res.statusCode, text };
        };
        const request = (runId: string) => ({ runId, strategyKey: "dema_confirmation", strategyParams: {}, backtestSettings: {}, capitalSettings: makeCapitalSettings(), interval: "4h", assetListText: "AAPL•\nMSFT•" });
        TopRawScanEngine.prototype.run = async function (emit, release) {
            if (this.request.runId === "boundary_first") { started(); await pending; }
            const status: ScanStatus = { ...this.getStatus(), phase: "completed", message: "complete" };
            release?.(status); emit?.(status); return status;
        };
        try {
            let finishDiskRead!: () => void;
            const diskRead = new Promise<void>(resolve => { finishDiskRead = resolve; });
            const delayedStore = new ScanStore();
            delayedStore.readManifest = async () => {
                await diskRead;
                return { status: { runId: "boundary_first", phase: "completed" }, result: { status: "completed" } } as unknown as ScanManifest;
            };
            // A saved-status read that began before admission must not publish an
            // old terminal phase after a new owner has started the same scan.
            const overlappingRestore = readScanStatus("boundary_first", delayedStore);
            running = call("run", "boundary_first", request("boundary_first"));
            await withTimeout(ready, 1000, "first route");
            finishDiskRead();
            assert.equal((await overlappingRestore)!.phase, "preflight");
            assert.equal(owner, 1);
            assert.equal(JSON.parse((await call("status", "boundary_first")).text).phase, "preflight");
            finish(); await running; assert.ok(next); await next;
            assert.equal(generation, 2); assert.equal(releases, 2); assert.equal(owner, 0);
            assert.equal(JSON.parse((await call("status", "boundary_first")).text).phase, "completed");
            // The same shared lock is immediately available to ordinary Batch.
            owner = ++generation; assert.equal(owner, 3); owner = 0;
        } finally { closing = true; finish(); await running; await next; TopRawScanEngine.prototype.run = original; }
    });
    it("gates all routes, rejects oversized uploads, shares busy ownership and closes Stop-before-run", async () => {
        const handlers = new Map<string, (req: IncomingMessage, res: ViteHttpResponse) => void | Promise<void>>();
        let busy = false, acquisitions = 0;
        registerTopRawScanRoutes({ use: (path, handler) => handlers.set(path, handler) }, {
            maxBodyBytes: 4096, rememberLocalApiOriginFromRequest: () => {},
            ownerLocks: { isBusy: () => busy, acquire: () => { acquisitions++; return { runOwner: 1, analysisOwner: 1 }; }, releaseIfStillOwner: () => {} },
        });
        const call = async (route: string, method: string, body?: unknown, remote = false) => {
            const prefix = "/api/batch-backtest/top-raw-scan/", path = prefix + route;
            const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
            Object.assign(req, { method, url: path + (method === "GET" ? "?runId=route_spec" : ""), headers: { host: "localhost:5173" }, socket: { remoteAddress: remote ? "203.0.113.2" : "127.0.0.1" } });
            let text = "", statusCode = 0;
            const res = { get statusCode() { return statusCode; }, set statusCode(value) { statusCode = value; }, setHeader() {}, end(value: string | Buffer) { text += value; } };
            await handlers.get(path)!(req, res); return { statusCode, text };
        };
        for (const route of ["run", "stop", "status", "result"]) assert.equal((await call(route, ["run", "stop"].includes(route) ? "POST" : "GET", {}, true)).statusCode, 401);
        assert.equal(acquisitions, 0);
        assert.equal((await call("run", "GET")).statusCode, 405);
        assert.equal((await call("run", "POST", { assetListText: "x".repeat(400000) })).statusCode, 413);
        const request = { runId: "route_spec", strategyKey: "dema_confirmation", strategyParams: {}, backtestSettings: makeBacktestSettings(), capitalSettings: makeCapitalSettings(), interval: "4h", assetListText: "AAPL•\nMSFT•" };
        busy = true; assert.equal((await call("run", "POST", request)).statusCode, 409); assert.equal(acquisitions, 0); busy = false;
        assert.equal((await call("stop", "POST", {})).statusCode, 400);
        assert.equal((await call("stop", "POST", { runId: "route_spec" })).statusCode, 200);
        const stopped = await call("run", "POST", request); assert.equal(stopped.statusCode, 409); assert.match(stopped.text, /before ownership/); assert.equal(acquisitions, 0);
    });
    it("retains shared ownership across disconnect, scopes Stop and releases after terminal settlement", async () => {
        const handlers = new Map<string, (req: IncomingMessage, res: ViteHttpResponse) => void | Promise<void>>();
        let busy = false, acquired = 0, released = 0, stopCalls = 0;
        const token = { runOwner: 41, analysisOwner: 43 };
        registerTopRawScanRoutes({ use: (path, handler) => handlers.set(path, handler) }, {
            maxBodyBytes: 4096, rememberLocalApiOriginFromRequest: () => {},
            ownerLocks: { isBusy: () => busy, acquire: () => { acquired++; busy = true; return token; }, releaseIfStillOwner: actual => { assert.equal(actual, token); released++; busy = false; } },
        });
        const call = async (route: string, body?: unknown) => {
            const path = "/api/batch-backtest/top-raw-scan/" + route;
            const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]) as unknown as IncomingMessage;
            Object.assign(req, { method: body === undefined ? "GET" : "POST", url: path + "?runId=route_owned", headers: { host: "localhost:5173" }, socket: { remoteAddress: "127.0.0.1" } });
            const events = new EventEmitter(); let text = "";
            const res = Object.assign(events, { statusCode: 0, setHeader() {}, write() { throw new Error("client disconnected"); }, end(value: string | Buffer) { text += value; } });
            await handlers.get(path)!(req, res); return { code: res.statusCode, text };
        };
        const original = { run: TopRawScanEngine.prototype.run, stop: TopRawScanEngine.prototype.stop };
        let started!: () => void, finish!: (value: ScanStatus) => void;
        const ready = new Promise<void>(resolve => { started = resolve; });
        const done = new Promise<ScanStatus>(resolve => { finish = resolve; });
        TopRawScanEngine.prototype.run = async function (emit) {
            assert.equal(acquired, 1, "ownership must precede asynchronous preflight");
            emit?.(this.getStatus()); started(); return done;
        };
        TopRawScanEngine.prototype.stop = function () { stopCalls++; finish({ ...this.getStatus(), phase: "interrupted", message: "stopped" }); };
        try {
            const request = { runId: "route_owned", strategyKey: "dema_confirmation", strategyParams: {}, backtestSettings: {}, capitalSettings: makeCapitalSettings(), interval: "4h", assetListText: "AAPL•\nMSFT•" };
            const running = call("run", request);
            await withTimeout(ready, 1000, "route preflight");
            assert.equal(released, 0); assert.equal(busy, true);
            assert.equal((await call("run", { ...request, runId: "other_run" })).code, 409);
            const status = await call("status"); assert.equal(JSON.parse(status.text).phase, "preflight");
            await call("stop", { runId: "wrong_run" }); assert.equal(stopCalls, 0); assert.equal(released, 0);
            await call("stop", { runId: request.runId });
            await withTimeout(running, 1000, "route teardown");
            assert.equal(stopCalls, 1); assert.equal(released, 1); assert.equal(busy, false);
        } finally { TopRawScanEngine.prototype.run = original.run; TopRawScanEngine.prototype.stop = original.stop; }
    });
});
