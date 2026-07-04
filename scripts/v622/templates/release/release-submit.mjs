#!/usr/bin/env node
// ---------------------------------------------------------------------------
// release-submit — the self-contained, portable shared submit CLI used by BOTH
// the reusable release workflow (CI) and manual/local backfill. It is
// intentionally standalone (no @cinatra-ai/cli dependency — the
// monorepo CLI is private) so it can run inside any extracted extension repo's
// CI by installing only two public deps at runtime: pacote and
// @modelcontextprotocol/sdk. It has NO module-load dependency (only Node
// builtins) so it imports cleanly for unit tests; pacote + the MCP SDK are
// lazy-imported inside the submit path, and the sibling build-server-entry.mjs
// (shared serverEntry resolver/classifier) is lazy-imported ONLY when the
// packed manifest declares `cinatra.serverEntry`.
//
// Flow:
//   1. Read the CI-built tarball bytes.
//   2. serverEntry preflight (cinatra#161): read the PACKED manifest from the
//      tarball bytes; when it declares `cinatra.serverEntry`, the resolved entry
//      must be a BUILT, present, Node-importable artifact (the runtime package
//      store refuses anything else at install time) — refuse to submit otherwise.
//   3. Derive name + version from the tarball's package.json (pacote).
//   4. Dependency-ordering gate: every @cinatra-ai/* EXTENSION EDGE declared in the
//      manifest's canonical `cinatra.dependencies` must already be PUBLISHED — which
//      happens by publishing it THROUGH the marketplace, never by direct registry
//      publish — fail BEFORE submit otherwise. Existence is determined by the
//      deployed, OIDC-gated marketplace ability `cinatra/extension-dependency-exists`
//      (broker-mediated): registry.cinatra.ai reads are ACL-gated to the install-broker
//      and the broker's read token is, by design, NOT in GitHub Actions, so the gate
//      cannot read the registry directly (a direct GET 401s in CI). Instead the gate
//      presents the GitHub Actions OIDC identity token (aud=marketplace) and the
//      ability returns ONLY booleans through the broker. Host-internal SDK/app peers
//      are host-provided under model-B and are SKIPPED (never declared as an edge).
//   5. sha256 + size; base64.
//   6. Call `cinatra-extension-submit-for-review` over MCP with the exact bytes.
//
// Tokens: CINATRA_MARKETPLACE_VENDOR_TOKEN (the submit-scope GitHub org secret, for
// the submit MCP call) and CINATRA_DEP_GATE_IDENTITY_TOKEN (a GitHub Actions OIDC
// token, aud=marketplace, minted by the reusable workflow for the dependency-gate
// ability call — see below). Every marketplace source-identity ability consumes a
// SINGLE-USE jti — one token authenticates exactly ONE ability call — so the caret
// RESOLVE path (which runs AFTER the gate has consumed the dep-gate token) mints a
// FRESH token PER resolve call from the runner's ambient OIDC endpoint
// ({@link mintCiOidcToken}) instead of reusing either pre-minted token.
//
// Gate scope vs. the dev CLI: this portable gate is EXISTENCE-based — it asks
// "is every @cinatra-ai/* EXTENSION EDGE (cinatra.dependencies) published at all?",
// which is the ordering guarantee that matters (a public repo can't install an
// unpublished sibling extension). It deliberately does NOT do semver
// range-satisfaction; the marketplace re-validates exact version compatibility at
// approval, and the dev-side packages/cli/src/extensions-dependency-gate.mjs adds
// the semver-aware check for local use.
//
// FAIL-CLOSED: the gate is the ordering guarantee, so EVERY auth/availability error
// is fatal and is NEVER allowed to read as "missing+pass" or to silently pass. A
// `false` from the ability => missing (a real ordering violation); an absent token,
// a 401/403/502 from the ability, an MCP transport error, or any ambiguous/partial/
// non-boolean result => fatal. The only escape hatch is the explicit
// `--skip-dependency-check` flag (manual/local backfill where the closure is
// independently known-published).
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const CINATRA_SCOPE = "@cinatra-ai/";
// Canonical install-backend registry URL. The dependency-ordering gate no longer
// reads it DIRECTLY (the broker-mediated ability owns the registry read — see the
// gate below), but it is kept as the canonical constant the dev-side semver gate
// (packages/cli/src/extensions-dependency-gate.mjs) shares for parity.
export const DEFAULT_REGISTRY_URL = "https://registry.cinatra.ai";
export const MARKETPLACE_BASE_URL = "https://marketplace.cinatra.ai";
const MCP_ROUTE = "/wp-json/cinatra/mcp";
// The deployed dependency-existence ability is registered as the WP ability
// `cinatra/extension-dependency-exists`; the MCP adapter exposes it as the tool
// name below (the WP ability id with `/`→`-`, the same convention by which
// `cinatra/extension-submit-for-review` is called as
// `cinatra-extension-submit-for-review`).
export const DEP_EXISTS_TOOL_NAME = "cinatra-extension-dependency-exists";
// The RESOLUTION ability (distinct from the booleans-only existence ability
// above, whose contract is untouched): given a first-party name + a caret range,
// it returns the HIGHEST promoted+reconciled version that satisfies the range
// (SemVer order, prereleases excluded), or fails closed if none. Used to turn a
// `semver-range` caret into the deterministic exact pin the marketplace
// reconciler requires — so a dependent declaring `^0.1.0` need not re-pin an
// exact version by hand at each dependency release.
export const DEP_RESOLVE_TOOL_NAME = "cinatra-extension-dependency-resolve";
// The deployed ability caps a batch at 64 names (one single-use OIDC jti
// authenticates exactly one batched call). A manifest declaring more first-party
// extension edges than this is implausible — but the gate must FAIL CLOSED with a
// clear error rather than silently truncate (which could let an unprobed,
// unpublished edge slip through the ordering guarantee).
export const DEP_EXISTS_MAX_NAMES = 64;
// Strict first-party scoped-name shape, mirroring the deployed ability's
// NAME_PATTERN exactly. A declared edge that does not match is an authoring error;
// the gate refuses it (fail-closed) instead of sending an ambiguous name.
export const DEP_NAME_PATTERN = /^@cinatra-ai\/[a-z0-9][a-z0-9_.-]*$/;
// The submit MCP call runs the promotion saga INLINE (stage-publish → final-publish →
// verify-digest → storefront read-back), which can exceed the MCP SDK's 60s default
// request timeout under rate-limit backoff or registry/WooCommerce slowness. Use a
// generous explicit timeout so a slow-but-succeeding publish is never falsely reported
// as a failure. Override via CINATRA_SUBMIT_TIMEOUT_MS.
const SUBMIT_TIMEOUT_MS = Number(process.env.CINATRA_SUBMIT_TIMEOUT_MS || 600_000);
// The dependency-existence ability is a cheap broker-mediated read (no saga). A
// modest explicit timeout fails fast; on timeout/transport failure the gate does NOT
// retry — the OIDC token's single-use jti may already have been consumed server-side,
// so a retry would need a freshly minted token. Override via CINATRA_DEP_GATE_TIMEOUT_MS.
const DEP_GATE_TIMEOUT_MS = Number(process.env.CINATRA_DEP_GATE_TIMEOUT_MS || 60_000);

