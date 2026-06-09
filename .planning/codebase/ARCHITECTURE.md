<!-- refreshed: 2026-06-09 -->
# Architecture

**Analysis Date:** 2026-06-09

## System Overview

```text
┌──────────────────────────────────────────────────────────────────┐
│              Extension Repo (thin caller)                        │
│   `.github/workflows/release.yml` (examples/release.yml ref)    │
│   Trigger: release: published  OR  workflow_dispatch (tag ref)   │
└────────────────────────┬─────────────────────────────────────────┘
                         │  workflow_call (secrets: inherit)
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│     Reusable Release Workflow (central CI orchestrator)          │
│  `.github/workflows/reusable-extension-release.yml`             │
│                                                                  │
│  Steps (in order):                                               │
│    1. Resolve + gate version (tag == v<pkg.version>)             │
│    2. Classify extension (host-coupled vs. standalone)           │
│    3. Install (pnpm, lockfile if present)                        │
│    4. Typecheck / Test (standalone only)                         │
│    5. Kind gate (extension-kind-gate.mjs in ext repo)            │
│    6. npm pack → tarball                                         │
│    7. actions/attest-build-provenance (OIDC)                     │
│    8. Checkout + install release-submit.mjs deps                 │
│    9. Mint GitHub OIDC source-identity token                     │
│   10. Submit via release-submit.mjs                              │
└────────────────────────┬─────────────────────────────────────────┘
                         │  node release-submit.mjs <tarball>
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│     Submit CLI  `scripts/v622/templates/release/release-submit.mjs` │
│                                                                  │
│  1. Read tarball bytes                                           │
│  2. Derive name/version via pacote                               │
│  3. Dependency-ordering gate (probe registry.cinatra.ai)         │
│  4. sha256 + size + base64-encode                                │
│  5. MCP call: cinatra-extension-submit-for-review                │
│  6. Assert/report submission outcome                             │
└────────────────────────┬─────────────────────────────────────────┘
                         │  MCP StreamableHTTP
                         ▼
┌──────────────────────────────────────────────────────────────────┐
│  Cinatra Marketplace MCP Proxy  (https://marketplace.cinatra.ai) │
│  Tool: cinatra-extension-submit-for-review                       │
│  Outcome: pending moderation  OR  promoted+complete (auto-approve)│
└──────────────────────────────────────────────────────────────────┘
```

## Component Responsibilities

| Component | Responsibility | File |
|-----------|----------------|------|
| Reusable release workflow | CI orchestrator: checkout, gate, build, pack, attest, submit | `.github/workflows/reusable-extension-release.yml` |
| Submit CLI | Standalone portable submit tool: dep-gate + MCP publish proxy call | `scripts/v622/templates/release/release-submit.mjs` |
| Thin caller template | Per-extension-repo `workflow_call` invoker (reference copy) | `examples/release.yml` |

## Pattern Overview

**Overall:** Centralized reusable GitHub Actions workflow pattern — a single source-of-truth workflow called by many thin per-repo callers.

**Key Characteristics:**
- All build/pack/gate/submit logic lives exclusively in this repo's reusable workflow; extension repos carry only a ~40-line caller
- Two-tier gating: (1) tag == `v<package.json.version>` version gate, (2) dependency-ordering gate (all `cinatra.dependencies` edges must be published on registry.cinatra.ai before submission)
- Submit path is MCP-proxied only — direct Verdaccio publish is explicitly forbidden
- Host-coupled extensions (those with `@cinatra-ai/*` peerDependencies) skip install/typecheck/test; the host monorepo owns those gates

## Layers

**CI Orchestration Layer:**
- Purpose: Sequence all release steps with correct permissions, secret injection, and conditional logic
- Location: `.github/workflows/reusable-extension-release.yml`
- Contains: GitHub Actions workflow YAML with 10-step job
- Depends on: GitHub OIDC (id-token: write), org secrets (`CINATRA_MARKETPLACE_VENDOR_TOKEN`, optionally `CINATRA_REGISTRY_TOKEN`)
- Used by: every extracted extension repo's thin `release.yml` caller via `workflow_call`

**Submit CLI Layer:**
- Purpose: Portable, self-contained submit logic runnable in CI or locally
- Location: `scripts/v622/templates/release/release-submit.mjs`
- Contains: dependency-gate logic, MCP client construction, submission outcome classification
- Depends on: `pacote` (tarball manifest extraction), `@modelcontextprotocol/sdk` (MCP client) — both lazy-imported at runtime; Node builtins only at load time
- Used by: reusable release workflow (step 10); also runnable manually for backfill

