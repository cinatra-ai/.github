# Wiring an extension repo to the marketplace release pipeline

This directory is a **copy-me reference** for extension-repo maintainers. Nothing
here runs in `cinatra-ai/.github` itself — the active automation is the reusable
workflow at [`.github/workflows/reusable-extension-release.yml`](../.github/workflows/reusable-extension-release.yml)
and the portable submit CLI at
[`scripts/v622/templates/release/release-submit.mjs`](../scripts/v622/templates/release/release-submit.mjs).

## What the pipeline does (P703 — SUBMIT only)

On a **published GitHub Release** whose tag is `v<package.json.version>`, the
caller invokes the central reusable workflow, which:

1. checks out the extension repo at the release tag (clean checkout),
2. gates `tag == v<package.json.version>` and **skips** pre-release versions
   (any version containing a `-`),
3. installs (`--frozen-lockfile` if a `pnpm-lock.yaml` is committed, else a fresh
   resolve), then runs `typecheck` / `test` / the per-kind `extension-kind-gate.mjs`,
4. runs the **packlist leak gate**: the release **fails** if `npm pack --dry-run
   --json` lists any non-distributable path — `.github/`, `.planning`, `.env*`
   (except `.env.example`), key material, tests/fixtures, or CI/build/lint
   tooling config (`tsconfig*.json`, bundler/test-runner configs, …). npm's
   force-included root `package.json` / `README*` / `LICENSE*` never flag; the
   fix in a flagged repo is a package.json `files` **allowlist**,
5. `npm pack`s the exact bytes and attests **build provenance** for that tarball,
6. runs the existence-based **dependency-ordering gate** (every `@cinatra-ai/*`
   dependency must already be published on `registry.cinatra.ai`),
7. **submits** the exact bytes through the marketplace MCP publish-proxy by calling
   the `cinatra-extension-submit-for-review` tool at
   `https://marketplace.cinatra.ai/wp-json/cinatra/mcp`,
8. after a successful submit, **decorates the tag's GitHub Release**: auto-generated
   "What's Changed" PR-list notes (backfilled only when the release body is empty —
   author-written notes are never overwritten; a `workflow_dispatch` backfill on a
   bare tag creates the Release with `--verify-tag`, never the tag itself) and
   attaches the **exact packed tarball + `SHA256SUMS.txt`**. Requires the caller to
   grant `contents: write` (see [`release.yml`](./release.yml)); with only
   `contents: read` the submit still succeeds and this step degrades to a warning.

Approval (human moderator, or trusted-vendor auto-approve once it ships) and the
promotion saga to `registry.cinatra.ai` happen **on the marketplace side** — CI
never publishes to Verdaccio.

## Step 1 — add the caller to your extension repo

Copy [`release.yml`](./release.yml) into your extension repo at
`.github/workflows/release.yml`. It is `uses: cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main`
with `secrets: inherit`. (The extension-repo extractor already ships an identical caller
into every extracted repo — copy this only when hand-wiring or auditing.)

## Step 2 — set the org secret (owner / org-admin)

The reusable workflow requires one org secret:

| Secret | Scope | Purpose |
|--------|-------|---------|
| **`CINATRA_MARKETPLACE_VENDOR_TOKEN`** | submit-only | Authenticates the `cinatra-extension-submit-for-review` MCP call. **Submit scope only** — never an admin-approve token, never a Verdaccio-publish token. |

The dependency-ordering gate needs **no** registry secret: the caller grants
`id-token: write` (already in `examples/release.yml`) and the gate mints a GitHub
Actions OIDC token (`aud=https://marketplace.cinatra.ai`) to verify the
`@cinatra-ai/*` closure through the OIDC-gated ability
`cinatra/extension-dependency-exists` (broker-mediated). It never reads the
registry directly.

Deprecated/unused:

| Secret | Scope | Purpose |
|--------|-------|---------|
| `CINATRA_REGISTRY_TOKEN` | read-only | **Deprecated/unused.** The gate no longer reads `registry.cinatra.ai` directly — it goes through the OIDC-gated marketplace ability. Safe to drop; kept (optional) only so existing callers that still pass it do not error. |

Set them at **Org → Settings → Secrets and variables → Actions → New organization
secret**, and under **Repository access** choose **Selected repositories** — add
only the extension repos that are allowed to publish (an allowlist; do **not**
grant the secret to all repos).

## Step 3 — release

Publish a GitHub Release on the extension repo with tag `v<package.json.version>`
(e.g. `v1.4.0` for `"version": "1.4.0"`). The caller fires, builds, and submits.
A mismatched or pre-release tag is skipped, not published.

`workflow_dispatch` is available for a manual backfill, but it **must** be run
against a `v<version>` tag ref — a dispatch on a branch HEAD fails closed so a
stable version can never publish from the default branch.

## Guarantees

- **SUBMIT only.** The pipeline calls the marketplace publish-proxy; it never runs
  `npm publish` / `pnpm publish` and never writes to `registry.cinatra.ai`
  (Verdaccio) directly.
- **No repo mutation.** It never deletes, archives, renames, or force-pushes any
  repository — it reads the extension at the tag and submits a tarball. The only
  write is additive Release decoration on the already-cut tag (notes + assets);
  it **never creates tags** (`--verify-tag` fails closed on a missing tag).
- **No self-approve.** The CI token is submit-scope; approval is a separate,
  trusted authority (human moderator or trusted-vendor policy).

## Non-extension repos: GitHub Release decoration

Repos that cut `v*` tags but do **not** publish an npm package (plain repos,
PHP/deploy repos) get the same *tag → shipped-PRs* traceability from a separate,
much thinner reusable workflow:
[`.github/workflows/reusable-release-notes.yml`](../.github/workflows/reusable-release-notes.yml).
Copy [`github-release.yml`](./github-release.yml) into the repo at
`.github/workflows/github-release.yml` and pin the `uses:` ref to a commit SHA.
It creates (or backfills, when the body is empty) the tag's GitHub Release with
auto-generated PR-list notes; it needs only `contents: write` and **no
secrets**. Semver gate, annotated-tag requirement, `--verify-tag` and the
never-overwrite-authored-notes rule are enforced inside the reusable workflow.

## The org-wide release contract

What a release carries per repo type (core / npm extensions / non-extension
repos), the packlist leak gate, the package.json `files` allowlist convention
and the `.gitattributes export-ignore` source-archive rules are documented in
one page:
[`cinatra-ai/ci/docs/release-contract.md`](https://github.com/cinatra-ai/ci/blob/main/docs/release-contract.md).
