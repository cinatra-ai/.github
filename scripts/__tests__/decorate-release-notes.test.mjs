import assert from "node:assert/strict";
import { test } from "node:test";
import {
  parseEntries,
  isBotLogin,
  reportersForEntry,
  formatReportedBy,
  decorateNotes,
} from "../decorate-release-notes.mjs";

const SAMPLE_NOTES = `## What's Changed
* Fix the thing by @alice in https://github.com/cinatra-ai/ci/pull/101
* Add the other thing by @bob in https://github.com/cinatra-ai/ci/pull/102
* Bump dep by @renovate[bot] in https://github.com/cinatra-ai/ci/pull/103

**Full Changelog**: https://github.com/cinatra-ai/ci/compare/v1.0.0...v1.1.0
`;

test("parseEntries extracts only What's Changed lines, in order", () => {
  const entries = parseEntries(SAMPLE_NOTES);
  assert.equal(entries.length, 3);
  assert.deepEqual(
    entries.map((e) => [e.author, e.prNumber]),
    [
      ["alice", "101"],
      ["bob", "102"],
      ["renovate[bot]", "103"],
    ],
  );
});

test("parseEntries ignores header, blank, and Full Changelog lines", () => {
  const entries = parseEntries(SAMPLE_NOTES);
  const rawLines = entries.map((e) => e.raw);
  assert.ok(!rawLines.some((l) => l.startsWith("## ")));
  assert.ok(!rawLines.some((l) => l.startsWith("**Full Changelog**")));
});

test("isBotLogin matches [bot] suffix case-insensitively", () => {
  assert.equal(isBotLogin("renovate[bot]"), true);
  assert.equal(isBotLogin("RENOVATE[BOT]"), true);
  assert.equal(isBotLogin("alice"), false);
  assert.equal(isBotLogin(undefined), false);
});

test("formatReportedBy joins 0/1/2/3+ handles correctly", () => {
  assert.equal(formatReportedBy([]), "");
  assert.equal(formatReportedBy(["alice"]), "Reported by @alice");
  assert.equal(
    formatReportedBy(["alice", "bob"]),
    "Reported by @alice and @bob",
  );
  assert.equal(
    formatReportedBy(["alice", "bob", "carol"]),
    "Reported by @alice, @bob and @carol",
  );
});

test("reportersForEntry credits a non-author public reporter", () => {
  const entry = { author: "bob", prNumber: "102" };
  const data = { 102: [{ login: "carol", isPrivate: false }] };
  assert.deepEqual(reportersForEntry(entry, data), ["carol"]);
});

test("reportersForEntry omits a self-reported issue (reporter == PR author)", () => {
  const entry = { author: "alice", prNumber: "101" };
  const data = { 101: [{ login: "alice", isPrivate: false }] };
  assert.deepEqual(reportersForEntry(entry, data), []);
});

test("reportersForEntry omits a bot reporter (isBot flag or [bot] suffix)", () => {
  const entry = { author: "bob", prNumber: "102" };
  const data = {
    102: [
      { login: "some-bot[bot]", isPrivate: false },
      { login: "app-bot", isPrivate: false, isBot: true },
    ],
  };
  assert.deepEqual(reportersForEntry(entry, data), []);
});

test("reportersForEntry fails closed: unknown/missing isPrivate excludes the reporter", () => {
  const entry = { author: "bob", prNumber: "102" };
  // No isPrivate field at all (e.g. GraphQL couldn't resolve the linked
  // repo's visibility) must NOT be treated as public.
  const data = { 102: [{ login: "carol" }] };
  assert.deepEqual(reportersForEntry(entry, data), []);
});

test("reportersForEntry excludes an explicitly private-repo reporter", () => {
  const entry = { author: "bob", prNumber: "102" };
  const data = { 102: [{ login: "carol", isPrivate: true }] };
  assert.deepEqual(reportersForEntry(entry, data), []);
});

test("reportersForEntry dedups the same reporter across multiple closing issues", () => {
  const entry = { author: "bob", prNumber: "102" };
  const data = {
    102: [
      { login: "carol", isPrivate: false },
      { login: "carol", isPrivate: false },
    ],
  };
  assert.deepEqual(reportersForEntry(entry, data), ["carol"]);
});

test("reportersForEntry with no closing issues returns empty", () => {
  const entry = { author: "bob", prNumber: "102" };
  assert.deepEqual(reportersForEntry(entry, {}), []);
  assert.deepEqual(reportersForEntry(entry, { 102: [] }), []);
});

test("decorateNotes appends credit only to entries with a confirmed reporter", () => {
  const data = {
    101: [{ login: "alice", isPrivate: false }], // self-reported -> no credit
    102: [{ login: "carol", isPrivate: false }], // non-author -> credit
    103: [{ login: "dave", isPrivate: false }], // bot PR author, non-bot reporter -> credit
  };
  const decorated = decorateNotes(SAMPLE_NOTES, data);
  const lines = decorated.split("\n");
  assert.equal(lines[1], "* Fix the thing by @alice in https://github.com/cinatra-ai/ci/pull/101");
  assert.equal(
    lines[2],
    "* Add the other thing by @bob in https://github.com/cinatra-ai/ci/pull/102 (Reported by @carol)",
  );
  assert.equal(
    lines[3],
    "* Bump dep by @renovate[bot] in https://github.com/cinatra-ai/ci/pull/103 (Reported by @dave)",
  );
});

test("decorateNotes credits multiple distinct reporters on one PR", () => {
  const data = { 101: [{ login: "carol", isPrivate: false }, { login: "dave", isPrivate: false }] };
  const decorated = decorateNotes(SAMPLE_NOTES, data);
  assert.equal(
    decorated.split("\n")[1],
    "* Fix the thing by @alice in https://github.com/cinatra-ai/ci/pull/101 (Reported by @carol and @dave)",
  );
});

test("decorateNotes never surfaces a private-repo reporter", () => {
  const data = { 101: [{ login: "carol", isPrivate: true }] };
  const decorated = decorateNotes(SAMPLE_NOTES, data);
  assert.equal(
    decorated.split("\n")[1],
    "* Fix the thing by @alice in https://github.com/cinatra-ai/ci/pull/101",
  );
});

test("decorateNotes is a no-op with no closing-issue data at all", () => {
  assert.equal(decorateNotes(SAMPLE_NOTES, {}), SAMPLE_NOTES);
  assert.equal(decorateNotes(SAMPLE_NOTES, undefined), SAMPLE_NOTES);
});

test("decorateNotes preserves headers, blank lines, and the Full Changelog footer verbatim", () => {
  const decorated = decorateNotes(SAMPLE_NOTES, {});
  assert.equal(decorated, SAMPLE_NOTES);
});
