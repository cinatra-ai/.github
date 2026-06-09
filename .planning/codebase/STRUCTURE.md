# Codebase Structure

**Analysis Date:** 2026-06-09

## Directory Layout

```
cinatra-ai/.github/   (repo root)
├── README.md                               # Repo overview and activation prerequisites
├── .github/
│   └── workflows/
│       └── reusable-extension-release.yml # Central reusable workflow_call workflow
├── examples/
│   ├── README.md                           # Placement guidance for extension repos
│   └── release.yml                         # Reference thin caller for extension repos
└── scripts/
    └── v622/
        └── templates/
            └── release/
                ├── README.md               # Placement + prerequisite doc for v6.22
                └── release-submit.mjs      # Self-contained submit CLI
```

## Directory Purposes

**`.github/workflows/`:**
- Purpose: Active GitHub Actions workflows for THIS org-level repo
- Contains: The single reusable `workflow_call` workflow that extension repos invoke
- Key files: `.github/workflows/reusable-extension-release.yml`

**`examples/`:**
- Purpose: Reference/canonical copies of files that get placed into extracted extension repos
- Contains: The thin per-repo release caller YAML and its placement README
- Key files: `examples/release.yml`, `examples/README.md`

**`scripts/v622/templates/release/`:**
- Purpose: Versioned (v6.22) placement artifacts — files shipped into repos and referenced by the reusable workflow
- Contains: The portable submit CLI and its documentation
- Key files: `scripts/v622/templates/release/release-submit.mjs`, `scripts/v622/templates/release/README.md`

## Key File Locations

**Entry Points:**
- `.github/workflows/reusable-extension-release.yml`: The `workflow_call` entry point — triggered by extension repo callers on `release: published` or `workflow_dispatch`
- `scripts/v622/templates/release/release-submit.mjs`: CLI entry point (`main()` at line 371) — invoked by the reusable workflow and usable manually

**Configuration:**
- `README.md`: Activation prerequisites (org secret names, registry posture)
- `scripts/v622/templates/release/README.md`: Full placement + prerequisite documentation

**Core Logic:**
- `scripts/v622/templates/release/release-submit.mjs`: All submit logic — dependency-ordering gate, MCP client, outcome classification, argument assembly

**Reference Templates:**
- `examples/release.yml`: Canonical thin caller for extension repos

## Naming Conventions

**Files:**
- Workflow YAML: `kebab-case.yml` — e.g., `reusable-extension-release.yml`
- ESM scripts: `kebab-case.mjs` — e.g., `release-submit.mjs`
- Documentation: `README.md` (uppercase)

**Directories:**
- Versioned script templates: `scripts/v<MAJOR><MINOR>/templates/<area>/` — e.g., `scripts/v622/templates/release/`
- GitHub Actions conventions: `.github/workflows/`

## Where to Add New Code

**New reusable workflow:**
- Primary code: `.github/workflows/<name>.yml`

**New versioned placement script (for a new extractor version):**
- Implementation: `scripts/v<XYZ>/templates/<area>/<script>.mjs`
- Documentation: `scripts/v<XYZ>/templates/<area>/README.md`

**New reference template for extension repos:**
- Implementation: `examples/<template-name>.yml` or `examples/<template-name>.mjs`

**Updated submit CLI (same extractor version):**
- Implementation: `scripts/v622/templates/release/release-submit.mjs` (edit in-place; the reusable workflow fetches from `main` at CI time)

## Special Directories

**`scripts/v622/`:**
- Purpose: Placement artifacts versioned to the v6.22 extractor release
- Generated: No (hand-authored)
- Committed: Yes

**`.github/workflows/`:**
- Purpose: Active GitHub Actions workflows callable by extension repos via `cinatra-ai/.github/.github/workflows/reusable-extension-release.yml@main`
- Generated: No
- Committed: Yes

---

*Structure analysis: 2026-06-09*
