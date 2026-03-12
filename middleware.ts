const AUTH_COOKIE_NAME = "site-password-auth";
const AUTH_PATH = "/_auth";
const COOKIE_TTL_SECONDS = 60 * 60 * 12;

function shouldProtect(url: URL): boolean {
	const hostname = url.hostname.toLowerCase();
	if (hostname === "localhost" || hostname === "127.0.0.1") {
		return false;
	}
	return process.env.VERCEL_ENV === "production";
}

function getConfiguredPassword(): string {
	return (process.env.SITE_PASSWORD || "").trim();
}

function parseCookies(header: string | null): Map<string, string> {
	const cookies = new Map<string, string>();
	if (!header) return cookies;

	for (const pair of header.split(";")) {
		const separatorIndex = pair.indexOf("=");
		if (separatorIndex === -1) continue;
		const key = pair.slice(0, separatorIndex).trim();
		const value = pair.slice(separatorIndex + 1).trim();
		if (!key) continue;
		cookies.set(key, decodeURIComponent(value));
	}

	return cookies;
}

function escapeHtml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;");
}

function normalizeReturnTo(rawValue: string | null, fallbackUrl: URL): string {
	if (!rawValue) {
		return `${fallbackUrl.pathname}${fallbackUrl.search}`;
	}
	if (!rawValue.startsWith("/") || rawValue.startsWith("//")) {
		return "/";
	}
	return rawValue;
}

async function sha256Hex(value: string): Promise<string> {
	const bytes = new TextEncoder().encode(value);
	const digest = await crypto.subtle.digest("SHA-256", bytes);
	return Array.from(new Uint8Array(digest))
		.map((byte) => byte.toString(16).padStart(2, "0"))
		.join("");
}

function buildSetCookie(value: string, maxAge: number): string {
	return [
		`${AUTH_COOKIE_NAME}=${encodeURIComponent(value)}`,
		"Path=/",
		`Max-Age=${maxAge}`,
		"HttpOnly",
		"Secure",
		"SameSite=Lax",
	].join("; ");
}

function renderLoginPage(returnTo: string, errorMessage?: string, status = 401): Response {
	const safeReturnTo = escapeHtml(returnTo);
	const safeError = errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : "";
	const html = `<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8">
	<meta name="viewport" content="width=device-width, initial-scale=1">
	<title>Protected Site</title>
	<style>
		:root {
			color-scheme: light;
			font-family: "Segoe UI", sans-serif;
			background: #0f172a;
			color: #e2e8f0;
		}
		body {
			margin: 0;
			min-height: 100vh;
			display: grid;
			place-items: center;
			background:
				radial-gradient(circle at top, rgba(56, 189, 248, 0.18), transparent 32%),
				linear-gradient(160deg, #020617, #111827 58%, #1e293b);
		}
		main {
			width: min(92vw, 420px);
			padding: 32px;
			border-radius: 18px;
			border: 1px solid rgba(148, 163, 184, 0.25);
			background: rgba(15, 23, 42, 0.84);
			box-shadow: 0 24px 80px rgba(2, 6, 23, 0.45);
		}
		h1 {
			margin: 0 0 10px;
			font-size: 1.6rem;
		}
		p {
			margin: 0 0 16px;
			color: #cbd5e1;
			line-height: 1.5;
		}
		form {
			display: grid;
			gap: 12px;
		}
		label {
			font-size: 0.95rem;
			color: #e2e8f0;
		}
		input {
			width: 100%;
			padding: 12px 14px;
			border-radius: 10px;
			border: 1px solid rgba(148, 163, 184, 0.32);
			background: rgba(15, 23, 42, 0.95);
			color: inherit;
			box-sizing: border-box;
		}
		button {
			padding: 12px 14px;
			border: 0;
			border-radius: 10px;
			background: linear-gradient(135deg, #38bdf8, #0ea5e9);
			color: #082f49;
			font-weight: 700;
			cursor: pointer;
		}
		.error {
			margin-top: -4px;
			color: #fca5a5;
		}
	</style>
</head>
<body>
	<main>
		<h1>Site Locked</h1>
		<p>Enter the shared password to continue.</p>
		${safeError}
		<form method="post" action="${AUTH_PATH}">
			<input type="hidden" name="next" value="${safeReturnTo}">
			<label for="password">Password</label>
			<input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
			<button type="submit">Enter</button>
		</form>
	</main>
</body>
</html>`;

	return new Response(html, {
		status,
		headers: {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "private, no-store, no-cache, must-revalidate",
		},
	});
}

function renderConfigurationError(): Response {
	return new Response("SITE_PASSWORD is not configured for production.", {
		status: 503,
		headers: {
			"Content-Type": "text/plain; charset=utf-8",
			"Cache-Control": "private, no-store, no-cache, must-revalidate",
		},
	});
}

async function isAuthenticated(request: Request, password: string): Promise<boolean> {
	const cookieHeader = request.headers.get("cookie");
	const cookieValue = parseCookies(cookieHeader).get(AUTH_COOKIE_NAME);
	if (!cookieValue) return false;

	const expectedHash = await sha256Hex(password);
	return cookieValue === expectedHash;
}

async function handleAuthSubmission(request: Request, url: URL, password: string): Promise<Response> {
	const formData = await request.formData();
	const submittedPassword = String(formData.get("password") || "");
	const next = normalizeReturnTo(String(formData.get("next") || ""), url);

	if (!submittedPassword) {
		return renderLoginPage(next, "Password is required.");
	}

	const submittedHash = await sha256Hex(submittedPassword);
	const expectedHash = await sha256Hex(password);
	if (submittedHash !== expectedHash) {
		return renderLoginPage(next, "Incorrect password.");
	}

	return new Response(null, {
		status: 302,
		headers: {
			"Location": next,
			"Set-Cookie": buildSetCookie(submittedHash, COOKIE_TTL_SECONDS),
			"Cache-Control": "private, no-store, no-cache, must-revalidate",
		},
	});
}

export default async function middleware(request: Request): Promise<Response | undefined> {
	const url = new URL(request.url);
	if (!shouldProtect(url)) {
		return undefined;
	}

	const password = getConfiguredPassword();
	if (!password) {
		return renderConfigurationError();
	}

	if (url.pathname === AUTH_PATH) {
		if (request.method === "POST") {
			return handleAuthSubmission(request, url, password);
		}
		const next = normalizeReturnTo(url.searchParams.get("next"), new URL("/", url));
		return renderLoginPage(next, undefined, 200);
	}

	if (await isAuthenticated(request, password)) {
		return undefined;
	}

	const returnTo = normalizeReturnTo(`${url.pathname}${url.search}`, new URL("/", url));
	return renderLoginPage(returnTo);
}

export const config = {
	matcher: "/:path*",
};
