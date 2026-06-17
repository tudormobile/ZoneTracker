import {
	env,
	createExecutionContext,
	waitOnExecutionContext,
	SELF,
} from "cloudflare:test";
import { describe, it, expect, vi } from "vitest";
import worker from "../src/index";

// For now, you'll need to do something like this to get a correctly-typed
// `Request` to pass to `worker.fetch()`.
const IncomingRequest = Request<unknown, IncomingRequestCfProperties>;

function extractCookiePair(setCookieHeader: string | null): string {
	return (setCookieHeader ?? "").split(";")[0] ?? "";
}

describe("PIN JWT auth worker", () => {
	it("uses the configured rate-limit binding on login", async () => {
		let limitCallCount = 0;
		const request = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": "198.51.100.20",
			},
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});

		const overriddenEnv = {
			...env,
			PIN_LOGIN_RATE_LIMITER: {
				limit: async ({ key }: { key: string }) => {
					limitCallCount += 1;
					expect(key).toBe("pin-login:198.51.100.20");
					return { success: false };
				},
			},
		} satisfies Env;

		const ctx = createExecutionContext();
		const response = await worker.fetch(request, overriddenEnv, ctx);
		await waitOnExecutionContext(ctx);

		expect(limitCallCount).toBe(1);
		expect(response.status).toBe(429);
		expect(response.headers.get("retry-after")).toBe("600");
	});

	it("issues and verifies a JWT (unit style)", async () => {
		const loginRequest = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});
		const loginCtx = createExecutionContext();
		const loginResponse = await worker.fetch(loginRequest, env, loginCtx);
		await waitOnExecutionContext(loginCtx);

		expect(loginResponse.status).toBe(200);
		const loginJson = (await loginResponse.json()) as { token: string };
		expect(typeof loginJson.token).toBe("string");
		expect(loginResponse.headers.get("set-cookie")).toContain("site_auth_token=");
		expect(loginResponse.headers.get("set-cookie")).toContain("HttpOnly");
		expect(loginResponse.headers.get("set-cookie")).not.toContain("Secure");

		const verifyRequest = new IncomingRequest("http://example.com/auth/verify", {
			method: "GET",
			headers: {
				authorization: `Bearer ${loginJson.token}`,
				cookie: `site_auth_token=${loginJson.token}`,
			},
		});
		const verifyCtx = createExecutionContext();
		const verifyResponse = await worker.fetch(verifyRequest, env, verifyCtx);
		await waitOnExecutionContext(verifyCtx);

		expect(verifyResponse.status).toBe(200);
		const verifyJson = (await verifyResponse.json()) as { valid: boolean };
		expect(verifyJson.valid).toBe(true);
		expect(verifyResponse.headers.get("set-cookie")).toContain("site_auth_token=");
	});

	it("rejects invalid pin", async () => {
		const request = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin: "0000" }),
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
	});

	it("rate limits repeated invalid login attempts", async () => {
		for (let attempt = 1; attempt <= 4; attempt++) {
			const request = new IncomingRequest("http://example.com/auth/login", {
				method: "POST",
				headers: {
					"content-type": "application/json",
					"cf-connecting-ip": "203.0.113.10",
				},
				body: JSON.stringify({ pin: "9999" }),
			});
			const ctx = createExecutionContext();
			const response = await worker.fetch(request, env, ctx);
			await waitOnExecutionContext(ctx);

			expect(response.status).toBe(401);
		}

		const finalRequest = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": "203.0.113.10",
			},
			body: JSON.stringify({ pin: "9999" }),
		});
		const finalCtx = createExecutionContext();
		const finalResponse = await worker.fetch(finalRequest, env, finalCtx);
		await waitOnExecutionContext(finalCtx);

		expect(finalResponse.status).toBe(429);
		const finalJson = (await finalResponse.json()) as {
			error: string;
			retryAfterSeconds: number;
		};
		expect(finalJson.error).toBe("Too many login attempts");
		expect(finalJson.retryAfterSeconds).toBeGreaterThan(0);
	});

	it("issues and verifies a JWT (integration style)", async () => {
		const loginResponse = await SELF.fetch("https://example.com/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});
		expect(loginResponse.status).toBe(200);
		const loginJson = (await loginResponse.json()) as { token: string };
		const loginCookie = loginResponse.headers.get("set-cookie");
		expect(loginCookie).toContain("site_auth_token=");
		expect(loginCookie).toContain("Secure");

		const verifyResponse = await SELF.fetch("https://example.com/auth/verify", {
			headers: {
				authorization: `Bearer ${loginJson.token}`,
				cookie: extractCookiePair(loginCookie),
			},
		});
		expect(verifyResponse.status).toBe(200);
		const verifyJson = (await verifyResponse.json()) as { valid: boolean };
		expect(verifyJson.valid).toBe(true);
	});

	it("requires site_auth_token cookie on proxied requests", async () => {
		const request = new IncomingRequest("http://example.com/protected", {
			method: "GET",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(401);
		const responseJson = (await response.json()) as { error: string };
		expect(responseJson.error).toBe("Authentication required");
	});

	it("redirects browser navigation to login when auth cookie is missing", async () => {
		const request = new IncomingRequest("http://example.com/protected?tab=1", {
			method: "GET",
			headers: {
				accept: "text/html",
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(302);
		expect(response.headers.get("location")).toBe(
			"http://example.com/auth/login?next=%2Fprotected%3Ftab%3D1",
		);
	});

	it("serves login page for browser GET /auth/login", async () => {
		const request = new IncomingRequest("http://example.com/auth/login", {
			method: "GET",
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		expect(response.headers.get("content-type")).toContain("text/html");
		expect(await response.text()).toContain("<form id=\"login-form\">");
	});

	it("sanitizes unsafe next param on login page", async () => {
		const request = new IncomingRequest(
			"http://example.com/auth/login?next=https%3A%2F%2Fevil.example",
			{
				method: "GET",
			},
		);
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(200);
		const html = await response.text();
		expect(html).toContain("const next = \"/\";");
	});

	it("proxies authenticated requests and injects secret header", async () => {
		const loginRequest = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});
		const loginCtx = createExecutionContext();
		const loginResponse = await worker.fetch(loginRequest, env, loginCtx);
		await waitOnExecutionContext(loginCtx);

		const loginCookie = loginResponse.headers.get("set-cookie");
		expect(loginCookie).toContain("site_auth_token=");

		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("proxied", { status: 200 }));

		const proxyRequest = new IncomingRequest("http://example.com/dashboard", {
			method: "GET",
			headers: { cookie: extractCookiePair(loginCookie) },
		});
		const proxyEnv = {
			...env,
			PROXY_HEADER_SECRET: "proxy-secret-value",
		} satisfies Env;
		const proxyCtx = createExecutionContext();
		const proxyResponse = await worker.fetch(proxyRequest, proxyEnv, proxyCtx);
		await waitOnExecutionContext(proxyCtx);

		expect(proxyResponse.status).toBe(200);
		expect(await proxyResponse.text()).toBe("proxied");
		expect(fetchMock).toHaveBeenCalledTimes(1);

		const [forwardedRequest] = fetchMock.mock.calls[0] as [Request];
		expect(forwardedRequest.headers.get("x-site-proxy-auth")).toBe(
			"proxy-secret-value",
		);
		expect(forwardedRequest.headers.get("cookie")).toBeNull();

		fetchMock.mockRestore();
	});

	it("uses configured PROXY_HEADER_NAME when injecting auth header", async () => {
		const loginRequest = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});
		const loginCtx = createExecutionContext();
		const loginResponse = await worker.fetch(loginRequest, env, loginCtx);
		await waitOnExecutionContext(loginCtx);

		const loginCookie = loginResponse.headers.get("set-cookie");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("proxied", { status: 200 }));

		const proxyRequest = new IncomingRequest("http://example.com/dashboard", {
			method: "GET",
			headers: { cookie: extractCookiePair(loginCookie) },
		});
		const proxyEnv = {
			...env,
			PROXY_HEADER_SECRET: "proxy-secret-value",
			PROXY_HEADER_NAME: "x-custom-proxy-auth",
		} satisfies Env;
		const proxyCtx = createExecutionContext();
		const proxyResponse = await worker.fetch(proxyRequest, proxyEnv, proxyCtx);
		await waitOnExecutionContext(proxyCtx);

		expect(proxyResponse.status).toBe(200);
		const [forwardedRequest] = fetchMock.mock.calls[0] as [Request];
		expect(forwardedRequest.headers.get("x-custom-proxy-auth")).toBe(
			"proxy-secret-value",
		);
		expect(forwardedRequest.headers.get("x-site-proxy-auth")).toBeNull();

		fetchMock.mockRestore();
	});

	it("proxies to configured PROXY_TARGET_ORIGIN in dev", async () => {
		const loginRequest = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": "198.51.100.101",
			},
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});
		const loginCtx = createExecutionContext();
		const loginResponse = await worker.fetch(loginRequest, env, loginCtx);
		await waitOnExecutionContext(loginCtx);
		expect(loginResponse.status).toBe(200);

		const loginCookie = loginResponse.headers.get("set-cookie");
		expect(loginCookie).toContain("site_auth_token=");
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("proxied", { status: 200 }));

		const proxyRequest = new IncomingRequest("http://example.com/dashboard?tab=2", {
			method: "GET",
			headers: {
				cookie: extractCookiePair(loginCookie),
				host: "localhost:8787",
			},
		});
		const proxyEnv = {
			...env,
			PROXY_HEADER_SECRET: "proxy-secret-value",
			PROXY_TARGET_ORIGIN: "http://127.0.0.1:5173",
		} satisfies Env;

		const proxyCtx = createExecutionContext();
		const proxyResponse = await worker.fetch(proxyRequest, proxyEnv, proxyCtx);
		await waitOnExecutionContext(proxyCtx);

		expect(proxyResponse.status).toBe(200);
		const [forwardedRequest] = fetchMock.mock.calls[0] as [Request];
		expect(new URL(forwardedRequest.url).toString()).toBe(
			"http://127.0.0.1:5173/dashboard?tab=2",
		);
		expect(forwardedRequest.headers.get("host")).toBeNull();

		fetchMock.mockRestore();
	});

	it("preserves base path from PROXY_TARGET_ORIGIN", async () => {
		const loginRequest = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": "198.51.100.104",
			},
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});
		const loginCtx = createExecutionContext();
		const loginResponse = await worker.fetch(loginRequest, env, loginCtx);
		await waitOnExecutionContext(loginCtx);

		const loginCookie = loginResponse.headers.get("set-cookie");
		expect(loginResponse.status).toBe(200);
		expect(loginCookie).toContain("site_auth_token=");

		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockResolvedValueOnce(new Response("proxied", { status: 200 }));

		const proxyRequest = new IncomingRequest("http://example.com/app/dashboard?tab=2", {
			method: "GET",
			headers: { cookie: extractCookiePair(loginCookie) },
		});
		const proxyEnv = {
			...env,
			PROXY_HEADER_SECRET: "proxy-secret-value",
			PROXY_TARGET_ORIGIN: "http://127.0.0.1:5173/base",
		} satisfies Env;
		const proxyCtx = createExecutionContext();
		const proxyResponse = await worker.fetch(proxyRequest, proxyEnv, proxyCtx);
		await waitOnExecutionContext(proxyCtx);

		expect(proxyResponse.status).toBe(200);
		const [forwardedRequest] = fetchMock.mock.calls[0] as [Request];
		expect(new URL(forwardedRequest.url).toString()).toBe(
			"http://127.0.0.1:5173/base/app/dashboard?tab=2",
		);

		fetchMock.mockRestore();
	});

	it("returns 500 when PROXY_TARGET_ORIGIN is invalid", async () => {
		const loginRequest = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": "198.51.100.102",
			},
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});
		const loginCtx = createExecutionContext();
		const loginResponse = await worker.fetch(loginRequest, env, loginCtx);
		await waitOnExecutionContext(loginCtx);
		expect(loginResponse.status).toBe(200);

		const loginCookie = loginResponse.headers.get("set-cookie");
		expect(loginCookie).toContain("site_auth_token=");
		const proxyRequest = new IncomingRequest("http://example.com/dashboard", {
			method: "GET",
			headers: { cookie: extractCookiePair(loginCookie) },
		});
		const proxyEnv = {
			...env,
			PROXY_HEADER_SECRET: "proxy-secret-value",
			PROXY_TARGET_ORIGIN: "not-a-url",
		} satisfies Env;

		const proxyCtx = createExecutionContext();
		const proxyResponse = await worker.fetch(proxyRequest, proxyEnv, proxyCtx);
		await waitOnExecutionContext(proxyCtx);

		expect(proxyResponse.status).toBe(500);
		const responseJson = (await proxyResponse.json()) as { error: string };
		expect(responseJson.error).toBe("Invalid PROXY_TARGET_ORIGIN binding");
	});

	it("returns 502 when upstream dev server is unavailable", async () => {
		const loginRequest = new IncomingRequest("http://example.com/auth/login", {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"cf-connecting-ip": "198.51.100.103",
			},
			body: JSON.stringify({ pin: env.AUTH_PIN }),
		});
		const loginCtx = createExecutionContext();
		const loginResponse = await worker.fetch(loginRequest, env, loginCtx);
		await waitOnExecutionContext(loginCtx);

		const loginCookie = loginResponse.headers.get("set-cookie");
		expect(loginResponse.status).toBe(200);
		expect(loginCookie).toContain("site_auth_token=");

		const proxyRequest = new IncomingRequest("http://example.com/dashboard", {
			method: "GET",
			headers: { cookie: extractCookiePair(loginCookie) },
		});
		const proxyEnv = {
			...env,
			PROXY_HEADER_SECRET: "proxy-secret-value",
			PROXY_TARGET_ORIGIN: "http://127.0.0.1:5173",
		} satisfies Env;

		const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(new Error("connect ECONNREFUSED"));

		const proxyCtx = createExecutionContext();
		const proxyResponse = await worker.fetch(proxyRequest, proxyEnv, proxyCtx);
		await waitOnExecutionContext(proxyCtx);

		expect(proxyResponse.status).toBe(502);
		const proxyJson = (await proxyResponse.json()) as {
			error: string;
			upstream: string;
			details: string;
		};
		expect(proxyJson.error).toBe("Upstream dev server unavailable");
		expect(proxyJson.upstream).toBe("http://127.0.0.1:5173/dashboard");
		expect(proxyJson.details).toContain("ECONNREFUSED");

		fetchMock.mockRestore();
	});

	it("returns 426 for websocket upgrade requests", async () => {
		const request = new IncomingRequest("http://example.com/", {
			method: "GET",
			headers: {
				upgrade: "websocket",
				connection: "Upgrade",
			},
		});
		const ctx = createExecutionContext();
		const response = await worker.fetch(request, env, ctx);
		await waitOnExecutionContext(ctx);

		expect(response.status).toBe(426);
		const responseJson = (await response.json()) as { error: string };
		expect(responseJson.error).toBe("WebSocket proxying is not supported in local dev");
	});
});
