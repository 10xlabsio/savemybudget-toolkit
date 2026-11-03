// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
//
// The boundary checks run by .github/workflows/boundary.yml: gitleaks with this repo's config, the keyed-term
// scan and the detection-core provenance check. Every case builds its own tree in a temp dir, with a test key
// and a test keyed list; nothing here uses the real key or list.
//
// The gitleaks cases need the gitleaks binary (set GITLEAKS, or have it on PATH). Without it they skip, unless
// BOUNDARY_TEST_REQUIRE_GITLEAKS=1 (set in CI), where a missing binary fails.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, createHmac, randomBytes } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(import.meta.dirname, "..");
const SCAN = join(REPO, "scripts", "boundary-scan.mjs");
const PROVENANCE = join(REPO, "scripts", "check-provenance.mjs");
const GITLEAKS_CONFIG = join(REPO, ".gitleaks.toml");

const TEST_KEY = randomBytes(32).toString("hex");
const rand = (n: number) => randomBytes(n).toString("hex").replace(/[0-9]/g, (d) => "qxzjv"[Number(d) % 5]);
/** A two-word synthetic term that can't occur anywhere by chance. */
const TERM = `Zq${rand(4)} Vx${rand(4)}`;
const normalise = (s: string) => (s.normalize("NFKC").toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).join("");
const hmac = (key: string, s: string) => createHmac("sha256", key).update(s, "utf8").digest("hex");

function keyedList(terms: string[], size = 256) {
  const entries = new Set(terms.map((t) => hmac(TEST_KEY, normalise(t))));
  while (entries.size < size) entries.add(hmac(TEST_KEY, randomBytes(16).toString("hex")));
  return { comment: "test list", format: 1, hash: "hmac-sha256", max_window: 6, entries: [...entries].sort() };
}

function tree(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "boundary-test-"));
  for (const [p, body] of Object.entries(files)) {
    mkdirSync(join(dir, p, ".."), { recursive: true });
    writeFileSync(join(dir, p), body);
  }
  return dir;
}

const CLEAN_FILES = {
  "README.md": "# Example\n\nA clean tree with ordinary words in it.\n",
  "src/app.ts": "export const greeting = 'hello world';\n",
};

function withList(files: Record<string, string>, list: unknown = keyedList([TERM])) {
  return tree({ ...files, ".github/boundary/keyed.json": JSON.stringify(list) });
}

function scan(root: string, opts: { key?: string | null; env?: Record<string, string>; args?: string[] } = {}) {
  const env: Record<string, string> = { PATH: process.env.PATH ?? "", ...opts.env };
  if (opts.key !== null) env.BOUNDARY_HMAC_KEY = opts.key ?? TEST_KEY;
  return spawnSync(process.execPath, [SCAN, "--root", root, ...(opts.args ?? [])], { env, encoding: "utf8" });
}

