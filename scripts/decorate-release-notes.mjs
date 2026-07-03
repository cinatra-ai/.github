#!/usr/bin/env node
// Decorates GitHub's auto-generated "What's Changed" Release notes with a
// `Reported by @handle` credit on each PR's line, per the org's
// reporter-credit convention — see reusable-release-notes.yml for the full
// contract this implements.
//
// This module is pure (no network, no filesystem beyond the thin CLI at the
// bottom) so the decoration logic is fully unit-testable. The workflow step
// is responsible for the I/O:
//   1. generate the raw notes (releases/generate-notes)
//   2. fetch each listed PR's closingIssuesReferences via the GraphQL API,
//      normalized into the closingIssuesByPr shape documented below
//   3. run this script: node decorate-release-notes.mjs <notes-file> <data-file>
// and use stdout as the (possibly decorated) Release body.
//
// closingIssuesByPr shape: { [prNumber: string]: Array<{
//   login: string | null,     // the closing issue's author handle
//   isPrivate: boolean,       // true unless CONFIRMED public (fail-closed)
//   isBot?: boolean,          // true when the author is a bot actor
// }> }

import { readFileSync } from "node:fs";

// Matches a single GitHub-generated "What's Changed" entry line, e.g.:
//   * Fix the thing by @alice in https://github.com/cinatra-ai/ci/pull/123
const ENTRY_RE =
  /^(\* .+ by @([\w-]+(?:\[bot\])?) in https:\/\/github\.com\/[^/\s]+\/[^/\s]+\/pull\/(\d+))\s*$/;

/**
 * Parses the "What's Changed" entry lines out of a generated Release body.
 * Returns one record per matched line, in file order. Non-matching lines
 * (headers, the Full Changelog footer, blank lines) are ignored.
 */
export function parseEntries(notesBody) {
  const lines = notesBody.split("\n");
  const entries = [];
  lines.forEach((line, index) => {
    const m = ENTRY_RE.exec(line);
    if (!m) return;
    const [, raw, author, prNumber] = m;
    entries.push({ index, raw, author, prNumber: String(Number(prNumber)) });
  });
  return entries;
}

/** A bot actor login, e.g. "renovate[bot]" — case-insensitive. */
export function isBotLogin(login) {
  return typeof login === "string" && login.toLowerCase().endsWith("[bot]");
}

/**
 * Distinct, ordered, non-author, non-bot, CONFIRMED-public reporter handles
 * for one "What's Changed" entry. Fails closed: an issue record is only
 * counted when `isPrivate === false` is explicit — anything else (missing,
 * true, or unresolved) is excluded, never assumed public.
 */
export function reportersForEntry(entry, closingIssuesByPr) {
  const issues = (closingIssuesByPr && closingIssuesByPr[entry.prNumber]) || [];
  const seen = new Set();
  const reporters = [];
  for (const issue of issues) {
    if (!issue || !issue.login) continue;
    if (issue.isPrivate !== false) continue; // fail closed on anything but a confirmed-public issue
    if (issue.login === entry.author) continue; // self-reported
    if (issue.isBot || isBotLogin(issue.login)) continue;
    if (seen.has(issue.login)) continue;
    seen.add(issue.login);
    reporters.push(issue.login);
  }
  return reporters;
}

/**
 * "Reported by @a" / "Reported by @a and @b" / "Reported by @a, @b and @c".
 * Returns "" for an empty list (nothing to append).
 */
export function formatReportedBy(logins) {
  if (!logins || logins.length === 0) return "";
  const handles = logins.map((login) => `@${login}`);
  if (handles.length === 1) return `Reported by ${handles[0]}`;
  const last = handles[handles.length - 1];
  const rest = handles.slice(0, -1);
  return `Reported by ${rest.join(", ")} and ${last}`;
}

/**
 * Returns the notes body with `(Reported by @handle...)` appended to each
 * "What's Changed" line whose PR has a confirmed-public, non-author,
 * non-bot closing-issue reporter. Lines with no credit are returned
 * unchanged. Never mutates ordering, never touches non-entry lines.
 */
export function decorateNotes(notesBody, closingIssuesByPr) {
  const lines = notesBody.split("\n");
  for (const entry of parseEntries(notesBody)) {
    const reporters = reportersForEntry(entry, closingIssuesByPr);
    if (reporters.length === 0) continue;
    const credit = formatReportedBy(reporters);
    lines[entry.index] = `${entry.raw} (${credit})`;
  }
  return lines.join("\n");
}

function main() {
  const [, , notesPath, dataPath] = process.argv;
  if (!notesPath || !dataPath) {
    console.error(
      "usage: decorate-release-notes.mjs <notes-file> <closing-issues-json-file>",
    );
    process.exit(1);
  }
  const notesBody = readFileSync(notesPath, "utf8");
  const closingIssuesByPr = JSON.parse(readFileSync(dataPath, "utf8"));
  process.stdout.write(decorateNotes(notesBody, closingIssuesByPr));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
