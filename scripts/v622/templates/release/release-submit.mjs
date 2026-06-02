#!/usr/bin/env node
// ---------------------------------------------------------------------------
// release-submit — the self-contained, portable shared submit CLI used by BOTH
// the reusable release workflow (CI) and manual/local backfill. It is
// intentionally standalone (no @cinatra-ai/cli dependency — the
// monorepo CLI is private) so it can run inside any extracted extension repo's
// CI by installing only two public deps at runtime: pacote and
// @modelcontextprotocol/sdk. It has NO module-load dependency (only Node
// builtins) so it imports cleanly for unit tests; pacote + the MCP SDK are
// lazy-imported inside the submit path.
//
// Flow:
//   1. Read the CI-built tarball bytes.
//   2. Derive name + version from the tarball's package.json (pacote).
//   3. Dependency-ordering gate: every @cinatra-ai/* dep must already be
//      PUBLISHED on registry.cinatra.ai — fail BEFORE submit otherwise.
//   4. sha256 + size; base64.
//   5. Call `cinatra/extension-submit-for-review` over MCP with the exact bytes.
//
// Token: CINATRA_MARKETPLACE_VENDOR_TOKEN (the submit-scope GitHub org secret).
//
// Gate scope vs. the dev CLI: this portable gate is EXISTENCE-based — it asks
// "is every @cinatra-ai/* dependency published on the registry at all?", which is
// the ordering guarantee that matters (a public repo can't install an unpublished
// dep). It deliberately does NOT do semver range-satisfaction; the marketplace
// re-validates exact version compatibility at approval, and the dev-side
// packages/cli/src/extensions-dependency-gate.mjs adds the semver-aware check for
// local use. Keep the 401-vs-404 classification below in lock-step with that
// module.
// ---------------------------------------------------------------------------

import { readFile } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";
import { createHash } from "node:crypto";

export const CINATRA_SCOPE = "@cinatra-ai/";
export const DEFAULT_REGISTRY_URL = "https://registry.cinatra.ai";
export const MARKETPLACE_BASE_URL = "https://marketplace.cinatra.ai";
const MCP_ROUTE = "/wp-json/cinatra/mcp";

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

function authHeader(token) {
  if (!token) return {};
  return { authorization: /^(Bearer|Basic)\s/i.test(token) ? token : `Bearer ${token}` };
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
  const deps = extractCinatraDeps(manifest);
  const results = [];
  for (const dep of deps) results.push(await probeDep(dep, { registryUrl, token, fetchImpl }));
  const missing = results.filter((r) => r.state === "missing");
  const unreadable = results.filter((r) => r.state === "unreadable");
  const errored = results.filter((r) => r.state === "error");
  return {
    ok: missing.length === 0 && unreadable.length === 0 && errored.length === 0,
    registryUrl, deps, results, missing, unreadable, errored,
    satisfied: results.filter((r) => r.state === "satisfied"),
  };
}

export function formatGateFailure(report) {
  const lines = [];
  if (report.missing.length > 0) {
    lines.push(`Dependency-ordering gate FAILED — ${report.missing.length} @cinatra-ai/* dependency(ies) not on ${report.registryUrl}:`);
    for (const m of report.missing) lines.push(`  • ${m.name}@${m.range} [${m.field}] — ${m.detail || "missing"}`);
    lines.push("Publish the package's @cinatra-ai/* closure (in dependency order) through the marketplace path FIRST, then re-submit.");
  }
  if (report.unreadable.length > 0) {
    lines.push(`Dependency-ordering gate could NOT verify — ${report.registryUrl} returned ${report.unreadable[0].status} (registry not readable):`);
    for (const u of report.unreadable) lines.push(`  • ${u.name}@${u.range} [${u.field}]`);
    lines.push("The registry's public-read is not enabled, or no read token is set. Export CINATRA_REGISTRY_TOKEN or wait for the public-read flip.");
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

// --- marketplace submit (lazy heavy imports) ---------------------------------
async function submitTarball({ tarballPath, description, skipDependencyCheck }) {
  const tarballBytes = await readFile(tarballPath);
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
    await assertDependencyOrdering({ manifest, registryUrl, token: process.env.CINATRA_REGISTRY_TOKEN });
  } else {
    process.stderr.write("⚠ --skip-dependency-check: bypassing the @cinatra-ai/* dependency-ordering gate.\n");
  }

  const artifactDigestSha256 = createHash("sha256").update(tarballBytes).digest("hex");
  const artifactSizeBytes = tarballBytes.byteLength;

  const token = process.env.CINATRA_MARKETPLACE_VENDOR_TOKEN;
  if (!token) throw new Error("CINATRA_MARKETPLACE_VENDOR_TOKEN is not set (the submit-scope vendor token).");
  const baseUrl = (process.env.MARKETPLACE_BASE_URL || MARKETPLACE_BASE_URL).replace(/\/+$/, "");

  const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
  const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
  const transport = new StreamableHTTPClientTransport(new URL(baseUrl + MCP_ROUTE), {
    requestInit: { headers: authHeader(token) },
  });
  const client = new Client({ name: "cinatra-release-submit", version: "1.0.0" });
  try {
    await client.connect(transport);
    process.stderr.write(`Submitting ${manifest.name}@${version} (${artifactSizeBytes} bytes) to the Cinatra Marketplace…\n`);
    const result = await client.callTool({
      name: "cinatra/extension-submit-for-review",
      arguments: {
        namespace,
        extension_name: extensionName,
        version,
        artifact_digest_sha256: artifactDigestSha256,
        artifact_size_bytes: artifactSizeBytes,
        tarball_base64: tarballBytes.toString("base64"),
        ...(description ? { description } : {}),
      },
    });
    if (result?.isError) {
      const txt = Array.isArray(result.content) ? result.content.find((c) => c.type === "text")?.text : null;
      throw new Error(`extension-submit-for-review error: ${txt ?? "unknown"}`);
    }
    const out = result?.structuredContent ?? {};
    process.stdout.write(`submission_id: ${out.submission_id ?? "?"}\nstatus: ${out.status ?? "?"}\n`);
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
  process.argv[1] && resolvePath(process.argv[1]) === resolvePath(new URL(import.meta.url).pathname);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
