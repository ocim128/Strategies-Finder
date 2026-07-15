import { describe, it } from "node:test";
import { expect } from "chai";
import { loadSecondMarketCandles } from "../lib/second-market/api";
import { setRuntimeLocalApiOrigin } from "../lib/local-api-transport";

describe("second-market API client", () => {
    it("refetches JSON when a binary candle response is malformed", async () => {
        const originalFetch = globalThis.fetch;
        const acceptHeaders: string[] = [];
        const signals: unknown[] = [];

        globalThis.fetch = (async (_input, init) => {
            const headers = init?.headers as Record<string, string> | undefined;
            acceptHeaders.push(String(headers?.Accept ?? ""));
            signals.push(init?.signal);
            if (acceptHeaders.length === 1) {
                return new Response(new ArrayBuffer(4), {
                    status: 200,
                    headers: { "content-type": "application/octet-stream" },
                });
            }
            return new Response(JSON.stringify({
                ok: true,
                candles: [{
                    ts: 1_700_000_000,
                    open: 100,
                    high: 101,
                    low: 99,
                    close: 100.5,
                    volume: 12,
                }],
            }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        try {
            const candles = await loadSecondMarketCandles({ symbol: "BTCUSDT", limit: 1 });

            expect(candles).to.deep.equal([{
                time: 1_700_000_000,
                open: 100,
                high: 101,
                low: 99,
                close: 100.5,
                volume: 12,
            }]);
            expect(acceptHeaders).to.deep.equal(["application/octet-stream", "application/json"]);
            expect(signals.every((signal) => signal instanceof AbortSignal)).to.equal(true);
        } finally {
            globalThis.fetch = originalFetch;
        }
    });

    // Audit Finding (Host SSRF / non-default Vite port): the previous
    // getBaseUrl(undefined) returned "http://localhost:5173" — an absolute URL
    // that bypassed resolveLocalApiUrl and ignored both the bound socket and
    // VITE_DEV_SERVER_ORIGIN. Verify the URL passed to fetch is now resolved
    // against the runtime origin recorded from the bound server socket.
    it("targets the recorded loopback origin instead of a hardcoded localhost:5173", async () => {
        const originalFetch = globalThis.fetch;
        const capturedUrls: string[] = [];

        globalThis.fetch = (async (input) => {
            capturedUrls.push(typeof input === "string" ? input : input.toString());
            return new Response(JSON.stringify({
                ok: true,
                candles: [],
            }), {
                status: 200,
                headers: { "content-type": "application/json" },
            });
        }) as typeof fetch;

        const previousOrigin = "http://127.0.0.1:61234";
        setRuntimeLocalApiOrigin(previousOrigin);
        try {
            await loadSecondMarketCandles({ symbol: "BTCUSDT", limit: 1 });

            expect(capturedUrls.length).to.equal(1);
            // Must target the recorded origin on port 61234, never localhost:5173.
            expect(capturedUrls[0]).to.include("127.0.0.1:61234");
            expect(capturedUrls[0]).to.not.include("localhost:5173");
            expect(capturedUrls[0]).to.include("/api/second-market/candles");
        } finally {
            globalThis.fetch = originalFetch;
            setRuntimeLocalApiOrigin(null);
        }
    });
});
