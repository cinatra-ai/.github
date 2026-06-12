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
//      manifest's canonical `cinatra.dependencies` must already be present on
//      registry.cinatra.ai (the authenticated install-backend) — which happens by
//      publishing it THROUGH the marketplace, never by direct registry publish —
//      fail BEFORE submit otherwise. Host-internal SDK/app peers are host-provided
//      under model-B and are SKIPPED (never on the registry).
//   5. sha256 + size; base64.
//   6. Call `cinatra-extension-submit-for-review` over MCP with the exact bytes.
//
// Token: CINATRA_MARKETPLACE_VENDOR_TOKEN (the submit-scope GitHub org secret).
//
// Gate scope vs. the dev CLI: this portable gate is EXISTENCE-based — it asks
// "is every @cinatra-ai/* EXTENSION EDGE (cinatra.dependencies) published on the
// registry at all?", which is the ordering guarantee that matters (a public repo
// can't install an unpublished sibling extension). It deliberately does NOT do
// semver range-satisfaction; the marketplace
// re-validates exact version compatibility at approval, and the dev-side
// packages/cli/src/extensions-dependency-gate.mjs adds the semver-aware check for
// local use. Keep the 401-vs-404 classification below in lock-step with that
// module.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { gunzipSync } from "node:zlib";

export const CINATRA_SCOPE = "@cinatra-ai/";
export const DEFAULT_REGISTRY_URL = "https://registry.cinatra.ai";
export const MARKETPLACE_BASE_URL = "https://marketplace.cinatra.ai";
const MCP_ROUTE = "/wp-json/cinatra/mcp";
// The submit MCP call runs the promotion saga INLINE (stage-publish → final-publish →
// verify-digest → storefront read-back), which can exceed the MCP SDK's 60s default
// request timeout under rate-limit backoff or registry/WooCommerce slowness. Use a
// generous explicit timeout so a slow-but-succeeding publish is never falsely reported
// as a failure. Override via CINATRA_SUBMIT_TIMEOUT_MS.
const SUBMIT_TIMEOUT_MS = Number(process.env.CINATRA_SUBMIT_TIMEOUT_MS || 600_000);

// --- dependency-ordering gate (existence-based; mirror of the 401-vs-404
//     classification in packages/cli/src/extensions-dependency-gate.mjs) -------
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

function authHeader(token) {
  if (!token) return {};
  return { authorization: /^(Bearer|Basic)\s/i.test(token) ? token : `Bearer ${token}` };
}

// Vendor SUBMIT auth (the marketplace MCP). CINATRA_MARKETPLACE_VENDOR_TOKEN may be
// a full "Basic …"/"Bearer …" header OR a RAW WordPress application password (what
// the wp-admin UI / Infisical hold). For a raw value, build HTTP Basic
// base64("<vendor-user>:<app-pw>") — WP application-password auth; the user defaults
// to the first-party vendor `cinatra-ai` (override via CINATRA_MARKETPLACE_VENDOR_USER).
// (The registry probe keeps authHeader()'s Bearer-by-default — that token is a
// registry read token, not a WP app-password.)
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

export async function probeDep(dep, { registryUrl, token, fetchImpl }) {
  const url = `${String(registryUrl).replace(/\/+$/, "")}/${dep.name.replace("/", "%2F")}`;
  let res;
  try {
    res = await fetchImpl(url, { headers: { accept: "application/json", ...authHeader(token) } });
  } catch (err) {
    return { ...dep, state: "error", detail: err instanceof Error ? err.message : String(err) };
  }
  if (res.status === 401 || res.status === 403) return { ...dep, state: "unreadable", status: res.status };
  if (res.status === 404) return { ...dep, state: "missing", status: 404, detail: "not found on the registry" };
  if (!res.ok) return { ...dep, state: "error", status: res.status, detail: `unexpected HTTP ${res.status}` };
  let body;
  try {
    body = await res.json();
  } catch {
    return { ...dep, state: "error", detail: "registry returned a non-JSON packument" };
  }
  const versions = Object.keys(body?.versions ?? {});
  return versions.length > 0
    ? { ...dep, state: "satisfied" }
    : { ...dep, state: "missing", detail: "no published versions" };
}

export async function checkDependencyOrdering({
  manifest,
  registryUrl = DEFAULT_REGISTRY_URL,
  token,
  fetchImpl = globalThis.fetch,
} = {}) {
  if (typeof fetchImpl !== "function") throw new Error("checkDependencyOrdering: no fetch implementation available");
  // Probe ONLY canonical extension edges (cinatra.dependencies); host-internal
  // @cinatra-ai/* peers are host-provided under model-B and never on the registry.
  const { toProbe: deps, skippedNonManifestCinatraDeps } = selectExtensionDepsToProbe(manifest);
  const results = [];
  for (const dep of deps) results.push(await probeDep(dep, { registryUrl, token, fetchImpl }));
  const missing = results.filter((r) => r.state === "missing");
  const unreadable = results.filter((r) => r.state === "unreadable");
  const errored = results.filter((r) => r.state === "error");
  return {
    ok: missing.length === 0 && unreadable.length === 0 && errored.length === 0,
    registryUrl, deps, skippedNonManifestCinatraDeps, results, missing, unreadable, errored,
    satisfied: results.filter((r) => r.state === "satisfied"),
  };
}

export function formatGateFailure(report) {
  const lines = [];
  if (report.missing.length > 0) {
    lines.push(`Dependency-ordering gate FAILED — ${report.missing.length} @cinatra-ai/* dependency(ies) not on ${report.registryUrl}:`);
    for (const m of report.missing) lines.push(`  • ${m.name}@${m.range} [${m.field}] — ${m.detail || "missing"}`);
    lines.push("Publish the missing @cinatra-ai/* dependency extension(s) (in dependency order) THROUGH the marketplace storefront FIRST, then re-submit. (These are dependency extensions, not the host SDK.)");
  }
  if (report.unreadable.length > 0) {
    lines.push(`Dependency-ordering gate could NOT verify — ${report.registryUrl} returned ${report.unreadable[0].status} (registry not readable):`);
    for (const u of report.unreadable) lines.push(`  • ${u.name}@${u.range} [${u.field}]`);
    lines.push("registry.cinatra.ai requires authentication by design — export a read-scope CINATRA_REGISTRY_TOKEN, then re-run. (Use --skip-dependency-check only if you have independently confirmed the closure is published.)");
  }
  if (report.errored.length > 0) {
    lines.push(`Dependency-ordering gate hit ${report.errored.length} registry error(s):`);
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
  // The GitHub-signed OIDC source-identity token (proves repo/owner/visibility/
  // workflow). Forwarded ONLY when present; the marketplace owns size/shape
  // validation (an oversized/invalid token => manual moderation, never a reject).
  if (typeof sourceIdentityToken === "string" && sourceIdentityToken !== "") {
    args.source_identity_token = sourceIdentityToken;
  }
  return args;
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
    const registryUrl = (process.env.CINATRA_REGISTRY_URL || DEFAULT_REGISTRY_URL).trim();
    const report = await assertDependencyOrdering({ manifest, registryUrl, token: process.env.CINATRA_REGISTRY_TOKEN });
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
