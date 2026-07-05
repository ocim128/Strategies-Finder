import { expect } from "chai";
import { describe, it, afterEach } from "node:test";
import {
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