**Template / Reference Layer:**
- Purpose: Canonical reference copies placed into extracted extension repos by the v6.22 extractor
- Location: `examples/release.yml`, `scripts/v622/templates/release/README.md`
- Contains: thin caller YAML + documentation
- Depends on: this repo at `cinatra-ai/.github` being reachable at the `main` ref

## Data Flow

### Primary Release Path

1. Maintainer publishes a GitHub Release with tag `v<version>` on an extension repo
2. Extension repo's `release.yml` fires `release: published` → calls `cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main` (`.github/workflows/reusable-extension-release.yml` step: `Resolve + gate version`)
3. Version gate validates tag == `v<package.json.version>`; pre-release tags (`-`) exit early (`should_publish=false`)
4. Classify step checks for `@cinatra-ai/*` peerDependencies to set `host_coupled` flag
5. Install → Typecheck → Test → Kind gate (all conditioned on `should_publish && !host_coupled`)
6. `npm pack` produces a deterministic tarball; path stored in `steps.pack.outputs.tarball`
7. `actions/attest-build-provenance@v2` attests the exact tarball bytes
8. `release-submit.mjs` is sparse-checked out from this repo into `$RUNNER_TEMP/cinatra-submit/`
9. GitHub OIDC token minted (audience `https://marketplace.cinatra.ai`) → masked → passed as `CINATRA_SOURCE_IDENTITY_TOKEN`
10. `node release-submit.mjs <tarball>` runs: dep-gate → sha256/size/base64 → MCP `cinatra-extension-submit-for-review` call
11. Marketplace returns `submission_id`, `status`, `promotion_state`; outcome classified and asserted (`scripts/v622/templates/release/release-submit.mjs` `assertSubmissionOutcome`)

### Manual Backfill Path

1. Operator runs `workflow_dispatch` against a `v<version>` tag ref (branch ref fails closed)
2. Same reusable workflow steps execute identically
3. `CINATRA_SOURCE_IDENTITY_TOKEN` may be absent → submission falls to manual moderation (not rejected)

### Dependency-Ordering Gate

1. `selectExtensionDepsToProbe` intersects `cinatra.dependencies` manifest edges with npm `dependencies`/`peerDependencies` (`release-submit.mjs:102`)
2. Host-internal `@cinatra-ai/*` peers NOT in `cinatra.dependencies` are skipped (model-B: host-provided)
3. Each canonical extension edge is probed via HTTP GET against `registry.cinatra.ai`
4. 404 → gate fails; 401/403 → gate fails (unreadable); 200 + no versions → gate fails
5. Any failure throws before the MCP submit call

**State Management:**
- No persistent state in this repo; all state is in GitHub Actions step outputs (`GITHUB_OUTPUT`), tarball bytes on the runner filesystem, and marketplace-side submission records

## Key Abstractions

**`extractCinatraManifestDepNames`:**
- Purpose: Canonical parser for `cinatra.dependencies` in a package.json manifest — produces the authoritative set of cross-extension dependency edge names
- Examples: `scripts/v622/templates/release/release-submit.mjs:80`
- Pattern: Supports three `cinatra.dependencies` shapes: array of `{packageName}` objects, array of strings, or name→spec object

**`selectExtensionDepsToProbe`:**
- Purpose: Reconciles `cinatra.dependencies` edge names with npm `dependencies`/`peerDependencies` to determine which `@cinatra-ai/*` packages to probe on the registry; excludes host-internal model-B peers
- Examples: `scripts/v622/templates/release/release-submit.mjs:102`
- Pattern: Set intersection — only names present in `cinatra.dependencies` are probed

**`classifySubmissionOutcome` / `assertSubmissionOutcome`:**
- Purpose: Map marketplace MCP response fields (`status`, `promotion_state`) to one of four outcomes: `listed`, `failed`, `pending`, `unconfirmed`; throw only on `failed`
- Examples: `scripts/v622/templates/release/release-submit.mjs:150-179`
- Pattern: Fail-closed on promotion failure; warn-and-pass on pending/unconfirmed (legitimate async paths)

