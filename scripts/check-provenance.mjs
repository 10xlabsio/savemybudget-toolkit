#!/usr/bin/env node
// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
//
// Provenance check for the generated detection core.
//
// src/detection/ is generated from the maintainer's source, never edited by hand. Each export writes
// src/detection/PROVENANCE.json:
//
//   { "format": ..., "rule_version": <integer>, "exported": "<ISO-8601 date or UTC time>",
//     "files": { "<path relative to src/detection/, '/'-separated>": "<lower-case hex sha256>" } }
//
// This check recomputes the sha256 of every file under src/detection/ (PROVENANCE.json itself excepted) and
// fails on a missing file, an extra file, a hash mismatch, a symlink or other non-regular file, an extra key
// or any other deviation from that shape. Until the first export lands (no src/detection/ at all) it passes
// and says so.
//
// Usage: node scripts/check-provenance.mjs [--root DIR]
// Exit codes: 0 ok, 1 check failed.

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

export const DETECTION_DIR = "src/detection";
export const PROVENANCE_FILE = "PROVENANCE.json";
const KEYS = ["exported", "files", "format", "rule_version"];
const HEX64 = /^[0-9a-f]{64}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?Z)?$/;
const FORMAT = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$/;
const SEGMENT = /^(?!\.{1,2}$)[^/\\\0]+$/;

function shapeProblems(p) {
  const out = [];
  if (p === null || typeof p !== "object" || Array.isArray(p)) return ["is not a JSON object"];
  const keys = Object.keys(p).sort();
  for (const k of keys) if (!KEYS.includes(k)) out.push(`has an extra key "${k}"`);
  for (const k of KEYS) if (!Object.hasOwn(p, k)) out.push(`is missing "${k}"`);
  if (Object.hasOwn(p, "format")) {
    const f = p.format;
    const ok = (typeof f === "string" && FORMAT.test(f)) || (Number.isSafeInteger(f) && f > 0);
    if (!ok) out.push('"format" must be a short identifier string or a positive integer');
  }
  if (Object.hasOwn(p, "rule_version") && !(Number.isSafeInteger(p.rule_version) && p.rule_version > 0)) {
    out.push('"rule_version" must be a positive integer');
  }
  if (Object.hasOwn(p, "exported")) {
    const e = p.exported;
    if (typeof e !== "string" || !ISO.test(e) || Number.isNaN(Date.parse(e))) {
      out.push('"exported" must be an ISO-8601 date or UTC time');
    }
  }
  if (Object.hasOwn(p, "files")) {
    const f = p.files;
    if (f === null || typeof f !== "object" || Array.isArray(f)) out.push('"files" must be an object');
    else if (Object.keys(f).length === 0) out.push('"files" is empty');
    else {
      for (const [path, hash] of Object.entries(f)) {
        if (path === PROVENANCE_FILE || !path.split("/").every((s) => SEGMENT.test(s))) {
          out.push(`"files" has an invalid path ${JSON.stringify(path)}`);
        }
        if (typeof hash !== "string" || !HEX64.test(hash)) out.push(`"files" has a hash for ${path} that is not lower-case hex sha256`);
      }
    }
  }
  return out;
}

/** Every entry under dir as a '/'-separated relative path; non-regular files are reported, not followed. */
function walk(dir, rel, files, problems) {
  for (const name of readdirSync(dir).sort()) {
    const abs = join(dir, name);
    const r = rel ? `${rel}/${name}` : name;
    const st = lstatSync(abs);
    if (st.isSymbolicLink()) problems.push(`${DETECTION_DIR}/${r} is a symlink`);
    else if (st.isDirectory()) walk(abs, r, files, problems);
    else if (st.isFile()) files.set(r, abs);
    else problems.push(`${DETECTION_DIR}/${r} is not a regular file`);
  }
}

export function check(root) {
  const dir = join(root, DETECTION_DIR);
  if (!existsSync(dir)) {
    return { ok: true, problems: [], note: `${DETECTION_DIR}/ is not in this tree yet: nothing to check.` };
  }
  const problems = [];
  const st = lstatSync(dir);
  if (!st.isDirectory() || st.isSymbolicLink()) return { ok: false, problems: [`${DETECTION_DIR} is not a directory`] };

  const files = new Map();
  walk(dir, "", files, problems);
  if (!files.has(PROVENANCE_FILE)) {
    problems.push(`${DETECTION_DIR}/${PROVENANCE_FILE} is missing`);
    return { ok: false, problems };
  }
  let prov;
  try {
    prov = JSON.parse(readFileSync(files.get(PROVENANCE_FILE), "utf8"));
  } catch {
    problems.push(`${DETECTION_DIR}/${PROVENANCE_FILE} is not valid JSON`);
    return { ok: false, problems };
  }
  files.delete(PROVENANCE_FILE);
  const shape = shapeProblems(prov);
  if (shape.length > 0) {
    problems.push(...shape.map((s) => `${PROVENANCE_FILE} ${s}`));
    return { ok: false, problems };
  }

  for (const [path, want] of Object.entries(prov.files)) {
    const abs = files.get(path);
    if (abs === undefined) {
      problems.push(`${DETECTION_DIR}/${path} is listed in ${PROVENANCE_FILE} but missing`);
      continue;
    }
    const got = createHash("sha256").update(readFileSync(abs)).digest("hex");
    if (got !== want) problems.push(`${DETECTION_DIR}/${path} does not match its hash in ${PROVENANCE_FILE} (edited by hand?)`);
  }
  for (const path of files.keys()) {
    if (!Object.hasOwn(prov.files, path)) problems.push(`${DETECTION_DIR}/${path} is not listed in ${PROVENANCE_FILE}`);
  }
  return { ok: problems.length === 0, problems, note: `${files.size} files match rules v${prov.rule_version}.` };
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname);
if (isMain) {
  const args = process.argv.slice(2);
  let root = process.cwd();
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--root" && args[i + 1] !== undefined) root = args[++i];
    else {
      console.error(`Provenance check: unknown argument ${args[i]}`);
      process.exit(1);
    }
  }
  const { ok, problems, note } = check(resolve(root));
  if (!ok) {
    for (const p of problems) console.error(p);
    console.error(
      "Provenance check failed. The detection core is generated; changes to it go through an issue (see CONTRIBUTING.md).",
    );
    process.exit(1);
  }
  console.log(`Provenance check: ok. ${note}`);
}
