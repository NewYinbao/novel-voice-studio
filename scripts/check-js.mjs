import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['public', 'src', 'scripts', 'tests'];
const files = [];

function collect(directory) {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) collect(fullPath);
    else if (/\.(?:js|mjs)$/.test(entry.name)) files.push(fullPath);
  }
}

for (const root of roots) collect(path.join(projectRoot, root));
files.sort();

for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (result.status !== 0) {
    process.stderr.write(result.stderr || result.stdout || `语法检查失败：${file}\n`);
    process.exit(result.status || 1);
  }
}

process.stdout.write(`JavaScript syntax OK: ${files.length} files\n`);
