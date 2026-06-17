
import { SignJWT, jwtVerify } from "jose";

const textEncoder = new TextEncoder();
const JWT_ISSUER = "vue-tracker-pin";
const JWT_AUDIENCE = "vue-tracker-pin-client";
const AUTH_COOKIE_NAME = "site_auth_token";
const AUTH_COOKIE_MAX_AGE_SECONDS = 3600;
const PROXY_AUTH_HEADER_NAME = "x-site-proxy-auth";
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 60 * 1000;
const MAX_AUTH_BODY_BYTES = 1024;
const LOGIN_RATE_LIMIT_PREFIX = "pin-login";

type LoginAttemptState = {
	count: number;
	windowStartedAt: number;
};

const loginAttemptsByClient = new Map<string, LoginAttemptState>();

function jsonResponse(status: number, body: unknown): Response {
	return Response.json(body, { status });
}

function isBrowserNavigationRequest(request: Request): boolean {
	if (request.method !== "GET") {
		return false;
	}

	const accept = request.headers.get("accept")?.toLowerCase() ?? "";
	return accept.includes("text/html");
}

function isWebSocketUpgradeRequest(request: Request): boolean {
	return request.headers.get("upgrade")?.toLowerCase() === "websocket";
}

function redirectToLogin(request: Request): Response {
	const url = new URL(request.url);
	const loginUrl = new URL("/auth/login", url.origin);
	loginUrl.searchParams.set("next", url.pathname + url.search);
	return Response.redirect(loginUrl.toString(), 302);
}

function sanitizeNextPath(next: string | null): string {
	if (!next) {
		return "/";
	}

	const trimmed = next.trim();
	if (!trimmed.startsWith("/")) {
		return "/";
	}

	if (trimmed.startsWith("//")) {
		return "/";
	}

	return trimmed;
}

function handleLoginPage(request: Request): Response {
	const url = new URL(request.url);
	const next = sanitizeNextPath(url.searchParams.get("next"));

	return new Response(
		`<!doctype html>
<html lang="en">
<head>
	<meta charset="utf-8" />
	<meta name="viewport" content="width=device-width, initial-scale=1" />
	<title>Sign in</title>
</head>
<body>
	<main>
		<h1>Enter PIN</h1>
		<form id="login-form">
			<label for="pin">PIN</label>
			<input id="pin" name="pin" type="password" inputmode="numeric" required />
			<button type="submit">Sign in</button>
		</form>
		<p id="error" role="alert"></p>
	</main>
	<script>
		const form = document.getElementById('login-form');
		const error = document.getElementById('error');
		const next = ${JSON.stringify(next)};

		form.addEventListener('submit', async (event) => {
			event.preventDefault();
			error.textContent = '';

			const pinInput = document.getElementById('pin');
			const response = await fetch('/auth/login', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ pin: pinInput.value }),
			});

			if (!response.ok) {
				const data = await response.json().catch(() => ({ error: 'Login failed' }));
				error.textContent = data.error || 'Login failed';
				return;
			}

			window.location.assign(next);
		});
	</script>
</body>
</html>`,
		{
			status: 200,
			headers: {
				"content-type": "text/html; charset=utf-8",
			},
		},
	);
}

function jsonResponseWithCookie(
	status: number,
	body: unknown,
	token: string,
	request: Request,
): Response {
	const response = jsonResponse(status, body);
	response.headers.append("set-cookie", buildAuthCookie(token, request));
	return response;
}

function rateLimitedResponse(retryAfterSeconds: number): Response {
	return Response.json(
		{ error: "Too many login attempts", retryAfterSeconds },
		{
			status: 429,
			headers: {
				"retry-after": String(retryAfterSeconds),
			},
		},
	);
}

function getJwtSecretKey(env: Env): Uint8Array {
	return textEncoder.encode(env.JWT_SECRET);
}

function shouldUseSecureCookie(request: Request): boolean {
	return new URL(request.url).protocol === "https:";
}

