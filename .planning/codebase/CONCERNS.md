# Codebase Concerns

**Analysis Date:** 2026-06-09

## Tech Debt

**No committed lockfile for extracted extension repos:**
- Issue: Extracted extension repos ship no `pnpm-lock.yaml`. The reusable workflow falls back to a fresh resolve (`--no-frozen-lockfile`) when no lockfile is present, making CI builds non-reproducible — dependency versions can drift between runs.
- Files: `.github/workflows/reusable-extension-release.yml` (lines 122–127), `scripts/v622/templates/release/README.md` (deferred hardening section)
- Impact: Build reproducibility is not guaranteed for the majority of extension repos. A dependency minor/patch bump between the pack and a later audit could cause silent behavioral differences.
- Fix approach: The README explicitly defers this. Ship a `pnpm-lock.yaml` with every extracted repo via the v6.22 extractor template.

**Actions pinned to major version tags, not commit SHAs:**
- Issue: All `uses:` references in `.github/workflows/reusable-extension-release.yml` use floating major-version tags (`actions/checkout@v4`, `actions/setup-node@v4`, `actions/attest-build-provenance@v2`). The deferred hardening section in `scripts/v622/templates/release/README.md` explicitly notes the v6.27 supply-chain policy requires SHA-pinning.
- Files: `.github/workflows/reusable-extension-release.yml` (lines 50, 52, 166)
- Impact: A compromised or force-updated major-version tag can inject arbitrary code into the privileged CI job that holds `id-token: write` (OIDC token capable of minting source-identity tokens) and `attestations: write`.
- Fix approach: Pin each action to its full commit SHA with a comment naming the tag for auditability.

**Long-lived org secret for marketplace submission:**
- Issue: `CINATRA_MARKETPLACE_VENDOR_TOKEN` is a long-lived GitHub org secret. The README and workflow comments explicitly mark OIDC-for-short-lived-JWT exchange as deferred hardening.
- Files: `scripts/v622/templates/release/README.md` (deferred hardening section), `.github/workflows/reusable-extension-release.yml` (lines 33–38, 209)
- Impact: If the org secret is leaked or rotated poorly it grants submit-scope marketplace access indefinitely. Short-lived, cryptographically-scoped tokens are the safer posture.
- Fix approach: Implement OIDC → short-lived vendor JWT exchange on the marketplace side and update the submit step to mint the token via OIDC at run time.

**Dependency-ordering gate is existence-only, not semver-aware:**
- Issue: `release-submit.mjs`'s `checkDependencyOrdering` only checks that a dependency package has at least one published version on `registry.cinatra.ai`. It does not verify that the declared semver range is satisfiable. A dependency at `^1.0.0` can pass the gate even if only `0.9.9` is published.
- Files: `scripts/v622/templates/release/release-submit.mjs` (lines 181–223)
- Impact: Extensions may be submitted and approved against a dependency version range that cannot actually be satisfied at install time. The comment in the code acknowledges the dev CLI (`extensions-dependency-gate.mjs`) does the semver-aware check, but CI does not.
- Fix approach: Extend `probeDep` to check whether any published version satisfies the declared range (using semver), mirroring the logic in the monorepo dev CLI.

**`classifySubmissionOutcome` treats ambiguous states as warnings, not failures:**
- Issue: When a submission returns `status=approved, promotion_state=failed`, the workflow does not fail the CI run — it only emits a warning. An extension that is "approved" but fails promotion is not actually listed on the storefront.
- Files: `scripts/v622/templates/release/release-submit.mjs` (lines 150–178), `assertSubmissionOutcome` function
- Impact: A failed promotion that is silently warned about will not trigger re-submission or alerting automatically. The README notes reconciliation is needed, but this is a manual step.
- Fix approach: Treat `promotion_state=failed` as a hard CI failure (non-zero exit code). The existing `assertSubmissionOutcome` already throws for this case — verify the throw propagates all the way to `process.exit(1)` in the workflow.

## Known Bugs

**`probeDep` URL encodes only the `/` in scoped package names:**
- Symptoms: `probeDep` encodes the package name with `dep.name.replace("/", "%2F")` — a single non-global replace. If a package name somehow contains more than one `/` (malformed scope), only the first is encoded.
- Files: `scripts/v622/templates/release/release-submit.mjs` (line 185)
- Trigger: Edge case; standard npm scoped names have exactly one `/`. Not an active bug for well-formed `@cinatra-ai/*` names, but a latent fragility if the function is used with arbitrary package names.
- Workaround: None needed currently. Use `encodeURIComponent(dep.name)` for correctness.

