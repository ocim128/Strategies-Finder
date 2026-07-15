import { afterEach, describe, it } from "node:test";
import { expect } from "chai";
import { isAllowedLocalRequest } from "../lib/local-route-authorization";

/**
 * Audit Finding: Execution Lab control-plane authorization (and the same gate
 * the IBKR / Batch / strategy-admin / crypto routes reuse).
 *
 * Intent being locked (AGENTS.md rule 8):
 *
 *   - A tokenless caller is trusted ONLY when ALL of:
 *       1. the peer socket address is loopback (cannot be spoofed);
 *       2. the `Host` header is loopback; AND
 *       3. any supplied `Origin`/`Referer` is loopback (or absent).
 *   - Any other caller MUST present the configured `LOCAL_PROXY_TOKEN`
 *     bearer — the same secret the Cloudflare Tunnel candle-proxy workflow
 *     already uses.
 *
 * This closes the previous bypass where a remotely reachable Vite server
 * (`--host` / tunnel / reverse proxy) accepted unauthenticated mutations
 * whenever the attacker supplied a loopback-looking Origin/Referer header.
 */
describe("isAllowedLocalRequest", () => {
    const ORIGINAL_TOKEN = process.env.LOCAL_PROXY_TOKEN;

    afterEach(() => {
        if (ORIGINAL_TOKEN === undefined) {
            delete process.env.LOCAL_PROXY_TOKEN;
        } else {
            process.env.LOCAL_PROXY_TOKEN = ORIGINAL_TOKEN;
        }
    });

    it("allows a tokenless caller only when peer socket + Host + Origin are all loopback", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
        })).to.equal(true);
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "::1" },
            headers: { host: "[::1]:5173", origin: "http://[::1]:5173" },
        })).to.equal(true);
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "127.1.2.3" },
            headers: { host: "localhost:5173", referer: "http://localhost:5173/" },
        })).to.equal(true);
    });

    it("allows a tokenless loopback caller when Origin/Referer are absent (privacy-stripped)", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173" },
        })).to.equal(true);
    });

    it("allows a loopback same-origin browser GET via sec-fetch-site + loopback socket + loopback Host", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173", "sec-fetch-site": "same-origin" },
        })).to.equal(true);
    });

    it("handles IPv4-mapped IPv6 loopback and Node scope suffixes on socket.remoteAddress", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "::ffff:127.0.0.1" },
            headers: { host: "127.0.0.1:5173" },
        })).to.equal(true);
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "::1%eth0" },
            headers: { host: "[::1]:5173" },
        })).to.equal(true);
    });

    // ----- THE BYPASS THE OLD GATE HAD -----
    it("rejects a spoofed loopback Origin from a NON-loopback socket (the P1 bypass)", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        // Attacker on 192.0.2.10 forges Origin: http://127.0.0.1:5173. The
        // peer address is the only unforgeable signal — gate must reject.
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "192.0.2.10" },
            headers: { host: "192.0.2.10:5173", origin: "http://127.0.0.1:5173" },
        })).to.equal(false);
        // Same attack with a loopback Host header but a remote socket.
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "192.0.2.10" },
            headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" },
        })).to.equal(false);
    });

    it("rejects when the Host is non-loopback even from a loopback socket (tunnel/reverse-proxy)", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            // A loopback socket but the Host header names a tunnel host.
            headers: { host: "tunnel.example.test:5173", origin: "http://127.0.0.1:5173" },
        })).to.equal(false);
    });

    it("rejects a cross-origin caller from a loopback socket (CSRF defense)", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173", origin: "https://evil.test" },
        })).to.equal(false);
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173", referer: "https://evil.test/csrf" },
        })).to.equal(false);
    });

    it("rejects a request with no socket info when no token is configured", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        // Without socket info the peer cannot be proven loopback, so the
        // tokenless path MUST fail. Real Node HTTP requests always have
        // socket.remoteAddress; absence indicates a test/stub context.
        expect(isAllowedLocalRequest({ headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1:5173" } })).to.equal(false);
        expect(isAllowedLocalRequest({ headers: {} })).to.equal(false);
        expect(isAllowedLocalRequest({})).to.equal(false);
    });

    it("rejects a non-loopback host even if it looks local-ish", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "127.0.0.1" },
            headers: { host: "127.0.0.1:5173", origin: "http://127.0.0.1.evil.test" },
        })).to.equal(false);
    });

    it("allows a non-local caller presenting the configured LOCAL_PROXY_TOKEN bearer", () => {
        process.env.LOCAL_PROXY_TOKEN = "secret-value";
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "192.0.2.10" },
            headers: { host: "tunnel.example.test:5173", origin: "https://evil.test", authorization: "Bearer secret-value" },
        })).to.equal(true);
    });

    it("rejects a non-local caller with the wrong bearer or a bare token", () => {
        process.env.LOCAL_PROXY_TOKEN = "secret-value";
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "192.0.2.10" },
            headers: { host: "tunnel.example.test:5173", authorization: "Bearer wrong" },
        })).to.equal(false);
        // A bare token without the `Bearer ` scheme prefix must not be accepted.
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "192.0.2.10" },
            headers: { host: "tunnel.example.test:5173", authorization: "secret-value" },
        })).to.equal(false);
    });

    it("rejects a non-local caller when no token is configured even if a bearer is sent", () => {
        delete process.env.LOCAL_PROXY_TOKEN;
        expect(isAllowedLocalRequest({
            socket: { remoteAddress: "192.0.2.10" },
            headers: { host: "tunnel.example.test:5173", authorization: "Bearer anything" },
        })).to.equal(false);
    });
});
