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
 * middleware `req` directly.
 */
export interface AuthorizedRequest {
    headers?: Record<string, unknown>;
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
 * Loopback gate for state-changing Vite dev-server routes. Mirrors the
 * established IBKR / strategy-library admin idiom: a same-origin browser
 * caller (loopback Origin/Referer) is trusted without a token; any other
 * caller must present the configured `LOCAL_PROXY_TOKEN` bearer.
 *
 * Returns `true` when the caller is allowed; the caller sends the 401 itself
 * so the response shape matches the rest of its handler.
 */
export function isAllowedLocalRequest(req: AuthorizedRequest): boolean {
    const origin = String(req.headers?.origin ?? "");
    const referer = String(req.headers?.referer ?? "");
    if (isLoopbackUrl(origin) || isLoopbackUrl(referer)) return true;
    // Privacy settings may strip Origin and Referer from same-origin GETs.
    // Fetch Metadata is browser-controlled; pair it with the loopback Host so
    // a remote page served from a non-loopback Vite host is still rejected.
    const fetchSite = String(req.headers?.["sec-fetch-site"] ?? "").toLowerCase();
    const host = String(req.headers?.host ?? "");
    if (fetchSite === "same-origin" && isLoopbackHost(host)) return true;
    // Non-local caller: require the documented shared secret.
    const token = process.env.LOCAL_PROXY_TOKEN?.trim();
    if (!token) return false;
    const auth = String(req.headers?.authorization ?? "");
    return auth === `Bearer ${token}`;
}
