# External Integrations

**Analysis Date:** 2026-06-09

## APIs & External Services

**Cinatra Marketplace (MCP publish proxy):**
- Service: `https://marketplace.cinatra.ai`
  - Endpoint: `/wp-json/cinatra/mcp` (MCP over HTTP, Streamable HTTP transport)
  - MCP tool called: `cinatra-extension-submit-for-review`
  - SDK/Client: `@modelcontextprotocol/sdk@^1.29.0` (`Client` + `StreamableHTTPClientTransport`)
  - Auth: `CINATRA_MARKETPLACE_VENDOR_TOKEN` — WordPress application-password (raw) or pre-formed `Bearer`/`Basic` header. Encoded as `Basic base64("<vendor-user>:<token>")` when raw. Vendor user defaults to `cinatra-ai`; overridable via `CINATRA_MARKETPLACE_VENDOR_USER`.
  - Source: `scripts/v622/templates/release/release-submit.mjs`

**GitHub Actions OIDC (source-identity token):**
- Service: GitHub-hosted OIDC endpoint (`ACTIONS_ID_TOKEN_REQUEST_URL`)
  - Purpose: Mints a short-lived, GitHub-signed JWT scoped to `aud=https://marketplace.cinatra.ai`. Sent as `source_identity_token` in the MCP submit call to enable trusted-vendor auto-approve.
  - Auth: `ACTIONS_ID_TOKEN_REQUEST_TOKEN` (runner-injected; not a user secret)
  - Requires: `id-token: write` permission on the workflow job
  - Failure mode: best-effort only — a mint failure routes the submission to manual moderation, never causes publish failure.
  - Source: `.github/workflows/reusable-extension-release.yml` (Submit step, lines ~224–239)

## Data Storage

**Databases:**
- Not applicable — this repo contains no database clients or connection configuration.

**File Storage:**
- Local filesystem only — the packed `.tgz` tarball is written to the runner workspace by `npm pack` and read by `release-submit.mjs` using `node:fs/promises`.

**Caching:**
- Not detected — no caching action or external cache service configured.

## Authentication & Identity

**Auth Provider:**
- WordPress application-password auth against `https://marketplace.cinatra.ai/wp-json/cinatra/mcp`
  - Implementation: `vendorAuthHeader()` in `scripts/v622/templates/release/release-submit.mjs`
  - Token source: `CINATRA_MARKETPLACE_VENDOR_TOKEN` (GitHub org secret)

- GitHub OIDC for source-identity (build provenance)
  - Implementation: inline `curl` + `node` JSON extraction in the submit step of `.github/workflows/reusable-extension-release.yml`
  - Token masked immediately with `::add-mask::` before use

## Monitoring & Observability

**Error Tracking:**
- Not detected — no external error-tracking service (e.g., Sentry) integrated.

**Logs:**
- GitHub Actions native step logs (stdout/stderr).
- `release-submit.mjs` writes submission outcome to stdout (`submission_id`, `status`, `promotion_state`) and diagnostics to stderr. The OIDC token value is explicitly never logged.

## CI/CD & Deployment

**Hosting:**
- GitHub Actions (`ubuntu-latest`) — the workflow is the deployment mechanism.

**CI Pipeline:**
- Reusable workflow: `.github/workflows/reusable-extension-release.yml`
  - Trigger: `workflow_call` (invoked by a thin per-extension-repo `release.yml` caller on `release: published` or `workflow_dispatch` against a tag ref)
  - Actions used:
    - `actions/checkout@v4` — two uses: extension repo checkout and sparse-checkout of this repo's submit tool
    - `actions/setup-node@v4` — Node.js 24 setup
    - `actions/attest-build-provenance@v2` — generates SLSA build provenance attestation for the packed `.tgz`

## Environment Configuration

**Required env vars (secrets):**
- `CINATRA_MARKETPLACE_VENDOR_TOKEN` — submit-scope vendor token (GitHub org secret, required for publish)
- `CINATRA_REGISTRY_TOKEN` — read-scope registry token (optional; required when `registry.cinatra.ai` is not publicly readable)

**Optional env var overrides:**
- `CINATRA_REGISTRY_URL` — registry base URL (default: `https://registry.cinatra.ai`)
- `MARKETPLACE_BASE_URL` — marketplace base URL (default: `https://marketplace.cinatra.ai`)
- `CINATRA_MARKETPLACE_VENDOR_USER` — WP application-password username (default: `cinatra-ai`)
- `CINATRA_SUBMIT_TIMEOUT_MS` — MCP submit call timeout in ms (default: `600000`)

**Secrets location:**
- GitHub org secrets scoped to extension repos and protected release refs (documented in `README.md` and `scripts/v622/templates/release/README.md`); no `.env` files present in this repo.

## Webhooks & Callbacks

**Incoming:**
- Not applicable — this repo contains no webhook receiver endpoints.

**Outgoing:**
- MCP HTTP POST to `https://marketplace.cinatra.ai/wp-json/cinatra/mcp` — initiated by `release-submit.mjs` via `@modelcontextprotocol/sdk` `StreamableHTTPClientTransport`.
- Registry probe HTTP GET to `https://registry.cinatra.ai/<package>` — initiated by `checkDependencyOrdering()` in `release-submit.mjs` for the dependency-ordering gate.

## Dependency Ordering Gate

**Registry:** `https://registry.cinatra.ai`
- Purpose: Before submitting to the marketplace, `release-submit.mjs` verifies that every `@cinatra-ai/*` extension edge declared in the manifest's `cinatra.dependencies` field is already published on the registry (existence-based, not semver-range-aware).
- Skipped: Host-internal `@cinatra-ai/*` SDK/app peers (`sdk-extensions`, `sdk-ui`, `mcp-client`, etc.) that are host-provided under model-B and never on the registry — identified by NOT being declared in `cinatra.dependencies`.
- Auth: `CINATRA_REGISTRY_TOKEN` (optional; registry may allow public read)
- Source: `scripts/v622/templates/release/release-submit.mjs` (`checkDependencyOrdering`, `probeDep`, `selectExtensionDepsToProbe`)

---

*Integration audit: 2026-06-09*