// The marketplace OIDC audience every source-identity ability verifies — the same
// value the reusable release workflow mints the two pre-minted tokens with.
export const MARKETPLACE_OIDC_AUDIENCE = "https://marketplace.cinatra.ai";

// Mint a FRESH GitHub Actions OIDC identity token (aud=marketplace) from the
// runner's ambient endpoint (ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN — exposed to
// EVERY step of a job granted `id-token: write`, which the blessed reusable
// release workflow grants). Every marketplace source-identity ability consumes a
// SINGLE-USE jti per call, so each ability call needs its OWN token: the
// dependency-ordering gate consumes CINATRA_DEP_GATE_IDENTITY_TOKEN with its ONE
// batched existence call, the submit consumes CINATRA_SOURCE_IDENTITY_TOKEN —
// REUSING either for a caret resolve call is a deterministic replay rejection
// (403 "The source identity does not satisfy the dependency-resolution policy",
// audit reason `token_replayed`). Returns null when no ambient endpoint exists
// (manual/local runs) so the caller can fail closed with an actionable message;
// an endpoint that ERRORS is fatal (throw) — never silently tokenless.
export async function mintCiOidcToken({ audience = MARKETPLACE_OIDC_AUDIENCE, fetchImpl = fetch, env = process.env } = {}) {
  const requestUrl = env.ACTIONS_ID_TOKEN_REQUEST_URL;
  const requestBearer = env.ACTIONS_ID_TOKEN_REQUEST_TOKEN;
  if (!requestUrl || !requestBearer) return null;
  const sep = requestUrl.includes("?") ? "&" : "?";
  let res;
  try {
    res = await fetchImpl(`${requestUrl}${sep}audience=${encodeURIComponent(audience)}`, {
      headers: { Authorization: `Bearer ${requestBearer}` },
    });
  } catch (err) {
    throw new Error(`OIDC mint request failed: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!res || !res.ok) {
    throw new Error(`OIDC mint failed: HTTP ${res?.status ?? "?"} from the runner's id-token endpoint.`);
  }
  const body = await res.json();
  const value = body?.value;
  return typeof value === "string" && value !== "" ? value : null;
}

// --- dependency-ordering gate (existence-based; the @cinatra-ai/* extension-edge
//     SELECTION mirrors packages/cli/src/extensions-dependency-gate.mjs; existence
//     itself is now resolved via the broker-mediated marketplace ability — boolean
//     result vs fatal ability error — not a direct registry 401-vs-404 probe) -----
export function extractCinatraDeps(manifest) {
  const out = [];
  const seen = new Set();
  for (const field of ["dependencies", "peerDependencies"]) {
    const deps = manifest?.[field];
    if (!deps || typeof deps !== "object") continue;
    for (const [name, range] of Object.entries(deps)) {
      if (!name.startsWith(CINATRA_SCOPE)) continue;
      const key = `${name}@${range}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, range: String(range ?? ""), field });
    }
  }
  return out;
}

// Canonical cross-extension edge names from the manifest's `cinatra.dependencies`
// (array of `{packageName}`, array of strings, or a name→spec object). Mirrors
// scripts/marketplace/extension-wave-runner.mjs `extractCinatraManifestDepNames`.
// This is the AUTHORITATIVE extension-edge set: only these @cinatra-ai/* deps are
// real marketplace dependencies that must be on the registry first. Host-internal
// SDK/app packages (sdk-extensions, sdk-ui, mcp-client, …) are NEVER declared here —
// under model-B they are host-provided OPTIONAL peers, intentionally not on any
// registry, so the ordering gate must SKIP them (probing would 404/401).
export function extractCinatraManifestDepNames(manifest) {
  const c = manifest?.cinatra?.dependencies;
  const out = new Set();
  if (Array.isArray(c)) {
    for (const e of c) {
      if (e && typeof e === "object" && typeof e.packageName === "string") out.add(e.packageName);
      else if (typeof e === "string") out.add(e.startsWith("@") ? e : `${CINATRA_SCOPE}${e}`);
    }
  } else if (c && typeof c === "object") {
    for (const k of Object.keys(c)) out.add(k);
  }
  return [...out];
}

// Select which @cinatra-ai/* deps the ordering gate must verify on the registry:
// ONLY the canonical extension edges declared in `cinatra.dependencies`. An npm
// dep/peer that is NOT a declared edge is host-internal (a host-provided peer) and
// is SKIPPED. An edge declared ONLY in `cinatra.dependencies` (no npm dep entry —
// e.g. linkedin→social-media, resend→email) is still probed with range "*".
// `skippedNonManifestCinatraDeps` surfaces the excluded names for transparency
// (a precise label: an authoring error that omits a real edge from
// `cinatra.dependencies` would land here, not "host-internal" overclaim).
export function selectExtensionDepsToProbe(manifest) {
  const edgeNames = new Set(extractCinatraManifestDepNames(manifest));
  const npmDeps = extractCinatraDeps(manifest);
  const toProbe = [];
  const seen = new Set();
  for (const d of npmDeps) {
    if (edgeNames.has(d.name) && !seen.has(d.name)) {
      toProbe.push(d);
      seen.add(d.name);
    }
  }
  for (const name of edgeNames) {
    if (!seen.has(name)) {
      toProbe.push({ name, range: "*", field: "cinatra.dependencies" });
      seen.add(name);
    }
  }
  const skippedNonManifestCinatraDeps = npmDeps.filter((d) => !edgeNames.has(d.name)).map((d) => d.name);
  return { toProbe, skippedNonManifestCinatraDeps };
}

// An EXACT semver (MAJOR.MINOR.PATCH with an optional -prerelease/+build) — the
// only version shape that can be a deterministic, vendor-declared pin. This MUST
// be byte-for-byte the strict SemVer 2.0 grammar the marketplace reconciler uses
// in ExtensionManifest::isExactSemver (no leading zeros on numeric identifiers;
// well-formed pre-release/build identifiers) — a looser regex here would let the
// tool emit a sidecar the reconciler then REJECTS, breaking "reconcilable by
// construction". A `semver-range` that is itself an exact semver is the only
// range form the reconciler accepts as a singleton; `*`/`^`/`~`/comparators are
// NOT, and are refused below (fail-closed).
const EXACT_SEMVER =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9]\d*|\d*[a-zA-Z-][0-9a-zA-Z-]*))*))?(?:\+([0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*))?$/;

// A STRICT caret over an exact MAJOR.MINOR.PATCH core, no prerelease/build — the
// ONLY range shape the sidecar builder will resolve (via the resolve ability) to
// an exact pin. Everything else a `semver-range` might carry (`*`, `~`, a
// comparator set, a caret with a prerelease) stays fail-closed `unsupported`,
// matching the marketplace reconciler's v1 grammar extension (strict `^X.Y.Z`).
const CARET_RANGE = /^\^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Build the marketplace `deps` SIDECAR — the vendor-declared exact-identity cover
// of the artifact's REQUIRED extension closure. The marketplace reconciler
// (ExtensionManifest::reconcile) diffs the artifact's `cinatra.dependencies`
// REQUIRED runtime/install-time projection against this sidecar and REFUSES the
// submit if any required edge has no satisfying pin ("Declared deps do not
// reconcile with the artifact manifest"). The older wave path supplied this; the
// portable submit tool MUST restore it or any connector with a real required edge
// (e.g. resend→email-connector, twenty→crm-connector) fails submit.
//
// FAIL-CLOSED on ambiguity (codex-converged): a required edge MUST carry an
// authoritative, deterministic EXACT version — either `versionConstraint
// {kind:"exact",version}` or a `{kind:"semver-range",range}` whose range is
// itself an exact semver. A `*`/`^`/`~`/comparator range, a `git-ref`, or a
// missing constraint is REFUSED here (never inferred from the connector's own
// version, npm, or any registry read) — the same v1 grammar the reconciler
// enforces, so the sidecar this builds is reconcilable by construction.
//
// Returns an array of exact final identities "@<ns>/<ext>@<version>", or throws.
export async function buildRequiredDepsSidecar(manifest, { resolveRange } = {}) {
  const c = manifest?.cinatra?.dependencies;
  if (c == null) return [];
  const edges = [];
  if (Array.isArray(c)) {
    for (const e of c) {
      if (e && typeof e === "object" && typeof e.packageName === "string") edges.push(e);
    }
  }
  // The string / name→spec manifest forms carry no per-edge requirement or
  // constraint, so they cannot declare a REQUIRED runtime/install-time edge that
  // needs a sidecar pin — only the object-edge form does. (extractCinatraManifestDepNames
  // already covers the string/object forms for the existence-only ordering gate.)
  const sidecar = [];
  const seen = new Set();
  for (const edge of edges) {
    if (edge.requirement !== "required") continue;
    if (edge.edgeType !== "runtime" && edge.edgeType !== "install-time") continue;
    const name = edge.packageName;
    const vc = edge.versionConstraint;
    let version = "";
    if (vc && typeof vc === "object") {
      if (vc.kind === "exact" && typeof vc.version === "string" && EXACT_SEMVER.test(vc.version)) {
        version = vc.version;
      } else if (vc.kind === "semver-range" && typeof vc.range === "string") {
        if (EXACT_SEMVER.test(vc.range)) {
          // A range that is itself an exact semver — a singleton pin (as before).
          version = vc.range;
        } else if (CARET_RANGE.test(vc.range)) {
          // A strict caret — resolve it to the highest PROMOTED+RECONCILED exact
          // version via the broker resolve ability. The resolver is injected by
          // the submit flow (the real MCP callTool) / by tests (a fake). If none
          // is available (no OIDC token / not in CI), fail CLOSED rather than
          // guess an inexact or drifting pin.
          if (typeof resolveRange !== "function") {
            throw new Error(
              `submit deps sidecar: required ${edge.edgeType} edge "${name}" declares a caret range ${JSON.stringify(vc.range)} ` +
                `but no dependency resolver is available (not running in CI with an ambient OIDC endpoint). ` +
                `A caret must resolve to the highest PROMOTED+RECONCILED version via the marketplace resolve ability. ` +
                `Refusing to submit (fail-closed).`,
            );
          }
          version = await resolveRange(name, vc.range);
          if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
            throw new Error(
              `submit deps sidecar: resolving caret ${JSON.stringify(vc.range)} for "${name}" did not yield an exact version ` +
                `(got ${JSON.stringify(version ?? null)}). Fail-closed.`,
            );
          }
        }
      }
    }
    if (!version) {
      throw new Error(
        `submit deps sidecar: required ${edge.edgeType} edge "${name}" has no deterministic exact version ` +
          `(versionConstraint=${JSON.stringify(vc ?? null)}). The marketplace reconciler needs an exact pin: ` +
          `declare versionConstraint {kind:"exact",version:"X.Y.Z"} (or a strict caret "^X.Y.Z" resolvable to a ` +
          `PROMOTED version of "${name}"). Refusing to submit (fail-closed) — an unsupported range cannot be pinned.`,
      );
    }
    if (seen.has(name)) {
      throw new Error(
        `submit deps sidecar: required edge "${name}" is declared more than once in cinatra.dependencies ` +
          `(the sidecar must be a canonical exact cover — duplicates are non-canonical). Refusing to submit.`,
      );
    }
    seen.add(name);
    sidecar.push(`${name}@${version}`);
  }
  return sidecar;
}

// True when a manifest has at least one REQUIRED runtime/install-time edge whose
// constraint is a strict caret range needing broker resolution. The submit flow
// uses this to open the resolve MCP route (and require the OIDC token) ONLY when
// a caret is actually present — a manifest with no caret edges submits exactly as
// before (no new network, no new token requirement — no regression).
export function requiresRangeResolution(manifest) {
  const c = manifest?.cinatra?.dependencies;
  if (!Array.isArray(c)) return false;
  for (const edge of c) {
    if (!edge || typeof edge !== "object") continue;
    if (edge.requirement !== "required") continue;
    if (edge.edgeType !== "runtime" && edge.edgeType !== "install-time") continue;
    const vc = edge.versionConstraint;
    if (vc && vc.kind === "semver-range" && typeof vc.range === "string" && !EXACT_SEMVER.test(vc.range) && CARET_RANGE.test(vc.range)) {
      return true;
    }
  }
  return false;
}

// Vendor SUBMIT auth (the marketplace MCP). CINATRA_MARKETPLACE_VENDOR_TOKEN may be
// a full "Basic …"/"Bearer …" header OR a RAW WordPress application password (what
// the wp-admin UI / Infisical hold). For a raw value, build HTTP Basic
// base64("<vendor-user>:<app-pw>") — WP application-password auth; the user defaults
// to the first-party vendor `cinatra-ai` (override via CINATRA_MARKETPLACE_VENDOR_USER).
// (The dependency-ordering gate does NOT use this: it authenticates per-call with a
// GitHub Actions OIDC token in the ability's request BODY, not a transport header.)
export function vendorAuthHeader(token) {
  if (!token) return {};
  if (/^(Bearer|Basic)\s/i.test(token)) return { authorization: token };
  const user = process.env.CINATRA_MARKETPLACE_VENDOR_USER || "cinatra-ai";
  return { authorization: `Basic ${Buffer.from(`${user}:${token}`).toString("base64")}` };
}

// --- submit outcome classification ------------------------------------------
// A submit that returns no MCP `isError` is NOT necessarily a published listing.
// On the auto-approve path the inline promotion saga can finish HALF-FAILED:
// status='approved' + promotion_state='failed' (the storefront read-back failed, the
// row stays unlisted and is queued for retry/dead-letter) — returned as a normal 200,
// no isError. Terminal SUCCESS is status='promoted' + promotion_state='complete'
// (Store::markPromoted). Pending moderation (auto-approve off / separation-of-duties)
// is status='pending' with no promotion_state — legitimate, not a failure.
export function classifySubmissionOutcome({ status, promotionState } = {}) {
  const s = String(status ?? "").toLowerCase();
  const p = promotionState != null ? String(promotionState).toLowerCase() : null;
  if (s === "promoted" && p === "complete") return { kind: "listed" };
  if (p === "failed") {
    return { kind: "failed", reason: "promotion_state=failed (stays approved+failed, queued for retry/dead-letter)" };
  }
  if (s === "pending") return { kind: "pending", reason: "awaiting moderation (auto-approve off or separation-of-duties)" };
  return { kind: "unconfirmed", reason: `status=${status ?? "?"}, promotion_state=${promotionState ?? "n/a"}` };
}

// Throw on a definitive promotion failure; warn (do not throw) on a not-yet-terminal
// state so the legitimate pending/in_flight paths still exit 0. The authoritative
// per-extension confirmation is the post-wave reconciliation pass.
export function assertSubmissionOutcome({ submissionId, status, promotionState } = {}) {
  const outcome = classifySubmissionOutcome({ status, promotionState });
  if (outcome.kind === "failed") {
    throw new Error(
      `Submission ${submissionId ?? "?"} was accepted (status=${status ?? "?"}) but ${outcome.reason} — ` +
        "the extension is NOT a renderable storefront listing. Reconcile before treating it as published.",
    );
  }
  if (outcome.kind !== "listed") {
    process.stderr.write(
      `⚠ Submission ${submissionId ?? "?"} accepted but NOT confirmed-listed (${outcome.reason}). ` +
        "Expected status=promoted + promotion_state=complete. Verify via reconciliation.\n",
    );
  }
  return outcome;
}

// PURE per-edge classifier over a name→boolean existence map (NOT a transport).
// The boolean map is produced by the broker-mediated ability (see
// lookupExtensionExistence) and injected, so this stays unit-testable with no MCP.
//   exists[dep.name] === true  → satisfied (published)
//   exists[dep.name] === false → missing (a real ordering violation)
// A name absent from the map, or a non-boolean value, is a CONTRACT VIOLATION and
// is classified `error` (fatal) — never read as "missing+pass". When the whole
// batched lookup throws, the caller poisons EVERY edge with `unreadable` instead
// of calling this (so the report shape is preserved and no edge silently vanishes).
export function classifyDepExistence(dep, exists) {
  const v = exists instanceof Map ? exists.get(dep.name) : exists?.[dep.name];
  if (v === true) return { ...dep, state: "satisfied" };
  if (v === false) return { ...dep, state: "missing", detail: "not published (the marketplace ability returned false)" };
  return {
    ...dep,
    state: "error",
    detail: "the marketplace ability returned no boolean for this name (contract violation)",
  };
}

// Effectful batched existence lookup THROUGH the deployed, OIDC-gated marketplace
// ability `cinatra/extension-dependency-exists`. Sends ALL `names` in ONE call (the
// ability batches; one single-use OIDC jti authenticates one call). Returns a
// Map name→boolean. FAIL-CLOSED: THROWS on a missing token, an MCP error, a
// malformed/partial result, an unexpected extra name, or any non-boolean value —
// the caller treats a throw as fatal for the whole gate.
//
// `callToolImpl(toolName, args, { timeoutMs })` is injected so the production MCP
// path and the unit tests share one classifier/validator. It must resolve to the
// MCP tool result `{ isError?, structuredContent?, content? }`.
export async function lookupExtensionExistence(
  names,
  { identityToken, callToolImpl, toolName = DEP_EXISTS_TOOL_NAME, timeoutMs = DEP_GATE_TIMEOUT_MS } = {},
) {
  if (typeof callToolImpl !== "function") {
    throw new Error("lookupExtensionExistence: no callTool implementation available");
  }
  if (typeof identityToken !== "string" || identityToken === "") {
    throw new Error(
      "dependency-ordering gate: no GitHub Actions OIDC identity token available " +
        "(CINATRA_DEP_GATE_IDENTITY_TOKEN unset) — the broker-mediated existence ability " +
        "requires it. Refusing to verify (fail-closed); the ordering guarantee cannot hold without it.",
    );
  }
  // Defensive batch validation (mirrors the deployed ability) BEFORE any call so a
  // malformed/oversized batch fails closed with a clear local error.
  if (!Array.isArray(names) || names.length === 0) {
    throw new Error("lookupExtensionExistence: at least one name is required.");
  }
  const unique = [...new Set(names)];
  if (unique.length !== names.length) {
    throw new Error("lookupExtensionExistence: duplicate names in the batch (refusing to send an ambiguous batch).");
  }
  if (unique.length > DEP_EXISTS_MAX_NAMES) {
    throw new Error(
      `dependency-ordering gate: ${unique.length} first-party extension edges exceeds the ability's ` +
        `batch cap of ${DEP_EXISTS_MAX_NAMES}. Refusing to verify (fail-closed) rather than truncate.`,
    );
  }
  for (const n of unique) {
    if (typeof n !== "string" || !DEP_NAME_PATTERN.test(n)) {
      throw new Error(
        `dependency-ordering gate: declared extension edge "${n}" is not a valid first-party ` +
          `"@cinatra-ai/<ext>" name. Fix cinatra.dependencies; refusing to verify (fail-closed).`,
      );
    }
  }

  let result;
  try {
    result = await callToolImpl(toolName, { source_identity_token: identityToken, names: unique }, { timeoutMs });
  } catch (err) {
    // Transport/timeout/protocol error. Do NOT retry with the same token (its jti
    // may already be consumed server-side); surface as fatal.
    throw new Error(
      `dependency-ordering gate: the marketplace ability "${toolName}" call failed: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (result?.isError) {
    const txt = Array.isArray(result.content) ? result.content.find((c) => c.type === "text")?.text : null;
    // A 401/403 (unverifiable caller) or 502 (broker existence read failed) lands
    // here — all fatal. The ability NEVER returns a partial/ambiguous success.
    throw new Error(`dependency-ordering gate: the marketplace ability "${toolName}" returned an error: ${txt ?? "unknown"}`);
  }
  const out = result?.structuredContent ?? {};
  const map = out.results;
  if (map == null || typeof map !== "object" || Array.isArray(map)) {
    throw new Error(`dependency-ordering gate: the marketplace ability "${toolName}" returned no usable results map.`);
  }
  const lookup = new Map();
  for (const n of unique) {
    if (!Object.prototype.hasOwnProperty.call(map, n)) {
      throw new Error(`dependency-ordering gate: the ability omitted "${n}" from its results (partial/ambiguous — fail-closed).`);
    }
    const v = map[n];
    if (typeof v !== "boolean") {
      throw new Error(`dependency-ordering gate: the ability returned a non-boolean for "${n}" (contract violation — fail-closed).`);
    }
    lookup.set(n, v);
  }
  // Reject contract drift: any name the ability returned that we did NOT ask for.
  for (const k of Object.keys(map)) {
    if (!lookup.has(k)) {
      throw new Error(`dependency-ordering gate: the ability returned an unrequested name "${k}" (contract drift — fail-closed).`);
    }
  }
  return lookup;
}

// Resolve a caret RANGE to a deterministic exact pin via the broker-mediated
// marketplace ability `cinatra-extension-dependency-resolve`. Given a first-party
// name + a strict caret range, the ability returns the HIGHEST promoted+reconciled
// version satisfying the range (SemVer order, prereleases excluded), or fails
// closed if none. Mirrors lookupExtensionExistence exactly: `callToolImpl` is
// injected (production MCP route vs a test fake), the OIDC token travels in the
// BODY (never a header/argv), a single-use jti means NO retry, and every
// non-success (transport error, isError, missing/inexact version) is fatal —
// the sidecar must be reconcilable by construction or the submit is refused.
export async function resolveDependencyVersion(
  name,
  range,
  { identityToken, callToolImpl, toolName = DEP_RESOLVE_TOOL_NAME, timeoutMs = DEP_GATE_TIMEOUT_MS } = {},
) {
  if (typeof callToolImpl !== "function") {
    throw new Error("resolveDependencyVersion: no callTool implementation available");
  }
  if (typeof identityToken !== "string" || identityToken === "") {
    throw new Error(
      "submit deps sidecar: no GitHub Actions OIDC identity token available for this resolve call — " +
        "the ability consumes a single-use jti per call, so the caller must mint a FRESH token per " +
        "resolve (mintCiOidcToken; never a reused/pre-consumed one). Refusing to submit (fail-closed).",
    );
  }
  if (typeof name !== "string" || !DEP_NAME_PATTERN.test(name)) {
    throw new Error(`submit deps sidecar: "${name}" is not a valid first-party @cinatra-ai/<ext> name (fail-closed).`);
  }
  if (typeof range !== "string" || !CARET_RANGE.test(range)) {
    throw new Error(`submit deps sidecar: "${range}" is not a strict caret range for "${name}" (fail-closed).`);
  }

  let result;
  try {
    result = await callToolImpl(toolName, { source_identity_token: identityToken, name, range }, { timeoutMs });
  } catch (err) {
    throw new Error(
      `submit deps sidecar: the marketplace ability "${toolName}" call failed for "${name}@${range}": ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (result?.isError) {
    const txt = Array.isArray(result.content) ? result.content.find((c) => c.type === "text")?.text : null;
    throw new Error(`submit deps sidecar: the marketplace ability "${toolName}" returned an error for "${name}@${range}": ${txt ?? "unknown"}`);
  }
  const out = result?.structuredContent ?? {};
  const version = out.version;
  if (typeof version !== "string" || !EXACT_SEMVER.test(version)) {
    throw new Error(
      `submit deps sidecar: the resolve ability returned no exact version for "${name}@${range}" ` +
        `(got ${JSON.stringify(version ?? null)}). No PROMOTED+RECONCILED version satisfies the range — fail-closed.`,
    );
  }
  return version;
}

// Production caret resolver: ONE freshly minted single-use OIDC token PER resolve
// call. NEVER reuses CINATRA_DEP_GATE_IDENTITY_TOKEN — by the time a caret edge
// resolves, the dependency-ordering gate has ALREADY consumed that token's
// single-use jti (one token authenticates exactly ONE marketplace ability call),
// so reuse is a deterministic replay rejection: the marketplace verifier returns
// 403 "The source identity does not satisfy the dependency-resolution policy"
// (audit reason `token_replayed`). Minting is per-call because a manifest may
// declare SEVERAL caret edges and the resolve ability cannot batch (one
// name+range per call). `mintTokenImpl` is injected for tests; production uses
// the runner's ambient OIDC endpoint via {@link mintCiOidcToken}.
export function makeCaretRangeResolver({ callToolImpl, mintTokenImpl = mintCiOidcToken } = {}) {
  return async (name, range) => {
    const identityToken = await mintTokenImpl();
    if (typeof identityToken !== "string" || identityToken === "") {
      throw new Error(
        `submit deps sidecar: cannot mint a GitHub Actions OIDC token for the caret resolve of "${name}@${range}" ` +
          `(no ambient ACTIONS_ID_TOKEN_REQUEST_URL/_TOKEN — not a CI job with id-token: write). ` +
          `Each resolve call consumes its OWN single-use token. Refusing to submit (fail-closed).`,
      );
    }
    return resolveDependencyVersion(name, range, { identityToken, callToolImpl });
  };
}

// Verify the @cinatra-ai/* dependency-ordering closure via the broker-mediated
// existence ability. `existsLookup(names) => Promise<Map name→boolean>` is injected
// (production wires it to lookupExtensionExistence over MCP; tests inject a stub).
// Probes ONLY canonical extension edges (cinatra.dependencies); host-internal
// @cinatra-ai/* peers are host-provided under model-B and intentionally never on
// the registry, so they are SKIPPED. FAIL-CLOSED: a lookup throw poisons EVERY
// probed edge as `unreadable` (fatal) so the report shape is intact and no edge
// silently disappears.
export async function checkDependencyOrdering({ manifest, existsLookup } = {}) {
  const { toProbe: deps, skippedNonManifestCinatraDeps } = selectExtensionDepsToProbe(manifest);
  let results;
  if (deps.length === 0) {
    // 0-dep manifest: nothing to verify, no token required, no ability call — and
    // no existsLookup needed (checked only when there are edges to probe).
    results = [];
  } else {
    if (typeof existsLookup !== "function") {
      throw new Error("checkDependencyOrdering: no existence-lookup implementation available");
    }
    const names = deps.map((d) => d.name);
    let lookup;
    try {
      lookup = await existsLookup(names);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      // Poison every edge — a single lookup failure must fail the WHOLE gate.
      results = deps.map((d) => ({ ...d, state: "unreadable", detail }));
      const errored = [];
      const missing = [];
      const unreadable = results;
      return {
        ok: false,
        deps,
        skippedNonManifestCinatraDeps,
        results,
        missing,
        unreadable,
        errored,
        satisfied: [],
        lookupError: detail,
      };
    }
    results = deps.map((d) => classifyDepExistence(d, lookup));
  }
  const missing = results.filter((r) => r.state === "missing");
  const unreadable = results.filter((r) => r.state === "unreadable");
  const errored = results.filter((r) => r.state === "error");
  return {
    ok: missing.length === 0 && unreadable.length === 0 && errored.length === 0,
    deps,
    skippedNonManifestCinatraDeps,
    results,
    missing,
    unreadable,
    errored,
    satisfied: results.filter((r) => r.state === "satisfied"),
  };
}

export function formatGateFailure(report) {
  const lines = [];
  if (report.missing.length > 0) {
    lines.push(`Dependency-ordering gate FAILED — ${report.missing.length} @cinatra-ai/* dependency(ies) not yet published:`);
    for (const m of report.missing) lines.push(`  • ${m.name}@${m.range} [${m.field}] — ${m.detail || "missing"}`);
    lines.push("Publish the missing @cinatra-ai/* dependency extension(s) (in dependency order) THROUGH the marketplace storefront FIRST, then re-submit. (These are dependency extensions, not the host SDK.)");
  }
  if (report.unreadable.length > 0) {
    lines.push(`Dependency-ordering gate could NOT verify via the marketplace existence ability (${report.lookupError || "unverifiable"}):`);
    for (const u of report.unreadable) lines.push(`  • ${u.name}@${u.range} [${u.field}]`);
    lines.push(
      "The broker-mediated ability requires a GitHub Actions OIDC identity token (aud=marketplace) and a verifiable, public, first-party caller. " +
        "In CI it is minted by the reusable release workflow (CINATRA_DEP_GATE_IDENTITY_TOKEN); a missing/rejected token or an ability/broker error is fatal by design. " +
        "(Use --skip-dependency-check only for manual/local backfill where you have independently confirmed the closure is published.)",
    );
  }
  if (report.errored.length > 0) {
    lines.push(`Dependency-ordering gate hit ${report.errored.length} ability error(s):`);
    for (const e of report.errored) lines.push(`  • ${e.name}@${e.range}: ${e.detail || `HTTP ${e.status}`}`);
  }
  return lines.join("\n");
}

export async function assertDependencyOrdering(opts) {
  const report = await checkDependencyOrdering(opts);
  if (!report.ok) throw new Error(formatGateFailure(report));
  return report;
}

// --- packed-manifest serverEntry preflight (cinatra#161 §4.2) -----------------
// The Cinatra runtime package store is BUILT-ARTIFACTS-ONLY: a package that
// declares `cinatra.serverEntry` must resolve it — through the package `exports`
// map under the pinned Cinatra resolver semantics, else as a literal path — to
// an EXISTING regular file with a Node-importable extension (.mjs/.cjs/.js).
// The host materializer refuses every other shape at install time, so submitting
// a source-mirror tarball would only mint a marketplace listing nobody can
// install. This preflight is the EARLIEST fail-loud: it reads the PACKED
// manifest from the tarball BYTES (never a source tree — the release build step
// rewrites the manifest in the staged pack dir only) and refuses to submit a
// violating tarball. Zero-dependency: a minimal USTAR walk over the gunzipped
// bytes (node builtins only); the resolver/classifier semantics are imported
// from the sibling build-server-entry.mjs (the byte-synced placement copy of
// the canonical cinatra-monorepo builder) ONLY when a serverEntry is declared,
// so this file still imports/runs standalone for every serverEntry-less
// extension (agents, skills, artifacts, workflows).

/**
 * Minimal USTAR reader for an npm tarball. Returns the gunzipped buffer and
 * every entry header `{ name, size, typeflag, dataStart }`. Handles the
 * ustar prefix field; pax/longname meta entries are walked over (their data
 * blocks are skipped correctly) — npm tarball member paths relevant to this
 * preflight (`package/package.json`, the resolved serverEntry) are short.
 */
export function listTarEntries(tarballBytes) {
  const tar = gunzipSync(tarballBytes);
  const entries = [];
  let off = 0;
  while (off + 512 <= tar.length) {
    const block = tar.subarray(off, off + 512);
    if (block.every((b) => b === 0)) break; // end-of-archive marker
    const cstr = (from, to) => {
      const slice = block.subarray(from, to);
      const nul = slice.indexOf(0);
      return slice.subarray(0, nul === -1 ? slice.length : nul).toString("utf8");
    };
    const nameRaw = cstr(0, 100);
    const prefix = cstr(345, 500);
    const size = Number.parseInt(cstr(124, 136).trim() || "0", 8);
    if (!Number.isFinite(size) || size < 0) {
      throw new Error("listTarEntries: malformed tar header (size field) — refusing to parse");
    }
    const typeflag = block[156] === 0 ? "0" : String.fromCharCode(block[156]);
    entries.push({
      name: prefix ? `${prefix}/${nameRaw}` : nameRaw,
      size,
      typeflag,
      dataStart: off + 512,
    });
    off += 512 + Math.ceil(size / 512) * 512;
  }
  return { tar, entries };
}

/**
 * Read the PACKED package.json from tarball bytes (npm pack prefixes every
 * member with `package/`) plus the set of regular-file member paths.
 *
 * FAIL-CLOSED tar semantics: a hand-crafted tarball
 * could shadow members (duplicate paths extract last-wins in npm/node-tar,
 * while a naive reader sees the first) or rename them via pax/GNU extended
 * headers — either would let the EFFECTIVE package diverge from what this
 * preflight inspected. npm pack emits neither (plain ustar names, prefix
 * splitting, no duplicates), so both shapes are refused outright instead of
 * being interpreted.
 */
export function readPackedManifest(tarballBytes) {
  const { tar, entries } = listTarEntries(tarballBytes);
  const extended = entries.find((e) => ["x", "g", "L", "K"].includes(e.typeflag));
  if (extended) {
    throw new Error(
      `tarball carries an extended tar header (typeflag "${extended.typeflag}") — refusing: the ` +
        "preflight requires plain ustar member names (which npm pack produces); extended headers " +
        "can rename members after inspection",
    );
  }
  // Canonical-names-only + duplicate check across ALL member types: a later
  // symlink/hardlink with a regular member's path, or a non-canonical alias
  // of it ("package/./register.mjs",
  // "package//register.mjs", absolute, ".." traversal), would extract
  // last-wins and shadow the inspected bytes. npm pack emits canonical,
  // duplicate-free names — anything else is refused, never interpreted.
  const seen = new Set();
  for (const e of entries) {
    const segments = e.name.split("/");
    // Tolerate exactly one trailing "/" (directory-entry convention).
    if (segments.length > 1 && segments[segments.length - 1] === "") segments.pop();
    if (e.name.startsWith("/") || segments.some((s) => s === "" || s === "." || s === "..")) {
      throw new Error(
        `tarball member "${e.name}" has a non-canonical path — refusing: aliased paths extract ` +
          "onto canonical ones last-wins and would shadow the bytes this preflight inspected",
      );
    }
    const canonical = segments.join("/");
    if (seen.has(canonical)) {
      throw new Error(
        `tarball has a duplicate member "${e.name}" — refusing: duplicate paths extract last-wins ` +
          "and would shadow the bytes this preflight inspected",
      );
    }
    seen.add(canonical);
  }
  const files = entries.filter((e) => e.typeflag === "0");
  const manifestEntry = files.find((e) => e.name === "package/package.json");
  if (!manifestEntry) {
    throw new Error("tarball carries no package/package.json — not an npm package tarball");
  }
  let manifest;
  try {
    manifest = JSON.parse(
      tar.subarray(manifestEntry.dataStart, manifestEntry.dataStart + manifestEntry.size).toString("utf8"),
    );
  } catch (err) {
    throw new Error(`tarball package/package.json is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { manifest, fileNames: new Set(files.map((e) => e.name)) };
}

/**
 * PURE serverEntry-contract check over a packed manifest + tarball file set.
 * Resolver/classifier are dependency-injected (the builder module's exports) so
 * this is unit-testable and the semantics live in exactly one placement file.
 * Returns null when the contract holds (or no serverEntry is declared), else a
 * violation message.
 */
export function packedServerEntryViolation(
  { manifest, fileNames },
  { resolveDeclaredServerEntry, classifyServerEntryArtifact },
) {
  const serverEntry =
    manifest?.cinatra && typeof manifest.cinatra.serverEntry === "string"
      ? manifest.cinatra.serverEntry
      : null;
  if (!serverEntry) return null; // no-server-entry package — valid as-is
  const resolution = resolveDeclaredServerEntry(manifest.exports, serverEntry);
  if (resolution.kind !== "resolved") {
    return (
      `cinatra.serverEntry "${serverEntry}" is a declared exports key whose target is outside the ` +
      `supported exports forms (exact key → "./"-relative string, or a one-level conditional whose ` +
      `import/default/require value is such a string) — the runtime store refuses this shape`
    );
  }
  const rel = resolution.rel;
  const cleaned = rel.replace(/^\.\//, "");
  // Same segment-level guard the host store and the builder apply: absolute
  // paths and ANY ".." segment are refused.
  if (cleaned.startsWith("/") || cleaned.split("/").some((seg) => seg === "..")) {
    return `cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — escapes the package dir`;
  }
  const cls = classifyServerEntryArtifact(rel);
  if (cls !== "importable") {
    return (
      `cinatra.serverEntry "${serverEntry}" resolves to "${rel}" — ` +
      `${cls === "source" ? "TypeScript source" : "not a concrete importable file"}. ` +
      `The runtime store activates BUILT artifacts only (.mjs/.cjs/.js)`
    );
  }
  if (!fileNames.has(`package/${cleaned}`)) {
    return `cinatra.serverEntry "${serverEntry}" resolves to "${rel}" but the tarball carries no such file`;
  }
  return null;
}

/**
 * Effectful preflight wrapper: parse the tarball bytes, lazy-import the sibling
 * builder module for the shared resolver/classifier (only when a serverEntry is
 * actually declared), and throw an actionable error on any violation.
 */
export async function assertPackedServerEntryContract(tarballBytes) {
  const { manifest, fileNames } = readPackedManifest(tarballBytes);
  const declares =
    manifest?.cinatra && typeof manifest.cinatra.serverEntry === "string";
  if (!declares) return { ok: true, serverEntry: null };
  let builder;
  try {
    builder = await import(new URL("./build-server-entry.mjs", import.meta.url).href);
  } catch {
    throw new Error(
      "serverEntry preflight needs build-server-entry.mjs next to release-submit.mjs (it provides the " +
        "shared exports resolver + artifact classifier). Ship the two files side by side — the reusable " +
        "release workflow stages them together.",
    );
  }
  const violation = packedServerEntryViolation({ manifest, fileNames }, builder);
  if (violation) {
    throw new Error(
      `serverEntry preflight FAILED — refusing to submit ${manifest.name ?? "?"}: ${violation}. ` +
        `Publish a BUILT entry: the release pipeline's build step (build-server-entry.mjs) turns the ` +
        `in-tree source shape (exports["./register"] → "./src/register.ts") into a bundled top-level ` +
        `register.mjs with cinatra.serverEntry "./register.mjs" in the PACKED manifest (cinatra#161).`,
    );
  }
  return { ok: true, serverEntry: manifest.cinatra.serverEntry };
}

// Assemble the exact `cinatra-extension-submit-for-review` MCP arguments. Kept a
// pure, exported function so the wire shape is unit-testable without pacote/MCP.
// Optional fields are emitted ONLY when meaningfully present, so a submit with no
// description and no source-identity token is byte-identical to the historical
// shape (back-compat with every existing/replayed submission).
export function buildSubmitArguments({
  namespace,
  extensionName,
  version,
  artifactDigestSha256,
  artifactSizeBytes,
  tarballBase64,
  description,
  sourceIdentityToken,
  deps,
} = {}) {
  const args = {
    namespace,
    extension_name: extensionName,
    version,
    artifact_digest_sha256: artifactDigestSha256,
    artifact_size_bytes: artifactSizeBytes,
    tarball_base64: tarballBase64,
  };
  if (typeof description === "string" && description !== "") args.description = description;
  // The vendor-declared exact-identity cover of the REQUIRED extension closure
  // (cinatra.dependencies). Emitted ONLY when non-empty so a connector with no
  // required edges stays byte-identical to the historical no-deps submit shape
  // (the 0-edge connectors that already promoted). When present, the marketplace
  // reconciles it against the artifact's required projection and refuses a
  // divergence — so it MUST be the exact cover (see buildRequiredDepsSidecar).
  if (Array.isArray(deps) && deps.length > 0) args.deps = deps;
  // The GitHub-signed OIDC source-identity token (proves repo/owner/visibility/
  // workflow). Forwarded ONLY when present; the marketplace owns size/shape
  // validation (an oversized/invalid token => manual moderation, never a reject).
  if (typeof sourceIdentityToken === "string" && sourceIdentityToken !== "") {
    args.source_identity_token = sourceIdentityToken;
  }
  return args;
}

// --- shared MCP connection helper --------------------------------------------
// Open a short-lived MCP client (lazy heavy imports) against the marketplace MCP
// route, hand a `callTool(name, args, { timeoutMs })` to `fn`, and ALWAYS close the
// connection. Used for the dependency-gate ability call (no transport auth header —
// the OIDC token rides in the call body). `headers` lets a caller add transport auth
// when needed (the submit path supplies the vendor Basic header).
async function withMcpCallTool({ baseUrl, headers = {}, clientName }, fn) {
  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + MCP_ROUTE), {
    requestInit: { headers },
  });
  const client = new Client({ name: clientName, version: "1.0.0" });
  await client.connect(transport);
  try {
    const callTool = (name, args, { timeoutMs } = {}) =>
      client.callTool({ name, arguments: args }, undefined, timeoutMs != null ? { timeout: timeoutMs } : undefined);
    return await fn(callTool);
  } finally {
    await client.close().catch(() => {});
  }
}

// --- marketplace submit (lazy heavy imports) ---------------------------------
async function submitTarball({ tarballPath, description, skipDependencyCheck }) {
  const tarballBytes = await readFile(tarballPath);
  // Earliest fail-loud (cinatra#161 §4.2): never submit a tarball whose PACKED
  // manifest declares a runtime-store-uninstallable serverEntry shape. Reads
  // the manifest from the tarball BYTES — the same bytes the marketplace gets.
  await assertPackedServerEntryContract(tarballBytes);
  const { default: pacote } = await import("pacote");
  const manifest = await pacote.manifest(`file:${tarballPath}`);
  if (typeof manifest.name !== "string" || manifest.name.indexOf("/") < 0) {
    throw new Error(`Tarball package name "${manifest.name}" must be scoped (@namespace/name).`);
  }
  const idx = manifest.name.indexOf("/");
  const namespace = manifest.name.slice(0, idx);
  const extensionName = manifest.name.slice(idx + 1);
  const version = String(manifest.version ?? "");
  if (!version) throw new Error("Tarball package.json is missing a `version` field.");

  if (!skipDependencyCheck) {
    const baseUrl = (process.env.MARKETPLACE_BASE_URL || MARKETPLACE_BASE_URL).replace(/\/+$/, "");
    // OIDC identity token (aud=marketplace) for the broker-mediated existence
    // ability. Minted by the reusable release workflow as a SEPARATE token from the
    // submit step's CINATRA_SOURCE_IDENTITY_TOKEN — the ability consumes a single-use
    // jti per call, so the gate must not share the submit token. An empty value here
    // means the gate will fail closed inside lookupExtensionExistence (NOT skip) —
    // the ordering guarantee cannot hold without a verifiable caller.
    const identityToken = process.env.CINATRA_DEP_GATE_IDENTITY_TOKEN;
    const existsLookup = (names) =>
      withMcpCallTool(
        { baseUrl, headers: {}, clientName: "cinatra-release-dep-gate" },
        (callTool) => lookupExtensionExistence(names, { identityToken, callToolImpl: callTool }),
      );
    const report = await assertDependencyOrdering({ manifest, existsLookup });
    const skipped = report?.skippedNonManifestCinatraDeps ?? [];
    if (skipped.length > 0) {
      process.stderr.write(
        `ℹ dependency-ordering gate: skipped ${skipped.length} host-provided @cinatra-ai/* peer(s) not declared as an extension edge in cinatra.dependencies (model-B host-internal — the host supplies them at install/runtime): ${skipped.join(", ")}\n`,
      );
    }
  } else {
    process.stderr.write("⚠ --skip-dependency-check: bypassing the @cinatra-ai/* dependency-ordering gate.\n");
  }

  const artifactDigestSha256 = createHash("sha256").update(tarballBytes).digest("hex");
  const artifactSizeBytes = tarballBytes.byteLength;

  // The marketplace `deps` sidecar: the exact-identity cover of the REQUIRED
  // extension closure declared in the artifact's cinatra.dependencies. Built from
  // the PACKED manifest (the same bytes the marketplace reconciles) and forwarded
  // so the submit reconciles by construction. Fail-closed (throws) if a required
  // edge lacks a deterministic exact version — never inferred.
  //
  // A required edge MAY declare a strict caret range (`^X.Y.Z`) instead of an
  // exact pin; that caret is resolved to the highest PROMOTED+RECONCILED exact
  // version via the broker resolve ability. We only open the resolve MCP route
  // (and mint per-call OIDC tokens) when a caret is actually present — a
  // manifest whose required edges are all exact/singleton submits exactly as
  // before (no new network, no new token requirement).
  //
  // NEVER reuse CINATRA_DEP_GATE_IDENTITY_TOKEN here: the dependency-ordering
  // gate above has ALREADY consumed that token's single-use jti (one token
  // authenticates exactly ONE marketplace ability call), so reusing it makes the
  // resolve ability's verifier reject every call as a replay — a deterministic
  // 403 for any manifest with both an extension edge and a caret. Each caret
  // edge instead mints its own fresh token (see makeCaretRangeResolver).
  let deps;
  if (requiresRangeResolution(manifest)) {
    const resolveBaseUrl = (process.env.MARKETPLACE_BASE_URL || MARKETPLACE_BASE_URL).replace(/\/+$/, "");
    deps = await withMcpCallTool(
      { baseUrl: resolveBaseUrl, headers: {}, clientName: "cinatra-release-dep-resolve" },
      (callTool) =>
        buildRequiredDepsSidecar(manifest, {
          resolveRange: makeCaretRangeResolver({ callToolImpl: callTool }),
        }),
    );
  } else {
    deps = await buildRequiredDepsSidecar(manifest);
  }
  if (deps.length > 0) {
    process.stderr.write(`ℹ submit deps sidecar (required extension closure): ${deps.join(", ")}\n`);
  }

  const token = process.env.CINATRA_MARKETPLACE_VENDOR_TOKEN;
  if (!token) throw new Error("CINATRA_MARKETPLACE_VENDOR_TOKEN is not set (the submit-scope vendor token).");
  // GitHub-signed source-identity OIDC token, minted by the reusable release
  // workflow scoped to the marketplace audience. Optional: present in CI (enables
  // public-repo auto-approve), absent for manual/local submit (manual moderation).
  const sourceIdentityToken = process.env.CINATRA_SOURCE_IDENTITY_TOKEN;
  const baseUrl = (process.env.MARKETPLACE_BASE_URL || MARKETPLACE_BASE_URL).replace(/\/+$/, "");

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + MCP_ROUTE), {
    requestInit: { headers: vendorAuthHeader(token) },
  });
  const client = new Client({ name: "cinatra-release-submit", version: "1.0.0" });
  try {
    await client.connect(transport);
    process.stderr.write(`Submitting ${manifest.name}@${version} (${artifactSizeBytes} bytes) to the Cinatra Marketplace…\n`);
    // Observability only — NEVER print the token value.
    process.stderr.write(
      sourceIdentityToken
        ? "ℹ source-identity OIDC token present — eligible for public-repo auto-approve.\n"
        : "ℹ no source-identity OIDC token (CINATRA_SOURCE_IDENTITY_TOKEN unset) — submission falls to manual moderation.\n",
    );
    const result = await client.callTool(
      {
        name: "cinatra-extension-submit-for-review",
        arguments: buildSubmitArguments({
          namespace,
          extensionName,
          version,
          artifactDigestSha256,
          artifactSizeBytes,
          tarballBase64: tarballBytes.toString("base64"),
          description,
          sourceIdentityToken,
          deps,
        }),
      },
      // resultSchema: keep the SDK default (pass undefined, not null).
      undefined,
      { timeout: SUBMIT_TIMEOUT_MS },
    );
    if (result?.isError) {
      const txt = Array.isArray(result.content) ? result.content.find((c) => c.type === "text")?.text : null;
      throw new Error(`extension-submit-for-review error: ${txt ?? "unknown"}`);
    }
    const out = result?.structuredContent ?? {};
    const submissionId = out.submission_id ?? "?";
    const status = String(out.status ?? "?");
    // promotion_state is present only on the auto-approve path (the inline saga ran).
    const promotionState = out.promotion_state != null ? String(out.promotion_state) : null;
    process.stdout.write(`submission_id: ${submissionId}\nstatus: ${status}\npromotion_state: ${promotionState ?? "n/a"}\n`);
    assertSubmissionOutcome({ submissionId, status, promotionState });
  } finally {
    await client.close().catch(() => {});
  }
}

async function main() {
  const args = process.argv.slice(2);
  const tarballPath = args.find((a) => !a.startsWith("--"));
  if (!tarballPath) {
    throw new Error("Usage: node release-submit.mjs <tarball.tgz> [--description \"<text>\"] [--skip-dependency-check]");
  }
  const dIdx = args.indexOf("--description");
  const description = dIdx >= 0 ? args[dIdx + 1] : undefined;
  await submitTarball({
    tarballPath: resolvePath(process.cwd(), tarballPath),
    description,
    skipDependencyCheck: args.includes("--skip-dependency-check"),
  });
}

const invokedDirectly =
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