**OIDC mint error is silently swallowed:**
- Symptoms: The `curl` OIDC mint call in the submit step uses `|| true`, meaning a network error or a non-zero HTTP status from the OIDC endpoint causes a silent fallthrough to submitting without a source-identity token. A warning is logged only if the parsed token value is empty.
- Files: `.github/workflows/reusable-extension-release.yml` (lines 224–238)
- Trigger: OIDC endpoint transient failure or misconfiguration.
- Workaround: The publish continues without auto-approve eligibility; manual moderation picks it up. The behavior is intentional per the comment ("BEST-EFFORT"), but a transient OIDC failure could silently route a trusted-vendor release to manual review.

## Security Considerations

**`id-token: write` permission is job-level:**
- Risk: The `id-token: write` permission is declared at the job level, meaning every step — including the `npm install --ignore-scripts` step — runs with an active `ACTIONS_ID_TOKEN_REQUEST_URL` and `ACTIONS_ID_TOKEN_REQUEST_TOKEN` in the environment. The workflow comment acknowledges this and uses `--ignore-scripts` as mitigation, but the permission cannot be narrowed further without splitting jobs.
- Files: `.github/workflows/reusable-extension-release.yml` (lines 44–46, 187–204)
- Current mitigation: `npm install --ignore-scripts` prevents lifecycle code from running during the install step. The comment notes this is belt-and-suspenders.
- Recommendations: Split the workflow into two jobs — one that installs and builds (no `id-token: write`) and one that attests and submits (with `id-token: write`). This eliminates the permission from all install/build steps.

**Marketplace-side provenance attestation is not yet verified:**
- Risk: The reusable workflow generates a build-provenance attestation (`actions/attest-build-provenance@v2`) and submits the tarball, but the marketplace's trusted-vendor auto-approve path does not yet verify the attestation before trusting the submission. Until verification is implemented, attestation is cosmetic for the auto-approve path.
- Files: `.github/workflows/reusable-extension-release.yml` (lines 165–169), `scripts/v622/templates/release/README.md` (deferred hardening section)
- Current mitigation: Manual moderation is the fallback. The attestation artifact is generated and stored for future verification.
- Recommendations: Implement attestation verification in the marketplace trusted-vendor auto-approve policy (explicitly noted as deferred).

**`--skip-dependency-check` flag is undocumented but functional:**
- Risk: `release-submit.mjs` accepts a `--skip-dependency-check` flag that bypasses the dependency-ordering gate entirely. If a maintainer invokes this for local backfill it can publish an extension whose dependency closure is not yet on the registry, breaking install for consumers.
- Files: `scripts/v622/templates/release/release-submit.mjs` (lines 306–309, 382)
- Current mitigation: The flag emits a visible warning to stderr. It is not exposed as a workflow input (so it cannot be passed via CI without modifying the workflow).
- Recommendations: Document the flag's risk prominently in the README and consider removing it or requiring an explicit confirmation.

**`workflow_dispatch` on caller allows manual backfill from any tag:**
- Risk: `examples/release.yml` exposes `workflow_dispatch: {}` with no input restriction. A maintainer who dispatches on a non-`v<version>` tag would get a clear error, but the empty dispatch definition provides no in-UI guidance to run against a tag rather than a branch.
- Files: `examples/release.yml` (line 31)
- Current mitigation: The reusable workflow enforces `ref_type == tag` for dispatch and fails closed on a branch ref.
- Recommendations: Add a `ref` input to the caller with a description instructing the user to provide a `v<version>` tag, improving UX and reducing operator error.

## Performance Bottlenecks

**Sequential dependency probe (no parallelism):**
- Problem: `checkDependencyOrdering` probes each `@cinatra-ai/*` dependency sequentially with `for ... await probeDep(...)`.
- Files: `scripts/v622/templates/release/release-submit.mjs` (lines 215)
- Cause: Sequential `for` loop over `probeDep` calls, each making an HTTP request.
- Improvement path: Use `Promise.all(deps.map(dep => probeDep(...)))` to probe all dependencies in parallel. Low priority for typical extension dependency counts (single digits), but worth fixing for correctness with large closures.

**600-second MCP submit timeout:**
- Problem: `SUBMIT_TIMEOUT_MS` defaults to 600,000 ms (10 minutes). A hanging marketplace or network partition will hold the CI runner for the full timeout before failing.
- Files: `scripts/v622/templates/release/release-submit.mjs` (line 51)
- Cause: Generous timeout chosen for slow promotion sagas. No intermediate heartbeat or progress log.
- Improvement path: Add periodic stderr progress messages during the MCP call, and consider a shorter default with an explicit override for known-slow paths.

