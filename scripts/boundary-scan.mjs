#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
//
// Keyed-term boundary scan.
//
// The maintainer keeps a short list of terms that must never appear in this public repository. The list is
// committed only as keyed hashes (.github/boundary/keyed.json), so the file itself names nothing: each entry is
// HMAC-SHA256(key, normalised term) in lower-case hex, and the list is padded with random decoys to a fixed size,
// so even its length says nothing. The key is a GitHub Actions secret (BOUNDARY_HMAC_KEY).
//
// The scan hashes every window of 1 to 6 consecutive words of:
//   - every text file in the tree (binary files, .git and node_modules are skipped),
//   - every commit message in --git-range,
//   - the pull request title and body and the branch name (BOUNDARY_PR_TITLE, BOUNDARY_PR_BODY, BOUNDARY_REF_NAME),
// and fails on any window whose hash is in the list. A finding prints where it is, never the words.
//
// Normalisation (the list must be built the same way): Unicode NFKC, lower-case, words are maximal runs of
// letters and digits (\p{L}\p{N}), and a window is its words joined with no separator. So "Example Corp",
// "example-corp", "example_corp" and "ExampleCorp" all hash the same.
//
// Fails closed: no key (a pull request from a fork gets no secrets), an unreadable or malformed list, or an
// unreadable git range all exit non-zero.
//
// Usage: node scripts/boundary-scan.mjs [--root DIR] [--list FILE] [--git-range A..B]
// Exit codes: 0 clean, 1 keyed term found, 2 could not run the scan (fails closed).

import { createHmac } from "node:crypto";
import { execFileSync } from "node:child_process";
import { lstatSync, openSync, readFileSync, readSync, closeSync, readdirSync } from "node:fs";
import { join, relative, resolve, sep } from "node:path";

export const MAX_WINDOW = 6;
export const LIST_SIZE = 256;
const SKIP_DIRS = new Set([".git", "node_modules"]);
const HEX64 = /^[0-9a-f]{64}$/;

class ScanError extends Error {}

/** Words of a text, each with the 1-based line it starts on. */
export function words(text) {
  const out = [];
  const norm = text.normalize("NFKC").toLowerCase();
  let line = 1;
  let last = 0;
  for (const m of norm.matchAll(/[\p{L}\p{N}]+/gu)) {
    for (let i = last; i < m.index; i++) if (norm.charCodeAt(i) === 10) line++;
    last = m.index;
    out.push({ w: m[0], line });
  }
  return out;
}

/** The normalised form of a term, as hashed into the list. */
export function normalise(term) {
  return words(term).map((x) => x.w).join("");
}

export function keyedHash(key, normalised) {
  return createHmac("sha256", key).update(normalised, "utf8").digest("hex");
}

/** Reads and checks the keyed list: exactly LIST_SIZE distinct lower-case hex SHA-256 entries. */
export function loadList(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (e) {
    throw new ScanError(`keyed list ${path} is missing or not JSON (${e.code ?? e.name})`);
  }
  // A bare array of entries is accepted as the minimal form of the list.
  if (Array.isArray(raw)) raw = { format: 1, hash: "hmac-sha256", max_window: MAX_WINDOW, entries: raw };
  if (raw === null || typeof raw !== "object") throw new ScanError("keyed list is not an object");
  const allowed = new Set(["comment", "format", "hash", "max_window", "entries"]);
  for (const k of Object.keys(raw)) if (!allowed.has(k)) throw new ScanError(`keyed list has an unknown key "${k}"`);
  if (raw.format !== 1) throw new ScanError("keyed list format must be 1");
  if (raw.hash !== "hmac-sha256") throw new ScanError('keyed list hash must be "hmac-sha256"');
  if (raw.max_window !== MAX_WINDOW) throw new ScanError(`keyed list max_window must be ${MAX_WINDOW}`);
  if (!Array.isArray(raw.entries) || raw.entries.length !== LIST_SIZE) {
    throw new ScanError(`keyed list must hold exactly ${LIST_SIZE} entries`);
  }
  const set = new Set();
  for (const e of raw.entries) {
    if (typeof e !== "string" || !HEX64.test(e)) throw new ScanError("keyed list entry is not lower-case hex SHA-256");
    set.add(e);
  }
  if (set.size !== LIST_SIZE) throw new ScanError("keyed list has duplicate entries");
  return set;
}

