# Testing Patterns

**Analysis Date:** 2026-06-09

## Test Framework

**Runner:**
- Not detected — no test framework is installed or configured in this repository
- No `package.json` at the repo root; no `jest.config.*`, `vitest.config.*`, or `mocha` config found

**Assertion Library:**
- Not detected

**Run Commands:**
```bash
# No test runner configured in this repo
# The reusable workflow runs `corepack pnpm test --if-present` in extension repos
```

## Test File Organization

**Location:**
- No test files exist in this repository (`*.test.*` and `*.spec.*` search returned no results)

**Naming:**
- Not applicable

**Structure:**
- Not applicable

## Test Structure

**Suite Organization:**
- Not applicable — no tests exist in this repo

**Key design note:** `scripts/v622/templates/release/release-submit.mjs` is explicitly architected for testability:
- All logic is broken into small, named, exported pure functions (`extractCinatraDeps`, `selectExtensionDepsToProbe`, `classifySubmissionOutcome`, `buildSubmitArguments`, `probeDep`, `checkDependencyOrdering`, etc.)
- Heavy I/O dependencies (`pacote`, `@modelcontextprotocol/sdk`) are lazy-imported only inside `submitTarball`, keeping the module importable with no side effects for unit tests
- The `main()` CLI entry point is gated behind an `invokedDirectly` check so the module loads cleanly in test contexts
- `probeDep` and `checkDependencyOrdering` accept a `fetchImpl` parameter for dependency injection (avoids real HTTP in tests)

## Mocking

**Framework:** Not detected

**Injectable seams available in `release-submit.mjs`:**
- `fetchImpl` parameter in `probeDep` and `checkDependencyOrdering` — pass a mock fetch to avoid real HTTP calls to `registry.cinatra.ai`
- `registryUrl` parameter — can be pointed at a local stub
- Environment variables read at call time (not module load): `CINATRA_MARKETPLACE_VENDOR_TOKEN`, `CINATRA_REGISTRY_TOKEN`, `CINATRA_SOURCE_IDENTITY_TOKEN`, `CINATRA_REGISTRY_URL`, `MARKETPLACE_BASE_URL`, `CINATRA_SUBMIT_TIMEOUT_MS`, `CINATRA_MARKETPLACE_VENDOR_USER`

**What to Mock (if tests are added):**
- `globalThis.fetch` or pass a `fetchImpl` stub to `checkDependencyOrdering`/`probeDep`
- `pacote.manifest` for `submitTarball` (lazy import; use `import.meta` mocking or restructure)
- MCP `Client` transport for the marketplace submit path

**What NOT to Mock:**
- Pure functions: `extractCinatraDeps`, `extractCinatraManifestDepNames`, `selectExtensionDepsToProbe`, `classifySubmissionOutcome`, `buildSubmitArguments`, `formatGateFailure`, `vendorAuthHeader` — test with real inputs

## Fixtures and Factories

**Test Data:**
- Not applicable (no tests exist)
- If added: construct `manifest` objects inline for pure-function tests (no factory needed — they are plain JS objects)

**Location:**
- Not applicable

## Coverage

**Requirements:** None enforced (no test framework or CI coverage gate configured)

**View Coverage:**
```bash
# Not configured
```

## Test Types

**Unit Tests:**
- Not present; strongly implied by the testability architecture of `release-submit.mjs`

**Integration Tests:**
- Not present

**E2E Tests:**
- Not present; the reusable workflow (`.github/workflows/reusable-extension-release.yml`) acts as the functional integration test — it runs `pnpm test --if-present`, typecheck, kind gate, `npm pack`, and marketplace submit in sequence on every real release

## Testing in the Reusable Workflow

The workflow at `.github/workflows/reusable-extension-release.yml` enforces the following gates for non-host-coupled extensions on every release:

1. Version/tag gate (step: `gate`) — tag must equal `v<package.json.version>`; pre-releases skip publish
2. Extension classification (step: `classify`) — detects host-coupled vs. standalone
3. Install (`pnpm install --frozen-lockfile` when lockfile present, fallback to `--no-frozen-lockfile`)
4. Typecheck (`pnpm run typecheck` or `tsc --noEmit`)
5. Test (`corepack pnpm test --if-present`) — runs extension's own test suite
6. Kind gate (`node extension-kind-gate.mjs --package-root .` if present)
7. Pack (`npm pack`)
8. Dependency-ordering gate (inside `release-submit.mjs`) — verifies all `cinatra.dependencies` edges are published on `registry.cinatra.ai`

Host-coupled extensions (those with `@cinatra-ai/*` peer dependencies) skip steps 3–5; the monorepo owns those gates.

## Common Patterns

**Async Testing (if tests are added):**
```javascript
// probeDep accepts fetchImpl injection — test without real HTTP:
const result = await probeDep(
  { name: "@cinatra-ai/some-ext", range: "^1.0.0", field: "dependencies" },
  { registryUrl: "https://registry.cinatra.ai", token: undefined, fetchImpl: mockFetch }
);
```

**Pure Function Testing (no async needed):**
```javascript
// classifySubmissionOutcome is fully pure:
const outcome = classifySubmissionOutcome({ status: "promoted", promotionState: "complete" });
// => { kind: "listed" }

// buildSubmitArguments emits optional fields only when present:
const args = buildSubmitArguments({ namespace: "@cinatra-ai", extensionName: "foo", version: "1.0.0", ... });
```

---

*Testing analysis: 2026-06-09*