## Fragile Areas

**Inline shell OIDC token parsing (Node one-liner via stdin):**
- Files: `.github/workflows/reusable-extension-release.yml` (lines 228–229)
- Why fragile: The OIDC response body is piped through a Node.js one-liner that reads stdin, parses JSON, and extracts `.value`. Any change to the OIDC response shape (or a partial response from a rate-limited endpoint) silently produces an empty token string and falls back to manual moderation, with no indication that the mint itself succeeded or failed.
- Safe modification: Extract token parsing into a tested helper script (e.g., a small `.mjs` in `scripts/`) with proper error handling. Load it in the workflow step.
- Test coverage: None — the inline shell one-liner is not unit-tested.

**`extractCinatraManifestDepNames` supports multiple input shapes:**
- Files: `scripts/v622/templates/release/release-submit.mjs` (lines 80–92)
- Why fragile: The `cinatra.dependencies` field can be an array of objects `{packageName}`, an array of strings, or a name→spec object. Three distinct code paths must all agree on what constitutes a valid edge. A new shape added to the manifest spec requires updating all three branches.
- Safe modification: Validate `cinatra.dependencies` shape against a schema before parsing and reject unknown shapes explicitly rather than silently ignoring them.
- Test coverage: Not visible in this repo (tests would live in the monorepo). The exported functions are testable but no test files exist here.

## Scaling Limits

**Workflow is a single reusable job with no matrix strategy:**
- Current capacity: One extension publish per workflow run, sequentially.
- Limit: If many extensions are released simultaneously (e.g., during a wave publish), each runs its own independent workflow run. This is fine for marketplace throughput but may hit GitHub Actions concurrency limits for the org.
- Scaling path: The dependency-ordering gate already handles wave ordering; no changes needed unless org-level concurrency becomes a bottleneck.

## Dependencies at Risk

**`pacote@^21` and `@modelcontextprotocol/sdk@^1.29.0` installed at runtime without a lockfile:**
- Risk: The submit tool's two runtime dependencies are installed fresh on each CI run with `npm install --no-package-lock`. A breaking patch or compromised package at these coordinates could affect every extension publish.
- Files: `.github/workflows/reusable-extension-release.yml` (line 204)
- Impact: Supply-chain risk in the publish path. `--ignore-scripts` reduces code execution risk during install, but version drift is still possible.
- Migration plan: Commit a minimal `package.json` + `package-lock.json` for the submit tool in `scripts/v622/templates/release/` and use `npm ci` in the workflow step.

## Missing Critical Features

**No post-submit reconciliation or alerting in CI:**
- Problem: When a submission enters `status=pending` (manual moderation) or `promotion_state=failed`, the CI job exits 0 with a warning. There is no automated follow-up, webhook, or notification to the submitting team.
- Blocks: Teams cannot distinguish a successful auto-approve publish from one silently routed to manual review without checking the marketplace dashboard manually.

**No test files in this repo:**
- Problem: `release-submit.mjs` exports all its logic as testable pure functions (`extractCinatraDeps`, `selectExtensionDepsToProbe`, `classifySubmissionOutcome`, `buildSubmitArguments`, `probeDep`, etc.) with a comment explicitly noting they are unit-testable without pacote/MCP. No test files exist in this repository.
- Blocks: Regressions in gate logic, submission outcome classification, or URL encoding are not caught before deployment.

## Test Coverage Gaps

**All exported logic in `release-submit.mjs` is untested in this repo:**
- What's not tested: `extractCinatraDeps`, `extractCinatraManifestDepNames`, `selectExtensionDepsToProbe`, `classifySubmissionOutcome`, `assertSubmissionOutcome`, `buildSubmitArguments`, `vendorAuthHeader`, `probeDep`, `checkDependencyOrdering`, `formatGateFailure`.
- Files: `scripts/v622/templates/release/release-submit.mjs`
- Risk: The dependency-ordering gate and submission outcome classification are the two correctness-critical paths. A logic error (e.g., wrong 401-vs-404 classification, wrong edge extraction) will silently pass during code review and only surface at publish time.
- Priority: High

**Reusable workflow shell logic is untested:**
- What's not tested: The version/tag gate shell script (`Resolve + gate version` step), the host-coupled classifier (`Classify extension` step), and the OIDC mint+parse one-liner.
- Files: `.github/workflows/reusable-extension-release.yml` (lines 62–96, 108–117, 224–239)
- Risk: A shell quoting error or logic regression in the version gate could silently allow publishing from a mismatched tag, or fail to block pre-release versions.
- Priority: Medium

---

*Concerns audit: 2026-06-09*
