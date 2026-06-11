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

## Activation prerequisites (owner/ops)

This pipeline is dormant until:
1. `CINATRA_MARKETPLACE_VENDOR_TOKEN` is set as an org secret (submit scope), scoped to the extension repos.
2. The extension repos exist and carry the thin `release: published` caller (shipped by the v6.22 extractor).
3. `registry.cinatra.ai` is reachable for the dependency-ordering gate (`CINATRA_REGISTRY_TOKEN` read scope,
   or the public-read posture).

See the cinatra repo's `scripts/v622/templates/release/README.md` for the full placement + prerequisite doc.