function buildAuthCookie(token: string, request: Request): string {
	const secureDirective = shouldUseSecureCookie(request) ? "; Secure" : "";
	return `${AUTH_COOKIE_NAME}=${token}; HttpOnly${secureDirective}; Path=/; SameSite=Lax; Max-Age=${AUTH_COOKIE_MAX_AGE_SECONDS}`;
}

function getProxyHeaderName(env: Env): string {
	const configuredName = env.PROXY_HEADER_NAME?.trim();
	return configuredName || PROXY_AUTH_HEADER_NAME;
}

function getProxyTargetUrl(request: Request, env: Env): URL | Response {
	const configuredOrigin = env.PROXY_TARGET_ORIGIN?.trim();
	const originalUrl = new URL(request.url);

	if (!configuredOrigin) {
		return originalUrl;
	}

	let targetOrigin: URL;
	try {
		targetOrigin = new URL(configuredOrigin);
	} catch {
		return jsonResponse(500, {
			error: "Invalid PROXY_TARGET_ORIGIN binding",
		});
	}

		const basePath = targetOrigin.pathname.endsWith("/")
			? targetOrigin.pathname.slice(0, -1)
			: targetOrigin.pathname;
		targetOrigin.pathname = `${basePath}${originalUrl.pathname}` || "/";
	targetOrigin.search = originalUrl.search;
	return targetOrigin;
}

function upstreamUnavailableResponse(targetUrl: URL, error: unknown): Response {
	return jsonResponse(502, {
		error: "Upstream dev server unavailable",
		upstream: targetUrl.toString(),
		details: error instanceof Error ? error.message : "Unknown fetch failure",
	});
}

async function secureStringCompare(a: string, b: string): Promise<boolean> {
	const [aDigest, bDigest] = await Promise.all([
		crypto.subtle.digest("SHA-256", textEncoder.encode(a)),
		crypto.subtle.digest("SHA-256", textEncoder.encode(b)),
	]);

	return crypto.subtle.timingSafeEqual(aDigest, bDigest);
}

function getBearerToken(request: Request): string | null {
	const authorization = request.headers.get("authorization");
	if (!authorization) {
		return null;
	}

	const [scheme, token] = authorization.split(" ");
	if (scheme !== "Bearer" || !token) {
		return null;
	}

	return token;
}

function parseCookies(request: Request): Map<string, string> {
	const cookieHeader = request.headers.get("cookie");
	if (!cookieHeader) {
		return new Map();
	}

	return new Map(
		cookieHeader
			.split(";")
			.map((part) => part.trim())
			.filter((part) => part.includes("="))
			.map((part) => {
				const separatorIndex = part.indexOf("=");
				const name = part.slice(0, separatorIndex).trim();
				const value = part.slice(separatorIndex + 1).trim();
				return [name, value];
			}),
	);
}

function getCookieToken(request: Request): string | null {
	const cookies = parseCookies(request);
	return cookies.get(AUTH_COOKIE_NAME) ?? null;
}

function stripAuthCookie(request: Request, headers: Headers): void {
	const cookieHeader = request.headers.get("cookie");
	if (!cookieHeader) {
		return;
	}

	const filtered = cookieHeader
		.split(";")
		.map((part) => part.trim())
		.filter((part) => !part.toLowerCase().startsWith(`${AUTH_COOKIE_NAME.toLowerCase()}=`));

	if (filtered.length === 0) {
		headers.delete("cookie");
		return;
	}

	headers.set("cookie", filtered.join("; "));
}

function getClientIdentifier(request: Request): string {
	const cfConnectingIp = request.headers.get("cf-connecting-ip");
	if (cfConnectingIp) {
		return cfConnectingIp;
	}

	const xForwardedFor = request.headers.get("x-forwarded-for");
	if (xForwardedFor) {
		return xForwardedFor.split(",")[0]?.trim() || "unknown";
	}

	return "unknown";
}

