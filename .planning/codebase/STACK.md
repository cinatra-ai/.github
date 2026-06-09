# Technology Stack

**Analysis Date:** 2026-06-09

## Languages

**Primary:**
- JavaScript (ESM) — `scripts/v622/templates/release/release-submit.mjs` (the submit CLI)
- YAML — `.github/workflows/reusable-extension-release.yml`, `examples/release.yml`

**Secondary:**
- Not applicable — no TypeScript, Python, or other language files present.

## Runtime

**Environment:**
- Node.js 24 (default; configurable via the `node-version` workflow input, defaulting to `"24"`)
- Runs inside GitHub Actions `ubuntu-latest` runners

**Package Manager:**
- pnpm (via `corepack enable` in CI) — no version pinned in this repo
- Lockfile: not committed (deferred hardening; noted in `scripts/v622/templates/release/README.md`)
- Extension repos may ship `pnpm-lock.yaml`; the workflow uses `--frozen-lockfile` when present and falls back to a fresh resolve otherwise

## Frameworks

**Core:**
- None — `release-submit.mjs` is a self-contained ESM CLI with no framework dependency.

**Testing:**
- Not detected in this repo (no test config or test files present).

**Build/Dev:**
- `npm pack` — used inside the reusable workflow to produce the publishable tarball from a clean checkout.
- `corepack pnpm` — used for extension `install`, `typecheck`, and `test` steps inside the reusable workflow.
- `tsc --noEmit` — invoked as a fallback typecheck when `typescript` is a dev dependency and no `typecheck` script exists.

## Key Dependencies

**Runtime (lazy-imported inside `release-submit.mjs` at submit time):**
- `pacote@^21` — reads the packument/manifest out of the packed `.tgz` to extract `name`, `version`, and dependency metadata.
- `@modelcontextprotocol/sdk@^1.29.0` — MCP client used to call the marketplace `cinatra-extension-submit-for-review` tool over `StreamableHTTPClientTransport`.

These two dependencies are installed at CI runtime in an isolated temp dir (`$RUNNER_TEMP/cinatra-submit`) with `--ignore-scripts` to prevent lifecycle code from accessing the OIDC token. They are NOT declared in a `package.json` in this repo.

**Node.js builtins used directly:**
- `node:fs/promises` (`readFile`)
- `node:path` (`resolve`)
- `node:url` (`fileURLToPath`)
- `node:crypto` (`createHash` — SHA-256 digest of the tarball)

## Configuration

**Environment (secrets — existence noted, contents not read):**
- `CINATRA_MARKETPLACE_VENDOR_TOKEN` — GitHub org secret; submit-scope vendor token for the marketplace MCP proxy. Required.
- `CINATRA_REGISTRY_TOKEN` — optional read-scope token for `registry.cinatra.ai` dependency probing.
- `CINATRA_SOURCE_IDENTITY_TOKEN` — GitHub OIDC token (minted inline in the submit step), scoped to `https://marketplace.cinatra.ai`. Enables trusted-vendor auto-approve; optional.
- `CINATRA_MARKETPLACE_VENDOR_USER` — override for the WP application-password username (default: `cinatra-ai`).
- `CINATRA_REGISTRY_URL` — override for the registry base URL (default: `https://registry.cinatra.ai`).
- `MARKETPLACE_BASE_URL` — override for the marketplace base URL (default: `https://marketplace.cinatra.ai`).
- `CINATRA_SUBMIT_TIMEOUT_MS` — override for the MCP call timeout (default: `600000` ms).

**Build:**
- `.github/workflows/reusable-extension-release.yml` — the central reusable workflow definition (the only active workflow config in this repo).

## Platform Requirements

**Development:**
- Node.js 24+
- `pacote` and `@modelcontextprotocol/sdk` available (installed at runtime in CI; must be available locally for manual backfill)

**Production:**
- GitHub Actions (`ubuntu-latest`) — the workflow is GitHub-Actions-native and uses `actions/checkout@v4`, `actions/setup-node@v4`, `actions/attest-build-provenance@v2`
- OIDC (`id-token: write` permission) required for build-provenance attestation and source-identity token minting

---

*Stack analysis: 2026-06-09*
