import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isTrustedLocalRequest, localSqlitePlugin } from "../lib/local-sqlite-vite-plugin";

const originalToken = process.env.LOCAL_PROXY_TOKEN;
afterEach(() => {
    if (originalToken === undefined) delete process.env.LOCAL_PROXY_TOKEN;
    else process.env.LOCAL_PROXY_TOKEN = originalToken;
});

describe("local sqlite vite plugin", () => {
    it("rejects requests without local origin or referer headers", () => {
        assert.equal(isTrustedLocalRequest({ headers: {} }), false);
    });

    it("allows localhost origin requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "localhost:5173", origin: "http://localhost:5173" },
        }), true);
    });

    it("allows localhost referer requests without a bearer token", () => {
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173", referer: "http://127.0.0.1:5173/chart" },
        }), true);
    });

    it("rejects forged local headers and deceptive hostnames", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        for (const origin of ["http://localhost:5173", "http://localhost.attacker.invalid:5173"]) {
            assert.equal(isTrustedLocalRequest({
                socket: { remoteAddress: "192.0.2.1" },
                headers: { host: "localhost:5173", origin },
            }), false);
        }
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "localhost:5173", origin: "http://localhost.attacker.invalid:5173" },
        }), false);
    });

    it("allows local internal calls without Origin and authenticated tunnel callers", () => {
        process.env.LOCAL_PROXY_TOKEN = "sqlite-test-token";
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "::1" }, headers: { host: "[::1]:5173" },
        }), true);
        assert.equal(isTrustedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "tunnel.example", authorization: "Bearer sqlite-test-token" },
        }), true);
    });

    it("gates both SQLite reads and writes before accessing the database", async () => {
        let handler: (req: unknown, res: unknown) => Promise<void> = async () => { throw new Error("not registered"); };
        const plugin = localSqlitePlugin();
        const configure = plugin.configureServer as (server: unknown) => void;
        configure({ middlewares: { use: (_path: string, registered: typeof handler) => { handler = registered; } } });
        for (const token of [undefined, "sqlite-test-token"]) {
            if (token === undefined) delete process.env.LOCAL_PROXY_TOKEN;
            else process.env.LOCAL_PROXY_TOKEN = token;
            for (const [method, url] of [["GET", "/load-ohlcv"], ["POST", "/store-ohlcv"]]) {
                let body = "";
                const res = { statusCode: 0, setHeader: () => {}, end: (value: string) => { body = value; } };
                await handler({ method, url, socket: { remoteAddress: "192.0.2.1" }, headers: { host: "localhost:5173", origin: "http://localhost:5173" } }, res);
                assert.equal(res.statusCode, 401);
                assert.equal(JSON.parse(body).error, "Unauthorized");
            }
        }
    });
});
