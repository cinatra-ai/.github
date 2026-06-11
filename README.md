# cinatra-ai org config

Org-shared GitHub configuration for the Cinatra extension marketplace publish pipeline.

## What's here

- **`.github/workflows/reusable-extension-release.yml`** — the central `workflow_call` reusable
  workflow that each extracted extension repo invokes from a thin `release: published` caller. It
  builds the extension from a clean checkout, runs the per-kind gate, runs the packlist leak gate
  (fails the release if `npm pack --dry-run --json` lists `.github/`, `.planning`, `.env*`, tests,
  or CI/tooling config — cinatra-engineering#56), `npm pack`s, attests build provenance, runs the
  dependency-ordering gate, and submits the exact bytes through the marketplace MCP publish-proxy
  (`extension-submit-for-review`) — never a direct Verdaccio publish.
- **`scripts/v622/templates/release/release-submit.mjs`** — the self-contained, portable submit CLI
  the reusable workflow (and manual/local backfill) uses. Needs only `pacote` + `@modelcontextprotocol/sdk`.
- **`workflow-templates/`** — org workflow templates that seed the three required gate callers
  into new repos (see below).

## Workflow templates: seeding the required gate callers into new repos

The org ruleset `baseline-protection` requires three status-check contexts on every default
branch org-wide:

- `source-leak-gate / source-leak-gate`
- `actions-pinned-gate / actions-pinned-gate`
- `gitignore-gate / gitignore-gate`

A ruleset only **requires** the checks — it never pushes workflow files, and GitHub has no
native auto-commit of workflows into new repos. `workflow-templates/` carries the org-standard
thin callers for all three gates so a new repo can be seeded in a few clicks, but **this is
manual opt-in by GitHub's design**: the templates appear under *Actions → New workflow →
"By cinatra-ai"*, and someone still has to add them.

### New-repo checklist

1. Create the repo. The org ruleset applies automatically; `do_not_enforce_on_create=true`
   defers the required checks until the gate callers exist, so the repo is not wedged at birth.
2. Seed the three gate callers — either select all three templates from
   *Actions → New workflow* ("By cinatra-ai"), or copy
   `workflow-templates/{source-leak-gate,actions-pinned-gate,gitignore-gate}.yml` into
   `.github/workflows/`. When copying by hand, replace the `$default-branch` placeholder with
   the repo's default branch (normally `main`) — the Actions UI does this substitution for you.
3. Give the repo a `.gitignore` carrying the org baseline entries (gitignore-gate enforces it,
   e.g. `.planning/` stays untracked) and SHA-pin any additional remote `uses:` refs with a
   version comment (actions-pinned-gate enforces that format).
4. Set the repo's `tier` custom property (baseline / full / exception) per the
   cinatra-engineering#59 classification.

The templates are double-pinned (`uses: …@<sha> # v0.1.0` **and** `with.ref: <sha>`) to the
current `cinatra-ai/ci` v0.1.0 SHA. When v0.1.0 is re-pointed per the documented ci release
policy, update the pins here as part of the same rollout.

## Activation prerequisites (owner/ops)

This pipeline is dormant until:
1. `CINATRA_MARKETPLACE_VENDOR_TOKEN` is set as an org secret (submit scope), scoped to the extension repos.
2. The extension repos exist and carry the thin `release: published` caller (shipped by the v6.22 extractor).
3. `registry.cinatra.ai` is reachable for the dependency-ordering gate (`CINATRA_REGISTRY_TOKEN` read scope,
   or the public-read posture).

See the cinatra repo's `scripts/v622/templates/release/README.md` for the full placement + prerequisite doc.
