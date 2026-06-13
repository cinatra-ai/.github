# Cinatra extension release pipeline (placement artifacts)

These files are **placement artifacts**. They are **not active** in the cinatra
monorepo — they are the drop-in source for the org-level release automation that
publishes extracted extensions to the Cinatra Marketplace **through the
marketplace MCP publish-proxy** (`extension-submit-for-review` → approve →
promotion saga → `registry.cinatra.ai`), **never** a direct Verdaccio publish.

## Files

| File | Destination | Role |
|------|-------------|------|
| `reusable-extension-release.yml` | `cinatra-ai/.github/.github/workflows/reusable-extension-release.yml` | The central `workflow_call` workflow: clean checkout → version/tag gate → install → typecheck/test/kind-gate → serverEntry build stage (cinatra#161) → packlist gate → `npm pack` → build-provenance attestation → preflighted, dependency-gated submit. |
| `release-submit.mjs` | `cinatra-ai/.github/scripts/v622/templates/release/release-submit.mjs` | The self-contained, portable submit CLI used by CI **and** manual/local backfill. Runs the serverEntry packed-manifest preflight (cinatra#161 — reads the manifest from the tarball BYTES; refuses a source-mirror serverEntry the runtime store could never install) and the dependency-ordering gate, then calls `extension-submit-for-review` with the exact CI-built bytes. Needs only `pacote` + `@modelcontextprotocol/sdk` (lazy-imported at submit time); the serverEntry preflight lazy-imports the sibling `build-server-entry.mjs` only when the packed manifest declares a serverEntry. |
| `build-server-entry.mjs` | `cinatra-ai/.github/scripts/v622/templates/release/build-server-entry.mjs` | The serverEntry builder (cinatra#161): byte-synced placement copy of the CANONICAL `scripts/extensions/build-server-entry.mjs` in the cinatra monorepo (pinned there by an SDK parity-table test + the first-party install e2e; the copy in `extension-release-tooling` is pinned by a golden-output test that executes it standalone). Bundles a declared `cinatra.serverEntry` (TS source, exports-key resolved) into a top-level `register.mjs` in a staged temp pack dir and rewrites the PACKED manifest (`serverEntry: "./register.mjs"`, inlined runtime `dependencies` pruned, `files` += `register.mjs`). Keep all three copies byte-identical (`diff` must be empty). |
| `../extension-repo/.github/workflows/release.yml` | every extracted extension repo (shipped by the extractor) | The thin `release: published` caller that invokes the reusable workflow. |

## Owner-gated prerequisites (none of this runs until these land)

1. The `cinatra-ai/.github` repo exists and holds `reusable-extension-release.yml`
   + `release-submit.mjs` + `build-server-entry.mjs` at the paths above.
2. `CINATRA_MARKETPLACE_VENDOR_TOKEN` is set as a **GitHub org secret**
   (submit-scope only — never an admin-approve or Verdaccio-publish token),
   scoped to extension repos + protected release refs.
3. The job grants `id-token: write` so the dependency-ordering gate can mint a
   GitHub Actions OIDC token (`aud=https://marketplace.cinatra.ai`) and verify the
   `@cinatra-ai/*` closure through the OIDC-gated marketplace ability
   `cinatra/extension-dependency-exists` (broker-mediated). The gate never reads
   `registry.cinatra.ai` directly — those reads are ACL-gated to the install-broker
   (whose token is, by design, not in Actions). `CINATRA_REGISTRY_TOKEN` is
   deprecated/unused for the CI gate.

## How a publish happens

1. Maintainer publishes a GitHub Release on the extension repo with tag
   `v<package.json.version>` (semver; pre-release tags are skipped).
2. The repo's `release.yml` caller invokes the reusable workflow.
3. The reusable workflow builds from a clean checkout. When the manifest
   declares `cinatra.serverEntry` (first-party connectors), the build stage
   bundles it into a top-level `register.mjs` in a STAGED pack dir whose
   rewritten manifest satisfies the runtime store's built-artifacts-only
   contract (cinatra#161) — packing then runs from that stage. It then packs,
   attests provenance, runs the serverEntry packed-manifest preflight + the
   dependency-ordering gate, and submits the exact bytes through the
   marketplace proxy.
4. The marketplace approves (manually, or — once trusted-vendor auto-approve
   ships — automatically) and the promotion saga publishes to the registry.

## Deferred hardening (explicitly out of scope for the initial drop-in)

- **Committed per-repo lockfile.** Extracted repos currently ship no
  `pnpm-lock.yaml`; the reusable workflow installs `--frozen-lockfile` when one is
  present and falls back to a fresh resolve otherwise. Committing a lockfile per
  repo (for fully reproducible CI builds) is a later step.
- **Marketplace-side provenance verification.** The reusable workflow *generates*
  a build-provenance attestation now. The trusted-vendor auto-approve path
  *verifying* that attestation before trusting a first-party release is a later step.
- **OIDC → short-lived vendor JWT.** The submit token is a long-lived org secret
  for now; exchanging a GitHub OIDC token for a short-lived vendor JWT is a later
  hardening.
- **SHA-pinned actions.** This template uses major-version action tags (matching
  the extracted-repo `ci.yml` convention); pin to commit SHAs when placed, per the
  v6.27 supply-chain policy.