function getRemainingWindowMs(clientId: string, now: number): number {
	const attemptState = loginAttemptsByClient.get(clientId);
	if (!attemptState) {
		return 0;
	}

	const elapsed = now - attemptState.windowStartedAt;
	if (elapsed >= LOGIN_WINDOW_MS) {
		loginAttemptsByClient.delete(clientId);
		return 0;
	}

	if (attemptState.count < LOGIN_MAX_ATTEMPTS) {
		return 0;
	}

	return LOGIN_WINDOW_MS - elapsed;
}

function registerFailedAttempt(clientId: string, now: number): number {
	const attemptState = loginAttemptsByClient.get(clientId);

	if (!attemptState || now - attemptState.windowStartedAt >= LOGIN_WINDOW_MS) {
		loginAttemptsByClient.set(clientId, { count: 1, windowStartedAt: now });
		return 1;
	}

	attemptState.count += 1;
	loginAttemptsByClient.set(clientId, attemptState);
	return attemptState.count;
}

function clearLoginAttempts(clientId: string): void {
	loginAttemptsByClient.delete(clientId);
}

function getContentLength(request: Request): number | null {
	const contentLength = request.headers.get("content-length");
	if (!contentLength) {
		return null;
	}

	const parsed = Number.parseInt(contentLength, 10);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

async function parseLoginRequest(request: Request): Promise<string | Response> {
	const contentLength = getContentLength(request);
	if (contentLength !== null && contentLength > MAX_AUTH_BODY_BYTES) {
		return jsonResponse(413, { error: "Request body too large" });
	}

	const rawBody = await request.text();
	if (rawBody.length > MAX_AUTH_BODY_BYTES) {
		return jsonResponse(413, { error: "Request body too large" });
	}

	let payload: unknown;
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return jsonResponse(400, { error: "Invalid JSON body" });
	}

	const providedPin =
		typeof payload === "object" && payload !== null && "pin" in payload
			? (payload as { pin?: unknown }).pin
			: undefined;

	if (typeof providedPin !== "string") {
		return jsonResponse(400, { error: "Expected pin as a string" });
	}

	return providedPin;
}

async function enforceLoginRateLimit(request: Request, env: Env): Promise<Response | null> {
	const clientId = getClientIdentifier(request);
	const rateLimiter = env.PIN_LOGIN_RATE_LIMITER;

	if (rateLimiter) {
		const { success } = await rateLimiter.limit({
			key: `${LOGIN_RATE_LIMIT_PREFIX}:${clientId}`,
		});
		if (!success) {
			return rateLimitedResponse(Math.ceil(LOGIN_WINDOW_MS / 1000));
		}

		return null;
	}

	const now = Date.now();
	const remainingWindowMs = getRemainingWindowMs(clientId, now);
	if (remainingWindowMs > 0) {
		return rateLimitedResponse(Math.ceil(remainingWindowMs / 1000));
	}

	return null;
}

async function handleLogin(request: Request, env: Env): Promise<Response> {
	if (!env.AUTH_PIN || !env.JWT_SECRET) {
		return jsonResponse(500, { error: "Missing AUTH_PIN or JWT_SECRET binding" });
	}

	const clientId = getClientIdentifier(request);
	const rateLimitResponse = await enforceLoginRateLimit(request, env);
	if (rateLimitResponse) {
		return rateLimitResponse;
	}

	const parsedRequest = await parseLoginRequest(request);
	if (parsedRequest instanceof Response) {
		return parsedRequest;
	}
	const providedPin = parsedRequest;

	if (!(await secureStringCompare(providedPin, env.AUTH_PIN))) {
		const now = Date.now();
		const failures = registerFailedAttempt(clientId, now);
		if (failures >= LOGIN_MAX_ATTEMPTS) {
			return rateLimitedResponse(Math.ceil(LOGIN_WINDOW_MS / 1000));
		}

		return jsonResponse(401, { error: "Invalid credentials" });
	}

	clearLoginAttempts(clientId);

	const token = await new SignJWT({ auth: "pin" })
		.setProtectedHeader({ alg: "HS256", typ: "JWT" })
		.setSubject("pin-user")
		.setIssuer(JWT_ISSUER)
		.setAudience(JWT_AUDIENCE)
		.setIssuedAt()
		.setExpirationTime("1h")
		.sign(getJwtSecretKey(env));

	return jsonResponseWithCookie(
		200,
		{
		token,
		tokenType: "Bearer",
		expiresIn: 3600,
		},
		token,
		request,
	);
}