function isBinary(path) {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

function* textFiles(root, dir = root) {
  const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1));
  for (const ent of entries) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) {
      if (!SKIP_DIRS.has(ent.name)) yield* textFiles(root, p);
    } else if (ent.isFile() && !isBinary(p)) {
      yield p;
    }
  }
}

/** Returns a scanner bound to one key and list; it remembers windows it has hashed already. */
export function makeScanner(key, list) {
  const seen = new Map();
  return function scan(text) {
    const ws = words(text);
    const hits = [];
    for (let i = 0; i < ws.length; i++) {
      let joined = "";
      for (let n = 1; n <= MAX_WINDOW && i + n <= ws.length; n++) {
        joined += ws[i + n - 1].w;
        let hit = seen.get(joined);
        if (hit === undefined) {
          hit = list.has(keyedHash(key, joined));
          seen.set(joined, hit);
        }
        if (hit) hits.push({ line: ws[i].line, words: n });
      }
    }
    return hits;
  };
}

function parseArgs(argv) {
  const opts = { root: process.cwd(), list: null, gitRange: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new ScanError(`${a} needs a value`);
      return v;
    };
    if (a === "--root") opts.root = next();
    else if (a === "--list") opts.list = next();
    else if (a === "--git-range") opts.gitRange = next();
    else throw new ScanError(`unknown argument ${a}`);
  }
  opts.root = resolve(opts.root);
  opts.list = resolve(opts.list ?? join(opts.root, ".github", "boundary", "keyed.json"));
  return opts;
}

export function run(argv, env) {
  const findings = [];
  const opts = parseArgs(argv);
  const key = env.BOUNDARY_HMAC_KEY ?? "";
  if (key.length === 0) {
    throw new ScanError(
      "BOUNDARY_HMAC_KEY is not set. The keyed-term scan fails closed without it. Pull requests from forks " +
        "don't receive repository secrets, so this check can't pass for them; a maintainer re-runs the change " +
        "from a branch in this repository.",
    );
  }
  const list = loadList(opts.list);
  const scan = makeScanner(key, list);
  const report = (where, hits) => {
    for (const h of hits) findings.push(`${where}:${h.line}: keyed term (${h.words}-word window)`);
  };

  let files = 0;
  if (!lstatSync(opts.root).isDirectory()) throw new ScanError(`--root ${opts.root} is not a directory`);
  for (const p of textFiles(opts.root)) {
    files++;
    report(relative(opts.root, p).split(sep).join("/"), scan(readFileSync(p, "utf8")));
  }

  let commits = 0;
  if (opts.gitRange) {
    let log;
    try {
      log = execFileSync("git", ["-C", opts.root, "log", "--format=%H%x00%B%x00", opts.gitRange, "--"], {
        encoding: "utf8",
        maxBuffer: 64 * 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new ScanError(`could not read commits in ${opts.gitRange}`);
    }
    const parts = log.split("\0");
    for (let i = 0; i + 1 < parts.length; i += 2) {
      const sha = parts[i].trim();
      if (!sha) continue;
      commits++;
      report(`commit ${sha.slice(0, 12)} message`, scan(parts[i + 1]));
    }
  }

  for (const [name, label] of [
    ["BOUNDARY_PR_TITLE", "pull request title"],
    ["BOUNDARY_PR_BODY", "pull request body"],
    ["BOUNDARY_REF_NAME", "branch name"],
  ]) {
    if (env[name]) report(label, scan(env[name]));
  }

  return { findings, files, commits };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  try {
    const { findings, files, commits } = run(process.argv.slice(2), process.env);
    if (findings.length > 0) {
      for (const f of findings) console.error(f);
      console.error(`Keyed-term scan: ${findings.length} finding(s). Remove the term; the finding names only where it is.`);
      process.exit(1);
    }
    console.log(`Keyed-term scan: clean (${files} files, ${commits} commit messages).`);
  } catch (e) {
    if (e instanceof ScanError) {
      console.error(`Keyed-term scan could not run: ${e.message}`);
      process.exit(2);
    }
    throw e;
  }
}