**`buildSubmitArguments`:**
- Purpose: Assemble the exact MCP tool arguments for `cinatra-extension-submit-for-review`; optional fields (`description`, `source_identity_token`) emitted only when present for back-compat
- Examples: `scripts/v622/templates/release/release-submit.mjs:256`
- Pattern: Pure function — no side effects, fully unit-testable without pacote/MCP

## Entry Points

**Reusable Workflow (`workflow_call`):**
- Location: `.github/workflows/reusable-extension-release.yml`
- Triggers: `workflow_call` from any extension repo's thin caller on `release: published` or `workflow_dispatch` (tag ref only)
- Responsibilities: Full CI pipeline — version gate, classify, build, pack, attest, submit

**Submit CLI (`main()`):**
- Location: `scripts/v622/templates/release/release-submit.mjs:371`
- Triggers: `node release-submit.mjs <tarball.tgz> [--description "..."] [--skip-dependency-check]`
- Responsibilities: Dependency gate + MCP submit; exits non-zero on any failure

## Architectural Constraints

- **No direct registry publish:** All extension publications go through `marketplace.cinatra.ai` MCP proxy → approval → promotion saga → `registry.cinatra.ai`. Direct Verdaccio publish is explicitly prohibited.
- **Tag-only stable releases:** Pre-release semver tags (containing `-`) are skipped. `workflow_dispatch` on a branch ref fails closed.
- **Host-coupled extension isolation:** Extensions with `@cinatra-ai/*` peerDeps cannot be installed/tested standalone; CI skips those steps and the host monorepo owns those gates.
- **Lazy heavy deps:** `pacote` and `@modelcontextprotocol/sdk` are imported inside the submit path only; the module is importable with no runtime deps (enabling unit tests).
- **OIDC token handling:** Source-identity token is minted, masked, and consumed inside a single step — never written to `GITHUB_OUTPUT`, files, or logs.
- **Install isolation:** Submit tool deps are installed in `$RUNNER_TEMP/cinatra-submit/` outside the extension repo tree to avoid npm peer-resolution conflicts with extension peers.

## Anti-Patterns

### Probing host-internal @cinatra-ai/* peers on the registry

**What happens:** If an `@cinatra-ai/*` peerDependency that is NOT declared in `cinatra.dependencies` were probed against `registry.cinatra.ai`, it would 404 (host-internal packages are never published there).
**Why it's wrong:** Would fail the dependency-ordering gate for valid host-coupled extensions and block all their releases.
**Do this instead:** Only probe deps that appear in `cinatra.dependencies` (the canonical extension-edge set). `selectExtensionDepsToProbe` in `scripts/v622/templates/release/release-submit.mjs:102` enforces this.

### Publishing directly to registry.cinatra.ai (Verdaccio)

**What happens:** Bypassing the MCP proxy to publish a package directly to the Verdaccio registry.
**Why it's wrong:** Skips the marketplace approval step, provenance attestation, promotion saga, and storefront listing — the extension would not appear in the marketplace.
**Do this instead:** Always submit via `cinatra-extension-submit-for-review` through the MCP proxy at `marketplace.cinatra.ai`.

## Error Handling

**Strategy:** Fail-fast with descriptive error messages; exit non-zero propagates through GitHub Actions to fail the workflow run.

**Patterns:**
- Version gate: `echo "::error::..."` + `exit 1` for hard failures; `should_publish=false` output for soft skips (pre-release)
- Dependency gate: throws `Error` with `formatGateFailure` message listing each missing/unreadable/errored dep
- Submission outcome: throws on `promotion_state=failed`; `process.stderr.write` warning (exit 0) on `pending` or `unconfirmed`
- OIDC mint failure: `::warning::` + continues without source-identity token (manual moderation, not rejection)

## Cross-Cutting Concerns

**Logging:** `process.stderr.write` for observability; `process.stdout.write` for machine-readable submit result fields (`submission_id`, `status`, `promotion_state`). GitHub Actions `::error::` / `::warning::` annotations in workflow shell steps.
**Validation:** Tag-version consistency enforced in shell; tarball package name scope enforced in `release-submit.mjs:289`; submission outcome validated via `assertSubmissionOutcome`.
**Authentication:** Three token types — `CINATRA_MARKETPLACE_VENDOR_TOKEN` (WP Basic or Bearer, submit-scope), `CINATRA_REGISTRY_TOKEN` (registry read, optional), `CINATRA_SOURCE_IDENTITY_TOKEN` (GitHub OIDC, transient, for auto-approve).

---

*Architecture analysis: 2026-06-09*
