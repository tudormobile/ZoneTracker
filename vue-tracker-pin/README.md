# vue-tracker-pin

A Cloudflare Worker that protects a PIN-based login flow with JWTs and proxies authenticated requests to origin.

## What It Does

This Worker exposes two auth endpoints and proxies all other paths:

- `POST /auth/login`
- `GET /auth/verify`

`POST /auth/login` accepts a JSON body with a PIN, compares it against `AUTH_PIN`, and returns a signed JWT if the PIN is correct.

On successful login, it also sets the JWT as an HTTP-only cookie named `site_auth_token`.

`GET /auth/verify` accepts a `Bearer` token (or `site_auth_token` cookie) and verifies that the token was signed with `JWT_SECRET`.

For non-auth routes, the Worker expects a valid `site_auth_token` cookie. Authenticated requests are proxied with a secret header. The header name comes from `PROXY_HEADER_NAME` (default `x-site-proxy-auth`) and the header value comes from `PROXY_HEADER_SECRET`.

You can optionally set `PROXY_TARGET_ORIGIN` to proxy to a different upstream URL. This is useful in local development when your Vue app runs on another port/host.

`PROXY_TARGET_ORIGIN` is treated as a secret binding, so the Worker reads it from `.dev.vars` locally and from Worker secrets in production.

The Worker also includes rate limiting on login attempts.

## Stack

- Cloudflare Workers
- Wrangler
- TypeScript
- Vitest
- `jose` for JWT signing and verification

## Requirements

- Node.js
- npm
- A Cloudflare account

## Install

```powershell
npm.cmd install
```

## Local Development

### 1. Create Local Secrets

Copy `.dev.vars.example` to `.dev.vars` and set your own values:

```dotenv
AUTH_PIN=1234
JWT_SECRET=replace-with-a-long-random-secret
PROXY_HEADER_SECRET=replace-with-a-long-random-proxy-secret
PROXY_HEADER_NAME=x-site-proxy-auth
PROXY_TARGET_ORIGIN=http://127.0.0.1:5173
```

`.dev.vars` is for local development only and should not be committed.

### 2. Start The Worker

```powershell
npm.cmd run dev
```

Wrangler will start a local Workers dev server, usually at `http://localhost:8787`.
This uses `wrangler dev --env development`, so it loads the development secret bindings without affecting production deploys.

### 3. Test The Endpoints

Login:

```powershell
curl -X POST http://localhost:8787/auth/login ^
  -H "content-type: application/json" ^
  -d "{\"pin\":\"1234\"}"
```

Verify:

```powershell
curl http://localhost:8787/auth/verify ^
  -H "authorization: Bearer YOUR_TOKEN_HERE"
```

## Production Secrets

In production, secrets are stored on the Cloudflare Worker, not in this repository.

Set them with Wrangler:

```powershell
npx wrangler secret put AUTH_PIN
npx wrangler secret put JWT_SECRET
npx wrangler secret put PROXY_HEADER_SECRET
npx wrangler secret put PROXY_TARGET_ORIGIN
```

The Worker reads these values from `env` at runtime.

`PROXY_HEADER_NAME` is set in `wrangler.jsonc` `vars`.
`PROXY_TARGET_ORIGIN` is a required secret binding and should be provided via `.dev.vars` locally or `wrangler secret put` in production.

If you want same-host behavior in production, set `PROXY_TARGET_ORIGIN` to your Worker host or route origin rather than leaving it empty.

Production deploys are not affected by the `package.json` dev/start change; only local `npm.cmd run dev` and `npm.cmd run start` use the development environment.

## Deploy

```powershell
npm.cmd run deploy
```

Wrangler will deploy the Worker defined in `wrangler.jsonc`.

## Rate Limiting

This project uses a Cloudflare Workers rate-limit binding named `PIN_LOGIN_RATE_LIMITER`.

Current config:

- 5 attempts
- 60 second window

The binding also needs a `namespace_id` in `wrangler.jsonc`.

Important:

- `namespace_id` must be a positive integer string
- it must be unique within your Cloudflare account unless you intentionally want to share counters

If `1001` is already in use in your account, change it before deploying.

## Useful Wrangler Commands

Start local dev server:

```powershell
npm.cmd run dev
```

Run tests:

```powershell
npm.cmd test -- --run test/index.spec.ts
```

Regenerate Worker binding types after changing `wrangler.jsonc`:

```powershell
npm.cmd run cf-typegen
```

Deploy:

```powershell
npm.cmd run deploy
```

Add or update production secrets:

```powershell
npx wrangler secret put AUTH_PIN
npx wrangler secret put JWT_SECRET
npx wrangler secret put PROXY_HEADER_SECRET

# Optional: change injected header name from default x-site-proxy-auth
# set in wrangler.jsonc vars as PROXY_HEADER_NAME
```

## Project Files

- `src/index.ts`: Worker entrypoint, auth logic, and authenticated proxy flow
- `wrangler.jsonc`: Worker config, secrets requirements, observability, rate-limit binding
- `.dev.vars.example`: local secret template
- `test/index.spec.ts`: auth tests
- `worker-configuration.d.ts`: generated Worker binding types

## Notes For Cloudflare Beginners

Wrangler is the CLI that manages almost everything for a Worker:

- local dev server
- deployment
- secret management
- generated binding types
- reading config from `wrangler.jsonc`

A useful mental model is:

- `wrangler.jsonc` holds non-secret configuration
- Cloudflare secrets hold sensitive values for deployed Workers
- `.dev.vars` holds local-only secret values for development

## Test

```powershell
npm.cmd test -- --run test/index.spec.ts
```
