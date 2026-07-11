import { expect } from "chai";
import { describe, it, afterEach } from "node:test";
import {
    isLoopbackHost,
    rememberLoopbackOriginFromRequest,
    resolveLocalApiUrl,
    setRuntimeLocalApiOrigin,
} from "../lib/local-api-transport";

const ORIGINAL_ENV_ORIGIN = process.env.VITE_DEV_SERVER_ORIGIN;

function resetOriginState(): void {
    setRuntimeLocalApiOrigin(null);
    if (ORIGINAL_ENV_ORIGIN === undefined) {
        delete process.env.VITE_DEV_SERVER_ORIGIN;
    } else {
        process.env.VITE_DEV_SERVER_ORIGIN = ORIGINAL_ENV_ORIGIN;
    }
}

afterEach(() => {
    resetOriginState();
});

describe("local API transport URL resolution", () => {
    it("uses the runtime Vite origin for relative URLs in Node", () => {
        delete process.env.VITE_DEV_SERVER_ORIGIN;
        setRuntimeLocalApiOrigin("http://127.0.0.1:5199");

        expect(resolveLocalApiUrl("/price-data/ibkr/csv/30m/UNH.csv"))
            .to.equal("http://127.0.0.1:5199/price-data/ibkr/csv/30m/UNH.csv");
    });

    it("keeps explicit VITE_DEV_SERVER_ORIGIN higher priority than runtime origin", () => {
        process.env.VITE_DEV_SERVER_ORIGIN = "http://127.0.0.1:5177";
        setRuntimeLocalApiOrigin("http://127.0.0.1:5199");

        expect(resolveLocalApiUrl("/api/sqlite/status"))
            .to.equal("http://127.0.0.1:5177/api/sqlite/status");
    });

    it("passes absolute URLs through unchanged", () => {
        delete process.env.VITE_DEV_SERVER_ORIGIN;
        setRuntimeLocalApiOrigin("http://127.0.0.1:5199");

        expect(resolveLocalApiUrl("https://example.test/api"))
            .to.equal("https://example.test/api");
    });
});

describe("isLoopbackHost", () => {
    // Audit Finding 5: the fallback used `host.split(":")[0]`, which turned
    // `[::1]:5173` into `"["` and rejected a real loopback host. These cases
    // lock the IPv6-bracket fix in both the pure helper and the
    // `rememberLoopbackOriginFromRequest` fallback path that uses it.
    it("accepts bracketed IPv6 loopback with and without a port", () => {
        expect(isLoopbackHost("[::1]:5173")).to.equal(true);
        expect(isLoopbackHost("[::1]")).to.equal(true);
    });

    it("accepts the IPv4 loopback variants and localhost", () => {
        expect(isLoopbackHost("localhost")).to.equal(true);
        expect(isLoopbackHost("localhost:5173")).to.equal(true);
        expect(isLoopbackHost("127.0.0.1")).to.equal(true);
        expect(isLoopbackHost("127.0.0.1:5173")).to.equal(true);
        expect(isLoopbackHost("127.0.0.2:4173")).to.equal(true);
        expect(isLoopbackHost("127.255.255.254:4173")).to.equal(true);
    });

    it("rejects non-loopback hosts", () => {
        expect(isLoopbackHost("192.168.1.5:5173")).to.equal(false);
        expect(isLoopbackHost("[2001:db8::1]:5173")).to.equal(false);
        expect(isLoopbackHost("example.test")).to.equal(false);
        expect(isLoopbackHost("")).to.equal(false);
        // Malformed bracket (no closing ]) must not be accepted as loopback.
        expect(isLoopbackHost("[::1")).to.equal(false);
    });
});

describe("rememberLoopbackOriginFromRequest Host-header fallback", () => {
    // Socket info is unavailable (test stub / unusual runtime) so the fallback
    // must derive the origin from a loopback Host header. Finding 5: the IPv6
    // bracket form was rejected before the fix. State reset is handled by the
    // file-level afterEach above.
    it("remembers the bracketed IPv6 origin from a loopback Host header", () => {
        delete process.env.VITE_DEV_SERVER_ORIGIN;
        setRuntimeLocalApiOrigin(null);

        rememberLoopbackOriginFromRequest({
            headers: { host: "[::1]:4173" },
            socket: null,
        });

        expect(resolveLocalApiUrl("/api/sqlite/status"))
            .to.equal("http://[::1]:4173/api/sqlite/status");
    });

    it("ignores a non-loopback Host header (no origin remembered)", () => {
        delete process.env.VITE_DEV_SERVER_ORIGIN;
        setRuntimeLocalApiOrigin(null);

        rememberLoopbackOriginFromRequest({
            headers: { host: "192.168.1.5:5173" },
            socket: null,
        });

        // Falls through to the default origin since the host is not loopback.
        expect(resolveLocalApiUrl("/api/sqlite/status"))
            .to.equal("http://127.0.0.1:5173/api/sqlite/status");
    });
});
