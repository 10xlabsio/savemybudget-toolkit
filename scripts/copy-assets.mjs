// Copies the non-TypeScript files tsc leaves behind (SDK bytes, build manifest, rule defaults) into dist/.
import { copyFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const files = ['sdk/smb.js', 'sdk/stub.js', 'sdk/smb.build.json', 'rules/defaults.json'];
for (const f of files) {
  const dst = join(root, 'dist', f);
  mkdirSync(dirname(dst), { recursive: true });
  copyFileSync(join(root, 'src', f), dst);
}
console.log(`copied ${files.length} asset files to dist/`);
