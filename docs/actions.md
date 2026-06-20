# GitHub Actions: Web Workflow

This document describes the workflow in `.github/workflows/web.yml`.

## Workflow Name

- `Vue App`

## Triggers

The workflow runs on:

- `workflow_dispatch`
- `pull_request` to `main` when files under `vue-tracker/**` or `.github/workflows/web.yml` change
- `push` to `main` when files under `vue-tracker/**` or `.github/workflows/web.yml` change

## Global Permissions

- `contents: read`
- `packages: read`

## Jobs Overview

The workflow has three jobs:

1. `ci` (build and package)
2. `release` (create GitHub release)
3. `deploy` (deploy static app via Cloudflare Worker)

Execution flow:

- `ci` runs first
- `release` runs after `ci`
- `deploy` runs after `release` succeeds

## Job: `ci`

Purpose:

- Build the `vue-tracker` app and publish a zip artifact.

Key behavior:

- Runs in `vue-tracker` as working directory
- Checks out repository
- Temporarily disables local `.npmrc` if present
- Computes semantic version using GitVersion
- Sets up Node.js 24 and installs dependencies with `npm ci`
- Builds app (`npm run build`) with `VITE_APP_VERSION` from GitVersion output
- Creates zip from `vue-tracker/dist`
- Uploads artifact:
  - Name: `vue-tracker-dist`
  - File: `vue-tracker-dist.zip`
  - Retention: 30 days

## Job: `release`

Purpose:

- Create a GitHub release and attach the packaged web artifact.

Runs when:

- Event is `push`
- Ref is `refs/heads/main` or a tag starting with `refs/tags/v`

Dependencies:

- `needs: ci`

Environment:

- `production-release`

Permissions:

- `contents: write`
- `packages: write`

Key behavior:

- Checks out repository
- Temporarily disables local `.npmrc` if present
- Computes version with GitVersion
- Downloads `vue-tracker-dist` artifact
- Creates release with `gh release create`
- Uses release tag/title format: `v<semver>-web`
- Attaches artifact as `package`

## Job: `deploy`

Purpose:

- Deploy the previously built artifact as static assets via Cloudflare Worker.

Runs when:

- Event is `push`
- Ref is `refs/heads/main` or a tag starting with `refs/tags/v`

Dependencies:

- `needs: release`
- This ensures deploy only runs after release succeeds.

Environment:

- `production-deploy`

Permissions:

- `contents: read`

Key behavior:

- Checks out repository
- Temporarily disables local `.npmrc` if present
- Sets up Node.js 24
- Installs `vue-tracker` dependencies
- Downloads `vue-tracker-dist` artifact
- Unzips artifact into `deploy-dist`
- Deploys static assets via Wrangler Worker deploy:
  - `wrangler deploy --config vue-tracker/wrangler.jsonc --assets deploy-dist --commit-dirty=true`
- Uses Worker static asset routing defined in `wrangler.jsonc`:
  - `assets.directory`: static content root
  - `assets.not_found_handling: single-page-application`: Vue Router fallback to `index.html`

Required GitHub configuration:

- Secrets:
  - `CLOUDFLARE_API_TOKEN`
  - `CLOUDFLARE_ACCOUNT_ID`

## Related Project Files

- `.github/workflows/web.yml`
- `vue-tracker/package.json` (Wrangler scripts and dependency)
- `vue-tracker/wrangler.jsonc` (Wrangler Worker static assets config)
