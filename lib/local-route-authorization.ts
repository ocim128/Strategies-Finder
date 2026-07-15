/**
 * Loopback/same-origin authorization gate for Vite dev-server mutation routes.
 *
 * Server-safe leaf: imports only {@link isLoopbackHost} from
 * `./local-api-transport` (a Node-only utility with no transitive
 * `lightweight-charts` / `chart-manager` deps), so it is safe to import from
 * any Vite plugin that `vite.config.ts` bundles.
 *
 * Established repo idiom: the IBKR plugin (`isAllowedIbkrCaller`) and the
 * strategy-library admin plugin (`isAllowedStrategyAdminCaller`) each
 * implement the same policy inline. Audit Finding 2 factored it into a single
 * leaf so the Crypto and Batch control routes can reuse the exact same gate
 * without duplicating the loopback/bearer logic a fourth time. The IBKR and
 * admin gates are intentionally left in place — they predate this leaf, their
 * call sites are stable, and a follow-up can migrate them if the duplication
 * becomes a maintenance burden.
 *
 * Policy:
 *   1. A same-origin browser caller (Origin/Referer on a loopback host) is
 *      trusted without a token.
 *   2. Any other caller must present the shared `LOCAL_PROXY_TOKEN` bearer —
 *      the same secret the Cloudflare Tunnel candle-proxy workflow uses.
 *
 * Returns `true` when the caller is allowed; the caller sends the 401/403
 * itself so the response shape matches the rest of its handler.
 */

import { isLoopbackHost } from "./local-api-transport";

/**
 * Minimal request shape this gate reads. Mirrors the `headers?` contract used
 * by the IBKR / strategy-admin gate functions so callers can pass the raw Vite
 * middleware `req` directly. `socket.remoteAddress` is read for the peer
 * address (an attacker cannot forge it).
 */
export interface AuthorizedRequest {
    headers?: Record<string, unknown>;
    socket?: { remoteAddress?: string } | null;
}

/**
 * True if `url` (an absolute `http(s)://host[:port]/...` string) points at a
 * loopback origin. Empty or non-absolute values are not loopback. Uses
 * {@link isLoopbackHost} for the authority check so bracketed IPv6
 * (`http://[::1]:5173`) and a bare `host:port` pair are parsed consistently
 * with the rest of the codebase.
 */
function isLoopbackUrl(url: string): boolean {
    if (!url) return false;
    let parsed: URL;
    try {
        parsed = new URL(url);
    } catch {
        return false;
    }
    return parsed.protocol === "http:" && isLoopbackHost(parsed.host);
}

/**
 * True if `addr` (a peer address from `req.socket.remoteAddress`) is loopback.
 * Handles the shapes Node surfaces on a socket — bare IPv4 (`127.0.0.1`),
 * IPv6 (`::1`), IPv4-mapped IPv6 (`::ffff:127.0.0.1`), and Node scope suffixes
 * (`::1%eth0`). Reuses {@link isLoopbackHost} for the dotted-quad / `::1`
 * logic so this stays a thin normalizer, not a second implementation.
 */
function isLoopbackAddress(addr: string | undefined): boolean {
    if (!addr) return false;
    let s = addr.trim().toLowerCase();
    if (!s) return false;
    // Strip a Node IPv6 scope suffix, e.g. `::1%eth0` → `::1`.
    const scope = s.indexOf("%");
    if (scope > 0) s = s.slice(0, scope);
    // Strip IPv4-mapped IPv6 prefix so the dotted-quad path in isLoopbackHost
    // applies to `::ffff:127.0.0.1` (the dual-stack form Node uses).
    if (s.startsWith("::ffff:")) s = s.slice(7);
    return s === "::1" || isLoopbackHost(s);
}

/**
 * Loopback gate for state-changing Vite dev-server routes. Mirrors the
 * established IBKR / strategy-library admin idiom with one hardening fix: a
 * tokenless caller is trusted ONLY when ALL of the following hold:
 *
 *   1. `req.socket.remoteAddress` is loopback (an attacker cannot spoof the
 *      peer address);
 *   2. the `Host` header is loopback; AND
 *   3. any supplied `Origin`/`Referer` is loopback OR absent (privacy-stripped).
 *
 * Relying on `Origin`/`Referer` alone is unsafe because arbitrary HTTP clients
 * can set those headers to any value — including `http://127.0.0.1:5173` —
 * against a remotely-reachable Vite server (`--host`, tunnel, reverse proxy).
 *
 * Any caller that fails the tokenless path MUST present the configured
 * `LOCAL_PROXY_TOKEN` bearer — the same secret the Cloudflare Tunnel
 * candle-proxy workflow already uses.
 *
 * Returns `true` when the caller is allowed; the caller sends the 401 itself
 * so the response shape matches the rest of its handler.
 */
export function isAllowedLocalRequest(req: AuthorizedRequest): boolean {
    const host = String(req.headers?.host ?? "");
    const origin = String(req.headers?.origin ?? "");
    const referer = String(req.headers?.referer ?? "");
    const remoteLoopback = isLoopbackAddress(req.socket?.remoteAddress);
    const hostLoopback = isLoopbackHost(host);
    // If any Origin/Referer was supplied, it must be loopback. A cross-origin
    // header is a hard reject even from a loopback socket (CSRF defense).
    const suppliedOriginLoopback =
        (!origin || isLoopbackUrl(origin)) && (!referer || isLoopbackUrl(referer));

    // Tokenless trust requires ALL THREE: loopback peer, loopback Host, and
    // (when supplied) loopback Origin/Referer. The peer address is the only
    // signal the caller cannot forge, so it gates the rest.
    if (remoteLoopback && hostLoopback && suppliedOriginLoopback) {
        return true;
    }

    // Privacy settings may strip Origin/Referer from same-origin browser GETs.
    // Fetch Metadata is browser-controlled; pair it with the loopback peer AND
    // loopback Host so a remote page served from a non-loopback Vite host is
    // still rejected.
    const fetchSite = String(req.headers?.["sec-fetch-site"] ?? "").toLowerCase();
    if (fetchSite === "same-origin" && remoteLoopback && hostLoopback) {
        return true;
    }

    // Non-local or cross-origin caller: require the documented shared secret.
    const token = process.env.LOCAL_PROXY_TOKEN?.trim();
    if (!token) return false;
    const auth = String(req.headers?.authorization ?? "");
    return auth === `Bearer ${token}`;
}
