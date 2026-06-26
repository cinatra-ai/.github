# cinatra-ai/.github

Org-shared GitHub configuration for the Cinatra extension marketplace publish pipeline.

This is the [`cinatra-ai` org config repository](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/creating-a-default-community-health-file). It holds the org-wide Renovate config, reusable CI workflows, workflow templates that seed the three required gate callers into new repos, and the portable release-submit CLI.

## What's here

| Path | Purpose |
|------|---------|
| `.github/workflows/reusable-extension-release.yml` | Central `workflow_call` reusable workflow for publishing a Cinatra marketplace extension (build → gate → pack → attest → submit). |
| `.github/workflows/reusable-release-notes.yml` | Thin reusable workflow that decorates non-extension repos' GitHub Releases with auto-generated PR-list notes. |
| `.github/workflows/source-leak-gate.yml` | Thin caller for the org-wide source-leak gate (via `cinatra-ai/ci`). |
| `.github/workflows/actions-pinned-gate.yml` | Thin caller for the actions-pinned gate. |
| `.github/workflows/gitignore-gate.yml` | Thin caller for the gitignore gate. |
| `.github/workflows/secret-scan-gate.yml` | Thin caller for the secret-scan gate (TruffleHog). |
| `.github/workflows/truthful-attribution-gate.yml` | Thin caller for the truthful-attribution gate (WARN mode). |
| `workflow-templates/` | Org workflow templates that seed the three required gate callers into new repos (see [New-repo checklist](#new-repo-checklist)). |
| `scripts/v622/templates/release/release-submit.mjs` | Self-contained, portable submit CLI used by `reusable-extension-release.yml` and manual backfills. Needs only `pacote` + `@modelcontextprotocol/sdk`. |
| `examples/` | Copy-me reference files for extension-repo maintainers. Nothing in `examples/` runs in this repo itself. |
| `renovate-config.json` | Org-wide Renovate defaults. Repos extend this as `local>cinatra-ai/.github:renovate-config`. |

## Reusable workflows

### Extension release (`reusable-extension-release.yml`)

Called by each extension repo's thin `release: published` caller. On a published GitHub Release tagged `v<package.json.version>`, the workflow:

1. Checks out the extension repo at the release tag (clean checkout).
2. Gates that `tag == v<package.json.version>` and skips pre-release versions (any version containing a `-`).
3. Installs and runs `typecheck` / `test` / the per-kind `extension-kind-gate.mjs`.
4. Runs the **packlist leak gate**: fails if `npm pack --dry-run --json` lists any non-distributable path (`.github/`, `.planning`, `.env*` except `.env.example`, tests/fixtures, CI/tooling config). The fix is a `package.json` `files` allowlist.
5. `npm pack`s the exact bytes and attests build provenance.
6. Runs the **dependency-ordering gate** (every `@cinatra-ai/*` dependency must already be published).
7. Submits the exact bytes through the marketplace MCP publish-proxy (`cinatra-extension-submit-for-review`). Never a direct Verdaccio publish.
8. Decorates the tag's GitHub Release with auto-generated "What's Changed" PR-list notes and attaches the tarball + `SHA256SUMS.txt` (requires `contents: write` in the caller; degrades gracefully to a warning with only `contents: read`).

See [`examples/README.md`](examples/README.md) for full wiring instructions.

### Release notes (`reusable-release-notes.yml`)

For repos that cut `v*` tags but do not publish an npm package. Creates or backfills the tag's GitHub Release with auto-generated PR-list notes. Requires only `contents: write` and no secrets. Copy [`examples/github-release.yml`](examples/github-release.yml) into the caller repo.

## Installation

There is nothing to install in this repository itself — it is an org configuration repo that GitHub reads automatically.

**Consume the Renovate preset** in any `cinatra-ai` repo by adding or updating its `renovate.json`:

```json
{
  "$schema": "https://docs.renovatebot.com/renovate-schema.json",
  "extends": ["local>cinatra-ai/.github:renovate-config"]
}
```

**Wire up the extension release pipeline** by copying `examples/release.yml` into the extension repo at `.github/workflows/release.yml`. See [`examples/README.md`](examples/README.md) for the complete step-by-step.

**Seed the three required gate callers** into a new repo via *Actions → New workflow → "By cinatra-ai"*, or by copying `workflow-templates/{source-leak-gate,actions-pinned-gate,gitignore-gate}.yml` into the repo's `.github/workflows/`. See the [New-repo checklist](#new-repo-checklist) below.

**Wire up GitHub Release decoration** (non-extension repos) by copying `examples/github-release.yml` into the repo at `.github/workflows/github-release.yml` and replacing the all-zeros SHA placeholder with the current commit SHA of `cinatra-ai/.github main`.

## Renovate config

`renovate-config.json` is the org-wide Renovate preset (see [Installation](#installation) for how to extend it). The preset pins Action digests via `helpers:pinGitHubActionDigests`, schedules weekly Monday runs before 06:00 Europe/Berlin, disables automerge, and enables the dependency dashboard. The `cinatra-ai/ci` reusable workflow callers use coordinated org rollout waves instead of Renovate automation (both the `uses:@<sha>` and `with.ref` pins must move together).

## New-repo checklist

The org ruleset `baseline-protection` requires three status-check contexts on every default branch:

- `source-leak-gate / source-leak-gate`
- `actions-pinned-gate / actions-pinned-gate`
- `gitignore-gate / gitignore-gate`

A ruleset only requires the checks — it never pushes workflow files into new repos. `workflow-templates/` carries the org-standard thin callers for all three gates so a new repo can be seeded in a few clicks via *Actions → New workflow → "By cinatra-ai"*, but this remains **manual opt-in by GitHub's design**.

1. Create the repo. The org ruleset applies automatically; `do_not_enforce_on_create=true` defers the required checks until the gate callers exist, so the repo is not wedged at birth.
2. Seed the three gate callers — select all three templates from *Actions → New workflow* ("By cinatra-ai"), or copy `workflow-templates/{source-leak-gate,actions-pinned-gate,gitignore-gate}.yml` into `.github/workflows/`. When copying by hand, replace the `$default-branch` placeholder with the repo's actual default branch name (e.g. `main`). The Actions UI performs this substitution automatically.
3. Add a `.gitignore` carrying the org baseline entries (the gitignore-gate enforces it; for example, `.planning/` must be listed so it stays untracked). SHA-pin any additional remote `uses:` refs with a version comment (`uses: owner/repo/.github/workflows/foo.yml@<sha> # vX.Y.Z`) — the actions-pinned-gate enforces that format.
4. Set the repo's `tier` custom property (`baseline` / `full` / `exception`) per the org classification.

The workflow templates are double-pinned (both a `uses: …@<sha>` SHA and a `with.ref: <sha>` input) to a specific `cinatra-ai/ci` release SHA. When a new `cinatra-ai/ci` release is rolled out, update both pins here as part of the same rollout.

## What belongs here vs elsewhere

| Belongs here | Belongs elsewhere |
|---|---|
| Org-wide Renovate config | Repo-specific Renovate overrides (in each repo's `renovate.json`) |
| Reusable CI workflows (`workflow_call`) | Thin caller workflows that invoke the reusables (in each extension repo) |
| Workflow templates for new-repo seeding | CI gate implementation (in `cinatra-ai/ci`) |
| Portable release-submit CLI and examples | Extension-specific build configuration |

## Development

This repo has no build step. To make changes:

1. Fork or create a branch from `main`.
2. Edit the relevant workflow or config file.
3. Run a Markdown link check on any changed `README.md` files (e.g. `npx markdown-link-check README.md`) and confirm internal links resolve correctly in the GitHub-rendered view.
4. For workflow template changes, verify the `$default-branch` placeholder is preserved — the Actions UI performs the substitution; hand-copied files need a manual find-and-replace.
5. For reusable workflow changes that add or rename inputs, update `examples/README.md` and `examples/release.yml` to match.
6. Open a PR; all three gate callers run on this repo itself, so the PR must pass `source-leak-gate`, `actions-pinned-gate`, and `gitignore-gate`.

## Troubleshooting

**A new repo's required checks are stuck / never green**

The most common cause is that the three gate caller workflows have not been added yet. Follow the [New-repo checklist](#new-repo-checklist) and confirm the files are committed to the default branch.

**`actions-pinned-gate` fails on a workflow I just added**

Every remote `uses:` reference must be pinned to a full commit SHA with a version comment on the same line: `uses: owner/repo/.github/workflows/foo.yml@<40-char-sha> # vX.Y.Z`. A bare tag or branch ref will fail the gate.

**`gitignore-gate` fails after adding a new file pattern**

The gate checks that each repo's `.gitignore` contains the org baseline entries. Add the flagged pattern (e.g. `.planning/`) to the repo's `.gitignore` and commit.

**`source-leak-gate` flags a line in README or a comment**

The gate runs in ratchet mode: it compares net-new lines in the diff against a set of disallowed tokens. If a new README line matches a leak token, rephrase the line to avoid the pattern. Do not edit the baseline ratchet file to suppress the finding.

**The packlist leak gate fails on an extension release**

Add a `files` allowlist to the extension's `package.json` that explicitly lists only the distributable paths (compiled output, `package.json`, `README`, `LICENSE`). Files outside the allowlist are excluded from the pack and the gate passes.

**A `workflow_dispatch` backfill fails on `reusable-release-notes.yml`**

The dispatch runs from the **default branch** and passes the existing tag via the `tag:` input (see `examples/github-release.yml`). The workflow then looks up the tag and decorates its Release. If the `tag:` input is left empty on a dispatch from a branch HEAD, the reusable workflow will exit with an error because no tag ref is being pushed. Pass the tag name in the `tag` input field when dispatching.

## Canonical references

- [`cinatra-ai/ci`](https://github.com/cinatra-ai/ci) — CI gate implementations (source-leak-gate, actions-pinned-gate, gitignore-gate, secret-scan-gate, truthful-attribution-gate, and others).
- [`cinatra-ai/ci/docs/release-contract.md`](https://github.com/cinatra-ai/ci/blob/main/docs/release-contract.md) — Org-wide release contract: what each release carries per repo type, packlist rules, `package.json files` allowlist convention, `.gitattributes export-ignore` rules.
- [`examples/README.md`](examples/README.md) — Full wiring instructions for extension-repo maintainers: caller setup, org secret placement, release steps, and the guarantees the pipeline provides.