function git(dir: string, ...args: string[]) {
  const r = spawnSync(
    "git",
    ["-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args],
    { encoding: "utf8" },
  );
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

// ---------- keyed-term scan ----------

test("keyed scan: a clean tree passes", (t) => {
  const dir = withList(CLEAN_FILES);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = scan(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /clean/);
});

test("keyed scan: a planted keyed term in a file fails, and the finding doesn't repeat the term", (t) => {
  const dir = withList({ ...CLEAN_FILES, "docs/notes.md": `Line one.\nThanks to ${TERM} for the help.\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = scan(dir);
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /docs\/notes\.md:2: keyed term \(2-word window\)/);
  for (const w of TERM.split(" ")) assert.ok(!r.stderr.toLowerCase().includes(w.toLowerCase()), "term leaked into output");
});

test("keyed scan: case, punctuation, line breaks and identifier spelling don't hide a term", (t) => {
  const [a, b] = TERM.split(" ");
  for (const spelling of [`${a.toUpperCase()}-${b}`, `${a}_${b.toLowerCase()}`, `${a}${b}`, `${a}\n  ${b}`]) {
    const dir = withList({ ...CLEAN_FILES, "src/x.ts": `const v = "${spelling}";\n` });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(scan(dir).status, 1, `missed spelling ${JSON.stringify(spelling)}`);
  }
});

test("keyed scan: a keyed term in a commit message fails", (t) => {
  const dir = withList(CLEAN_FILES);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Initial commit");
  const base = git(dir, "rev-parse", "HEAD");
  writeFileSync(join(dir, "src/app.ts"), "export const greeting = 'hi';\n");
  git(dir, "commit", "-q", "-am", `Tweak the greeting\n\nAsked for by ${TERM}.`);
  const clean = scan(dir, { args: ["--git-range", `${base}~0..${base}`] });
  assert.equal(clean.status, 0, clean.stderr);
  const r = scan(dir, { args: ["--git-range", `${base}..HEAD`] });
  assert.equal(r.status, 1, r.stderr);
  assert.match(r.stderr, /commit [0-9a-f]{12} message:3: keyed term/);
});

test("keyed scan: an unreadable git range fails closed", (t) => {
  const dir = withList(CLEAN_FILES);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(scan(dir, { args: ["--git-range", "nope..nothing"] }).status, 2);
});

test("keyed scan: a keyed term in the pull request title, body or branch name fails", (t) => {
  const dir = withList(CLEAN_FILES);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const name of ["BOUNDARY_PR_TITLE", "BOUNDARY_PR_BODY", "BOUNDARY_REF_NAME"]) {
    const r = scan(dir, { env: { [name]: `Something about ${TERM.replace(" ", "-")} here` } });
    assert.equal(r.status, 1, `${name}: ${r.stderr}`);
  }
  assert.equal(scan(dir, { env: { BOUNDARY_PR_TITLE: "An ordinary title", BOUNDARY_PR_BODY: "Body." } }).status, 0);
});

test("keyed scan: without the key (a fork pull request) it fails closed", (t) => {
  const dir = withList(CLEAN_FILES);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  for (const key of [null, ""]) {
    const r = scan(dir, { key });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /BOUNDARY_HMAC_KEY is not set/);
  }
});

test("keyed scan: under a different key the same list finds nothing", (t) => {
  const dir = withList({ ...CLEAN_FILES, "a.md": TERM });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(scan(dir, { key: randomBytes(32).toString("hex") }).status, 0);
});

test("keyed scan: a missing or malformed list fails closed", (t) => {
  const good = keyedList([TERM]);
  const bad: unknown[] = [
    null,
    { ...good, entries: good.entries.slice(1) },
    { ...good, entries: [...good.entries.slice(1), good.entries[0].toUpperCase()] },
    { ...good, entries: [...good.entries.slice(1), good.entries[1]] },
    { ...good, extra: true },
    { ...good, max_window: 4 },
  ];
  for (const list of bad) {
    const dir = list === null ? tree(CLEAN_FILES) : withList(CLEAN_FILES, list);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(scan(dir).status, 2, JSON.stringify(list)?.slice(0, 80));
  }
});

test("keyed scan: binary files, .git and node_modules are skipped", (t) => {
  const dir = withList({ ...CLEAN_FILES, "node_modules/pkg/index.js": TERM, ".git/info/x": TERM });
  writeFileSync(join(dir, "blob.bin"), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from(TERM)]));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  assert.equal(scan(dir).status, 0);
});

test("keyed scan: the committed placeholder list is well formed", (t) => {
  const dir = tree(CLEAN_FILES);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = scan(dir, { args: ["--list", join(REPO, ".github", "boundary", "keyed.json")] });
  assert.equal(r.status, 0, r.stderr);
});

// ---------- provenance ----------

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const CORE = {
  "src/detection/index.ts": "export const x = 1;\n",
  "src/detection/rules/rules.json": '{"version":1}\n',
};

function provenance(files: Record<string, string>, over: Record<string, unknown> = {}) {
  const hashes = Object.fromEntries(Object.entries(files).map(([p, b]) => [p.replace("src/detection/", ""), sha(b)]));
  return JSON.stringify({ format: "provenance/1", rule_version: 9, exported: "2026-11-13T00:00:00Z", files: hashes, ...over });
}

function core(extra: Record<string, string> = {}, prov = provenance(CORE)) {
  return tree({ ...CORE, "src/detection/PROVENANCE.json": prov, ...extra });
}

function checkProvenance(root: string) {
  return spawnSync(process.execPath, [PROVENANCE, "--root", root], { encoding: "utf8" });
}

test("provenance: a tree without a detection core passes and says so", (t) => {
  const dir = tree(CLEAN_FILES);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = checkProvenance(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /not in this tree yet/);
});

test("provenance: an untouched export passes", (t) => {
  const dir = core();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = checkProvenance(dir);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /2 files match rules v9/);
});

test("provenance: a hand edit under src/detection/ fails", (t) => {
  const dir = core();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, "src/detection/index.ts"), "export const x = 2;\n");
  const r = checkProvenance(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /src\/detection\/index\.ts does not match its hash/);
});

test("provenance: an extra file fails", (t) => {
  const dir = core({ "src/detection/extra.ts": "export {};\n" });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = checkProvenance(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /extra\.ts is not listed/);
});

test("provenance: a missing file fails", (t) => {
  const dir = core();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  rmSync(join(dir, "src/detection/rules/rules.json"));
  const r = checkProvenance(dir);
  assert.equal(r.status, 1);
  assert.match(r.stderr, /rules\/rules\.json is listed .* but missing/);
});

test("provenance: a symlink under src/detection/ fails", (t) => {
  const dir = core();
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  symlinkSync("index.ts", join(dir, "src/detection/link.ts"));
  assert.equal(checkProvenance(dir).status, 1);
});

test("provenance: a missing, unparsable or wrongly shaped PROVENANCE.json fails", (t) => {
  const good = JSON.parse(provenance(CORE));
  const bad: (string | null)[] = [
    null,
    "{not json",
    "[]",
    JSON.stringify({ ...good, commit: "abc" }),
    JSON.stringify({ ...good, rule_version: "9" }),
    JSON.stringify({ ...good, rule_version: 9.5 }),
    JSON.stringify({ ...good, exported: "last tuesday" }),
    JSON.stringify({ ...good, format: { v: 1 } }),
    JSON.stringify({ ...good, files: [] }),
    JSON.stringify({ ...good, files: {} }),
    JSON.stringify({ ...good, files: { ...good.files, "index.ts": good.files["index.ts"].toUpperCase() } }),
    JSON.stringify({ ...good, files: { ...good.files, "../escape.ts": sha("x") } }),
    JSON.stringify({ format: good.format, rule_version: 9, files: good.files }),
  ];
  for (const prov of bad) {
    const dir = prov === null ? tree(CORE) : core({}, prov);
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    const r = checkProvenance(dir);
    assert.equal(r.status, 1, `accepted: ${prov}`);
  }
});

// ---------- gitleaks ----------

function gitleaksBin(): string | null {
  const candidate = process.env.GITLEAKS || "gitleaks";
  const r = spawnSync(candidate, ["version"], { encoding: "utf8" });
  return r.status === 0 ? candidate : null;
}
const GITLEAKS = gitleaksBin();
const gitleaksSkip =
  GITLEAKS === null && process.env.BOUNDARY_TEST_REQUIRE_GITLEAKS !== "1" ? "gitleaks not installed" : false;

function gitleaks(dir: string) {
  assert.ok(GITLEAKS, "gitleaks is required (BOUNDARY_TEST_REQUIRE_GITLEAKS=1) but was not found");
  return spawnSync(GITLEAKS, ["dir", dir, "--config", GITLEAKS_CONFIG, "--redact", "--no-banner", "--exit-code", "1"], {
    encoding: "utf8",
  });
}

test("gitleaks: a clean tree passes with this repo's config", { skip: gitleaksSkip }, (t) => {
  const dir = tree(CLEAN_FILES);
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = gitleaks(dir);
  assert.equal(r.status, 0, r.stderr);
});

test("gitleaks: a planted secret fails, and the output is redacted", { skip: gitleaksSkip }, (t) => {
  // Built at run time so no secret-shaped string is ever committed.
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const body = [...randomBytes(36)].map((b) => alphabet[b % alphabet.length]).join("");
  const token = ["gh", "p_", body].join("");
  const dir = tree({ ...CLEAN_FILES, "src/config.ts": `export const token = "${token}";\n` });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = gitleaks(dir);
  assert.equal(r.status, 1, r.stderr);
  assert.ok(!`${r.stdout}${r.stderr}`.includes(body), "secret printed unredacted");
});

// The export writes PROVENANCE.json pretty-printed, one `"<path>": "<sha256 hex>"` entry per line. A name such as
// oauth.ts next to 64 hex characters reads as a generic API key to gitleaks' default rules; .gitleaks.toml allows
// exactly that line shape in exactly that file, and nothing else.
const PROVENANCE_PATH = "src/detection/PROVENANCE.json";
const PROVENANCE_CORE = {
  "src/detection/oauth.ts": "export const scopes = ['openid'];\n",
  "src/detection/rules/rules.json": '{"version":1}\n',
  "src/detection/rules/rules.md": "# Rules\n",
};
/** PROVENANCE.json as the export writes it: pretty-printed, so each file hash sits on its own line. */
const prettyProvenance = (files: Record<string, string>) => `${JSON.stringify(JSON.parse(provenance(files)), null, 2)}\n`;

/** The same scan as the workflow's "over the new commits" step, on a one-commit repo built from dir. */
function gitleaksGit(dir: string) {
  assert.ok(GITLEAKS, "gitleaks is required (BOUNDARY_TEST_REQUIRE_GITLEAKS=1) but was not found");
  git(dir, "init", "-q");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "Detection export");
  return spawnSync(
    GITLEAKS,
    ["git", dir, "--config", GITLEAKS_CONFIG, "--redact", "--no-banner", "--exit-code", "1", "--log-opts=-1 HEAD"],
    { encoding: "utf8" },
  );
}

test("gitleaks: a provenance file with file-name/sha256 lines passes, over the tree and over the commit", { skip: gitleaksSkip }, (t) => {
  const prov = prettyProvenance(PROVENANCE_CORE);
  assert.match(prov, /^ {4}"oauth\.ts": "[0-9a-f]{64}",$/m, "the sample has the line shape the allowlist is for");
  const dir = tree({ ...CLEAN_FILES, ...PROVENANCE_CORE, [PROVENANCE_PATH]: prov });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = gitleaks(dir);
  assert.equal(r.status, 0, r.stderr);
  const g = gitleaksGit(dir);
  assert.equal(g.status, 0, g.stderr);
});

test("gitleaks: a planted key in the provenance file still fails", { skip: gitleaksSkip }, (t) => {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const body = [...randomBytes(36)].map((b) => alphabet[b % alphabet.length]).join("");
  const token = ["gh", "p_", body].join("");
  const planted = prettyProvenance(PROVENANCE_CORE).replace('"files": {\n', `"files": {\n    "token": "${token}",\n`);
  assert.ok(planted.includes(token));
  const dir = tree({ ...CLEAN_FILES, ...PROVENANCE_CORE, [PROVENANCE_PATH]: planted });
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const r = gitleaks(dir);
  assert.equal(r.status, 1, "the allowlist let a planted key through");
  assert.ok(!`${r.stdout}${r.stderr}`.includes(body), "secret printed unredacted");
  assert.equal(gitleaksGit(dir).status, 1, "the allowlist let a planted key through (git mode)");
});

test("gitleaks: the allowlist is for that line shape in that file only", { skip: gitleaksSkip }, (t) => {
  const prov = prettyProvenance(PROVENANCE_CORE);
  const hex = prov.match(/"oauth\.ts": "([0-9a-f]{64})"/)![1];
  const cases: Record<string, Record<string, string>> = {
    // The same line, not lower-case hex: not the shape, so the generic rule applies as before.
    "upper-case hex": { [PROVENANCE_PATH]: prov.replace(hex, hex.toUpperCase()) },
    // A value that isn't a sha256 at all, on the line of a file name.
    "not a sha256": { [PROVENANCE_PATH]: prov.replace(hex, `${hex.slice(0, 40)}-${hex.slice(40, 60)}`) },
    // The exact line shape in a different file.
    "another file": { "src/other/manifest.json": `{\n  "oauth.ts": "${hex}"\n}\n` },
  };
  for (const [name, files] of Object.entries(cases)) {
    const dir = tree({ ...CLEAN_FILES, ...PROVENANCE_CORE, ...files });
    t.after(() => rmSync(dir, { recursive: true, force: true }));
    assert.equal(gitleaks(dir).status, 1, `${name}: expected a finding`);
  }
});
