// SPDX-License-Identifier: Apache-2.0
// Copyright 2026 10xlabs. Part of the SaveMyBudget Toolkit — https://github.com/10xlabsio/savemybudget-toolkit
//
// The generated detection core imports its own modules with explicit `.ts` extensions (`from "./rules.ts"`).
// tsconfig.json sets `rewriteRelativeImportExtensions`, so `npm run build` accepts such imports and emits `.js`
// in their place. This compiles a two-file module with a `.ts` import under this repository's tsconfig, in a
// temp dir, and runs what comes out.

import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = resolve(import.meta.dirname, "..");
const TSC = join(REPO, "node_modules", "typescript", "bin", "tsc");

test("a relative import with an explicit .ts extension compiles under tsconfig.json and is emitted as .js", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "ts-ext-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  mkdirSync(join(dir, "src", "detection"), { recursive: true });
  writeFileSync(join(dir, "package.json"), '{ "type": "module" }\n');
  writeFileSync(
    join(dir, "tsconfig.json"),
    JSON.stringify({
      extends: join(REPO, "tsconfig.json"),
      compilerOptions: { rootDir: "src", outDir: "dist", noEmit: false },
      include: ["src"],
    }),
  );
  writeFileSync(join(dir, "src", "detection", "leaf.ts"), "export const answer = 42;\n");
  writeFileSync(join(dir, "src", "detection", "types.ts"), "export type Doubled = number;\n");
  writeFileSync(
    join(dir, "src", "detection", "index.ts"),
    'import { answer } from "./leaf.ts";\nimport type { Doubled } from "./types.ts";\nexport const doubled: Doubled = answer * 2;\n',
  );

  const r = spawnSync(process.execPath, [TSC, "-p", join(dir, "tsconfig.json")], { encoding: "utf8" });
  assert.equal(r.status, 0, `tsc failed:\n${r.stdout}${r.stderr}`);

  const emitted = readFileSync(join(dir, "dist", "detection", "index.js"), "utf8");
  assert.match(emitted, /from "\.\/leaf\.js"/, `the .ts import was not rewritten to .js:\n${emitted}`);
  assert.doesNotMatch(emitted, /\.ts"/, `a .ts specifier survived into the output:\n${emitted}`);

  const mod = (await import(pathToFileURL(join(dir, "dist", "detection", "index.js")).href)) as { doubled: number };
  assert.equal(mod.doubled, 84);
});
