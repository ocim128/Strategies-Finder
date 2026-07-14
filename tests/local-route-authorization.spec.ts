import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import { isAllowedLocalRequest } from "../lib/local-route-authorization";

/**
 * Audit Finding 2: `isAllowedLocalRequest` is the shared loopback/bearer gate
 * the Crypto and Batch control routes now reuse (mirroring the established IBKR
 * / strategy-admin idiom). The intent being locked (AGENTS.md rule 8):
 *
 *   - A same-origin browser caller on a loopback host is trusted with no token
 *     (so the existing dev-server UX is unchanged).
 *   - Any other caller MUST present the configured `LOCAL_PROXY_TOKEN`
 *     bearer — the same secret the Cloudflare Tunnel candle-proxy workflow
 *     already uses — so a Vite server exposed via `--host` / tunnel / reverse
 *     proxy cannot be driven to download data or burn CPU remotely.
 *
 * Direct gate-function tests mirror `isAllowedIbkrCaller` /
 * `isAllowedStrategyAdminCaller` coverage. No live Vite server required.
 */
describe("isAllowedLocalRequest (audit Finding 2)", () => {
    const ORIGINAL_TOKEN = process.env.LOCAL_PROXY_TOKEN;

    afterEach(() => {
        if (ORIGINAL_TOKEN === undefined) {
            delete process.env.LOCAL_PROXY_TOKEN;
        } else {
            process.env.LOCAL_PROXY_TOKEN = ORIGINAL_TOKEN;
        }
    });

    it("allows same-origin localhost and 127.0.0.1 Origin/Referer without a token", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({ headers: { origin: "http://localhost:5173" } })).to.equal(true);
        expect(isAllowedLocalRequest({ headers: { origin: "http://127.0.0.1:5173" } })).to.equal(true);
        expect(isAllowedLocalRequest({ headers: { referer: "http://localhost:5173/" } })).to.equal(true);
        expect(isAllowedLocalRequest({ headers: { referer: "http://127.0.0.1:5173/" } })).to.equal(true);
    });

    it("allows bracketed IPv6 loopback origin", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({ headers: { origin: "http://[::1]:5173" } })).to.equal(true);
    });

    it("allows a loopback same-origin browser GET when privacy settings strip Origin/Referer", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            headers: { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin" },
        })).to.equal(true);
        expect(isAllowedLocalRequest({
            headers: { host: "localhost:5173", "sec-fetch-site": "same-origin" },
        })).to.equal(true);
    });

    it("allows other 127.0.0.0/8 loopback addresses", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({ headers: { origin: "http://127.1.2.3:5173" } })).to.equal(true);
    });

    it("rejects a cross-origin caller with no token (the CSRF / remote-abuse vector)", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({ headers: { origin: "https://evil.test" } })).to.equal(false);
        expect(isAllowedLocalRequest({ headers: { referer: "https://evil.test/csrf" } })).to.equal(false);
    });

    it("rejects a request with no Origin/Referer when no token is configured", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({ headers: {} })).to.equal(false);
        expect(isAllowedLocalRequest({})).to.equal(false);
    });

    it("rejects a non-loopback host even if it looks local-ish", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        // A public host must NOT be trusted regardless of port.
        expect(isAllowedLocalRequest({ headers: { origin: "http://example.test:5173" } })).to.equal(false);
        // 127.0.0.1 embedded as a substring of another host is not loopback.
        expect(isAllowedLocalRequest({ headers: { origin: "http://127.0.0.1.evil.test" } })).to.equal(false);
        expect(isAllowedLocalRequest({
            headers: { host: "example.test:5173", "sec-fetch-site": "same-origin" },
        })).to.equal(false);
    });

    it("allows a non-local caller presenting the configured LOCAL_PROXY_TOKEN bearer", () => {
        process.env.LOCAL_PROXY_TOKEN = "secret-value";
        expect(isAllowedLocalRequest({
            headers: { origin: "https://evil.test", authorization: "Bearer secret-value" },
        })).to.equal(true);
    });

    it("rejects a non-local caller with the wrong bearer", () => {
        process.env.LOCAL_PROXY_TOKEN = "secret-value";
        expect(isAllowedLocalRequest({
            headers: { origin: "https://evil.test", authorization: "Bearer wrong" },
        })).to.equal(false);
        // A bare token without the `Bearer ` scheme prefix must not be accepted.
        expect(isAllowedLocalRequest({
            headers: { origin: "https://evil.test", authorization: "secret-value" },
        })).to.equal(false);
    });

    it("rejects a non-local caller when no token is configured even if a bearer is sent", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            headers: { origin: "https://evil.test", authorization: "Bearer anything" },
        })).to.equal(false);
    });
});
