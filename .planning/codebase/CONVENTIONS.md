# Coding Conventions

**Analysis Date:** 2026-06-09

## Overview

This repository is a small org-config repo containing one reusable GitHub Actions workflow and one standalone ESM submit CLI script. There is no application src/ tree. Conventions are observed in `scripts/v622/templates/release/release-submit.mjs` and `.github/workflows/reusable-extension-release.yml`.

## Naming Patterns

**Files:**
- kebab-case for all files: `release-submit.mjs`, `reusable-extension-release.yml`
- Descriptive hyphenated names that convey role and scope

**Functions:**
- camelCase for all exported and internal functions: `extractCinatraDeps`, `selectExtensionDepsToProbe`, `checkDependencyOrdering`, `probeDep`, `buildSubmitArguments`, `classifySubmissionOutcome`, `assertSubmissionOutcome`, `formatGateFailure`, `assertDependencyOrdering`, `vendorAuthHeader`
- Exported pure functions are prefixed with intent verbs: `extract*`, `select*`, `check*`, `probe*`, `build*`, `classify*`, `assert*`, `format*`
- Internal/async impure functions use verb-noun form: `submitTarball`, `main`

**Variables:**
- camelCase: `tarballBytes`, `tarballPath`, `extensionName`, `artifactDigestSha256`, `submissionId`, `promotionState`, `sourceIdentityToken`
- SCREAMING_SNAKE_CASE for exported constants: `CINATRA_SCOPE`, `DEFAULT_REGISTRY_URL`, `MARKETPLACE_BASE_URL`
- SCREAMING_SNAKE_CASE for environment variable names: `CINATRA_MARKETPLACE_VENDOR_TOKEN`, `CINATRA_REGISTRY_TOKEN`, `CINATRA_SOURCE_IDENTITY_TOKEN`

**Types:**
- No TypeScript — pure ESM JavaScript (`release-submit.mjs`)
- JSDoc-style inline comments describe shape expectations informally

## Code Style

**Formatting:**
- No formatter config file detected in this repo (no `.prettierrc`, `.eslintrc`, `biome.json`)
- Consistent 2-space indentation observed throughout `release-submit.mjs`
- Trailing commas on multi-line object/array literals
- Double quotes for strings (consistent throughout)
- Arrow functions for small callbacks; named `async function` declarations for top-level exported/private functions

**Linting:**
- No linter config detected; no `package.json` at repo root

## Import Organization

**Order in `release-submit.mjs`:**
1. Node built-in imports (`node:fs/promises`, `node:path`, `node:url`, `node:crypto`)
2. Heavy third-party dependencies (`pacote`, `@modelcontextprotocol/sdk`) are lazy-imported inside the submit path only — never at module load time

**Path Aliases:**
- Not applicable (no build system, no tsconfig)

## Error Handling

**Patterns:**
- Throwing `new Error(...)` with descriptive messages for validation failures
- `try/finally` used in MCP client lifecycle to ensure `client.close()` always runs
- `catch (() => {})` used only for intentionally ignorable cleanup errors (e.g., `client.close()`)
- Async HTTP errors caught per-call in `probeDep`; each result carries a `state` discriminant (`"satisfied"`, `"missing"`, `"unreadable"`, `"error"`)
- `assertDependencyOrdering` and `assertSubmissionOutcome` follow an assert-or-throw pattern for fatal cases
- Non-fatal anomalies use `process.stderr.write(...)` with a `⚠` warning prefix instead of throwing
- `main()` uses `.catch((err) => { console.error(...); process.exit(1); })` for top-level CLI error termination
- Shell steps in the workflow use `set -euo pipefail` for safe bash execution

**Security-sensitive handling:**
- OIDC token is minted and consumed within a single workflow step — never written to `GITHUB_OUTPUT`, files, or logs
- Token values are masked with `echo "::add-mask::${CINATRA_SOURCE_IDENTITY_TOKEN}"` before use
- Token presence is reported ("present"/"absent") but value is never printed: `process.stderr.write(sourceIdentityToken ? "ℹ source-identity OIDC token present…" : "ℹ no source-identity OIDC token…")`

## Logging

**Framework:** `process.stderr.write(...)` for operational output; `process.stdout.write(...)` for machine-parseable submission result fields

**Patterns:**
- Observational/status messages → `process.stderr.write()`
- Structured key-value output (submission_id, status, promotion_state) → `process.stdout.write()`
- Warnings prefixed with `⚠` and info messages prefixed with `ℹ`
- GitHub Actions annotations used in workflow steps: `echo "::error::..."`, `echo "::warning::..."`, `echo "::add-mask::..."`

## Comments

**When to Comment:**
- Top-of-file block comment explaining the file's role, flow, token usage, and relationship to other pipeline components
- Inline `//` comments preceding every non-obvious logic block, especially security decisions and gate rationale
- Comments explicitly call out deferred hardening, known limitations, and cross-module synchronization requirements

**JSDoc/TSDoc:**
- Not used; comments are plain-text prose above function definitions and inline

## Function Design

**Size:** Functions are small and single-purpose; complex logic is split into `extract*`, `select*`, `check*`, `format*`, `assert*` helpers before the top-level `submitTarball`

**Parameters:** Object destructuring with defaults for multi-parameter functions (e.g., `checkDependencyOrdering({ manifest, registryUrl = DEFAULT_REGISTRY_URL, token, fetchImpl = globalThis.fetch } = {})`)

**Return Values:** Result objects carry discriminant fields (`state`, `kind`, `ok`) enabling callers to branch without instanceof checks; `assert*` functions throw on failure and return the result on success

## Module Design

**Exports:** Named exports for all pure/testable functions; no default export from `release-submit.mjs`
- Exported: `CINATRA_SCOPE`, `DEFAULT_REGISTRY_URL`, `MARKETPLACE_BASE_URL`, `extractCinatraDeps`, `extractCinatraManifestDepNames`, `selectExtensionDepsToProbe`, `vendorAuthHeader`, `classifySubmissionOutcome`, `assertSubmissionOutcome`, `probeDep`, `checkDependencyOrdering`, `formatGateFailure`, `assertDependencyOrdering`, `buildSubmitArguments`

**Barrel Files:** Not applicable (single script file)

**CLI guard:** The `main()` function is gated with an `invokedDirectly` check (`process.argv[1]` vs `import.meta.url`) so the module is importable for unit tests without side effects

---

*Convention analysis: 2026-06-09*