async function verifyToken(token: string, env: Env): Promise<boolean> {
	try {
		await jwtVerify(token, getJwtSecretKey(env), {
			algorithms: ["HS256"],
			issuer: JWT_ISSUER,
			audience: JWT_AUDIENCE,
		});
		return true;
	} catch {
		return false;
	}
}

async function handleVerify(request: Request, env: Env): Promise<Response> {
	if (!env.JWT_SECRET) {
		return jsonResponse(500, { error: "Missing JWT_SECRET binding" });
	}

	const token = getBearerToken(request) ?? getCookieToken(request);
	if (!token) {
		return jsonResponse(401, { error: "Missing auth token" });
	}

	try {
		const { payload } = await jwtVerify(token, getJwtSecretKey(env), {
			algorithms: ["HS256"],
			issuer: JWT_ISSUER,
			audience: JWT_AUDIENCE,
		});

		return jsonResponseWithCookie(
			200,
			{
				valid: true,
				subject: payload.sub,
				expiresAt: payload.exp,
			},
			token,
			request,
		);
	} catch {
		return jsonResponse(401, { error: "Invalid or expired token" });
	}
}

async function handleProxy(request: Request, env: Env): Promise<Response> {
	if (isWebSocketUpgradeRequest(request)) {
		return jsonResponse(426, {
			error: "WebSocket proxying is not supported in local dev",
			loginPath: "/auth/login",
		});
	}

	const token = getCookieToken(request);
	if (!token) {
		if (isBrowserNavigationRequest(request)) {
			return redirectToLogin(request);
		}

		return jsonResponse(401, {
			error: "Authentication required",
			loginPath: "/auth/login",
		});
	}

	if (!env.JWT_SECRET || !env.PROXY_HEADER_SECRET) {
		return jsonResponse(500, {
			error: "Missing JWT_SECRET or PROXY_HEADER_SECRET binding",
		});
	}

	if (!(await verifyToken(token, env))) {
		if (isBrowserNavigationRequest(request)) {
			return redirectToLogin(request);
		}

		return jsonResponse(401, {
			error: "Invalid or expired token",
			loginPath: "/auth/login",
		});
	}

	const proxyHeaders = new Headers(request.headers);
	proxyHeaders.set(getProxyHeaderName(env), env.PROXY_HEADER_SECRET);
	stripAuthCookie(request, proxyHeaders);
	// Let runtime derive host from target URL. Forwarding original host can break local dev servers.
	proxyHeaders.delete("host");
	proxyHeaders.delete("content-length");
	const targetUrl = getProxyTargetUrl(request, env);
	if (targetUrl instanceof Response) {
		return targetUrl;
	}

	const proxyRequest = new Request(targetUrl.toString(), {
		method: request.method,
		headers: proxyHeaders,
		body: request.body,
		redirect: request.redirect,
	});

	let upstreamResponse: Response;
	try {
		upstreamResponse = await fetch(proxyRequest);
	} catch (error) {
		return upstreamUnavailableResponse(targetUrl, error);
	}
	const responseHeaders = new Headers(upstreamResponse.headers);
	responseHeaders.append("set-cookie", buildAuthCookie(token, request));

	return new Response(upstreamResponse.body, {
		status: upstreamResponse.status,
		statusText: upstreamResponse.statusText,
		headers: responseHeaders,
	});
}

export default {
	async fetch(request, env): Promise<Response> {
		const url = new URL(request.url);

		if (url.pathname === "/auth/login" && request.method === "GET") {
			return handleLoginPage(request);
		}

		if (url.pathname === "/auth/login" && request.method === "POST") {
			return handleLogin(request, env);
		}

		if (url.pathname === "/auth/verify" && request.method === "GET") {
			return handleVerify(request, env);
		}

		return handleProxy(request, env);
	},
} satisfies ExportedHandler<Env>;
